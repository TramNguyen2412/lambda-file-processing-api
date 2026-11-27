import { Context } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { logger } from '../lib/logger';

export interface DbInitEvent {
  sql?: string;
}

/**
 * One-shot VPC helper handler to apply DDL (sql/schema.sql) to private RDS PostgreSQL.
 */
export const handler = async (event: DbInitEvent, context: Context) => {
  if (!event.sql || typeof event.sql !== 'string') {
    throw new Error('Missing event.sql string');
  }

  const pool = await getDbPool();
  await pool.query(event.sql);

  logger.info('DB_SCHEMA_APPLIED', {
    awsRequestId: context.awsRequestId,
    sqlLength: event.sql.length,
  });

  return { ok: true, sqlLength: event.sql.length };
};
