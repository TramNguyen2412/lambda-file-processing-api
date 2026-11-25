import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { generateExcel } from '../utils/excelGenerator';

const DEFAULT_ROWS = 1_000;
const MAX_ROWS     = 100_000;

/**
 * GET /generate-excel?rows=N[&delay=S]
 * Generates an Excel file with N rows of fake data and returns it directly
 * in the HTTP response body as a Base64-encoded binary.
 *
 * Works via:
 *   - API Gateway HTTP API (buffered response, subject to 6 MB response limit)
 *   - Lambda Function URL BUFFERED (same 6 MB response limit)
 *
 * Optional parameter `delay` (seconds, 1-60): adds an artificial sleep before
 * generating the file. Used in EXP-4 (timeout testing) to reliably trigger
 * Lambda timeout without depending on row count.
 *
 * Response headers include X-* metadata so you can inspect them with curl -D.
 *
 * NOTE: If the generated buffer exceeds ~6 MB, the Lambda runtime will reject
 * the response and API Gateway will return HTTP 500/502. Use the
 * generateExcelStream handler (via Function URL RESPONSE_STREAM) for large files.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const qs = event.queryStringParameters ?? {};

  // --- Parse & validate rows ---
  const rawRows = parseInt(qs['rows'] ?? String(DEFAULT_ROWS), 10);
  if (isNaN(rawRows) || rawRows < 1) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `'rows' must be a positive integer. Received: ${qs['rows']}`,
      }),
    };
  }
  const rows = Math.min(rawRows, MAX_ROWS);

  // --- Optional delay for timeout experiment (EXP-4) ---
  const rawDelay = parseInt(qs['delay'] ?? '0', 10);
  const delay    = isNaN(rawDelay) ? 0 : Math.min(Math.max(rawDelay, 0), 60);
  if (delay > 0) {
    console.log(`[TEST] Sleeping ${delay}s to simulate heavy workload...`);
    await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
  }

  // --- Generate ---
  const result   = await generateExcel(rows);
  const filename = `report_${rows}rows_${Date.now()}.xlsx`;

  // Log to CloudWatch so we can observe real file sizes during experiments
  console.log(JSON.stringify({
    event:          'generate_excel',
    rows,
    delayS:         delay,
    fileSizeMB:     result.fileSizeMB,
    fileSizeBytes:  result.fileSizeBytes,
    generateMs:     result.elapsedMs,
    lambdaMemoryMB: context.memoryLimitInMB,
  }));

  return {
    statusCode: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Lambda-Request-Id': context.awsRequestId,
      'X-Row-Count':         String(rows),
      'X-File-Size-MB':      String(result.fileSizeMB),
      'X-File-Size-Bytes':   String(result.fileSizeBytes),
      'X-Generate-MS':       String(result.elapsedMs),
      'X-Lambda-Memory-MB':  String(context.memoryLimitInMB),
      'X-Remaining-Time-MS': String(context.getRemainingTimeInMillis()),
    },
    body:           result.buffer.toString('base64'),
    isBase64Encoded: true,
  };
};
