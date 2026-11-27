import crypto from 'node:crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { logger } from '../lib/logger';
import { jsonResponse } from '../lib/response';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CachedFileJob {
  fileId: string;
  originalKey: string;
  processedKey: string | null;
  status: string;
  notificationStatus: string;
  rowCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  processedAt: string | null;
}

// Module-level execution environment state (persists across warm invocations, NOT shared across instances)
const CONTAINER_ID = crypto.randomUUID().slice(0, 8);
const COLD_START_AT = new Date().toISOString();
const CACHE_TTL_MS = Number(process.env.FILE_CACHE_TTL_MS ?? '30000');
const MAX_CACHE_SIZE = Number(process.env.FILE_CACHE_MAX_SIZE ?? '500');

let invocationCount = 0;
let cacheHits = 0;
let cacheMisses = 0;

const fileJobCache = new Map<string, { data: CachedFileJob; expiresAt: number }>();

logger.info('CONTAINER_INIT', {
  handler: 'fileQuery',
  containerId: CONTAINER_ID,
  coldStartAt: COLD_START_AT,
  cacheTtlMs: CACHE_TTL_MS,
  maxCacheSize: MAX_CACHE_SIZE,
});

/**
 * Reset container-local cache & counters (for unit/integration tests simulating a fresh container).
 */
export function resetContainerCacheForTest(): void {
  fileJobCache.clear();
  invocationCount = 0;
  cacheHits = 0;
  cacheMisses = 0;
}

export function getContainerCacheStats() {
  return {
    containerId: CONTAINER_ID,
    coldStartAt: COLD_START_AT,
    invocationCount,
    size: fileJobCache.size,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

function getCached(fileId: string, now: number): CachedFileJob | null {
  const entry = fileJobCache.get(fileId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    fileJobCache.delete(fileId); // lazy TTL eviction
    return null;
  }
  // Refresh LRU order (delete + re-insert at tail)
  fileJobCache.delete(fileId);
  fileJobCache.set(fileId, entry);
  return entry.data;
}

function setCached(fileId: string, data: CachedFileJob, now: number): void {
  if (fileJobCache.size >= MAX_CACHE_SIZE) {
    for (const [k, v] of fileJobCache) {
      if (v.expiresAt <= now) fileJobCache.delete(k);
    }
    if (fileJobCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = fileJobCache.keys().next().value;
      if (oldestKey) {
        fileJobCache.delete(oldestKey);
        logger.info('FILE_QUERY_CACHE_LRU_EVICT', {
          containerId: CONTAINER_ID,
          evictedFileId: oldestKey,
        });
      }
    }
  }
  fileJobCache.set(fileId, { data, expiresAt: now + CACHE_TTL_MS });
}

function resolveFileId(event: APIGatewayProxyEventV2): string | null {
  const paramId = event.pathParameters?.id;
  if (paramId) return paramId;

  const match = event.rawPath?.match(/\/file\/([^/]+)(?:\/rows)?$/);
  return match ? match[1] : null;
}

function isRowsRoute(event: APIGatewayProxyEventV2): boolean {
  if (event.routeKey?.endsWith('/rows')) return true;
  return Boolean(event.rawPath?.endsWith('/rows'));
}

/**
 * GET /file/{id}       (uses bounded 30s container-local cache)
 * GET /file/{id}/rows  (always queries PostgreSQL directly)
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  invocationCount += 1;
  const isColdStart = invocationCount === 1;

  const fileId = resolveFileId(event);
  if (!fileId || !UUID_REGEX.test(fileId)) {
    return jsonResponse(400, {
      error: 'Invalid or missing fileId (expected UUID)',
      containerId: CONTAINER_ID,
      isColdStart,
      invocationCount,
    });
  }

  const rowsRoute = isRowsRoute(event);
  const now = Date.now();

  if (!rowsRoute) {
    const cached = getCached(fileId, now);
    if (cached) {
      cacheHits += 1;
      logger.info('FILE_QUERY_CACHE_HIT', {
        awsRequestId: context.awsRequestId,
        fileId,
        containerId: CONTAINER_ID,
        isColdStart,
        invocationCount,
      });
      return jsonResponse(200, {
        ...cached,
        source: 'container-cache',
        containerId: CONTAINER_ID,
        isColdStart,
        invocationCount,
        cacheStats: { size: fileJobCache.size, hits: cacheHits, misses: cacheMisses },
      });
    }
  }

  try {
    const pool = await getDbPool();
    const jobRes = await pool.query<{
      file_id: string;
      original_key: string;
      processed_key: string | null;
      status: string;
      notification_status: string;
      row_count: number | null;
      error_message: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
      processed_at: string | null;
    }>(
      `SELECT file_id, original_key, processed_key, status, notification_status,
              row_count, error_message, created_at, started_at, finished_at, processed_at
       FROM file_jobs
       WHERE file_id = $1`,
      [fileId],
    );

    if (jobRes.rows.length === 0) {
      return jsonResponse(404, {
        error: 'File job not found',
        fileId,
        containerId: CONTAINER_ID,
        isColdStart,
        invocationCount,
      });
    }

    const row = jobRes.rows[0];
    const job: CachedFileJob = {
      fileId: row.file_id,
      originalKey: row.original_key,
      processedKey: row.processed_key,
      status: row.status,
      notificationStatus: row.notification_status,
      rowCount: row.row_count,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      processedAt: row.processed_at,
    };

    if (!rowsRoute) {
      cacheMisses += 1;
      setCached(fileId, job, now);
      logger.info('FILE_QUERY_CACHE_MISS', {
        awsRequestId: context.awsRequestId,
        fileId,
        containerId: CONTAINER_ID,
        isColdStart,
        invocationCount,
      });
      return jsonResponse(200, {
        ...job,
        source: 'database',
        containerId: CONTAINER_ID,
        isColdStart,
        invocationCount,
        cacheStats: { size: fileJobCache.size, hits: cacheHits, misses: cacheMisses },
      });
    }

    const rawLimit = Number(event.queryStringParameters?.limit ?? '100');
    const rawOffset = Number(event.queryStringParameters?.offset ?? '0');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 100;
    const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

    const rowsRes = await pool.query<{ row_index: number; data: Record<string, unknown> }>(
      `SELECT row_index, data
       FROM file_records
       WHERE file_id = $1
       ORDER BY row_index ASC
       LIMIT $2 OFFSET $3`,
      [fileId, limit, offset],
    );

    return jsonResponse(200, {
      fileId: job.fileId,
      status: job.status,
      rowCount: job.rowCount ?? rowsRes.rows.length,
      limit,
      offset,
      returnedCount: rowsRes.rows.length,
      source: 'database',
      containerId: CONTAINER_ID,
      isColdStart,
      invocationCount,
      rows: rowsRes.rows.map((r) => ({
        rowIndex: r.row_index,
        data: r.data,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('FILE_QUERY_FAILED', {
      awsRequestId: context.awsRequestId,
      fileId,
      containerId: CONTAINER_ID,
      error: message,
    });
    return jsonResponse(500, { error: 'Failed to query file job', details: message });
  }
};
