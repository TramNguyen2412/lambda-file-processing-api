#!/usr/bin/env node
/**
 * scripts/test-phase5-local.mjs
 * Local end-to-end verification for Phase 5 (EventBridge Scheduler -> maintenance):
 *   1. Audit log retention cleanup (30-day boundary, multi-batch, duplicate run)
 *   2. Stalled job detection (active <= 1h untouched vs stalled > 1h -> timeout + FILE_FAILED)
 *   3. Outbox retry (eligible > 5m, expired lease > 10m, active lease skipped, preserved event_id, attempts >= 3 -> failed, lease fencing)
 *   4. Manual invoke (mode omitted -> runs both daily + recovery) & summary-consumer idempotency on retried eventId
 *
 * Run: npm run test:phase5
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', 'dist');

const { setDbPoolForTest } = require(`${distDir}/lib/db`);
const { setSnsPublisherForTest } = require(`${distDir}/lib/sns`);
const { handler: maintenanceHandler } = require(`${distDir}/handlers/maintenance`);
const { handler: summaryConsumerHandler } = require(`${distDir}/handlers/summaryConsumer`);

function createPhase5MockDb() {
  const state = {
    file_jobs: new Map(),
    outbox: [],
    audit_logs: [],
    daily_summaries: new Map(),
    consumer_processed_events: new Set(),
  };
  let nextAuditId = 1;
  let nextOutboxId = 1;

  function cloneState(s) {
    return {
      file_jobs: new Map(Array.from(s.file_jobs.entries(), ([k, v]) => [k, { ...v }])),
      outbox: s.outbox.map((o) => ({ ...o })),
      audit_logs: s.audit_logs.map((a) => ({ ...a })),
      daily_summaries: new Map(Array.from(s.daily_summaries.entries(), ([k, v]) => [k, { ...v }])),
      consumer_processed_events: new Set(s.consumer_processed_events),
    };
  }

  function execSql(target, sql, params = []) {
    const n = sql.replace(/\s+/g, ' ').trim();
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const FIVE_MIN_MS = 5 * 60 * 1000;
    const TEN_MIN_MS = 10 * 60 * 1000;

    if (n.includes('DELETE FROM audit_logs a')) {
      const [limit] = params;
      const toDelete = target.audit_logs
        .filter((a) => a.created_at_ms < now - THIRTY_DAYS_MS)
        .slice(0, limit);
      const delIds = new Set(toDelete.map((d) => d.id));
      target.audit_logs = target.audit_logs.filter((a) => !delIds.has(a.id));
      return { rows: toDelete.map((d) => ({ id: d.id })), rowCount: toDelete.length };
    }

    if (n.startsWith("INSERT INTO audit_logs (event_type, file_id, message) VALUES ('MAINTENANCE_RUN'")) {
      const [message] = params;
      target.audit_logs.push({
        id: nextAuditId++,
        event_type: 'MAINTENANCE_RUN',
        file_id: null,
        message,
        created_at_ms: now,
      });
      return { rows: [], rowCount: 1 };
    }

    if (n.startsWith("UPDATE file_jobs SET status = 'timeout'")) {
      const stuck = [];
      for (const job of target.file_jobs.values()) {
        if (
          (job.status === 'processing' || job.status === 'uploading') &&
          job.started_at_ms < now - ONE_HOUR_MS
        ) {
          job.status = 'timeout';
          job.error_message = 'processing exceeded 1 hour';
          stuck.push({
            file_id: job.file_id,
            original_key: job.original_key,
            started_epoch: String(Math.floor(job.started_at_ms / 1000)),
          });
        }
      }
      return { rows: stuck, rowCount: stuck.length };
    }

    if (n.includes("last_error = 'superseded by timeout'")) {
      const [ids] = params;
      const idSet = new Set(ids);
      let count = 0;
      for (const o of target.outbox) {
        if (idSet.has(o.file_id) && o.status === 'pending') {
          o.status = 'failed';
          o.last_error = 'superseded by timeout';
          o.lease_token = null;
          o.locked_at_ms = null;
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (n.startsWith('INSERT INTO outbox')) {
      const [eventId, fileId, dedupKey, payloadJson, leaseToken] = params;
      if (target.outbox.some((o) => o.dedup_key === dedupKey)) {
        return { rows: [], rowCount: 0 };
      }
      const row = {
        id: nextOutboxId++,
        event_id: eventId,
        file_id: fileId,
        event_type: n.includes("'FILE_FAILED'") ? 'FILE_FAILED' : 'FILE_PROCESSED',
        dedup_key: dedupKey,
        payload: JSON.parse(payloadJson),
        status: 'pending',
        attempts: 0,
        last_error: null,
        lease_token: leaseToken,
        locked_at_ms: now,
        created_at_ms: now,
      };
      target.outbox.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (n.startsWith('WITH claimed AS')) {
      const eligible = target.outbox
        .filter(
          (o) =>
            o.status === 'pending' &&
            o.created_at_ms < now - FIVE_MIN_MS &&
            (o.locked_at_ms === null || o.locked_at_ms < now - TEN_MIN_MS),
        )
        .sort((a, b) => a.created_at_ms - b.created_at_ms)
        .slice(0, 20);

      for (const row of eligible) {
        row.locked_at_ms = now;
        row.lease_token = crypto.randomUUID();
      }
      return { rows: eligible.map((r) => ({ ...r })), rowCount: eligible.length };
    }

    if (n.startsWith("UPDATE outbox SET status = 'published'")) {
      const [id, leaseToken] = params;
      const row = target.outbox.find((o) => o.id === id && o.lease_token === leaseToken);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'published';
      row.lease_token = null;
      row.locked_at_ms = null;
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (n.startsWith('UPDATE outbox SET attempts = attempts + 1')) {
      const [id, leaseToken, errMsg] = params;
      const row = target.outbox.find((o) => o.id === id && o.lease_token === leaseToken);
      if (!row) return { rows: [], rowCount: 0 };
      row.attempts += 1;
      row.last_error = errMsg;
      row.lease_token = null;
      row.locked_at_ms = null;
      row.status = row.attempts >= 3 ? 'failed' : 'pending';
      return { rows: [{ status: row.status }], rowCount: 1 };
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

    if (n.startsWith('INSERT INTO consumer_processed_events')) {
      const [eventId] = params;
      const key = `summary-consumer:${eventId}`;
      if (target.consumer_processed_events.has(key)) return { rows: [], rowCount: 0 };
      target.consumer_processed_events.add(key);
      return { rows: [{ event_id: eventId }], rowCount: 1 };
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

    throw new Error(`Unsupported SQL in Phase 5 mock DB: ${n}`);
  }

  return {
    state,
    addAuditLog(eventType, ageDays) {
      state.audit_logs.push({
        id: nextAuditId++,
        event_type: eventType,
        file_id: null,
        message: 'seed',
        created_at_ms: Date.now() - ageDays * 24 * 60 * 60 * 1000,
      });
    },
    addOutbox(opts) {
      const row = {
        id: nextOutboxId++,
        event_id: opts.event_id,
        file_id: opts.file_id,
        event_type: opts.event_type ?? 'FILE_PROCESSED',
        dedup_key: opts.dedup_key,
        payload: opts.payload,
        status: opts.status ?? 'pending',
        attempts: opts.attempts ?? 0,
        last_error: null,
        lease_token: opts.lease_token ?? null,
        locked_at_ms: opts.locked_at_ms ?? null,
        created_at_ms: opts.created_at_ms ?? Date.now(),
      };
      state.outbox.push(row);
      return row;
    },
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
  awsRequestId: 'phase5-local-req',
  functionName: 'lambda-file-api-maintenance',
  functionVersion: '$LATEST',
  memoryLimitInMB: '256',
  getRemainingTimeInMillis: () => 300000,
};

async function run() {
  console.log('======================================================');
  console.log('PHASE 5 LOCAL TEST SUITE (EventBridge Scheduler)');
  console.log('======================================================\n');

  process.env.SNS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:lambda-file-api-file-processed';
  const db = createPhase5MockDb();
  const publishedEvents = [];
  let failSns = false;
  let onSnsPublishHook = null;

  setDbPoolForTest(db);
  setSnsPublisherForTest({
    async publish(_topicArn, message, statusAttr) {
      if (onSnsPublishHook) await onSnsPublishHook(JSON.parse(message));
      if (failSns) throw new Error('SNS publish failed (simulated)');
      publishedEvents.push({ statusAttr, payload: JSON.parse(message) });
      return { messageId: crypto.randomUUID() };
    },
  });

  // 1. Audit log retention cleanup (30-day boundary, batching, duplicate run)
  console.log('1. Testing daily audit log retention cleanup (boundary + batching + idempotency)...');
  for (let i = 0; i < 5; i++) db.addAuditLog('FILE_PROCESSED', 31); // expired (5 rows)
  db.addAuditLog('FILE_PROCESSED', 29); // boundary: must be kept
  db.addAuditLog('FILE_FAILED', 1);     // recent: must be kept

  const dailyRes1 = await maintenanceHandler({ mode: 'daily', auditBatchSize: 2 }, dummyCtx);
  assert.equal(dailyRes1.cleanupAudit.deletedRows, 5);
  assert.equal(dailyRes1.cleanupAudit.batches, 3);
  assert.equal(db.state.audit_logs.filter((a) => a.event_type !== 'MAINTENANCE_RUN').length, 2);
  assert.equal(db.state.audit_logs.filter((a) => a.event_type === 'MAINTENANCE_RUN').length, 1);

  const dailyRes2 = await maintenanceHandler({ mode: 'daily', auditBatchSize: 2 }, dummyCtx);
  assert.equal(dailyRes2.cleanupAudit.deletedRows, 0);
  console.log('   PASSED\n');

  // 2. Stalled job detection (active vs stalled)
  console.log('2. Testing stalled job detection (active <= 1h vs stalled > 1h)...');
  const activeProcId = crypto.randomUUID();
  const activeUplId = crypto.randomUUID();
  const stalledProcId = crypto.randomUUID();
  const stalledUplId = crypto.randomUUID();

  db.state.file_jobs.set(activeProcId, {
    file_id: activeProcId, original_key: `input/${activeProcId}/a.xlsx`, status: 'processing',
    notification_status: 'not_required', started_at_ms: Date.now() - 20 * 60_000,
  });
  db.state.file_jobs.set(activeUplId, {
    file_id: activeUplId, original_key: `input/${activeUplId}/b.xlsx`, status: 'uploading',
    notification_status: 'not_required', started_at_ms: Date.now() - 45 * 60_000,
  });
  db.state.file_jobs.set(stalledProcId, {
    file_id: stalledProcId, original_key: `input/${stalledProcId}/c.xlsx`, status: 'processing',
    notification_status: 'not_required', started_at_ms: Date.now() - 90 * 60_000,
  });
  db.state.file_jobs.set(stalledUplId, {
    file_id: stalledUplId, original_key: `input/${stalledUplId}/d.xlsx`, status: 'uploading',
    notification_status: 'not_required', started_at_ms: Date.now() - 120 * 60_000,
  });

  const recRes1 = await maintenanceHandler({ mode: 'recovery' }, dummyCtx);
  assert.equal(recRes1.detectStuck.stuckCount, 2);
  assert.equal(recRes1.detectStuck.failedNotificationsPublished, 2);
  assert.equal(db.state.file_jobs.get(activeProcId).status, 'processing');
  assert.equal(db.state.file_jobs.get(activeUplId).status, 'uploading');
  assert.equal(db.state.file_jobs.get(stalledProcId).status, 'timeout');
  assert.equal(db.state.file_jobs.get(stalledUplId).status, 'timeout');

  // Re-run recovery -> no duplicate timeouts or FILE_FAILED events
  const recRes2 = await maintenanceHandler({ mode: 'recovery' }, dummyCtx);
  assert.equal(recRes2.detectStuck.stuckCount, 0);
  console.log('   PASSED\n');

  // 3. Outbox retry: eligible, expired lease, active lease skipped, preserved event_id, attempts >= 3, lease fencing
  console.log('3. Testing outbox retry (expired lease, preserved event_id, max attempts, fencing)...');
  const f1 = crypto.randomUUID();
  const ev1 = crypto.randomUUID();
  const fExpired = crypto.randomUUID();
  const evExpired = crypto.randomUUID();
  const fActiveLease = crypto.randomUUID();
  const fTooFresh = crypto.randomUUID();

  for (const fid of [f1, fExpired, fActiveLease, fTooFresh]) {
    db.state.file_jobs.set(fid, {
      file_id: fid, original_key: `input/${fid}/orig.xlsx`, status: 'processed',
      notification_status: 'pending', started_at_ms: Date.now() - 10 * 60_000,
    });
  }

  const ob1 = db.addOutbox({
    event_id: ev1, file_id: f1, dedup_key: `fp:${f1}:1`,
    payload: { eventId: ev1, eventType: 'FILE_PROCESSED', status: 'processed', fileId: f1, rowCount: 40, s3Key: `processed/${f1}/result.xlsx` },
    created_at_ms: Date.now() - 8 * 60_000,
  });
  const obExp = db.addOutbox({
    event_id: evExpired, file_id: fExpired, dedup_key: `fp:${fExpired}:1`,
    payload: { eventId: evExpired, eventType: 'FILE_PROCESSED', status: 'processed', fileId: fExpired, rowCount: 15, s3Key: `processed/${fExpired}/result.xlsx` },
    created_at_ms: Date.now() - 20 * 60_000,
    locked_at_ms: Date.now() - 12 * 60_000, // expired > 10 min
    lease_token: crypto.randomUUID(),
  });
  const obAct = db.addOutbox({
    event_id: crypto.randomUUID(), file_id: fActiveLease, dedup_key: `fp:${fActiveLease}:1`,
    payload: { eventId: 'act', eventType: 'FILE_PROCESSED', status: 'processed', fileId: fActiveLease, rowCount: 10, s3Key: 'x' },
    created_at_ms: Date.now() - 20 * 60_000,
    locked_at_ms: Date.now() - 2 * 60_000, // active lease < 10 min
    lease_token: crypto.randomUUID(),
  });
  const obFresh = db.addOutbox({
    event_id: crypto.randomUUID(), file_id: fTooFresh, dedup_key: `fp:${fTooFresh}:1`,
    payload: { eventId: 'fresh', eventType: 'FILE_PROCESSED', status: 'processed', fileId: fTooFresh, rowCount: 10, s3Key: 'y' },
    created_at_ms: Date.now() - 1 * 60_000, // < 5 min
  });

  const getOb = (id) => db.state.outbox.find((o) => o.id === id);
  const retryRes = await maintenanceHandler({ mode: 'recovery' }, dummyCtx);
  assert.equal(retryRes.outboxRetry.retriedCount, 2);
  assert.equal(retryRes.outboxRetry.successCount, 2);
  assert.equal(getOb(ob1.id).status, 'published');
  assert.equal(getOb(obExp.id).status, 'published');
  assert.equal(getOb(obAct.id).status, 'pending', 'Active lease must not be reclaimed');
  assert.equal(getOb(obFresh.id).status, 'pending', 'Fresh outbox (<5m) must not be claimed');
  assert.equal(db.state.file_jobs.get(f1).notification_status, 'published');
  assert.equal(db.state.file_jobs.get(f1).status, 'processed');

  // Verify original event_id was preserved & summary-consumer deduplicates if delivered twice
  await summaryConsumerHandler({ Records: [{ messageId: 'm1', body: JSON.stringify({ Message: JSON.stringify(ob1.payload) }) }] }, dummyCtx);
  await summaryConsumerHandler({ Records: [{ messageId: 'm2', body: JSON.stringify({ Message: JSON.stringify(ob1.payload) }) }] }, dummyCtx);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(db.state.daily_summaries.get(today).processing_runs, 1);
  assert.equal(db.state.daily_summaries.get(today).total_rows, 40);

  // Test attempts >= 3 -> outbox.status='failed', notification_status='failed', file_jobs.status stays 'processed'
  const fMax = crypto.randomUUID();
  const evMax = crypto.randomUUID();
  db.state.file_jobs.set(fMax, {
    file_id: fMax, original_key: `input/${fMax}/orig.xlsx`, status: 'processed',
    notification_status: 'pending', started_at_ms: Date.now() - 10 * 60_000,
  });
  const obMax = db.addOutbox({
    event_id: evMax, file_id: fMax, dedup_key: `fp:${fMax}:1`,
    payload: { eventId: evMax, eventType: 'FILE_PROCESSED', status: 'processed', fileId: fMax, rowCount: 5, s3Key: 'z' },
    created_at_ms: Date.now() - 15 * 60_000,
    attempts: 2,
  });
  failSns = true;
  const maxRes = await maintenanceHandler({ mode: 'recovery' }, dummyCtx);
  failSns = false;
  assert.equal(maxRes.outboxRetry.failedCount, 1);
  assert.equal(getOb(obMax.id).attempts, 3);
  assert.equal(getOb(obMax.id).status, 'failed');
  assert.equal(db.state.file_jobs.get(fMax).notification_status, 'failed');
  assert.equal(db.state.file_jobs.get(fMax).status, 'processed');

  // Test lease_token fencing: stale worker cannot overwrite newer worker's lease
  const fFence = crypto.randomUUID();
  const evFence = crypto.randomUUID();
  db.state.file_jobs.set(fFence, {
    file_id: fFence, original_key: `input/${fFence}/orig.xlsx`, status: 'processed',
    notification_status: 'pending', started_at_ms: Date.now() - 10 * 60_000,
  });
  const obFence = db.addOutbox({
    event_id: evFence, file_id: fFence, dedup_key: `fp:${fFence}:1`,
    payload: { eventId: evFence, eventType: 'FILE_PROCESSED', status: 'processed', fileId: fFence, rowCount: 5, s3Key: 'f' },
    created_at_ms: Date.now() - 15 * 60_000,
  });
  onSnsPublishHook = () => {
    // Simulate a newer worker stealing the lease while this worker was in-flight
    getOb(obFence.id).lease_token = crypto.randomUUID();
  };
  await maintenanceHandler({ mode: 'recovery' }, dummyCtx);
  onSnsPublishHook = null;
  assert.equal(getOb(obFence.id).status, 'pending', 'Stale lease_token must not mark outbox published');
  assert.equal(db.state.file_jobs.get(fFence).notification_status, 'pending');
  console.log('   PASSED\n');

  // 4. Manual invoke (no mode) runs both daily & recovery
  console.log('4. Testing manual invoke (mode omitted -> daily + recovery)...');
  const allRes = await maintenanceHandler({ source: 'manual-test' }, dummyCtx);
  assert.equal(allRes.mode, 'all');
  assert.ok(allRes.cleanupAudit && allRes.detectStuck && allRes.outboxRetry);
  console.log('   PASSED\n');

  console.log('ALL PHASE 5 LOCAL TESTS PASSED (4/4)!');
}

run().catch((err) => {
  console.error('\nPHASE 5 TEST FAILED:', err);
  process.exit(1);
});
