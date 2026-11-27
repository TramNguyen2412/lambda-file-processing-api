import { Context, S3Event } from 'aws-lambda';
import { processExcelFile } from '../lib/excelProcessor';
import { logger } from '../lib/logger';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract fileId from an S3 object key of the form input/{fileId}/...
 */
export function extractFileIdFromKey(key: string): string | null {
  const parts = key.split('/');
  if (parts.length < 3 || parts[0] !== 'input') {
    return null;
  }
  const candidate = parts[1];
  return UUID_REGEX.test(candidate) ? candidate : null;
}

/**
 * S3 ObjectCreated event handler (prefix input/, suffix .xlsx).
 * Processes uploaded Excel files asynchronously and persists rows to PostgreSQL.
 */
export const handler = async (event: S3Event, context: Context): Promise<void> => {
  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Defensive guard against recursive triggers (in addition to S3 Notification FilterRule)
    if (!key.startsWith('input/') || !key.toLowerCase().endsWith('.xlsx')) {
      logger.warn('S3_EVENT_IGNORED_KEY', {
        awsRequestId: context.awsRequestId,
        bucket,
        key,
        reason: 'Key does not match input/*.xlsx',
      });
      continue;
    }

    const fileId = extractFileIdFromKey(key);
    if (!fileId) {
      logger.warn('S3_EVENT_INVALID_FILE_ID', {
        awsRequestId: context.awsRequestId,
        bucket,
        key,
        reason: 'Expected key format input/{uuid}/filename.xlsx',
      });
      continue;
    }

    await processExcelFile({
      bucket,
      originalKey: key,
      fileId,
      mode: 's3',
    });
  }
};
