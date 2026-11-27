import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { withTransaction } from './db';
import { logger } from './logger';

export interface SnsPublisherLike {
  publish(topicArn: string, message: string, statusAttribute: 'processed' | 'failed'): Promise<{ messageId?: string }>;
}

export interface FileNotificationPayload {
  eventId: string;
  eventType: 'FILE_PROCESSED' | 'FILE_FAILED';
  status: 'processed' | 'failed';
  fileId: string;
  s3Key: string;
  rowCount?: number;
  processedAt?: string;
  errorMessage?: string;
  failedAt?: string;
}

export interface OutboxRecord {
  id: number;
  event_id: string;
  file_id: string;
  event_type: 'FILE_PROCESSED' | 'FILE_FAILED';
  lease_token: string;
  payload: FileNotificationPayload;
}

let snsClient: SNSClient | null = null;
let overridePublisher: SnsPublisherLike | null = null;

function getClient(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: process.env.AWS_REGION });
  }
  return snsClient;
}

/**
 * Override SNS publisher for local testing without AWS.
 */
export function setSnsPublisherForTest(publisher: SnsPublisherLike | null): void {
  overridePublisher = publisher;
}

export async function publishSnsMessage(
  topicArn: string,
  message: string,
  statusAttribute: 'processed' | 'failed',
): Promise<{ messageId?: string }> {
  if (overridePublisher) {
    return overridePublisher.publish(topicArn, message, statusAttribute);
  }
  const res = await getClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: message,
      MessageAttributes: {
        status: {
          DataType: 'String',
          StringValue: statusAttribute,
        },
      },
    }),
  );
  return { messageId: res.MessageId };
}

/**
 * Best-effort fenced SNS publish outside any DB transaction.
 * Uses lease_token fencing so a stale worker never overwrites a newer worker's state.
 * Never throws on SNS failure (Phase 5 outbox recovery handles retries).
 */
export async function bestEffortFencedPublish(
  outboxRow: OutboxRecord,
  topicArn: string,
): Promise<boolean> {
  const statusAttr: 'processed' | 'failed' =
    outboxRow.event_type === 'FILE_FAILED' ? 'failed' : 'processed';

  try {
    await publishSnsMessage(topicArn, JSON.stringify(outboxRow.payload), statusAttr);

    await withTransaction(async (client) => {
      const updated = await client.query<{ id: number }>(
        `UPDATE outbox
         SET status = 'published',
             published_at = NOW(),
             lease_token = NULL,
             locked_at = NULL,
             updated_at = NOW()
         WHERE id = $1 AND lease_token = $2
         RETURNING id`,
        [outboxRow.id, outboxRow.lease_token],
      );
      if ((updated.rowCount ?? updated.rows.length) === 0) {
        logger.warn('OUTBOX_LEASE_LOST_ON_PUBLISH', {
          outboxId: outboxRow.id,
          fileId: outboxRow.file_id,
        });
        return;
      }
      if (outboxRow.event_type === 'FILE_PROCESSED') {
        await client.query(
          `UPDATE file_jobs SET notification_status = 'published' WHERE file_id = $1`,
          [outboxRow.file_id],
        );
      }
    });

    logger.info('SNS_OUTBOX_PUBLISHED', {
      outboxId: outboxRow.id,
      eventId: outboxRow.event_id,
      eventType: outboxRow.event_type,
      fileId: outboxRow.file_id,
    });
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('SNS_OUTBOX_PUBLISH_FAILED', {
      outboxId: outboxRow.id,
      eventId: outboxRow.event_id,
      eventType: outboxRow.event_type,
      fileId: outboxRow.file_id,
      error: errMsg,
    });

    try {
      await withTransaction(async (client) => {
        const res = await client.query<{ status: string }>(
          `UPDATE outbox
           SET attempts = attempts + 1,
               last_error = $3,
               lease_token = NULL,
               locked_at = NULL,
               updated_at = NOW(),
               status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END
           WHERE id = $1 AND lease_token = $2
           RETURNING status`,
          [outboxRow.id, outboxRow.lease_token, errMsg.slice(0, 2000)],
        );
        if (
          (res.rowCount ?? res.rows.length) > 0 &&
          res.rows[0].status === 'failed' &&
          outboxRow.event_type === 'FILE_PROCESSED'
        ) {
          await client.query(
            `UPDATE file_jobs SET notification_status = 'failed' WHERE file_id = $1`,
            [outboxRow.file_id],
          );
        }
      });
    } catch (dbErr) {
      logger.error('OUTBOX_FAILURE_RECORD_ERROR', {
        outboxId: outboxRow.id,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    return false;
  }
}
