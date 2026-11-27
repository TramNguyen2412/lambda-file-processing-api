#!/usr/bin/env node
/**
 * scripts/test-phase3-local.mjs
 * Local end-to-end verification for Phase 3 (SQS + DLQ):
 *   1. POST /process-job status guards (404, 409, 202) & 503 compensating rollback
 *   2. End-to-end reprocess flow (failed -> POST /process-job -> jobConsumer -> processed)
 *   3. Duplicate SQS message idempotency (completed jobId skipped cleanly)
 *   4. Transient error retries (attempts 1..3 -> DLQ) + recovery after DLQ redrive
 *   5. Terminal error (corrupted XLSX) acknowledged cleanly without DLQ retry
 *
 * Run: npm run test:phase3
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
const { setDbPoolForTest } = require(`${distDir}/lib/db`);
const { setS3StorageForTest } = require(`${distDir}/lib/s3`);
const { setSqsSenderForTest } = require(`${distDir}/lib/sqs`);
const { handler: jobProducerHandler } = require(`${distDir}/handlers/jobProducer`);
const { handler: jobConsumerHandler } = require(`${distDir}/handlers/jobConsumer`);

function createPhase3MockDb() {
  const state = {
    file_jobs: new Map(),
    file_records: new Map(),
    processing_jobs: new Map(),
  };

  function cloneState(s) {
    return {
      file_jobs: new Map(Array.from(s.file_jobs.entries(), ([k, v]) => [k, { ...v }])),
      file_records: new Map(Array.from(s.file_records.entries(), ([k, v]) => [k, { ...v }])),
      processing_jobs: new Map(Array.from(s.processing_jobs.entries(), ([k, v]) => [k, { ...v }])),
    };
  }

  function execSql(target, sql, params = []) {
    const n = sql.replace(/\s+/g, ' ').trim();

    if (n.startsWith('INSERT INTO file_jobs')) {
      const [fileId, originalKey] = params;
      if (!target.file_jobs.has(fileId)) {
        target.file_jobs.set(fileId, {
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
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.includes("WHERE file_id = $1 AND status IN ('failed', 'timeout')")) {
      const [fileId] = params;
      const job = target.file_jobs.get(fileId);
      if (job && (job.status === 'failed' || job.status === 'timeout')) {
        job.status = 'pending';
        job.started_at = null;
        job.finished_at = null;
        job.processed_at = null;
        job.error_message = null;
        job.notification_status = 'not_required';
        return { rows: [{ file_id: job.file_id, original_key: job.original_key }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (n.includes("WHERE file_id = $1 AND status = 'pending'") && n.includes('SQS enqueue failed')) {
      const [fileId, errMsg] = params;
      const job = target.file_jobs.get(fileId);
      if (job && job.status === 'pending') {
        job.status = 'failed';
        job.error_message = errMsg;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (n.startsWith('INSERT INTO processing_jobs')) {
      const [jobId, fileId] = params;
      const existing = target.processing_jobs.get(jobId);
      if (!existing) {
        target.processing_jobs.set(jobId, {
          job_id: jobId,
          file_id: fileId,
          status: 'processing',
          attempts: 1,
          updated_at: Date.now(),
          completed_at: null,
        });
        return { rows: [{ job_id: jobId, attempts: 1 }], rowCount: 1 };
      }
      if (existing.status === 'failed' || (existing.status === 'processing' && existing.updated_at < Date.now() - 180_000)) {
        existing.status = 'processing';
        existing.attempts += 1;
        existing.updated_at = Date.now();
        return { rows: [{ job_id: jobId, attempts: existing.attempts }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (n.startsWith('SELECT status FROM processing_jobs WHERE job_id = $1')) {
      const [jobId] = params;
      const pj = target.processing_jobs.get(jobId);
      return { rows: pj ? [{ status: pj.status }] : [], rowCount: pj ? 1 : 0 };
    }

    if (n.startsWith("UPDATE processing_jobs SET status = 'completed'")) {
      const [jobId] = params;
      const pj = target.processing_jobs.get(jobId);
      if (pj) {
        pj.status = 'completed';
        pj.completed_at = new Date().toISOString();
      }
      return { rows: [], rowCount: pj ? 1 : 0 };
    }

    if (n.startsWith("UPDATE processing_jobs SET status = 'failed'")) {
      const [jobId] = params;
      const pj = target.processing_jobs.get(jobId);
      if (pj) pj.status = 'failed';
      return { rows: [], rowCount: pj ? 1 : 0 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'processing'")) {
      const [fileId] = params;
      const job = target.file_jobs.get(fileId);
      const isStale = job && (job.status === 'processing' || job.status === 'uploading') && job.started_at_ms && job.started_at_ms < Date.now() - 180_000;
      if (job && (['pending', 'failed', 'timeout'].includes(job.status) || isStale)) {
        job.status = 'processing';
        job.started_at = new Date().toISOString();
        job.started_at_ms = Date.now();
        job.error_message = null;
        return { rows: [{ file_id: fileId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (n.startsWith('SELECT status FROM file_jobs WHERE file_id = $1')) {
      const [fileId] = params;
      const job = target.file_jobs.get(fileId);
      return { rows: job ? [{ status: job.status }] : [], rowCount: job ? 1 : 0 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'failed'")) {
      const [fileId, errMsg] = params;
      const job = target.file_jobs.get(fileId);
      if (job && (!n.includes("status IN ('processing', 'uploading')") || ['processing', 'uploading'].includes(job.status))) {
        job.status = 'failed';
        job.error_message = errMsg;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'uploading'")) {
      const [fileId, rowCount] = params;
      const job = target.file_jobs.get(fileId);
      if (job) {
        job.status = 'uploading';
        job.row_count = rowCount;
        job.finished_at = new Date().toISOString();
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'processed'")) {
      const [fileId, processedKey] = params;
      const job = target.file_jobs.get(fileId);
      if (job) {
        job.status = 'processed';
        job.processed_key = processedKey;
        job.processed_at = new Date().toISOString();
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith('INSERT INTO file_records')) {
      for (let i = 0; i < params.length; i += 3) {
        const key = `${params[i]}:${params[i + 1]}`;
        if (!target.file_records.has(key)) {
          target.file_records.set(key, {
            file_id: params[i],
            row_index: params[i + 1],
            data: JSON.parse(params[i + 2]),
          });
        }
      }
      return { rows: [], rowCount: params.length / 3 };
    }

    throw new Error(`Unsupported SQL in Phase 3 mock DB: ${n}`);
  }

  return {
    state,
    async query(sql, params) {
      return execSql(state, sql, params);
    },
    async connect() {
      let tx = null;
      return {
        async query(sql, params) {
          const cmd = sql.trim().toUpperCase();
          if (cmd === 'BEGIN') {
            tx = cloneState(state);
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'COMMIT') {
            if (tx) {
              state.file_jobs = tx.file_jobs;
              state.file_records = tx.file_records;
              state.processing_jobs = tx.processing_jobs;
              tx = null;
            }
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'ROLLBACK') {
            tx = null;
            return { rows: [], rowCount: 0 };
          }
          return execSql(tx ?? state, sql, params);
        },
        release() {
          tx = null;
        },
      };
    },
  };
}

const dummyCtx = {
  awsRequestId: 'phase3-local-req',
  functionName: 'local-test',
  functionVersion: '$LATEST',
  memoryLimitInMB: '512',
  getRemainingTimeInMillis: () => 30000,
};

async function run() {
  console.log('======================================================');
  console.log('PHASE 3 LOCAL TEST SUITE (SQS + DLQ)');
  console.log('======================================================\n');

  process.env.S3_BUCKET = 'lambda-file-api-data-test';
  process.env.SQS_QUEUE_URL = 'https://sqs.ap-southeast-2.amazonaws.com/123456789012/lambda-file-api-jobs';

  const db = createPhase3MockDb();
  const s3Objects = new Map();
  let failS3DownloadTransient = false;
  let failSqsSend = false;
  const sentMessages = [];

  setDbPoolForTest(db);
  setS3StorageForTest({
    async createPresignedPutUrl(bucket, key) {
      return `https://${bucket}.s3.amazonaws.com/${key}`;
    },
    async getObjectBuffer(bucket, key) {
      if (failS3DownloadTransient) {
        throw new Error('S3 503 Service Unavailable (transient)');
      }
      const k = `${bucket}/${key}`;
      if (!s3Objects.has(k)) {
        const e = new Error(`NoSuchKey: ${key}`);
        e.name = 'NoSuchKey';
        throw e;
      }
      return s3Objects.get(k);
    },
    async putObjectBuffer(bucket, key, body) {
      s3Objects.set(`${bucket}/${key}`, body);
    },
  });
  setSqsSenderForTest({
    async sendMessage(queueUrl, body) {
      if (failSqsSend) throw new Error('SQS endpoint unreachable');
      sentMessages.push({ queueUrl, body });
      return { messageId: crypto.randomUUID() };
    },
  });

  const sample = await generateExcel(25);

  // 1. Producer guards: 404, 409, and 503 rollback
  console.log('1. Testing POST /process-job guards (404, 409, 503 rollback)...');
  const res404 = await jobProducerHandler(
    { body: JSON.stringify({ fileId: crypto.randomUUID() }), isBase64Encoded: false },
    dummyCtx,
  );
  assert.equal(res404.statusCode, 404);

  const pendingId = crypto.randomUUID();
  await db.query('INSERT INTO file_jobs (file_id, original_key) VALUES ($1, $2)', [
    pendingId,
    `input/${pendingId}/original.xlsx`,
  ]);
  const res409 = await jobProducerHandler(
    { body: JSON.stringify({ fileId: pendingId }), isBase64Encoded: false },
    dummyCtx,
  );
  assert.equal(res409.statusCode, 409);

  const failedId = crypto.randomUUID();
  const failedKey = `input/${failedId}/original.xlsx`;
  await db.query('INSERT INTO file_jobs (file_id, original_key) VALUES ($1, $2)', [failedId, failedKey]);
  db.state.file_jobs.get(failedId).status = 'failed';

  failSqsSend = true;
  const res503 = await jobProducerHandler(
    { body: JSON.stringify({ fileId: failedId }), isBase64Encoded: false },
    dummyCtx,
  );
  assert.equal(res503.statusCode, 503);
  assert.equal(db.state.file_jobs.get(failedId).status, 'failed', 'Compensating rollback must revert status to failed');
  failSqsSend = false;
  console.log('   PASSED\n');

  // 2. Normal reprocess flow + Duplicate SQS message idempotency
  console.log('2. Testing normal reprocess flow & duplicate SQS message idempotency...');
  s3Objects.set(`${process.env.S3_BUCKET}/${failedKey}`, sample.buffer);
  const res202 = await jobProducerHandler(
    { body: JSON.stringify({ fileId: failedId }), isBase64Encoded: false },
    dummyCtx,
  );
  assert.equal(res202.statusCode, 202);
  const { jobId } = JSON.parse(res202.body);
  assert.equal(sentMessages.length, 1);

  const sqsEvent = {
    Records: [
      {
        messageId: 'msg-1',
        body: sentMessages[0].body,
        attributes: { ApproximateReceiveCount: '1' },
      },
    ],
  };
  await jobConsumerHandler(sqsEvent, dummyCtx);
  assert.equal(db.state.file_jobs.get(failedId).status, 'processed');
  assert.equal(db.state.file_jobs.get(failedId).row_count, 25);
  assert.equal(db.state.processing_jobs.get(jobId).status, 'completed');

  // Deliver exact duplicate SQS message -> should skip cleanly
  await jobConsumerHandler(sqsEvent, dummyCtx);
  assert.equal(db.state.processing_jobs.get(jobId).attempts, 1, 'Completed jobId must not be re-executed');
  console.log('   PASSED\n');

  // 3. Transient error retries (1..3 -> DLQ) and DLQ redrive recovery
  console.log('3. Testing transient retry exhaustion (attempts 1..3) & DLQ redrive recovery...');
  const retryFileId = crypto.randomUUID();
  const retryKey = `input/${retryFileId}/original.xlsx`;
  await db.query('INSERT INTO file_jobs (file_id, original_key) VALUES ($1, $2)', [retryFileId, retryKey]);
  db.state.file_jobs.get(retryFileId).status = 'timeout';
  s3Objects.set(`${process.env.S3_BUCKET}/${retryKey}`, sample.buffer);

  const retry202 = await jobProducerHandler(
    { body: JSON.stringify({ fileId: retryFileId }), isBase64Encoded: false },
    dummyCtx,
  );
  assert.equal(retry202.statusCode, 202);
  const retryMsgBody = sentMessages[1].body;
  const retryJobId = JSON.parse(retryMsgBody).jobId;

  failS3DownloadTransient = true;
  for (const rc of ['1', '2', '3']) {
    await assert.rejects(
      () =>
        jobConsumerHandler(
          { Records: [{ messageId: `r-${rc}`, body: retryMsgBody, attributes: { ApproximateReceiveCount: rc } }] },
          dummyCtx,
        ),
      /S3 503/,
    );
    assert.equal(db.state.processing_jobs.get(retryJobId).status, 'failed');
    assert.equal(db.state.file_jobs.get(retryFileId).status, 'failed');
  }
  assert.equal(db.state.processing_jobs.get(retryJobId).attempts, 3);

  // Redrive from DLQ after S3 recovers
  failS3DownloadTransient = false;
  await jobConsumerHandler(
    { Records: [{ messageId: 'r-redrive', body: retryMsgBody, attributes: { ApproximateReceiveCount: '1' } }] },
    dummyCtx,
  );
  assert.equal(db.state.processing_jobs.get(retryJobId).status, 'completed');
  assert.equal(db.state.file_jobs.get(retryFileId).status, 'processed');
  console.log('   PASSED\n');

  // 4. Terminal error acknowledged cleanly (not retried to DLQ)
  console.log('4. Testing terminal error acknowledgement (corrupted XLSX)...');
  const badFileId = crypto.randomUUID();
  const badKey = `input/${badFileId}/original.xlsx`;
  await db.query('INSERT INTO file_jobs (file_id, original_key) VALUES ($1, $2)', [badFileId, badKey]);
  db.state.file_jobs.get(badFileId).status = 'failed';
  s3Objects.set(`${process.env.S3_BUCKET}/${badKey}`, Buffer.from('corrupted-bytes'));

  const bad202 = await jobProducerHandler(
    { body: JSON.stringify({ fileId: badFileId }), isBase64Encoded: false },
    dummyCtx,
  );
  const badJobId = JSON.parse(bad202.body).jobId;
  await jobConsumerHandler(
    { Records: [{ messageId: 'bad-1', body: sentMessages[2].body, attributes: { ApproximateReceiveCount: '1' } }] },
    dummyCtx,
  );
  assert.equal(db.state.processing_jobs.get(badJobId).status, 'failed');
  assert.equal(db.state.file_jobs.get(badFileId).status, 'failed');
  console.log('   PASSED\n');

  // 5. Stale-claim recovery (> 180s) vs active-claim rejection (<= 180s)
  console.log('5. Testing 180s stale-claim recovery vs active-claim rejection...');
  const staleFileId = crypto.randomUUID();
  const staleKey = `input/${staleFileId}/original.xlsx`;
  const staleJobId = crypto.randomUUID();
  await db.query('INSERT INTO file_jobs (file_id, original_key) VALUES ($1, $2)', [staleFileId, staleKey]);
  s3Objects.set(`${process.env.S3_BUCKET}/${staleKey}`, sample.buffer);

  // Simulate an active worker (<= 180s) -> new delivery must throw & not steal claim
  db.state.processing_jobs.set(staleJobId, {
    job_id: staleJobId,
    file_id: staleFileId,
    status: 'processing',
    attempts: 1,
    updated_at: Date.now(),
    completed_at: null,
  });
  db.state.file_jobs.get(staleFileId).status = 'processing';
  db.state.file_jobs.get(staleFileId).started_at_ms = Date.now();

  const staleMsg = JSON.stringify({
    jobId: staleJobId,
    fileId: staleFileId,
    s3Key: staleKey,
    enqueuedAt: new Date().toISOString(),
    requestedBy: 'api',
  });
  await assert.rejects(
    () => jobConsumerHandler({ Records: [{ messageId: 'active-1', body: staleMsg, attributes: { ApproximateReceiveCount: '1' } }] }, dummyCtx),
    /currently in progress/,
  );

  // Now simulate > 180s elapsed (worker crashed/timed out) -> stale recovery succeeds
  db.state.processing_jobs.get(staleJobId).updated_at = Date.now() - 190_000;
  db.state.file_jobs.get(staleFileId).started_at_ms = Date.now() - 190_000;
  await jobConsumerHandler(
    { Records: [{ messageId: 'stale-2', body: staleMsg, attributes: { ApproximateReceiveCount: '2' } }] },
    dummyCtx,
  );
  assert.equal(db.state.processing_jobs.get(staleJobId).status, 'completed');
  assert.equal(db.state.processing_jobs.get(staleJobId).attempts, 2);
  assert.equal(db.state.file_jobs.get(staleFileId).status, 'processed');
  console.log('   PASSED\n');

  console.log('ALL PHASE 3 LOCAL TESTS PASSED (5/5)!');
}

run().catch((err) => {
  console.error('\nPHASE 3 TEST FAILED:', err);
  process.exit(1);
});
