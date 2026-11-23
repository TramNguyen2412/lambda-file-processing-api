import 'aws-lambda';
import { generateExcel } from '../utils/excelGenerator';

const DEFAULT_ROWS = 10_000;
const MAX_ROWS     = 500_000;

// Maximum size for synthetic streaming test (Lambda Function URL response hard quota is 200 MB)
const MAX_SYNTHETIC_MB = 195;
const DEFAULT_CHUNK_KB = 64;

/**
 * Lambda Function URL – RESPONSE_STREAM handler
 *
 * This handler is deployed with InvokeMode = RESPONSE_STREAM.
 * It supports TWO operational modes:
 *
 * 1. Excel Generation Mode (Default or when ?rows=N is supplied):
 *    Generates an Excel workbook with N rows and writes it to the response stream.
 *    Example: GET <url>?rows=50000
 *
 * 2. Synthetic Chunked Streaming Mode (When ?mode=synthetic or ?sizeMB=N is supplied):
 *    Streams synthetic data chunk-by-chunk in a loop with O(1) memory consumption.
 *    Does NOT hold the response payload in RAM.
 *    Allows benchmarking:
 *      - Payloads from 1 MB up to 195 MB (testing near the 200 MB quota).
 *      - Time-to-first-byte (TTFB).
 *      - Inter-chunk delay (?delayMs=10) and network throughput.
 *    Example: GET <url>?mode=synthetic&sizeMB=50&chunkKB=64&format=csv
 */
export const handler = awslambda.streamifyResponse(
  async (
    event: AWSLambda.APIGatewayProxyEventV2,
    responseStream: awslambda.HttpResponseStream,
    context: AWSLambda.Context,
  ): Promise<void> => {
    const qs = event.queryStringParameters ?? {};
    const startTime = Date.now();

    const isSyntheticMode =
      qs['mode']?.toLowerCase() === 'synthetic' ||
      qs['sizeMB'] !== undefined;

    // =========================================================================
    // MODE 2: Synthetic Chunked Streaming (Constant RAM, up to 195 MB)
    // =========================================================================
    if (isSyntheticMode) {
      const rawSizeMB = parseFloat(qs['sizeMB'] ?? '10');
      const sizeMB    = isNaN(rawSizeMB) ? 10 : Math.min(Math.max(rawSizeMB, 0.1), MAX_SYNTHETIC_MB);

      const rawChunkKB = parseInt(qs['chunkKB'] ?? String(DEFAULT_CHUNK_KB), 10);
      const chunkKB    = isNaN(rawChunkKB) ? DEFAULT_CHUNK_KB : Math.min(Math.max(rawChunkKB, 4), 1024);

      const rawDelay = parseInt(qs['delayMs'] ?? '0', 10);
      const delayMs  = isNaN(rawDelay) ? 0 : Math.min(Math.max(rawDelay, 0), 500);

      const format = qs['format']?.toLowerCase() === 'csv' ? 'csv' : 'binary';
      const filename = `synthetic_stream_${sizeMB}MB_${Date.now()}.${format === 'csv' ? 'csv' : 'bin'}`;

      const targetBytes = Math.round(sizeMB * 1024 * 1024);
      const chunkBytes  = chunkKB * 1024;

      // Attach HTTP headers before streaming any bytes
      const metadataStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          'Content-Type':        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Stream-Mode':       'synthetic-chunked',
          'X-Target-Size-MB':    sizeMB.toFixed(2),
          'X-Chunk-Size-KB':     String(chunkKB),
          'X-Lambda-Memory-MB':  String(context.memoryLimitInMB),
        },
      });

      // Prepare a single reusable chunk buffer in memory (O(1) memory overhead)
      const chunkBuffer = Buffer.alloc(chunkBytes);
      if (format === 'csv') {
        const line = '1,2024-01-01,Synthetic_Stream_Record,Benchmark,100,99.99,9999.00,OK\n';
        const lineBuf = Buffer.from(line);
        let offset = 0;
        while (offset < chunkBytes) {
          const copied = lineBuf.copy(chunkBuffer, offset);
          offset += copied;
        }
      } else {
        // Pseudo-random byte pattern
        for (let i = 0; i < chunkBytes; i++) {
          chunkBuffer[i] = (i * 31 + 17) & 0xff;
        }
      }

      let bytesStreamed = 0;
      let chunkCount    = 0;
      let ttfbMs        = 0;

      while (bytesStreamed < targetBytes) {
        const remaining = targetBytes - bytesStreamed;
        const currentChunkSize = Math.min(chunkBytes, remaining);
        const toWrite = currentChunkSize === chunkBytes
          ? chunkBuffer
          : chunkBuffer.subarray(0, currentChunkSize);

        metadataStream.write(toWrite);

        if (chunkCount === 0) {
          ttfbMs = Date.now() - startTime;
        }

        bytesStreamed += currentChunkSize;
        chunkCount++;

        if (delayMs > 0 && bytesStreamed < targetBytes) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }

      metadataStream.end();
      const totalElapsedMs = Date.now() - startTime;
      const throughputMBs = totalElapsedMs > 0
        ? Math.round(((bytesStreamed / 1024 / 1024) / (totalElapsedMs / 1000)) * 100) / 100
        : 0;

      console.log(JSON.stringify({
        event:               'synthetic_stream_completed',
        sizeMB,
        totalBytesStreamed:  bytesStreamed,
        chunkCount,
        chunkKB,
        delayMs,
        ttfbMs,
        totalElapsedMs,
        throughputMBs,
        lambdaMemoryMB:      context.memoryLimitInMB,
        remainingTimeMS:     context.getRemainingTimeInMillis(),
      }));
      return;
    }

    // =========================================================================
    // MODE 1: Excel Generation Mode (Default)
    // =========================================================================
    const rawRows = parseInt(qs['rows'] ?? String(DEFAULT_ROWS), 10);
    const rows    = Math.min(isNaN(rawRows) || rawRows < 1 ? DEFAULT_ROWS : rawRows, MAX_ROWS);

    const result   = await generateExcel(rows);
    const filename = `stream_report_${rows}rows_${Date.now()}.xlsx`;

    console.log(JSON.stringify({
      event:          'generate_excel_stream',
      rows,
      fileSizeMB:     result.fileSizeMB,
      fileSizeBytes:  result.fileSizeBytes,
      generateMs:     result.elapsedMs,
      lambdaMemoryMB: context.memoryLimitInMB,
      remainingTimeMS: context.getRemainingTimeInMillis(),
    }));

    const metadataStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Stream-Mode':       'excel-buffer',
        'X-Row-Count':         String(rows),
        'X-File-Size-MB':      String(result.fileSizeMB),
        'X-File-Size-Bytes':   String(result.fileSizeBytes),
        'X-Generate-MS':       String(result.elapsedMs),
        'X-Lambda-Memory-MB':  String(context.memoryLimitInMB),
      },
    });

    metadataStream.write(result.buffer);
    metadataStream.end();
  },
);
