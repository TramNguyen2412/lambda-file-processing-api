import crypto from 'node:crypto';
import { Context } from 'aws-lambda';
import { getDbPool, withTransaction } from '../lib/db';
import { logger } from '../lib/logger';
import { bestEffortFencedPublish, FileNotificationPayload, OutboxRecord } from '../lib/sns';

export interface MaintenanceEvent {
  mode?: 'daily' | 'recovery' | 'all';
  source?: string;
  auditBatchSize?: number;
}

export interface MaintenanceResult {
  mode: 'daily' | 'recovery' | 'all';
  cleanupAudit?: { deletedRows: number; batches: number };
  detectStuck?: { stuckCount: number; stuckFileIds: string[]; failedNotificationsPublished: number };
  outboxRetry?: { retriedCount: number; successCount: number; failedCount: number };
}

const DEFAULT_AUDIT_BATCH_SIZE = 1000;

/**
 * Daily task: delete audit_logs older than 30 days in safe batches,
 * then record a MAINTENANCE_RUN audit entry.
 */
export async function runCleanupAudit(batchSize = DEFAULT_AUDIT_BATCH_SIZE): Promise<{
  deletedRows: number;
  batches: number;
}> {
  const pool = await getDbPool();
  let deletedRows = 0;
  let batches = 0;

  while (true) {
    const res = await pool.query<{ id: number }>(
      `WITH batch AS (
         SELECT id FROM audit_logs
         WHERE created_at < NOW() - INTERVAL '30 days'
         LIMIT $1
       )
       DELETE FROM audit_logs a
       USING batch b
       WHERE a.id = b.id
       RETURNING a.id`,
      [batchSize],
    );
    const count = res.rowCount ?? res.rows.length;
    if (count === 0) break;
    deletedRows += count;
    batches += 1;
    if (count < batchSize) break;
  }

  await pool.query(
    `INSERT INTO audit_logs (event_type, file_id, message)
     VALUES ('MAINTENANCE_RUN', NULL, $1)`,
    [JSON.stringify({ task: 'cleanup_audit', deletedRows, batches })],
  );

  logger.info('MAINTENANCE_CLEANUP_AUDIT', { task: 'cleanup_audit', deletedRows, batches });
  return { deletedRows, batches };
}

/**
 * Recovery Task A: detect jobs stuck in 'processing' or 'uploading' > 1 hour,
 * transition them to 'timeout', cancel stale pending outbox entries, and emit FILE_FAILED.
 */
export async function runDetectStuck(): Promise<{
  stuckCount: number;
  stuckFileIds: string[];
  failedNotificationsPublished: number;
}> {
  const topicArn = process.env.SNS_TOPIC_ARN;

  const { stuckFileIds, outboxRows } = await withTransaction(async (client) => {
    const stuckRes = await client.query<{
      file_id: string;
      original_key: string;
      started_epoch: string;
    }>(
      `UPDATE file_jobs
       SET status = 'timeout', error_message = 'processing exceeded 1 hour'
       WHERE status IN ('processing', 'uploading')
         AND started_at < NOW() - INTERVAL '1 hour'
       RETURNING file_id, original_key, extract(epoch from started_at)::text AS started_epoch`,
    );

    const ids = stuckRes.rows.map((r) => r.file_id);
    if (ids.length === 0) {
      return { stuckFileIds: [], outboxRows: [] as OutboxRecord[] };
    }

    await client.query(
      `UPDATE outbox
       SET status = 'failed',
           last_error = 'superseded by timeout',
           lease_token = NULL,
           locked_at = NULL,
           updated_at = NOW()
       WHERE file_id = ANY($1) AND status = 'pending'`,
      [ids],
    );

    const createdOutbox: OutboxRecord[] = [];
    if (topicArn) {
      const failedAt = new Date().toISOString();
      for (const row of stuckRes.rows) {
        const eventId = crypto.randomUUID();
        const leaseToken = crypto.randomUUID();
        const dedupKey = `file_failed:${row.file_id}:${row.started_epoch}`;
        const payload: FileNotificationPayload = {
          eventId,
          eventType: 'FILE_FAILED',
          status: 'failed',
          fileId: row.file_id,
          errorMessage: 'processing exceeded 1 hour',
          failedAt,
          s3Key: row.original_key,
        };
        const outboxRes = await client.query<OutboxRecord>(
          `INSERT INTO outbox (event_id, file_id, event_type, dedup_key, payload, status, lease_token, locked_at)
           VALUES ($1, $2, 'FILE_FAILED', $3, $4::jsonb, 'pending', $5, NOW())
           ON CONFLICT (dedup_key) DO NOTHING
           RETURNING id, event_id, file_id, event_type, lease_token, payload`,
          [eventId, row.file_id, dedupKey, JSON.stringify(payload), leaseToken],
        );
        if (outboxRes.rows[0]) {
          createdOutbox.push(outboxRes.rows[0]);
        }
      }
    }

    return { stuckFileIds: ids, outboxRows: createdOutbox };
  });

  let failedNotificationsPublished = 0;
  if (topicArn) {
    for (const outboxRow of outboxRows) {
      const ok = await bestEffortFencedPublish(outboxRow, topicArn);
      if (ok) failedNotificationsPublished += 1;
    }
  }

  logger.info('MAINTENANCE_DETECT_STUCK', {
    task: 'detect_stuck',
    stuckCount: stuckFileIds.length,
    stuckJobs: stuckFileIds,
    failedNotificationsPublished,
  });

  return {
    stuckCount: stuckFileIds.length,
    stuckFileIds,
    failedNotificationsPublished,
  };
}

