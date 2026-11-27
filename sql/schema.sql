-- sql/schema.sql
-- PostgreSQL schema for lambda-file-processing-api (Phases 2-5).
-- Safe to re-run (idempotent via IF NOT EXISTS).

-- 1. File upload jobs
CREATE TABLE IF NOT EXISTS file_jobs (
  file_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_key        TEXT NOT NULL,
  processed_key       TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  notification_status TEXT NOT NULL DEFAULT 'not_required',
  row_count           INTEGER,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  processed_at        TIMESTAMPTZ,
  CONSTRAINT valid_status CHECK (
    status IN ('pending', 'processing', 'uploading', 'processed', 'failed', 'timeout')
  ),
  CONSTRAINT valid_notification_status CHECK (
    notification_status IN ('not_required', 'pending', 'published', 'failed')
  )
);

-- 2. Extracted rows from Excel files
CREATE TABLE IF NOT EXISTS file_records (
  id        BIGSERIAL PRIMARY KEY,
  file_id   UUID NOT NULL REFERENCES file_jobs(file_id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  data      JSONB NOT NULL,
  UNIQUE (file_id, row_index)
);

-- 3. SQS job tracking & idempotency (Phase 3)
CREATE TABLE IF NOT EXISTS processing_jobs (
  job_id       UUID PRIMARY KEY,
  file_id      UUID NOT NULL REFERENCES file_jobs(file_id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'processing',
  attempts     INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT valid_processing_job_status CHECK (
    status IN ('processing', 'completed', 'failed')
  )
);

-- 4. Transactional outbox for SNS notifications (schema ready in Phase 2, active in Phase 4+)
CREATE TABLE IF NOT EXISTS outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  file_id      UUID NOT NULL REFERENCES file_jobs(file_id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL DEFAULT 'FILE_PROCESSED',
  dedup_key    TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  lease_token  UUID,
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  CONSTRAINT unique_outbox_event_id UNIQUE (event_id),
  CONSTRAINT unique_outbox_dedup_key UNIQUE (dedup_key),
  CONSTRAINT valid_outbox_status CHECK (status IN ('pending', 'published', 'failed')),
  CONSTRAINT valid_outbox_event_type CHECK (event_type IN ('FILE_PROCESSED', 'FILE_FAILED'))
);

-- 5. Audit log (Phase 4+)
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  file_id     UUID REFERENCES file_jobs(file_id) ON DELETE SET NULL,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Daily summary (Phase 4+)
CREATE TABLE IF NOT EXISTS daily_summaries (
  summary_date    DATE PRIMARY KEY,
  processing_runs INTEGER NOT NULL DEFAULT 0,
  total_rows      INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Consumer event deduplication (Phase 4+)
CREATE TABLE IF NOT EXISTS consumer_processed_events (
  consumer_name TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  file_id       UUID REFERENCES file_jobs(file_id) ON DELETE SET NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer_name, event_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_file_records_file_id ON file_records(file_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_file_id ON audit_logs(file_id);
CREATE INDEX IF NOT EXISTS idx_file_jobs_status ON file_jobs(status);
CREATE INDEX IF NOT EXISTS idx_file_jobs_started_at ON file_jobs(started_at)
  WHERE status IN ('processing', 'uploading');
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at)
  WHERE status = 'pending';
