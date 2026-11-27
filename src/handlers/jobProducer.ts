import crypto from 'node:crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { logger } from '../lib/logger';
import { jsonResponse } from '../lib/response';
import { sendSqsMessage } from '../lib/sqs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProcessJobMessage {
  jobId: string;
  fileId: string;
  s3Key: string;
  enqueuedAt: string;
  requestedBy: 'api' | 'dlq-redrive' | 'manual';
}

/**
 * POST /process-job
 * Enqueues a failed or timed-out file_job for asynchronous reprocessing via SQS.
 * Uses an atomic conditional UPDATE (status IN ('failed', 'timeout') -> 'pending')
 * with compensating rollback if SQS SendMessage fails.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    logger.error('MISSING_SQS_QUEUE_URL', { awsRequestId: context.awsRequestId });
    return jsonResponse(500, { error: 'Server configuration error: SQS_QUEUE_URL is not set' });
  }

  let fileId: string | undefined;
  try {
    const raw = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body
      : '';
    const body = JSON.parse(raw) as { fileId?: string };
    fileId = body.fileId;
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON request body' });
  }

  if (!fileId || !UUID_REGEX.test(fileId)) {
    return jsonResponse(400, { error: 'Invalid or missing fileId (expected UUID)' });
  }

  const pool = await getDbPool();

  // [1] Atomic conditional transition: only failed or timeout jobs can be re-queued
  const claimed = await pool.query<{ file_id: string; original_key: string }>(
    `UPDATE file_jobs
     SET status = 'pending',
         started_at = NULL,
         finished_at = NULL,
         processed_at = NULL,
         error_message = NULL,
         notification_status = 'not_required'
     WHERE file_id = $1 AND status IN ('failed', 'timeout')
     RETURNING file_id, original_key`,
    [fileId],
  );

  if ((claimed.rowCount ?? claimed.rows.length) === 0) {
    const existing = await pool.query<{ status: string }>(
      `SELECT status FROM file_jobs WHERE file_id = $1`,
      [fileId],
    );
    if (existing.rows.length === 0) {
      return jsonResponse(404, { error: 'File job not found', fileId });
    }
    return jsonResponse(409, {
      error: 'File job is not eligible for reprocessing (must be failed or timeout)',
      fileId,
      currentStatus: existing.rows[0].status,
    });
  }

  const originalKey = claimed.rows[0].original_key;
  const jobId = crypto.randomUUID();
  const message: ProcessJobMessage = {
    jobId,
    fileId,
    s3Key: originalKey,
    enqueuedAt: new Date().toISOString(),
    requestedBy: 'api',
  };

  // [2] Enqueue to SQS with compensating rollback on failure
  try {
    const sqsRes = await sendSqsMessage(queueUrl, JSON.stringify(message));
    logger.info('JOB_ENQUEUED', {
      awsRequestId: context.awsRequestId,
      jobId,
      fileId,
      s3Key: originalKey,
      sqsMessageId: sqsRes.messageId,
    });

    return jsonResponse(202, {
      jobId,
      fileId,
      status: 'queued',
      s3Key: originalKey,
      pollUrl: `/file/${fileId}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('SQS_SEND_FAILED_ROLLBACK', {
      awsRequestId: context.awsRequestId,
      jobId,
      fileId,
      error: msg,
    });
    await pool.query(
      `UPDATE file_jobs
       SET status = 'failed', error_message = $2
       WHERE file_id = $1 AND status = 'pending'`,
      [fileId, `SQS enqueue failed: ${msg}`.slice(0, 2000)],
    );
    return jsonResponse(503, {
      error: 'Failed to enqueue job to SQS; job reverted to failed',
      fileId,
    });
  }
};
