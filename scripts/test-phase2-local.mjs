#!/usr/bin/env node
/**
 * scripts/test-phase2-local.mjs
 * Local end-to-end verification for Phase 2 (no AWS or external RDS required).
 * Tests compiled handlers & shared libs in dist/ using an in-memory transactional
 * PostgreSQL simulator and in-memory S3 store.
 *
 * Run: npm run test:phase2
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', 'dist');

const { generateExcel } = require(`${distDir}/utils/excelGenerator`);
const { parseAllExcelRows } = require(`${distDir}/utils/excelParser`);
const { setDbPoolForTest } = require(`${distDir}/lib/db`);
const { setS3StorageForTest } = require(`${distDir}/lib/s3`);
const { processExcelFile } = require(`${distDir}/lib/excelProcessor`);
const { handler: uploadToS3Handler } = require(`${distDir}/handlers/uploadToS3`);
const { handler: s3ProcessorHandler } = require(`${distDir}/handlers/s3Processor`);
const { handler: fileQueryHandler } = require(`${distDir}/handlers/fileQuery`);

// ---------------------------------------------------------------------------
// In-memory transactional PostgreSQL mock
// ---------------------------------------------------------------------------
function createInMemoryDb() {
  let state = {
    file_jobs: new Map(),
    file_records: new Map(), // key: `${file_id}:${row_index}`
  };

  function cloneState(s) {
    return {
      file_jobs: new Map(Array.from(s.file_jobs.entries(), ([k, v]) => [k, { ...v }])),
      file_records: new Map(Array.from(s.file_records.entries(), ([k, v]) => [k, { ...v }])),
    };
  }

  function execSql(targetState, sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('INSERT INTO file_jobs')) {
      const [fileId, originalKey] = params;
      if (normalized.includes('ON CONFLICT (file_id) DO NOTHING')) {
        if (!targetState.file_jobs.has(fileId)) {
          targetState.file_jobs.set(fileId, {
            file_id: fileId,
            original_key: originalKey,
            processed_key: null,
            status: 'pending',
            notification_status: 'not_required',
            row_count: null,
            error_message: null,
            created_at: new Date().toISOString(),
            started_at: null,
            finished_at: null,
            processed_at: null,
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      targetState.file_jobs.set(fileId, {
        file_id: fileId,
        original_key: originalKey,
        processed_key: null,
        status: 'pending',
        notification_status: 'not_required',
        row_count: null,
        error_message: null,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        processed_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE file_jobs SET status = 'processing'")) {
      const [fileId] = params;
      const job = targetState.file_jobs.get(fileId);
      if (job && job.status === 'pending') {
        job.status = 'processing';
        job.started_at = new Date().toISOString();
        job.error_message = null;
        return { rows: [{ file_id: fileId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE file_jobs SET status = 'failed'")) {
      const [fileId, errorMessage] = params;
      const job = targetState.file_jobs.get(fileId);
      if (job) {
        job.status = 'failed';
        job.error_message = errorMessage;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE file_jobs SET status = 'pending'")) {
      const [fileId, errorMessage] = params;
      const job = targetState.file_jobs.get(fileId);
      if (job && (job.status === 'processing' || job.status === 'uploading')) {
        job.status = 'pending';
        job.started_at = null;
        job.error_message = errorMessage;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE file_jobs SET status = 'uploading'")) {
      const [fileId, rowCount] = params;
      const job = targetState.file_jobs.get(fileId);
      if (job) {
        job.status = 'uploading';
        job.row_count = rowCount;
        job.finished_at = new Date().toISOString();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE file_jobs SET status = 'processed'")) {
      const [fileId, processedKey] = params;
      const job = targetState.file_jobs.get(fileId);
      if (job) {
        job.status = 'processed';
        job.processed_key = processedKey;
        job.processed_at = new Date().toISOString();
        job.notification_status = 'not_required';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('INSERT INTO file_records')) {
      let inserted = 0;
      for (let i = 0; i < params.length; i += 3) {
        const fileId = params[i];
        const rowIndex = params[i + 1];
        const data = JSON.parse(params[i + 2]);
        const key = `${fileId}:${rowIndex}`;
        if (!targetState.file_records.has(key)) {
          targetState.file_records.set(key, { file_id: fileId, row_index: rowIndex, data });
          inserted++;
        }
      }
      return { rows: [], rowCount: inserted };
    }

    if (normalized.includes('FROM file_jobs WHERE file_id = $1')) {
      const [fileId] = params;
      const job = targetState.file_jobs.get(fileId);
      return { rows: job ? [{ ...job }] : [], rowCount: job ? 1 : 0 };
    }

    if (normalized.includes('FROM file_records WHERE file_id = $1')) {
      const [fileId, limit, offset] = params;
      const all = Array.from(targetState.file_records.values())
        .filter((r) => r.file_id === fileId)
        .sort((a, b) => a.row_index - b.row_index);
      const sliced = all.slice(offset, offset + limit).map((r) => ({
        row_index: r.row_index,
        data: r.data,
      }));
      return { rows: sliced, rowCount: sliced.length };
    }

    throw new Error(`Unsupported SQL in mock DB: ${normalized}`);
  }

  return {
    state,
    async query(sql, params) {
      return execSql(state, sql, params);
    },
    async connect() {
      let txState = null;
      return {
        async query(sql, params) {
          const cmd = sql.trim().toUpperCase();
          if (cmd === 'BEGIN') {
            txState = cloneState(state);
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'COMMIT') {
            if (txState) {
              state.file_jobs = txState.file_jobs;
              state.file_records = txState.file_records;
              txState = null;
            }
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'ROLLBACK') {
            txState = null;
            return { rows: [], rowCount: 0 };
          }
          return execSql(txState ?? state, sql, params);
        },
        release() {
          txState = null;
        },
      };
    },
  };
}

function createInMemoryS3() {
  const objects = new Map();
  return {
    objects,
    async createPresignedPutUrl(bucket, key) {
      return `https://${bucket}.s3.amazonaws.com/${key}?X-Amz-Signature=mock`;
    },
    async getObjectBuffer(bucket, key) {
      const fullKey = `${bucket}/${key}`;
      if (!objects.has(fullKey)) {
        const err = new Error(`The specified key does not exist: ${key}`);
        err.name = 'NoSuchKey';
        err.Code = 'NoSuchKey';
        throw err;
      }
      return objects.get(fullKey);
    },
    async putObjectBuffer(bucket, key, body) {
      objects.set(`${bucket}/${key}`, body);
    },
  };
}

const dummyContext = {
  awsRequestId: 'local-test-req-id',
  functionName: 'local-test',
  functionVersion: '$LATEST',
  memoryLimitInMB: '512',
  getRemainingTimeInMillis: () => 30000,
};

async function run() {
  console.log('======================================================');
  console.log('PHASE 2 LOCAL TEST SUITE (S3 Event + PostgreSQL)');
  console.log('======================================================\n');

  process.env.S3_BUCKET = 'lambda-file-api-data-test';
  const db = createInMemoryDb();
  const s3 = createInMemoryS3();
  setDbPoolForTest(db);
  setS3StorageForTest(s3);

  const sample = await generateExcel(50);

  // 1. POST /upload-to-s3 + Normal S3 Event flow (Option A)
  console.log('1. Testing POST /upload-to-s3 + Normal S3 Event flow (50 rows)...');
  const uploadRes = await uploadToS3Handler({ body: null, isBase64Encoded: false }, dummyContext);
  assert.equal(uploadRes.statusCode, 200);
  const uploadBody = JSON.parse(uploadRes.body);
  assert.ok(uploadBody.fileId);
  assert.ok(uploadBody.uploadUrl.includes(`input/${uploadBody.fileId}/original.xlsx`));
  assert.equal(db.state.file_jobs.get(uploadBody.fileId).status, 'pending');

  // Simulate client PUT to S3 + S3 ObjectCreated event
  await s3.putObjectBuffer(uploadBody.bucket, uploadBody.originalKey, sample.buffer);
  await s3ProcessorHandler(
    {
      Records: [
        { s3: { bucket: { name: uploadBody.bucket }, object: { key: uploadBody.originalKey } } },
      ],
    },
    dummyContext,
  );

  const jobA = db.state.file_jobs.get(uploadBody.fileId);
  assert.equal(jobA.status, 'processed');
  assert.equal(jobA.row_count, 50);
  assert.equal(jobA.processed_key, `processed/${uploadBody.fileId}/result.xlsx`);
  assert.ok(jobA.finished_at && jobA.processed_at);
  assert.ok(s3.objects.has(`${uploadBody.bucket}/${jobA.processed_key}`));
  const parsedResult = await parseAllExcelRows(s3.objects.get(`${uploadBody.bucket}/${jobA.processed_key}`));
  assert.equal(parsedResult.sheetName, 'Summary');
  console.log('   PASSED\n');

  // 2. Option B: Direct S3 CLI upload (no prior file_jobs row)
  console.log('2. Testing Option B direct S3 upload (auto-create file_jobs)...');
  const fileIdB = crypto.randomUUID();
  const keyB = `input/${fileIdB}/original.xlsx`;
  await s3.putObjectBuffer(process.env.S3_BUCKET, keyB, sample.buffer);
  await s3ProcessorHandler(
    { Records: [{ s3: { bucket: { name: process.env.S3_BUCKET }, object: { key: keyB } } }] },
    dummyContext,
  );
  assert.equal(db.state.file_jobs.get(fileIdB).status, 'processed');
  assert.equal(db.state.file_jobs.get(fileIdB).row_count, 50);
  console.log('   PASSED\n');

  // 3. Idempotency: Concurrent duplicate S3 events
  console.log('3. Testing concurrent duplicate S3 events (atomic claim)...');
  const fileIdDup = crypto.randomUUID();
  const keyDup = `input/${fileIdDup}/original.xlsx`;
  await s3.putObjectBuffer(process.env.S3_BUCKET, keyDup, sample.buffer);
  const [res1, res2] = await Promise.all([
    processExcelFile({ bucket: process.env.S3_BUCKET, originalKey: keyDup, fileId: fileIdDup }),
    processExcelFile({ bucket: process.env.S3_BUCKET, originalKey: keyDup, fileId: fileIdDup }),
  ]);
  const claimedCount = [res1.claimed, res2.claimed].filter(Boolean).length;
  assert.equal(claimedCount, 1, 'Exactly one concurrent invocation may claim the job');
  const dupRows = Array.from(db.state.file_records.values()).filter((r) => r.file_id === fileIdDup);
  assert.equal(dupRows.length, 50, 'Must have 50 rows, never 100');
  console.log('   PASSED\n');

  // 4. Transaction rollback on DB failure
  console.log('4. Testing PostgreSQL transaction rollback on mid-flight DB error...');
  const fileIdRb = crypto.randomUUID();
  const keyRb = `input/${fileIdRb}/original.xlsx`;
  await s3.putObjectBuffer(process.env.S3_BUCKET, keyRb, sample.buffer);
  await assert.rejects(
    () =>
      processExcelFile({
        bucket: process.env.S3_BUCKET,
        originalKey: keyRb,
        fileId: fileIdRb,
        onBeforeStep: (step) => {
          if (step === 'db') {
            throw new Error('Simulated DB connection failure');
          }
        },
      }),
    /Simulated DB connection failure/,
  );
  const rbRows = Array.from(db.state.file_records.values()).filter((r) => r.file_id === fileIdRb);
  assert.equal(rbRows.length, 0, 'ROLLBACK must leave 0 orphaned file_records');
  assert.equal(db.state.file_jobs.get(fileIdRb).status, 'pending', 'Transient DB failure resets s3 job to pending');
  console.log('   PASSED\n');

  // 5. Terminal errors: Corrupted Excel & NoSuchKey
  console.log('5. Testing terminal failures (corrupted XLSX & NoSuchKey)...');
  const fileIdBad = crypto.randomUUID();
  const keyBad = `input/${fileIdBad}/original.xlsx`;
  await s3.putObjectBuffer(process.env.S3_BUCKET, keyBad, Buffer.from('not-a-valid-xlsx'));
  const badRes = await processExcelFile({ bucket: process.env.S3_BUCKET, originalKey: keyBad, fileId: fileIdBad });
  assert.equal(badRes.finalStatus, 'failed');
  assert.equal(db.state.file_jobs.get(fileIdBad).status, 'failed');

  const fileIdMissing = crypto.randomUUID();
  const missingRes = await processExcelFile({
    bucket: process.env.S3_BUCKET,
    originalKey: `input/${fileIdMissing}/original.xlsx`,
    fileId: fileIdMissing,
  });
  assert.equal(missingRes.finalStatus, 'failed');
  assert.equal(db.state.file_jobs.get(fileIdMissing).status, 'failed');
  console.log('   PASSED\n');

  // 6. Infinite loop prevention (processed/ key ignored)
  console.log('6. Testing infinite loop guard (processed/ prefix ignored)...');
  const jobsBefore = db.state.file_jobs.size;
  await s3ProcessorHandler(
    {
      Records: [
        { s3: { bucket: { name: process.env.S3_BUCKET }, object: { key: `processed/${uploadBody.fileId}/result.xlsx` } } },
        { s3: { bucket: { name: process.env.S3_BUCKET }, object: { key: `input/${crypto.randomUUID()}/notes.txt` } } },
      ],
    },
    dummyContext,
  );
  assert.equal(db.state.file_jobs.size, jobsBefore, 'processed/ and non-.xlsx keys must be ignored');
  console.log('   PASSED\n');

  // 7. GET /file/:id and GET /file/:id/rows
  console.log('7. Testing GET /file/:id and GET /file/:id/rows (pagination, 404, 400)...');
  const qJob = await fileQueryHandler(
    { routeKey: 'GET /file/{id}', rawPath: `/file/${uploadBody.fileId}`, pathParameters: { id: uploadBody.fileId } },
    dummyContext,
  );
  assert.equal(qJob.statusCode, 200);
  assert.equal(JSON.parse(qJob.body).status, 'processed');

  const qRows = await fileQueryHandler(
    {
      routeKey: 'GET /file/{id}/rows',
      rawPath: `/file/${uploadBody.fileId}/rows`,
      pathParameters: { id: uploadBody.fileId },
      queryStringParameters: { limit: '10', offset: '5' },
    },
    dummyContext,
  );
  assert.equal(qRows.statusCode, 200);
  const qRowsBody = JSON.parse(qRows.body);
  assert.equal(qRowsBody.returnedCount, 10);
  assert.equal(qRowsBody.rows[0].rowIndex, 6);

  const q404 = await fileQueryHandler(
    { routeKey: 'GET /file/{id}', rawPath: `/file/${crypto.randomUUID()}`, pathParameters: { id: crypto.randomUUID() } },
    dummyContext,
  );
  assert.equal(q404.statusCode, 404);

  const q400 = await fileQueryHandler(
    { routeKey: 'GET /file/{id}', rawPath: '/file/not-a-uuid', pathParameters: { id: 'not-a-uuid' } },
    dummyContext,
  );
  assert.equal(q400.statusCode, 400);
  console.log('   PASSED\n');

  // 8. Phase 3 compatibility: alreadyClaimed=true & throwOnTerminalError=true
  console.log('8. Testing Phase 3 compatibility (alreadyClaimed & throwOnTerminalError)...');
  const fileIdP3 = crypto.randomUUID();
  const keyP3 = `input/${fileIdP3}/original.xlsx`;
  await s3.putObjectBuffer(process.env.S3_BUCKET, keyP3, sample.buffer);
  await db.query("INSERT INTO file_jobs (file_id, original_key, status) VALUES ($1, $2, 'pending')", [fileIdP3, keyP3]);
  await db.query("UPDATE file_jobs SET status = 'processing', started_at = NOW(), error_message = NULL WHERE file_id = $1 AND status = 'pending' RETURNING file_id", [fileIdP3]);
  const p3Res = await processExcelFile({
    bucket: process.env.S3_BUCKET,
    originalKey: keyP3,
    fileId: fileIdP3,
    mode: 'sqs',
    alreadyClaimed: true,
    throwOnTerminalError: true,
  });
  assert.equal(p3Res.finalStatus, 'processed');
  assert.equal(db.state.file_jobs.get(fileIdP3).status, 'processed');
  console.log('   PASSED\n');

  console.log('ALL PHASE 2 LOCAL TESTS PASSED (8/8)!');
}

run().catch((err) => {
  console.error('\nPHASE 2 TEST FAILED:', err);
  process.exit(1);
});
