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
 * SQS consumer for lambda-file-api-summary-queue.
 * Receives only FILE_PROCESSED events via SNS Filter Policy,
 * deduplicates per (consumer_name, event_id), and atomically increments daily_summaries.
 */
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
  for (const record of event.Records ?? []) {
    const payload = unwrapSnsPayload(record.body);
    const { eventId, fileId, status, rowCount } = payload;

    if (!eventId || !fileId) {
      logger.warn('SUMMARY_CONSUMER_MALFORMED_EVENT', {
        awsRequestId: context.awsRequestId,
        messageId: record.messageId,
      });
      continue;
    }

    // Defensive check alongside SNS Filter Policy ({ "status": ["processed"] })
    if (status !== 'processed') {
      logger.info('SUMMARY_CONSUMER_NON_PROCESSED_SKIPPED', {
        awsRequestId: context.awsRequestId,
        eventId,
        fileId,
        status,
      });
      continue;
    }

    const rowsToAdd = typeof rowCount === 'number' && Number.isFinite(rowCount) ? rowCount : 0;

    const updated = await withTransaction(async (client) => {
      const dedup = await client.query<{ event_id: string }>(
        `INSERT INTO consumer_processed_events (consumer_name, event_id, file_id)
         VALUES ('summary-consumer', $1, $2)
         ON CONFLICT (consumer_name, event_id) DO NOTHING
         RETURNING event_id`,
        [eventId, fileId],
      );

      if ((dedup.rowCount ?? dedup.rows.length) === 0) {
        return false;
      }

      await client.query(
        `INSERT INTO daily_summaries (summary_date, processing_runs, total_rows)
         VALUES (CURRENT_DATE, 1, $1)
         ON CONFLICT (summary_date) DO UPDATE
         SET processing_runs = daily_summaries.processing_runs + 1,
             total_rows = daily_summaries.total_rows + EXCLUDED.total_rows,
             updated_at = NOW()`,
        [rowsToAdd],
      );
      return true;
    });

    if (!updated) {
      logger.info('SUMMARY_CONSUMER_DUPLICATE_SKIPPED', {
        awsRequestId: context.awsRequestId,
        eventId,
        fileId,
      });
    } else {
      logger.info('DAILY_SUMMARY_UPDATED', {
        awsRequestId: context.awsRequestId,
        eventId,
        fileId,
        rowsToAdd,
      });
    }
  }
};
