#!/usr/bin/env node
/**
 * scripts/test-phase4-local.mjs
 * Local end-to-end verification for Phase 4 (SNS -> SQS Fan-out + Outbox):
 *   1. FILE_PROCESSED outbox -> SNS fan-out -> audit-consumer & summary-consumer
 *   2. Duplicate eventId idempotency via consumer_processed_events
 *   3. Outbox SNS failure detection (outbox='pending', file_jobs='processed', no throw)
 *   4. Message filtering (FILE_FAILED routed only to audit-queue, not summary-queue)
 *   5. Failure isolation (summary-consumer failure does not block audit-consumer)
 *
 * Run: npm run test:phase4
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
const { setSnsPublisherForTest } = require(`${distDir}/lib/sns`);
const { handler: s3ProcessorHandler } = require(`${distDir}/handlers/s3Processor`);
const { handler: auditConsumerHandler } = require(`${distDir}/handlers/auditConsumer`);
const { handler: summaryConsumerHandler } = require(`${distDir}/handlers/summaryConsumer`);

function createPhase4MockDb() {
  const state = {
    file_jobs: new Map(),
    file_records: new Map(),
    outbox: [],
    audit_logs: [],
    daily_summaries: new Map(),
    consumer_processed_events: new Set(),
  };

  function cloneState(s) {
    return {
      file_jobs: new Map(Array.from(s.file_jobs.entries(), ([k, v]) => [k, { ...v }])),
      file_records: new Map(Array.from(s.file_records.entries(), ([k, v]) => [k, { ...v }])),
      outbox: s.outbox.map((o) => ({ ...o })),
      audit_logs: s.audit_logs.map((a) => ({ ...a })),
      daily_summaries: new Map(Array.from(s.daily_summaries.entries(), ([k, v]) => [k, { ...v }])),
      consumer_processed_events: new Set(s.consumer_processed_events),
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
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'processing'")) {
      const [fileId] = params;
      const job = target.file_jobs.get(fileId);
      if (job && job.status === 'pending') {
        job.status = 'processing';
        job.started_at = new Date().toISOString();
        return { rows: [{ file_id: fileId, started_at: job.started_at }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'uploading'")) {
      const [fileId, rowCount] = params;
      const job = target.file_jobs.get(fileId);
      if (job) {
        job.status = 'uploading';
        job.row_count = rowCount;
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'processed'")) {
      const [fileId, processedKey] = params;
      const job = target.file_jobs.get(fileId);
      if (job) {
        job.status = 'processed';
        job.processed_key = processedKey;
        job.notification_status = n.includes("notification_status = 'pending'") ? 'pending' : 'not_required';
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'failed'")) {
      const [fileId, errMsg] = params;
      const job = target.file_jobs.get(fileId);
      if (job) {
        job.status = 'failed';
        job.error_message = errMsg;
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith("UPDATE file_jobs SET notification_status = 'published'")) {
      const [fileId] = params;
      const job = target.file_jobs.get(fileId);
      if (job) job.notification_status = 'published';
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith("UPDATE file_jobs SET notification_status = 'failed'")) {
      const [fileId] = params;
      const job = target.file_jobs.get(fileId);
      if (job) job.notification_status = 'failed';
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith('INSERT INTO file_records')) {
      for (let i = 0; i < params.length; i += 3) {
        target.file_records.set(`${params[i]}:${params[i + 1]}`, {
          file_id: params[i],
          row_index: params[i + 1],
          data: JSON.parse(params[i + 2]),
        });
      }
      return { rows: [], rowCount: params.length / 3 };
    }

    if (n.startsWith('INSERT INTO outbox')) {
      const [eventId, fileId, dedupKey, payloadJson, leaseToken] = params;
      if (target.outbox.some((o) => o.dedup_key === dedupKey)) {
        return { rows: [], rowCount: 0 };
      }
      const eventType = n.includes("'FILE_FAILED'") ? 'FILE_FAILED' : 'FILE_PROCESSED';
      const row = {
        id: target.outbox.length + 1,
        event_id: eventId,
        file_id: fileId,
        event_type: eventType,
        dedup_key: dedupKey,
        payload: JSON.parse(payloadJson),
        status: 'pending',
        attempts: 0,
        last_error: null,
        lease_token: leaseToken,
      };
      target.outbox.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (n.startsWith("UPDATE outbox SET status = 'published'")) {
      const [id, leaseToken] = params;
      const row = target.outbox.find((o) => o.id === id && o.lease_token === leaseToken);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'published';
      row.lease_token = null;
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (n.startsWith('UPDATE outbox SET attempts = attempts + 1')) {
      const [id, leaseToken, errMsg] = params;
      const row = target.outbox.find((o) => o.id === id && o.lease_token === leaseToken);
      if (!row) return { rows: [], rowCount: 0 };
      row.attempts += 1;
      row.last_error = errMsg;
      row.lease_token = null;
      row.status = row.attempts >= 3 ? 'failed' : 'pending';
      return { rows: [{ status: row.status }], rowCount: 1 };
    }

    if (n.startsWith('INSERT INTO consumer_processed_events')) {
      const consumerName = n.includes("'audit-consumer'") ? 'audit-consumer' : 'summary-consumer';
      const [eventId] = params;
      const key = `${consumerName}:${eventId}`;
      if (target.consumer_processed_events.has(key)) {
        return { rows: [], rowCount: 0 };
      }
      target.consumer_processed_events.add(key);
      return { rows: [{ event_id: eventId }], rowCount: 1 };
    }

    if (n.startsWith('INSERT INTO audit_logs')) {
      const [eventType, fileId, message] = params;
      target.audit_logs.push({ id: target.audit_logs.length + 1, event_type: eventType, file_id: fileId, message });
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith('INSERT INTO daily_summaries')) {
      const [rowsToAdd] = params;
      const today = new Date().toISOString().slice(0, 10);
      const cur = target.daily_summaries.get(today) ?? { summary_date: today, processing_runs: 0, total_rows: 0 };
      cur.processing_runs += 1;
      cur.total_rows += rowsToAdd;
      target.daily_summaries.set(today, cur);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unsupported SQL in Phase 4 mock DB: ${n}`);
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
              Object.assign(state, tx);
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
  awsRequestId: 'phase4-local-req',
  functionName: 'local-test',
  functionVersion: '$LATEST',
  memoryLimitInMB: '128',
  getRemainingTimeInMillis: () => 30000,
};

async function run() {
  console.log('======================================================');
  console.log('PHASE 4 LOCAL TEST SUITE (SNS -> SQS Fan-out + Outbox)');
  console.log('======================================================\n');

  process.env.S3_BUCKET = 'lambda-file-api-data-test';
  process.env.SNS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:lambda-file-api-file-processed';

  const db = createPhase4MockDb();
  const s3Objects = new Map();
  const auditQueue = [];
  const summaryQueue = [];
  let failSnsPublish = false;

  setDbPoolForTest(db);
  setS3StorageForTest({
    async createPresignedPutUrl(b, k) { return `https://${b}.s3.amazonaws.com/${k}`; },
    async getObjectBuffer(b, k) {
      const buf = s3Objects.get(`${b}/${k}`);
      if (!buf) {
        const e = new Error(`NoSuchKey: ${k}`);
        e.name = 'NoSuchKey';
        throw e;
      }
      return buf;
    },
    async putObjectBuffer(b, k, body) { s3Objects.set(`${b}/${k}`, body); },
  });

  // Simulate SNS Topic + Filter Policies routing to audit-queue (processed|failed) & summary-queue (processed)
  setSnsPublisherForTest({
    async publish(_topicArn, message, statusAttr) {
      if (failSnsPublish) throw new Error('SNS Topic unreachable (simulated)');
      const snsEnvelope = JSON.stringify({ Message: message });
      if (statusAttr === 'processed' || statusAttr === 'failed') {
        auditQueue.push({ messageId: crypto.randomUUID(), body: snsEnvelope });
      }
      if (statusAttr === 'processed') {
        summaryQueue.push({ messageId: crypto.randomUUID(), body: snsEnvelope });
      }
      return { messageId: crypto.randomUUID() };
    },
  });

  const sample = await generateExcel(30);

  // 1. Happy path: FILE_PROCESSED -> Outbox -> SNS -> both queues -> audit_logs & daily_summaries
  console.log('1. Testing FILE_PROCESSED fan-out to audit-consumer & summary-consumer...');
  const fileId1 = crypto.randomUUID();
  const key1 = `input/${fileId1}/original.xlsx`;
  s3Objects.set(`${process.env.S3_BUCKET}/${key1}`, sample.buffer);
  await s3ProcessorHandler(
    { Records: [{ s3: { bucket: { name: process.env.S3_BUCKET }, object: { key: key1 } } }] },
    { ...dummyCtx, awsRequestId: 'run-1' },
  );

  assert.equal(db.state.file_jobs.get(fileId1).status, 'processed');
  assert.equal(db.state.file_jobs.get(fileId1).notification_status, 'published');
  assert.equal(db.state.outbox[0].status, 'published');
  assert.ok(
    db.state.outbox[0].dedup_key.startsWith(`file_processed:${fileId1}:20`),
    'S3 outbox dedup_key must use stable job started_at timestamp',
  );
  assert.equal(auditQueue.length, 1);
  assert.equal(summaryQueue.length, 1);

  await auditConsumerHandler({ Records: [auditQueue[0]] }, dummyCtx);
  await summaryConsumerHandler({ Records: [summaryQueue[0]] }, dummyCtx);

  assert.equal(db.state.audit_logs.length, 1);
  assert.equal(db.state.audit_logs[0].event_type, 'FILE_PROCESSED');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(db.state.daily_summaries.get(today).processing_runs, 1);
  assert.equal(db.state.daily_summaries.get(today).total_rows, 30);
  console.log('   PASSED\n');

  // 2. Duplicate eventId idempotency across both consumers
  console.log('2. Testing duplicate eventId idempotency (consumer_processed_events)...');
  await auditConsumerHandler({ Records: [auditQueue[0]] }, dummyCtx);
  await summaryConsumerHandler({ Records: [summaryQueue[0]] }, dummyCtx);
  assert.equal(db.state.audit_logs.length, 1, 'Duplicate eventId must not insert duplicate audit_log');
  assert.equal(db.state.daily_summaries.get(today).processing_runs, 1, 'Duplicate eventId must not double-count');
  console.log('   PASSED\n');

  // 3. Outbox SNS failure detection (must not throw; file_jobs stays processed, notification_status='pending')
  console.log('3. Testing Outbox SNS failure detection...');
  failSnsPublish = true;
  const fileId2 = crypto.randomUUID();
  const key2 = `input/${fileId2}/original.xlsx`;
  s3Objects.set(`${process.env.S3_BUCKET}/${key2}`, sample.buffer);
  await s3ProcessorHandler(
    { Records: [{ s3: { bucket: { name: process.env.S3_BUCKET }, object: { key: key2 } } }] },
    { ...dummyCtx, awsRequestId: 'run-2' },
  );
  failSnsPublish = false;

  assert.equal(db.state.file_jobs.get(fileId2).status, 'processed');
  assert.equal(db.state.file_jobs.get(fileId2).notification_status, 'pending');
  assert.equal(db.state.outbox[1].status, 'pending');
  assert.equal(db.state.outbox[1].attempts, 1);
  console.log('   PASSED\n');

  // 4. Message filtering: FILE_FAILED goes only to audit-queue, never summary-queue
  console.log('4. Testing SNS Filter Policy for FILE_FAILED...');
  const auditBefore = auditQueue.length;
  const summaryBefore = summaryQueue.length;
  const badId = crypto.randomUUID();
  const badKey = `input/${badId}/original.xlsx`;
  s3Objects.set(`${process.env.S3_BUCKET}/${badKey}`, Buffer.from('not-xlsx'));
  await s3ProcessorHandler(
    { Records: [{ s3: { bucket: { name: process.env.S3_BUCKET }, object: { key: badKey } } }] },
    { ...dummyCtx, awsRequestId: 'run-3' },
  );

  assert.equal(db.state.file_jobs.get(badId).status, 'failed');
  assert.equal(auditQueue.length, auditBefore + 1, 'audit-queue must receive FILE_FAILED');
  assert.equal(summaryQueue.length, summaryBefore, 'summary-queue must filter out FILE_FAILED');

  await auditConsumerHandler({ Records: [auditQueue[auditQueue.length - 1]] }, dummyCtx);
  assert.equal(db.state.audit_logs[1].event_type, 'FILE_FAILED');
  assert.equal(db.state.daily_summaries.get(today).processing_runs, 1);
  console.log('   PASSED\n');

  // 5. Failure isolation: summary-consumer fails while audit-consumer still commits
  console.log('5. Testing failure isolation (summary-consumer fails independently)...');
  const isoId = crypto.randomUUID();
  const isoKey = `input/${isoId}/original.xlsx`;
  s3Objects.set(`${process.env.S3_BUCKET}/${isoKey}`, sample.buffer);
  await s3ProcessorHandler(
    { Records: [{ s3: { bucket: { name: process.env.S3_BUCKET }, object: { key: isoKey } } }] },
    { ...dummyCtx, awsRequestId: 'run-4' },
  );

  await auditConsumerHandler({ Records: [auditQueue[auditQueue.length - 1]] }, dummyCtx);
  assert.equal(db.state.audit_logs.length, 3);

  // Simulate summary-consumer DB error -> throws for summary-queue retry, audit_logs unaffected
  const origConnect = db.connect.bind(db);
  db.connect = async () => { throw new Error('Simulated summary DB outage'); };
  await assert.rejects(
    () => summaryConsumerHandler({ Records: [summaryQueue[summaryQueue.length - 1]] }, dummyCtx),
    /Simulated summary DB outage/,
  );
  db.connect = origConnect;
  assert.equal(db.state.audit_logs.length, 3, 'audit-consumer remains unaffected');
  console.log('   PASSED\n');

  console.log('ALL PHASE 4 LOCAL TESTS PASSED (5/5)!');
}

run().catch((err) => {
  console.error('\nPHASE 4 TEST FAILED:', err);
  process.exit(1);
});
