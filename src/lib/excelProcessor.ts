import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { getDbPool, withTransaction } from './db';
import { logger } from './logger';
import { getObjectBuffer, putObjectBuffer } from './s3';
import { bestEffortFencedPublish, FileNotificationPayload, OutboxRecord } from './sns';
import { FullParseResult, parseAllExcelRows } from '../utils/excelParser';

export interface ProcessExcelInput {
  bucket: string;
  originalKey: string;
  fileId: string;
  /** 's3' resets to 'pending' on transient errors; 'sqs' (Phase 3) lets job-consumer manage retry state */
  mode?: 's3' | 'sqs';
  /** Stable identifier for the current processing run (used for outbox dedup_key) */
  runId?: string;
  /** Set true when caller (e.g. Phase 3 job-consumer) already claimed file_jobs row as 'processing' */
  alreadyClaimed?: boolean;
  /** Set true when caller (e.g. Phase 3 job-consumer) handles terminal failure persistence & SQS ack/DLQ */
  throwOnTerminalError?: boolean;
  /** Optional test hook to inject a failure at a specific pipeline step */
  onBeforeStep?: (step: 'download' | 'parse' | 'db' | 'upload' | 'finalize') => Promise<void> | void;
}

export interface ProcessExcelOutput {
  claimed: boolean;
  fileId: string;
  rowCount: number;
  processedKey?: string;
  snsPublished: boolean;
  finalStatus: 'processed' | 'failed' | 'skipped';
  errorMessage?: string;
}

const BATCH_SIZE = 500;
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function isTerminalS3Error(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NoSuchKey' ||
    e.Code === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

/**
 * Classify whether an error from Excel processing is terminal (cannot recover via retry)
 * vs transient (e.g., network/DB/S3 503). Reused by Phase 3 job-consumer.
 */
export function isTerminalProcessingError(err: unknown): boolean {
  if (isTerminalS3Error(err)) return true;
  if (err instanceof Error) {
    const msg = err.message;
    if (
      msg.includes('Invalid Excel file') ||
      msg.includes('không có worksheet') ||
      msg.includes('không có header row') ||
      msg.includes('End of data reached') ||
      msg.includes('invalid signature') ||
      msg.includes('Corrupted zip')
    ) {
      return true;
    }
  }
  return false;
}

async function markTerminalFailed(
  fileId: string,
  originalKey: string,
  runId: string,
  errorMessage: string,
): Promise<void> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  const trimmed = errorMessage.slice(0, 2000);

  if (!topicArn) {
    const pool = await getDbPool();
    await pool.query(
      `UPDATE file_jobs
       SET status = 'failed', error_message = $2
       WHERE file_id = $1`,
      [fileId, trimmed],
    );
    return;
  }

  const eventId = crypto.randomUUID();
  const leaseToken = crypto.randomUUID();
  const payload: FileNotificationPayload = {
    eventId,
    eventType: 'FILE_FAILED',
    status: 'failed',
    fileId,
    errorMessage: trimmed,
    failedAt: new Date().toISOString(),
    s3Key: originalKey,
  };
  const dedupKey = `file_failed:${fileId}:${runId}`;

  const outboxRow = await withTransaction(async (client) => {
    await client.query(
      `UPDATE file_jobs
       SET status = 'failed', error_message = $2
       WHERE file_id = $1`,
      [fileId, trimmed],
    );
    const res = await client.query<OutboxRecord>(
      `INSERT INTO outbox (event_id, file_id, event_type, dedup_key, payload, status, lease_token, locked_at)
       VALUES ($1, $2, 'FILE_FAILED', $3, $4::jsonb, 'pending', $5, NOW())
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id, event_id, file_id, event_type, lease_token, payload`,
      [eventId, fileId, dedupKey, JSON.stringify(payload), leaseToken],
    );
    return res.rows[0] ?? null;
  });

  if (outboxRow) {
    await bestEffortFencedPublish(outboxRow, topicArn);
  }
}

async function resetTransientPending(fileId: string, errorMessage: string): Promise<void> {
  try {
    const pool = await getDbPool();
    await pool.query(
      `UPDATE file_jobs
       SET status = 'pending', started_at = NULL, error_message = $2
       WHERE file_id = $1 AND status IN ('processing', 'uploading')`,
      [fileId, errorMessage.slice(0, 2000)],
    );
  } catch (resetErr) {
    logger.error('RESET_PENDING_FAILED', {
      fileId,
      error: resetErr instanceof Error ? resetErr.message : String(resetErr),
    });
  }
}

