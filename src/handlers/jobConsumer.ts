import crypto from 'node:crypto';
import { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { getDbPool, withTransaction } from '../lib/db';
import { isTerminalProcessingError, processExcelFile } from '../lib/excelProcessor';
import { logger } from '../lib/logger';
import { bestEffortFencedPublish, FileNotificationPayload, OutboxRecord } from '../lib/sns';
import { ProcessJobMessage } from './jobProducer';

async function processRecord(record: SQSRecord, context: Context): Promise<void> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('Server configuration error: S3_BUCKET is not set');
  }

  const message = JSON.parse(record.body) as ProcessJobMessage;
  const { jobId, fileId, s3Key } = message;
  if (!jobId || !fileId || !s3Key) {
    logger.warn('SQS_MALFORMED_MESSAGE', {
      awsRequestId: context.awsRequestId,
      messageId: record.messageId,
    });
    return; // Acknowledge malformed message so it doesn't poison-loop
  }

  const pool = await getDbPool();
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? '1');

  // [1] Claim in processing_jobs (handles SQS duplicate delivery vs retry/stale recovery > 180s)
  const jobClaim = await pool.query<{ job_id: string; attempts: number }>(
    `INSERT INTO processing_jobs (job_id, file_id, status, attempts)
     VALUES ($1, $2, 'processing', 1)
     ON CONFLICT (job_id) DO UPDATE
       SET status = 'processing',
           attempts = processing_jobs.attempts + 1,
           updated_at = NOW()
     WHERE processing_jobs.status = 'failed'
        OR (processing_jobs.status = 'processing'
            AND processing_jobs.updated_at < NOW() - INTERVAL '180 seconds')
     RETURNING job_id, attempts`,
    [jobId, fileId],
  );

  if ((jobClaim.rowCount ?? jobClaim.rows.length) === 0) {
    const existing = await pool.query<{ status: string }>(
      `SELECT status FROM processing_jobs WHERE job_id = $1`,
      [jobId],
    );
    if (existing.rows[0]?.status === 'completed') {
      logger.info('SQS_DUPLICATE_COMPLETED_SKIPPED', {
        awsRequestId: context.awsRequestId,
        jobId,
        fileId,
      });
      return; // Acknowledge safely
    }
    throw new Error(`jobId=${jobId} is currently in progress in another worker`);
  }

  let claimedFileJob = false;

  try {
    // [2] Atomic claim on file_jobs (180s stale-claim recovery)
    const fileClaim = await pool.query<{ file_id: string }>(
      `UPDATE file_jobs
       SET status = 'processing', started_at = NOW(), error_message = NULL
       WHERE file_id = $1
         AND (status IN ('pending', 'failed', 'timeout')
              OR (status IN ('processing', 'uploading') AND started_at < NOW() - INTERVAL '180 seconds'))
       RETURNING file_id`,
      [fileId],
    );

    if ((fileClaim.rowCount ?? fileClaim.rows.length) === 0) {
      const current = await pool.query<{ status: string }>(
        `SELECT status FROM file_jobs WHERE file_id = $1`,
        [fileId],
      );
      const currentStatus = current.rows[0]?.status;
      if (currentStatus === 'processed') {
        await pool.query(
          `UPDATE processing_jobs
           SET status = 'completed', completed_at = NOW(), updated_at = NOW()
           WHERE job_id = $1`,
          [jobId],
        );
        logger.info('SQS_FILE_ALREADY_PROCESSED', {
          awsRequestId: context.awsRequestId,
          jobId,
          fileId,
        });
        return;
      }

      await pool.query(
        `UPDATE processing_jobs SET status = 'failed', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      throw new Error(`fileId=${fileId} cannot be claimed (current status=${currentStatus})`);
    }

    claimedFileJob = true;

    // [3] Reuse shared Excel processing pipeline
    await processExcelFile({
      bucket,
      originalKey: s3Key,
      fileId,
      mode: 'sqs',
      runId: jobId,
      alreadyClaimed: true,
      throwOnTerminalError: true,
    });

    await pool.query(
      `UPDATE processing_jobs
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE job_id = $1`,
      [jobId],
    );

    logger.info('SQS_JOB_COMPLETED', {
      awsRequestId: context.awsRequestId,
      jobId,
      fileId,
      receiveCount,
    });
  } catch (err) {
    const terminal = isTerminalProcessingError(err);
    const errMsg = err instanceof Error ? err.message : String(err);
    const topicArn = process.env.SNS_TOPIC_ARN;
    const shouldEmitFailed = Boolean(topicArn) && claimedFileJob && (terminal || receiveCount >= 3);

    const outboxRow = await withTransaction(async (client) => {
      await client.query(
        `UPDATE processing_jobs SET status = 'failed', updated_at = NOW() WHERE job_id = $1`,
        [jobId],
      );
      if (claimedFileJob) {
        await client.query(
          `UPDATE file_jobs
           SET status = 'failed', error_message = $2
           WHERE file_id = $1 AND status IN ('processing', 'uploading')`,
          [fileId, errMsg.slice(0, 2000)],
        );
      }
      if (shouldEmitFailed) {
        const eventId = crypto.randomUUID();
        const leaseToken = crypto.randomUUID();
        const failedPayload: FileNotificationPayload = {
          eventId,
          eventType: 'FILE_FAILED',
          status: 'failed',
          fileId,
          errorMessage: errMsg.slice(0, 2000),
          failedAt: new Date().toISOString(),
          s3Key,
        };
        const outboxRes = await client.query<OutboxRecord>(
          `INSERT INTO outbox (event_id, file_id, event_type, dedup_key, payload, status, lease_token, locked_at)
           VALUES ($1, $2, 'FILE_FAILED', $3, $4::jsonb, 'pending', $5, NOW())
           ON CONFLICT (dedup_key) DO NOTHING
           RETURNING id, event_id, file_id, event_type, lease_token, payload`,
          [eventId, fileId, `file_failed:${fileId}:${jobId}`, JSON.stringify(failedPayload), leaseToken],
        );
        return outboxRes.rows[0] ?? null;
      }
      return null;
    });

    if (outboxRow && topicArn) {
      await bestEffortFencedPublish(outboxRow, topicArn);
    }

    if (terminal) {
      logger.warn('SQS_TERMINAL_ERROR_ACKED', {
        awsRequestId: context.awsRequestId,
        jobId,
        fileId,
        error: errMsg,
      });
      return; // Do not retry terminal data errors into DLQ
    }

    logger.error('SQS_TRANSIENT_ERROR_RETRY', {
      awsRequestId: context.awsRequestId,
      jobId,
      fileId,
      receiveCount,
      willRouteToDlq: receiveCount >= 3,
      error: errMsg,
    });
    throw err;
  }
}

/**
 * SQS Event Source Mapping handler for lambda-file-api-job-consumer.
 */
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
  for (const record of event.Records ?? []) {
    await processRecord(record, context);
  }
};
