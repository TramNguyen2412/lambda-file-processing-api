import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { parseExcel } from '../utils/excelParser';
import { extractFileBuffer } from '../utils/multipartParser';

/**
 * Maximum file size (in bytes) this handler will attempt to parse into memory.
 * Files larger than this return HTTP 413 immediately without calling ExcelJS.
 * This prevents high heap allocation that could crash Lambda on low memory configs.
 */
const MAX_PARSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * POST /upload-excel
 * Accepts an Excel file (.xlsx) or binary test payload via:
 *   1. Raw binary: curl -X POST <url> -H "Content-Type: application/octet-stream" --data-binary @file.xlsx
 *   2. Multipart form: curl -F "file=@file.xlsx" <url>
 *
 * Payload flow:
 *   Client ──(raw file)──► API Gateway HTTP API (10 MB limit)
 *                           └── Base64 encodes body into event JSON
 *                           └── Passes event to Lambda (6 MB event limit)
 *                                └── uploadExcel handler decodes Base64
 *                                └── Extracts file buffer (strips multipart if present)
 *                                └── Parses Excel workbook or returns diagnostic JSON
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const startTime = Date.now();

  // --- 1. Validate body presence ---
  if (!event.body) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Request body is empty.',
        hint: 'Send a file as raw binary (--data-binary @file.xlsx) or form-data (-F "file=@file.xlsx")',
      }),
    };
  }

  // --- 2. Decode body ---
  // API Gateway HTTP API v2 sets isBase64Encoded = true for binary payloads
  const rawBuffer = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'latin1');

  // --- 3. Extract file buffer (handles both raw binary and multipart/form-data) ---
  const contentType =
    event.headers?.['content-type'] ||
    event.headers?.['Content-Type'] ||
    'application/octet-stream';

  const buffer = extractFileBuffer(rawBuffer, contentType);

  // --- 4. Memory guard: check size before parsing ---
  if (buffer.byteLength > MAX_PARSE_BYTES) {
    return {
      statusCode: 413,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'File exceeds maximum parse limit (5 MB).',
        receivedBytes: buffer.byteLength,
        receivedMB:    Math.round((buffer.byteLength / 1024 / 1024) * 1000) / 1000,
        maxAllowedMB:  MAX_PARSE_BYTES / 1024 / 1024,
        note: 'Payload successfully traversed API Gateway and Lambda synchronous invocation boundary before handler rejected it.',
      }),
    };
  }

  // --- 5. Validate XLSX signature and parse ---
  // Standard XLSX files are ZIP archives starting with magic bytes PK\x03\x04 (0x50, 0x4B, 0x03, 0x04)
  const isZipMagic =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4B &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;

  if (!isZipMagic) {
    return {
      statusCode: 422,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'Uploaded file is not a valid Excel (.xlsx) file (missing ZIP/PK header).',
        payloadMetrics: {
          receivedBytes:   buffer.byteLength,
          receivedMB:      Math.round((buffer.byteLength / 1024 / 1024) * 1000) / 1000,
          isBase64Encoded: event.isBase64Encoded,
          contentType,
        },
        boundaryStatus: {
          apiGatewayPassed: true,
          lambdaSyncPassed: true,
          message: 'Payload successfully reached Lambda handler through API Gateway.',
        },
      }),
    };
  }

  try {
    const parseResult = await parseExcel(buffer);
    const elapsedMs   = Date.now() - startTime;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        file: {
          receivedBytes:   buffer.byteLength,
          receivedMB:      Math.round((buffer.byteLength / 1024 / 1024) * 1000) / 1000,
          isBase64Encoded: event.isBase64Encoded,
          contentType,
        },
        excel: parseResult,
        performance: {
          parseElapsedMs:  elapsedMs,
          lambdaMemoryMB:  context.memoryLimitInMB,
          remainingTimeMS: context.getRemainingTimeInMillis(),
        },
      }),
    };
  } catch (err: unknown) {
    return {
      statusCode: 422,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'Failed to parse Excel workbook contents.',
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