async function buildProcessedWorkbook(
  fileId: string,
  parsed: FullParseResult,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'lambda-file-api-s3-processor';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Summary');
  summary.addRow(['fileId', fileId]);
  summary.addRow(['sourceSheet', parsed.sheetName]);
  summary.addRow(['rowCount', parsed.rowCount]);
  summary.addRow(['columnCount', parsed.columnCount]);
  summary.addRow(['processedAt', new Date().toISOString()]);

  const dataSheet = workbook.addWorksheet('ProcessedRows');
  dataSheet.columns = parsed.headers.map((h) => ({ header: h, key: h, width: 18 }));
  for (const row of parsed.rows) {
    dataSheet.addRow(row.data);
  }

  const raw = await workbook.xlsx.writeBuffer();
  return Buffer.from(raw);
}

/**
 * Shared Excel processing pipeline (reused by Phase 2 s3Processor and Phase 3 jobConsumer).
 * Implements atomic claim, S3 download, Excel parse, transactional DB insert,
 * S3 result upload, and final status update.
 */
export async function processExcelFile(input: ProcessExcelInput): Promise<ProcessExcelOutput> {
  const {
    bucket,
    originalKey,
    fileId,
    mode = 's3',
    runId,
    alreadyClaimed = false,
    throwOnTerminalError = false,
    onBeforeStep,
  } = input;
  const pool = await getDbPool();

  let effectiveRunId = runId;

  if (!alreadyClaimed) {
    // [1a] Ensure job row exists (supports direct S3 CLI uploads without POST /upload-to-s3)
    await pool.query(
      `INSERT INTO file_jobs (file_id, original_key, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (file_id) DO NOTHING`,
      [fileId, originalKey],
    );

    // [1b] Atomic claim: only one concurrent invocation can transition pending -> processing
    const claimResult = await pool.query<{ file_id: string; started_at: string }>(
      `UPDATE file_jobs
       SET status = 'processing', started_at = NOW(), error_message = NULL
       WHERE file_id = $1 AND status = 'pending'
       RETURNING file_id, started_at::text`,
      [fileId],
    );

    if ((claimResult.rowCount ?? claimResult.rows.length) === 0) {
      logger.info('JOB_CLAIM_SKIPPED', { fileId, originalKey, reason: 'already_claimed_or_processed' });
      return {
        claimed: false,
        fileId,
        rowCount: 0,
        snsPublished: false,
        finalStatus: 'skipped',
      };
    }

    effectiveRunId = effectiveRunId ?? claimResult.rows[0]?.started_at;
  }

  effectiveRunId = effectiveRunId ?? crypto.randomUUID();

  logger.info('JOB_CLAIMED', { fileId, bucket, originalKey, alreadyClaimed });

  // [2] Download from S3
  let fileBuffer: Buffer;
  try {
    await onBeforeStep?.('download');
    fileBuffer = await getObjectBuffer(bucket, originalKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isTerminalS3Error(err)) {
      logger.warn('S3_DOWNLOAD_TERMINAL_ERROR', { fileId, originalKey, error: msg });
      if (throwOnTerminalError) throw err;
      await markTerminalFailed(fileId, originalKey, effectiveRunId, msg);
      return {
        claimed: true,
        fileId,
        rowCount: 0,
        snsPublished: false,
        finalStatus: 'failed',
        errorMessage: msg,
      };
    }
    logger.error('S3_DOWNLOAD_TRANSIENT_ERROR', { fileId, originalKey, error: msg });
    if (mode === 's3') {
      await resetTransientPending(fileId, msg);
    }
    throw err;
  }

  // [3] Parse Excel (terminal on malformed/invalid file)
  let parsed: FullParseResult;
  let resultBuffer: Buffer;
  try {
    await onBeforeStep?.('parse');
    parsed = await parseAllExcelRows(fileBuffer);
    resultBuffer = await buildProcessedWorkbook(fileId, parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('EXCEL_PARSE_TERMINAL_ERROR', { fileId, originalKey, error: msg });
    if (throwOnTerminalError) throw err;
    await markTerminalFailed(fileId, originalKey, effectiveRunId, msg);
    return {
      claimed: true,
      fileId,
      rowCount: 0,
      snsPublished: false,
      finalStatus: 'failed',
      errorMessage: msg,
    };
  }

  // [4] Transactional DB persistence (file_records + status='uploading')
  try {
    await withTransaction(async (client) => {
      for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
        const batch = parsed.rows.slice(i, i + BATCH_SIZE);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        batch.forEach((row, idx) => {
          const base = idx * 3;
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`);
          values.push(fileId, row.rowIndex, JSON.stringify(row.data));
        });

        await client.query(
          `INSERT INTO file_records (file_id, row_index, data)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (file_id, row_index) DO NOTHING`,
          values,
        );
      }

      await onBeforeStep?.('db');

      await client.query(
        `UPDATE file_jobs
         SET status = 'uploading', row_count = $2, finished_at = NOW()
         WHERE file_id = $1`,
        [fileId, parsed.rowCount],
      );
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('DB_TRANSACTION_ERROR', { fileId, error: msg });
    if (mode === 's3') {
      await resetTransientPending(fileId, msg);
    }
    throw err;
  }

  // [5] Upload processed result to S3 processed/{fileId}/result.xlsx (idempotent PutObject)
  const processedKey = `processed/${fileId}/result.xlsx`;
  try {
    await onBeforeStep?.('upload');
    await putObjectBuffer(bucket, processedKey, resultBuffer, XLSX_CONTENT_TYPE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('S3_UPLOAD_RESULT_ERROR', { fileId, processedKey, error: msg });
    if (mode === 's3') {
      await resetTransientPending(fileId, msg);
    }
    throw err;
  }

  // [6] Finalize file_jobs status='processed' (+ transactional outbox if SNS_TOPIC_ARN is set)
  await onBeforeStep?.('finalize');
  const topicArn = process.env.SNS_TOPIC_ARN;

  if (!topicArn) {
    await pool.query(
      `UPDATE file_jobs
       SET status = 'processed',
           processed_key = $2,
           processed_at = NOW(),
           notification_status = 'not_required'
       WHERE file_id = $1`,
      [fileId, processedKey],
    );

    logger.info('JOB_PROCESSED', {
      fileId,
      rowCount: parsed.rowCount,
      processedKey,
    });

    return {
      claimed: true,
      fileId,
      rowCount: parsed.rowCount,
      processedKey,
      snsPublished: false,
      finalStatus: 'processed',
    };
  }

  const eventId = crypto.randomUUID();
  const leaseToken = crypto.randomUUID();
  const processedAt = new Date().toISOString();
  const payload: FileNotificationPayload = {
    eventId,
    eventType: 'FILE_PROCESSED',
    status: 'processed',
    fileId,
    rowCount: parsed.rowCount,
    processedAt,
    s3Key: processedKey,
  };
  const dedupKey = `file_processed:${fileId}:${effectiveRunId}`;

  const outboxRow = await withTransaction(async (client) => {
    const outboxRes = await client.query<OutboxRecord>(
      `INSERT INTO outbox (event_id, file_id, event_type, dedup_key, payload, status, lease_token, locked_at)
       VALUES ($1, $2, 'FILE_PROCESSED', $3, $4::jsonb, 'pending', $5, NOW())
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id, event_id, file_id, event_type, lease_token, payload`,
      [eventId, fileId, dedupKey, JSON.stringify(payload), leaseToken],
    );
    await client.query(
      `UPDATE file_jobs
       SET status = 'processed',
           processed_key = $2,
           processed_at = NOW(),
           notification_status = 'pending'
       WHERE file_id = $1`,
      [fileId, processedKey],
    );
    return outboxRes.rows[0] ?? null;
  });

  // [7] Publish SNS outside DB transaction (best-effort; never throws on SNS failure)
  let snsPublished = false;
  if (outboxRow) {
    snsPublished = await bestEffortFencedPublish(outboxRow, topicArn);
  }

  logger.info('JOB_PROCESSED', {
    fileId,
    rowCount: parsed.rowCount,
    processedKey,
    snsPublished,
  });

  return {
    claimed: true,
    fileId,
    rowCount: parsed.rowCount,
    processedKey,
    snsPublished,
    finalStatus: 'processed',
  };
}
