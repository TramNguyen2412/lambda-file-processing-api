import crypto from 'node:crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { logger } from '../lib/logger';
import { jsonResponse } from '../lib/response';
import { createPresignedPutUrl } from '../lib/s3';

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PRESIGNED_EXPIRES_SECONDS = 300;

/**
 * POST /upload-to-s3
 * Creates a pending file_jobs record in PostgreSQL and returns a presigned S3 PUT URL
 * so clients can upload files > 4.5 MiB directly to S3 input/{fileId}/original.xlsx.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    logger.error('MISSING_S3_BUCKET_ENV', { awsRequestId: context.awsRequestId });
    return jsonResponse(500, { error: 'Server configuration error: S3_BUCKET is not set' });
  }

  let contentType = XLSX_CONTENT_TYPE;
  if (event.body) {
    try {
      const parsed = JSON.parse(
        event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body,
      ) as { contentType?: string };
      if (parsed.contentType && typeof parsed.contentType === 'string') {
        contentType = parsed.contentType;
      }
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON request body' });
    }
  }

  const fileId = crypto.randomUUID();
  const originalKey = `input/${fileId}/original.xlsx`;

  try {
    const pool = await getDbPool();
    await pool.query(
      `INSERT INTO file_jobs (file_id, original_key, status)
       VALUES ($1, $2, 'pending')`,
      [fileId, originalKey],
    );

    const uploadUrl = await createPresignedPutUrl(
      bucket,
      originalKey,
      contentType,
      PRESIGNED_EXPIRES_SECONDS,
    );

    logger.info('PRESIGNED_URL_CREATED', {
      awsRequestId: context.awsRequestId,
      fileId,
      bucket,
      originalKey,
    });

    return jsonResponse(200, {
      fileId,
      bucket,
      originalKey,
      uploadUrl,
      expiresIn: PRESIGNED_EXPIRES_SECONDS,
      contentType,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('UPLOAD_TO_S3_FAILED', {
      awsRequestId: context.awsRequestId,
      fileId,
      error: message,
    });
    return jsonResponse(500, { error: 'Failed to initialize S3 upload', details: message });
  }
};
