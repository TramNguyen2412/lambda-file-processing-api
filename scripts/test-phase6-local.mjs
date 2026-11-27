#!/usr/bin/env node
/**
 * scripts/test-phase6-local.mjs
 * Local end-to-end verification for Phase 6 (Lambda Layer + Execution Environment Cache):
 *   6A. Layer layout (pg-helper, logger, response-builder, pg) & versioned logger output
 *   6B. Container cache: cold start vs warm hit, TTL expiration & refresh,
 *       bounded LRU eviction, /rows bypass, concurrent container isolation,
 *       and pg-helper auth-error (28P01) pool reset.
 *
 * Run: npm run test:phase6
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const distDir = resolve(projectRoot, 'dist');
const layerModulesDir = resolve(projectRoot, 'layer', 'nodejs', 'node_modules');

const dummyCtx = {
  awsRequestId: 'phase6-local-req',
  functionName: 'lambda-file-api-file-query',
  functionVersion: '$LATEST',
  memoryLimitInMB: '256',
  getRemainingTimeInMillis: () => 30000,
};

async function run() {
  console.log('======================================================');
  console.log('PHASE 6 LOCAL TEST SUITE (Layer + Container Cache)');
  console.log('======================================================\n');

  // 1. Phase 6A: Verify Lambda Layer directory structure & module resolution
  console.log('1. Testing Phase 6A Lambda Layer layout and module resolution...');
  for (const pkg of ['pg', 'pg-helper', 'logger', 'response-builder']) {
    const pkgDir = resolve(layerModulesDir, pkg);
    assert.ok(existsSync(resolve(pkgDir, 'package.json')), `Missing ${pkg}/package.json in Layer`);
  }
  for (const pkg of ['pg-helper', 'logger', 'response-builder']) {
    const pkgDir = resolve(layerModulesDir, pkg);
    assert.ok(existsSync(resolve(pkgDir, 'index.js')), `Missing ${pkg}/index.js in Layer`);
    assert.ok(existsSync(resolve(pkgDir, 'index.d.ts')), `Missing ${pkg}/index.d.ts in Layer`);
  }

  const layerPgHelper = require(resolve(layerModulesDir, 'pg-helper'));
  const layerLogger = require(resolve(layerModulesDir, 'logger'));
  const layerResponse = require(resolve(layerModulesDir, 'response-builder'));
  assert.equal(typeof layerPgHelper.withTransaction, 'function');
  assert.equal(typeof layerLogger.logger.info, 'function');
  assert.equal(layerResponse.jsonResponse(200, { ok: true }).statusCode, 200);

  // Verify LAYER_VERSION=v2 changes structured log output
  process.env.LAYER_VERSION = 'v2';
  const loggerEntryPath = resolve(layerModulesDir, 'logger', 'index.js');
  delete require.cache[require.resolve(loggerEntryPath)];
  const layerLoggerV2 = require(loggerEntryPath);
  const origLog = console.log;
  let capturedLog = '';
  console.log = (line) => { capturedLog = line; };
  layerLoggerV2.logger.info('LAYER_V2_TEST');
  console.log = origLog;
  assert.equal(JSON.parse(capturedLog).layerVersion, 'v2');
  process.env.LAYER_VERSION = 'v1';
  console.log('   PASSED\n');

  // 2. Phase 6B: Cold start, warm cache hit, and /rows bypass
  console.log('2. Testing Phase 6B cold start vs warm hit & /rows bypass...');
  process.env.FILE_CACHE_TTL_MS = '50';
  process.env.FILE_CACHE_MAX_SIZE = '2';

  const { setDbPoolForTest, withTransaction } = require(`${distDir}/lib/db`);
  const fileQueryModulePath = `${distDir}/handlers/fileQuery.js`;
  delete require.cache[require.resolve(fileQueryModulePath)];
  const { handler: fileQueryHandler, resetContainerCacheForTest } = require(fileQueryModulePath);

  let dbQueryCount = 0;
  const jobs = new Map();
  const f1 = crypto.randomUUID();
  jobs.set(f1, {
    file_id: f1,
    original_key: `input/${f1}/orig.xlsx`,
    processed_key: `processed/${f1}/result.xlsx`,
    status: 'processed',
    notification_status: 'published',
    row_count: 10,
    error_message: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
  });

  setDbPoolForTest({
    async query(sql, params = []) {
      dbQueryCount += 1;
      if (sql.includes('FROM file_jobs')) {
        const job = jobs.get(params[0]);
        return { rows: job ? [{ ...job }] : [], rowCount: job ? 1 : 0 };
      }
      if (sql.includes('FROM file_records')) {
        return { rows: [{ row_index: 1, data: { id: 1 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query() { return { rows: [], rowCount: 0 }; },
        release() {},
      };
    },
  });

  resetContainerCacheForTest();

  // Request 1: Cold start -> database
  const r1 = JSON.parse((await fileQueryHandler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx)).body);
  assert.equal(r1.isColdStart, true);
  assert.equal(r1.invocationCount, 1);
  assert.equal(r1.source, 'database');
  assert.equal(dbQueryCount, 1);

  // Request 2: Warm hit -> container-cache (no DB query)
  const r2 = JSON.parse((await fileQueryHandler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx)).body);
  assert.equal(r2.isColdStart, false);
  assert.equal(r2.invocationCount, 2);
  assert.equal(r2.source, 'container-cache');
  assert.equal(r2.containerId, r1.containerId);
  assert.equal(dbQueryCount, 1, 'Warm cache hit must not query DB');

  // Request 3: /rows must bypass cache
  const rRows = JSON.parse((await fileQueryHandler({ routeKey: 'GET /file/{id}/rows', rawPath: `/file/${f1}/rows`, pathParameters: { id: f1 } }, dummyCtx)).body);
  assert.equal(rRows.source, 'database');
  assert.equal(dbQueryCount, 3, '/rows queries file_jobs + file_records directly');
  console.log('   PASSED\n');

  // 3. Stale read within TTL & refresh after TTL expiry
  console.log('3. Testing TTL expiration (stale within TTL, fresh after expiry)...');
  jobs.get(f1).status = 'failed';
  const rStale = JSON.parse((await fileQueryHandler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx)).body);
  assert.equal(rStale.source, 'container-cache');
  assert.equal(rStale.status, 'processed', 'Within TTL, container cache serves stale status');

  await new Promise((r) => setTimeout(r, 70));
  const rFresh = JSON.parse((await fileQueryHandler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx)).body);
  assert.equal(rFresh.source, 'database');
  assert.equal(rFresh.status, 'failed', 'After TTL expiry, fresh status is fetched from DB');
  console.log('   PASSED\n');

  // 4. Bounded LRU eviction (MAX_CACHE_SIZE=2)
  console.log('4. Testing bounded LRU cache eviction (MAX_CACHE_SIZE=2)...');
  process.env.FILE_CACHE_TTL_MS = '30000';
  delete require.cache[require.resolve(fileQueryModulePath)];
  const fqLru = require(fileQueryModulePath);
  fqLru.resetContainerCacheForTest();

  const f2 = crypto.randomUUID();
  const f3 = crypto.randomUUID();
  jobs.set(f2, { ...jobs.get(f1), file_id: f2, status: 'processed' });
  jobs.set(f3, { ...jobs.get(f1), file_id: f3, status: 'processed' });

  await fqLru.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx); // cache: [f1]
  await fqLru.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f2}`, pathParameters: { id: f2 } }, dummyCtx); // cache: [f1, f2]
  await fqLru.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx); // touch f1 -> [f2, f1]
  await fqLru.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f3}`, pathParameters: { id: f3 } }, dummyCtx); // evicts f2 -> [f1, f3]

  const stats = fqLru.getContainerCacheStats();
  assert.equal(stats.size, 2);
  const f1Check = JSON.parse((await fqLru.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx)).body);
  const f2Check = JSON.parse((await fqLru.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f2}`, pathParameters: { id: f2 } }, dummyCtx)).body);
  assert.equal(f1Check.source, 'container-cache', 'Recently used f1 must remain cached');
  assert.equal(f2Check.source, 'database', 'Least recently used f2 must be evicted');
  console.log('   PASSED\n');

  // 5. Execution environment isolation (2 separate module instances = 2 concurrent containers)
  console.log('5. Testing execution environment isolation across concurrent instances...');
  delete require.cache[require.resolve(fileQueryModulePath)];
  const containerA = require(fileQueryModulePath);
  const idA = containerA.getContainerCacheStats().containerId;
  const resA = JSON.parse((await containerA.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx)).body);

  delete require.cache[require.resolve(fileQueryModulePath)];
  const containerB = require(fileQueryModulePath);
  const idB = containerB.getContainerCacheStats().containerId;
  const resB = JSON.parse((await containerB.handler({ routeKey: 'GET /file/{id}', rawPath: `/file/${f1}`, pathParameters: { id: f1 } }, dummyCtx)).body);

  assert.notEqual(idA, idB, 'Separate containers must have distinct containerIds');
  assert.equal(resA.source, 'database');
  assert.equal(resB.source, 'database', 'Container B must experience cold miss even after Container A cached f1');
  console.log('   PASSED\n');

  // 6. Auth error (28P01) pool invalidation + CAS race protection + subsequent recovery
  console.log('6. Testing pg-helper auth error (28P01) pool invalidation & CAS protection...');
  const { resetDbPool, getDbPool } = require(`${distDir}/lib/db`);
  let endedOld = false;
  let endedNew = false;
  const oldPool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
          if (sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
          const err = new Error('password authentication failed');
          err.code = '28P01';
          throw err;
        },
        release() {},
      };
    },
    async end() { endedOld = true; },
  };
  setDbPoolForTest(oldPool);
  await assert.rejects(() => withTransaction((c) => c.query('SELECT 1')), /password authentication failed/);
  assert.equal(endedOld, true, 'Auth error 28P01 must reset and close stale pool');

  // Simulate new pool initialized with refreshed credentials; stale resetDbPool(oldPool) must NOT close newPool
  const newPool = {
    async query() { return { rows: [{ ok: 1 }], rowCount: 1 }; },
    async connect() { return { async query() { return { rows: [], rowCount: 0 }; }, release() {} }; },
    async end() { endedNew = true; },
  };
  setDbPoolForTest(newPool);
  await resetDbPool(oldPool);
  assert.equal(endedNew, false, 'Stale resetDbPool(oldPool) must not close newly initialized pool');
  const activePool = await getDbPool();
  const recoveryRes = await activePool.query('SELECT 1');
  assert.equal(recoveryRes.rows[0].ok, 1, 'Subsequent query succeeds on refreshed pool');
  console.log('   PASSED\n');

  console.log('ALL PHASE 6 LOCAL TESTS PASSED (6/6)!');
}

run().catch((err) => {
  console.error('\nPHASE 6 TEST FAILED:', err);
  process.exit(1);
});
