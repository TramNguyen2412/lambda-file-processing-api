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
 *
 * Observability & Request Correlation:
 *   - API Gateway Access Logs record "$context.requestId".
 *   - This handler correlates with API Gateway by logging "apiGwRequestId" (event.requestContext.requestId)
 *     and "awsRequestId" (context.awsRequestId).
 *   - Aggregate CloudWatch Metrics for boundary verification:
 *       * Invocations: Count of requests that successfully traversed the 6 MB event boundary into Lambda.
 *       * Errors: Unhandled runtime errors (e.g. OOM crash).
 *       * Throttles: Concurrent execution limits exceeded.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const startTime = Date.now();
  const awsRequestId = context.awsRequestId;
  const apiGwRequestId = event.requestContext?.requestId || 'N/A';
  const hasBody = Boolean(event.body);
  const encodedBodyLength = event.body ? event.body.length : 0;
  const isBase64Encoded = Boolean(event.isBase64Encoded);
  const contentType =
    event.headers?.['content-type'] ||
    event.headers?.['Content-Type'] ||
    'application/octet-stream';

  // --- Observability Layer B: Earliest structured handler entry log ---
  // If this log does not appear in CloudWatch for a given API Gateway request ID,
  // the request was rejected at an outer boundary (API Gateway edge proxy or Lambda service invoke)
  // before container handler execution began.
  console.log(JSON.stringify({
    diagnosticType: 'UPLOAD_HANDLER_ENTRY',
    awsRequestId,
    apiGwRequestId,
    isBase64Encoded,
    hasBody,
    encodedBodyLength,
    contentType,
    routeKey: event.routeKey || 'N/A',
    sourceIp: event.requestContext?.http?.sourceIp || 'N/A',
  }));

  // --- 1. Validate body presence ---
  if (!event.body) {
    console.warn(JSON.stringify({
      diagnosticType: 'UPLOAD_EMPTY_BODY',
      awsRequestId,
      apiGwRequestId,
    }));
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
  // API Gateway HTTP API v2 and Function URL set isBase64Encoded = true for binary payloads
  const rawBuffer = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'latin1');

  // --- 3. Extract file buffer (handles both raw binary and multipart/form-data) ---
  const buffer = extractFileBuffer(rawBuffer, contentType);

  // Diagnostic log: payload successfully decoded into RAM
  console.log(JSON.stringify({
    diagnosticType: 'UPLOAD_BODY_DECODED',
    awsRequestId,
    apiGwRequestId,
    rawDecodedBytes: rawBuffer.byteLength, //DL sau decode 
    extractedFileBytes: buffer.byteLength, //DL sau khi extract file 
    isMemoryGuardPassed: buffer.byteLength <= MAX_PARSE_BYTES, // co vuot qua memory guard
    reachesFileValidation: buffer.byteLength <= MAX_PARSE_BYTES,
  }));

  // --- 4. Memory guard: check size before parsing ---
  if (buffer.byteLength > MAX_PARSE_BYTES) {
    console.warn(JSON.stringify({
      diagnosticType: 'UPLOAD_MEMORY_GUARD_REJECTION',
      awsRequestId,
      apiGwRequestId,
      receivedBytes: buffer.byteLength,
      maxAllowedBytes: MAX_PARSE_BYTES,
    }));
    return {
      statusCode: 413,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'File exceeds maximum parse limit (5 MB).',
        receivedBytes: buffer.byteLength,
        receivedMB: Math.round((buffer.byteLength / 1024 / 1024) * 1000) / 1000,
        maxAllowedMB: MAX_PARSE_BYTES / 1024 / 1024,
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
    console.warn(JSON.stringify({
      diagnosticType: 'UPLOAD_FORMAT_VALIDATION_REJECTION',
      awsRequestId,
      apiGwRequestId,
      isZipMagic: false,
      receivedBytes: buffer.byteLength,
    }));
    return {
      statusCode: 422,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'Uploaded file is not a valid Excel (.xlsx) file (missing ZIP/PK header).',
        payloadMetrics: {
          receivedBytes: buffer.byteLength,
          receivedMB: Math.round((buffer.byteLength / 1024 / 1024) * 1000) / 1000,
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
    const elapsedMs = Date.now() - startTime;

    console.log(JSON.stringify({
      diagnosticType: 'UPLOAD_PARSE_SUCCESS',
      awsRequestId,
      apiGwRequestId,
      receivedBytes: buffer.byteLength,
      rowCount: parseResult.rowCount,
      columnCount: parseResult.columnCount,
      parseElapsedMs: elapsedMs,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        file: {
          receivedBytes: buffer.byteLength,
          receivedMB: Math.round((buffer.byteLength / 1024 / 1024) * 1000) / 1000,
          isBase64Encoded: event.isBase64Encoded,
          contentType,
        },
        excel: parseResult,
        performance: {
          parseElapsedMs: elapsedMs,
          lambdaMemoryMB: context.memoryLimitInMB,
          remainingTimeMS: context.getRemainingTimeInMillis(),
        },
      }),
    };
  } catch (err: unknown) {
    console.error(JSON.stringify({
      diagnosticType: 'UPLOAD_PARSE_ERROR',
      awsRequestId,
      apiGwRequestId,
      error: err instanceof Error ? err.message : String(err),
    }));
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
