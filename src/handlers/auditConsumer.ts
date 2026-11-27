import { Context, SQSEvent } from 'aws-lambda';
import { withTransaction } from '../lib/db';
import { logger } from '../lib/logger';
import { FileNotificationPayload } from '../lib/sns';

function unwrapSnsPayload(recordBody: string): FileNotificationPayload {
  const parsed = JSON.parse(recordBody) as { Message?: string } & Partial<FileNotificationPayload>;
  if (typeof parsed.Message === 'string') {
    return JSON.parse(parsed.Message) as FileNotificationPayload;
  }
  return parsed as FileNotificationPayload;
}

/**
 * SQS consumer for lambda-file-api-audit-queue.
 * Receives both FILE_PROCESSED and FILE_FAILED events via SNS Filter Policy,
 * deduplicates per (consumer_name, event_id), and inserts into audit_logs.
 */
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
  for (const record of event.Records ?? []) {
    const payload = unwrapSnsPayload(record.body);
    const { eventId, fileId, status, rowCount, errorMessage, s3Key } = payload;

    if (!eventId || !fileId) {
      logger.warn('AUDIT_CONSUMER_MALFORMED_EVENT', {
        awsRequestId: context.awsRequestId,
        messageId: record.messageId,
      });
      continue;
    }

    const eventType = status === 'failed' ? 'FILE_FAILED' : 'FILE_PROCESSED';
    const message =
      eventType === 'FILE_FAILED'
        ? `File processing failed (${s3Key}): ${errorMessage ?? 'unknown error'}`
        : `File processed successfully (${s3Key}), rows=${rowCount ?? 0}`;

    const inserted = await withTransaction(async (client) => {
      const dedup = await client.query<{ event_id: string }>(
        `INSERT INTO consumer_processed_events (consumer_name, event_id, file_id)
         VALUES ('audit-consumer', $1, $2)
         ON CONFLICT (consumer_name, event_id) DO NOTHING
         RETURNING event_id`,
        [eventId, fileId],
      );

      if ((dedup.rowCount ?? dedup.rows.length) === 0) {
        return false;
      }

      await client.query(
        `INSERT INTO audit_logs (event_type, file_id, message)
         VALUES ($1, $2, $3)`,
        [eventType, fileId, message],
      );
      return true;
    });

    if (!inserted) {
      logger.info('AUDIT_CONSUMER_DUPLICATE_SKIPPED', {
        awsRequestId: context.awsRequestId,
        eventId,
        fileId,
      });
    } else {
      logger.info('AUDIT_LOG_RECORDED', {
        awsRequestId: context.awsRequestId,
        eventId,
        eventType,
        fileId,
      });
    }
  }
};
