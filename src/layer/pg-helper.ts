import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

export interface DbPoolLike {
  connect(): Promise<PoolClientLike>;
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  end?(): Promise<void>;
}

export interface PoolClientLike {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  release(): void;
}

interface DbSecretPayload {
  host?: string;
  port?: number | string;
  dbname?: string;
  database?: string;
  username?: string;
  user?: string;
  password?: string;
}

const SECRET_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes per PLAN.md

let cachedPool: DbPoolLike | null = null;
let cachedConfigPromise: Promise<PoolConfig> | null = null;
let secretExpiresAt = 0;

/**
 * Override the DB pool (for local unit/integration tests without RDS).
 */
export function setDbPoolForTest(pool: DbPoolLike | null): void {
  cachedPool = pool;
  cachedConfigPromise = null;
  secretExpiresAt = pool ? Number.MAX_SAFE_INTEGER : 0;
}

/**
 * Invalidate cached Secrets Manager config & pool (e.g., on auth error 28P01/28000).
 * When expectedPool is provided, uses compare-and-swap so a stale failure on an old pool
 * cannot wipe out a newly initialized pool.
 */
export async function resetDbPool(expectedPool?: DbPoolLike): Promise<void> {
  if (expectedPool && cachedPool !== expectedPool) {
    return;
  }
  const oldPool = cachedPool;
  cachedPool = null;
  cachedConfigPromise = null;
  secretExpiresAt = 0;
  if (oldPool?.end) {
    try {
      await oldPool.end();
    } catch {
      // Ignore cleanup errors on stale pool
    }
  }
}

export function isPgAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === '28P01' || code === '28000';
}

async function resolvePoolConfig(): Promise<PoolConfig> {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? '5'),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }

  const secretId = process.env.DB_SECRET_ARN || process.env.DB_SECRET_NAME;
  if (secretId) {
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!res.SecretString) {
      throw new Error(`Secrets Manager secret ${secretId} has no SecretString`);
    }
    const secret = JSON.parse(res.SecretString) as DbSecretPayload;
    const host = secret.host ?? process.env.PGHOST;
    const database = secret.dbname ?? secret.database ?? process.env.PGDATABASE ?? 'fileapi';
    const user = secret.username ?? secret.user ?? process.env.PGUSER;
    const password = secret.password ?? process.env.PGPASSWORD;
    const port = Number(secret.port ?? process.env.PGPORT ?? '5432');

    if (!host || !user || !password) {
      throw new Error('Incomplete DB credentials in Secrets Manager secret');
    }

    secretExpiresAt = Date.now() + SECRET_CACHE_TTL_MS;

    return {
      host,
      port,
      database,
      user,
      password,
      max: Number(process.env.PG_POOL_MAX ?? '5'),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    };
  }

  if (process.env.PGHOST) {
    return {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? '5432'),
      database: process.env.PGDATABASE ?? 'fileapi',
      user: process.env.PGUSER ?? 'postgres',
      password: process.env.PGPASSWORD ?? '',
      max: Number(process.env.PG_POOL_MAX ?? '5'),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }

  throw new Error('Database configuration missing: set DB_SECRET_ARN, DATABASE_URL, or PGHOST');
}

/**
 * Return a container-scoped PostgreSQL connection pool.
 * Refreshes Secrets Manager credentials if the 10-minute TTL has expired.
 */
export async function getDbPool(): Promise<DbPoolLike> {
  if (cachedPool && (secretExpiresAt === 0 || Date.now() < secretExpiresAt)) {
    return cachedPool;
  }

  if (cachedPool && secretExpiresAt > 0 && Date.now() >= secretExpiresAt) {
    await resetDbPool();
  }

  if (!cachedConfigPromise) {
    cachedConfigPromise = resolvePoolConfig().catch((err) => {
      cachedConfigPromise = null;
      throw err;
    });
  }

  const config = await cachedConfigPromise;
  if (cachedPool) {
    return cachedPool;
  }
  const rawPool = new Pool(config) as unknown as DbPoolLike;
  const wrappedPool: DbPoolLike = {
    connect: () => rawPool.connect(),
    end: () => rawPool.end?.() ?? Promise.resolve(),
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      try {
        return await rawPool.query<R>(text, values);
      } catch (err) {
        if (isPgAuthError(err)) {
          await resetDbPool(wrappedPool);
        }
        throw err;
      }
    },
  };
  cachedPool = wrappedPool;
  return cachedPool;
}

/**
 * Execute a multi-statement PostgreSQL transaction on a single dedicated PoolClient.
 */
export async function withTransaction<T>(
  fn: (client: PoolClientLike) => Promise<T>,
): Promise<T> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve original error
    }
    if (isPgAuthError(err)) {
      await resetDbPool(pool);
    }
    throw err;
  } finally {
    client.release();
  }
}

export type { PoolClient };