/**
 * Recovery Task B: claim up to 20 pending outbox rows (> 5 min old, unlocked or lease > 10 min)
 * using FOR UPDATE SKIP LOCKED + lease_token fencing, then publish via SNS outside the DB TX.
 * Preserves original event_id so downstream consumers remain idempotent.
 */
export async function runOutboxRetry(): Promise<{
  retriedCount: number;
  successCount: number;
  failedCount: number;
}> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    logger.info('MAINTENANCE_OUTBOX_RETRY_SKIPPED', { reason: 'SNS_TOPIC_ARN not set' });
    return { retriedCount: 0, successCount: 0, failedCount: 0 };
  }

  const claimed = await withTransaction(async (client) => {
    const res = await client.query<OutboxRecord>(
      `WITH claimed AS (
         SELECT id FROM outbox
         WHERE status = 'pending'
           AND created_at < NOW() - INTERVAL '5 minutes'
           AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '10 minutes')
         ORDER BY created_at ASC
         LIMIT 20
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
       SET locked_at = NOW(), lease_token = gen_random_uuid(), updated_at = NOW()
       FROM claimed
       WHERE o.id = claimed.id
       RETURNING o.id, o.event_id, o.file_id, o.event_type, o.lease_token, o.payload`,
    );
    return res.rows;
  });

  let successCount = 0;
  let failedCount = 0;

  for (const record of claimed) {
    const ok = await bestEffortFencedPublish(record, topicArn);
    if (ok) {
      successCount += 1;
    } else {
      failedCount += 1;
    }
  }

  logger.info('MAINTENANCE_OUTBOX_RETRY', {
    task: 'outbox_retry',
    retriedCount: claimed.length,
    successCount,
    failedCount,
  });

  return {
    retriedCount: claimed.length,
    successCount,
    failedCount,
  };
}

/**
 * EventBridge Scheduler & manual maintenance handler.
 */
export const handler = async (
  event: MaintenanceEvent = {},
  context: Context,
): Promise<MaintenanceResult> => {
  const mode: 'daily' | 'recovery' | 'all' =
    event.mode === 'daily' || event.mode === 'recovery' ? event.mode : 'all';

  logger.info('MAINTENANCE_STARTED', {
    awsRequestId: context.awsRequestId,
    mode,
    source: event.source ?? 'scheduler',
  });

  const result: MaintenanceResult = { mode };

  if (mode === 'daily' || mode === 'all') {
    result.cleanupAudit = await runCleanupAudit(event.auditBatchSize);
  }

  if (mode === 'recovery' || mode === 'all') {
    result.detectStuck = await runDetectStuck();
    result.outboxRetry = await runOutboxRetry();
  }

  return result;
};
