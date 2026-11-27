# AWS Serverless Learning Project – Implementation Plan

> **Dự án:** `lambda-file-processing-api` – AWS Serverless thực nghiệm sâu  
> **Trạng thái:** Phase 1 ✅ Hoàn thành · Phase 2–6 đang triển khai  
> **Phương châm:** Mỗi service phải có lý do kỹ thuật rõ ràng. Hiểu tại sao, không chỉ làm cho xong.  
> **Database:** PostgreSQL (Amazon RDS) – thay thế DynamoDB từ Phase 2 trở đi

---

## Tổng quan

Đây là một learning project được xây dựng theo từng phase, mỗi phase tập trung vào một nhóm AWS services cụ thể. Mỗi service được đưa vào vì một lý do kỹ thuật thực tế, không phải chỉ để làm cho architecture trông phức tạp hơn.

### Services và lý do chọn

| Phase | Services | Lý do có mặt trong project |
|---|---|---|
| **Phase 1 ✅** | Lambda, API Gateway, Function URL | Upload/parse/generate Excel trong memory; đo giới hạn payload và streaming |
| **Phase 2** | S3, S3 Event, Lambda, RDS PostgreSQL | File lớn cần lưu trữ trung gian; event-driven processing; dữ liệu có cấu trúc cần relational DB |
| **Phase 3** | SQS, DLQ | Tách file-processing request khỏi actual processing; retry có kiểm soát; DLQ cho failure investigation |
| **Phase 4** | SNS → SQS | Sau khi process xong, nhiều hệ thống độc lập cần biết; fan-out một lần thay vì gọi từng cái |
| **Phase 5** | EventBridge Scheduler | Maintenance task không cần người kích hoạt; phát hiện stuck jobs; tóm tắt định kỳ |
| **Phase 6** | Lambda Layer, Container Cache, ElastiCache | Hiểu 3 loại cache hoàn toàn khác nhau về scope, lifetime và visibility |

---

## Kiến trúc tổng thể

```
                           Client / cURL
                                │
                   ┌────────────▼────────────┐
                   │  API Gateway HTTP API   │
                   │  (v2, existing Phase 1) │
                   └────────────┬────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         ▼                      ▼                      ▼
   [Phase 1 – existing]   [Phase 2 – new]       [Phase 3 – new]
   GET  /health            POST /upload-to-s3    POST /process-job
   GET  /info              GET  /file/:id        (producer → SQS)
   POST /upload-excel      GET  /file/:id/rows
   GET  /generate-excel
   Function URLs

                                │
                          S3 input/
                                │
                      S3 ObjectCreated Event
                                │
                      ┌─────────▼─────────┐
                      │ lambda-s3-processor │
                      └─────────┬─────────┘
                                │
                    [State machine – see Phase 2]
                                │
                      ┌─────────▼──────────┐
                      │ SNS: file-processed │   ← published only after full success
                      └─────────┬──────────┘
                                │
                  ┌─────────────┴─────────────┐
                  ▼                           ▼
         SQS: audit-queue             SQS: summary-queue
                  │                           │
     lambda-audit-consumer         lambda-summary-consumer
     (ghi audit log vào PG)        (cập nhật daily summary)

   EventBridge Scheduler (daily cleanup + 5-min outbox/stuck recovery)
         │
         ▼
   lambda-scheduled-maintenance
         │
   ├── Xóa audit logs cũ (> 30 ngày) [daily]
   ├── Phát hiện file stuck in "processing"/"uploading" > 1 giờ → update status = "timeout" [5-min]
   └── Retry pending outbox records > 5 phút → publish SNS [5-min]

   Lambda Layer: common-layer
         │
   ├── pg-helper (PostgreSQL queries)
   ├── logger (structured JSON logs)
   └── response-builder (API response format)

   Container cache: DB config, frequently queried data
   ElastiCache (optional advanced): cross-instance shared cache
```

---

## Chi phí và Free Tier

> ⚠️ **Đọc kỹ trước khi deploy bất kỳ thứ gì.**

| Service | Free Tier | Rủi ro chi phí |
|---|---|---|
| Lambda | 1M requests/tháng, 400,000 GB-seconds | Thấp |
| API Gateway | 1M API calls/tháng (12 tháng đầu) | Thấp |
| S3 | 5 GB storage, 20K GET, 2K PUT (12 tháng đầu) | Thấp |
| SQS | 1M requests/tháng | Thấp |
| SNS | 1M publishes/tháng | Thấp |
| EventBridge Scheduler | 14M invocations/tháng | Thấp |
| **RDS PostgreSQL** | **db.t3.micro, 20 GB, 20M I/O (12 tháng đầu)** | **Trung bình – phải xóa sau thực nghiệm** |
| **RDS Proxy** | **Không có Free Tier** | **⚠️ Tính phí ngay – xem xét bỏ qua** |
| **ElastiCache** | **Không có Free Tier** | **⚠️ Tính phí ngay – để optional** |
| VPC Interface Endpoints | Không có Free Tier | **⚠️ ~\$0.01/hour mỗi endpoint – xem xét kỹ** |
| NAT Gateway | Không có Free Tier | **⚠️ ~\$0.045/giờ nếu Lambda cần ra internet từ trong VPC** |

**Quyết định kiến trúc dựa trên chi phí:**
1. **RDS PostgreSQL db.t3.micro** → Dùng. Nằm trong Free Tier nếu tài khoản < 12 tháng. Phải stop/delete sau khi xong.
2. **RDS Proxy** → **Bỏ qua** (không có Free Tier). Giải thích trong plan tại sao nó hữu ích nhưng không dùng vì chi phí.
3. **ElastiCache** → **Optional Advanced**, tách riêng. Học concept bằng container cache trước.
4. **NAT Gateway** → **Tránh**. Lambda trong VPC kết nối RDS dùng VPC internal routing, không cần NAT. Chỉ cần NAT nếu Lambda cần gọi ra internet.
5. **VPC Interface Endpoints** → S3 dùng Gateway type (miễn phí). Secrets Manager, SQS, SNS cần Interface type (~\$0.01/hour). Nếu chi phí là vấn đề: dùng Public RDS endpoint với SSL thay VPC isolation, và gọi Secrets Manager / SQS / SNS qua public internet (Lambda không trong VPC). Ghi trade-off này trong report.

---

## Phase 1 – Upload File (Hoàn thành) ✅

> **Giữ nguyên toàn bộ. Không sửa bất kỳ thứ gì.**

### Mục tiêu đã đạt được
Hiểu giới hạn thực tế của AWS Lambda khi xử lý file nhị phân mà **không dùng S3 hay Database**. Đây là điều kiện cần thiết để hiểu tại sao Phase 2 lại cần S3 và PostgreSQL.

### Lambda Functions hiện tại

| Function | RAM | Timeout | Vai trò |
|---|:---:|:---:|---|
| `lambda-file-api-health` | 128 MB | 10s | Health check |
| `lambda-file-api-info` | 128 MB | 10s | API limits reference |
| `lambda-file-api-upload-excel` | 512 MB | 60s | Upload & parse Excel qua API Gateway |
| `lambda-file-api-generate-excel` | 1024 MB | 120s | Generate Excel buffered response |
| `lambda-file-api-generate-excel-stream` | 1024 MB | 120s | Generate Excel streaming response |

### Thực nghiệm đã hoàn thành

- **21/21 test cases PASS** – ranh giới payload, validation, streaming
- **Base64 Inflation** – file thô tối đa ~4.50 MiB qua API Gateway (giải thích rõ tại sao)
- **Memory scaling** – 128 MB → 1024 MB, nhanh hơn 10.04×
- **Response Streaming** – thành công tới 190 MiB, giới hạn thực tế ~200 MiB

📄 Xem chi tiết: [`EXPERIMENT_REPORT.md`](EXPERIMENT_REPORT.md)

---

## Phase 2 – S3 Event + PostgreSQL (RDS) 🔲

### Tại sao cần Phase này?

Phase 1 chứng minh được rằng upload trực tiếp qua Lambda có giới hạn ~4.5 MiB (do Base64). File Excel thực tế trong production thường lớn hơn nhiều. Phase 2 giải quyết vấn đề này bằng cách đưa S3 vào làm nơi lưu trữ file, và dùng S3 Event để kích hoạt xử lý bất đồng bộ.

**Câu hỏi kỹ thuật cần trả lời:**
- Tại sao cần S3 thay vì tiếp nhận file trực tiếp?
- S3 Event notification hoạt động thế nào, có đảm bảo không bỏ sót event không?
- Làm thế nào tránh vòng lặp vô hạn khi Lambda upload file lại S3?
- Tại sao dùng PostgreSQL thay vì NoSQL cho bài toán này?
- Làm thế nào kết nối Lambda với RDS ở trong VPC mà không cần NAT Gateway?

---

### Processing State Machine

**Trạng thái hợp lệ và chuyển đổi:**

```
                 ┌─────────────────────── (Phase 3: POST /process-job retry) ──────────────────────┐
                 ▼                                                                                 │
pending ──► processing ──► uploading ──► processed                                                 │
                │               │                                                                  │
                ├──► failed ────┼──────────────────────────────────────────────────────────────────┤
                │               ├──► failed                                                        │
                ▼               ▼                                                                  │
             timeout ◄──────────┘  (Phase 5: stuck > 1 giờ) ───────────────────────────────────────┘
```

| Trạng thái | Ý nghĩa | Điều kiện chuyển |
|---|---|---|
| `pending` | File đã được ghi nhận, chờ xử lý | Tạo khi nhận presigned URL / reset từ `failed` hoặc `timeout` |
| `processing` | Đang download + parse + INSERT rows | Lambda đã claim job thành công (`started_at = NOW()`) |
| `uploading` | DB commit xong (`finished_at = NOW()`), đang upload result file (+ publish SNS ở Phase 4) | Sau khi COMMIT `file_records` thành công |
| `processed` | Toàn bộ pipeline hoàn tất (`processed_at = NOW()`) | Sau khi upload S3 xong (Phase 2) và SNS publish xong (Phase 4) |
| `failed` | Lỗi tại bước download, parse, DB hoặc upload S3 | Lỗi không recover được trong lần chạy hiện tại; có thể retry qua Phase 3 |
| `timeout` | Phase 5 phát hiện `processing` hoặc `uploading` stuck > 1 giờ | EventBridge Scheduler recovery; có thể retry qua Phase 3 |

**Tại sao cần trạng thái `uploading`?**

Nếu chỉ dùng `processing` → `processed`, không có cách phân biệt:
- Job đang thực sự processing (đang parse Excel / insert DB)
- Job đã commit DB xong nhưng chưa hoàn tất upload result file lên S3 (Phase 2) hoặc publish SNS (Phase 4)

Trạng thái `uploading` tạo checkpoint rõ ràng: nếu Lambda crash ở bước upload S3 hoặc SNS, maintenance job ở Phase 5 (hoặc Phase 3 retry) biết DB đã commit xong và có thể kiểm tra outbox / resume mà không mất dữ liệu.

**Thứ tự các bước và tại sao theo thứ tự này:**

```
[1] Atomic claim:
    UPDATE file_jobs
    SET status='processing', started_at=NOW(), error_message=NULL
    WHERE file_id=$1 AND status='pending'
    → Nếu 0 rows updated → bỏ qua (đã được claim bởi instance khác)

[2] Download file từ S3
    → Nếu lỗi → UPDATE file_jobs SET status='failed', error_message=$err WHERE file_id=$1 → return/throw

[3] Parse Excel: đọc từng row
    → Nếu lỗi → UPDATE file_jobs SET status='failed', error_message=$err WHERE file_id=$1 → return/throw

[4] BEGIN TRANSACTION
      INSERT INTO file_records (file_id, row_index, data)
        VALUES (...) ON CONFLICT (file_id, row_index) DO NOTHING
      UPDATE file_jobs SET status='uploading', row_count=N, finished_at=NOW() WHERE file_id=$1
    COMMIT
    → Nếu lỗi → ROLLBACK → UPDATE file_jobs SET status='failed', error_message=$err WHERE file_id=$1 → return/throw

[5] Upload result file lên S3 processed/{fileId}/result.xlsx
    → Nếu lỗi → UPDATE file_jobs SET status='failed', error_message=$err WHERE file_id=$1 → return/throw
    → Lưu ý: nếu retry, file này có thể đã tồn tại trên S3 → PutObject idempotent

[6] (Phase 4 – chỉ chạy khi SNS_TOPIC_ARN được cấu hình)
    INSERT INTO outbox (file_id, event_type, payload, status)
    VALUES ($1, 'FILE_PROCESSED', $payload, 'pending')
    → Lưu SNS payload (kèm eventId UUID) vào outbox TRƯỚC khi publish

[7] (Phase 4 – chỉ chạy khi SNS_TOPIC_ARN được cấu hình)
    Publish SNS notification
    → Nếu thành công → UPDATE outbox SET status='published', published_at=NOW(), updated_at=NOW() WHERE id=$outboxId
    → Nếu lỗi → outbox record vẫn còn với status='pending'
                 → Phase 5 recovery sẽ retry publish cho records này

[8] UPDATE file_jobs
    SET status='processed', processed_key=$processedKey, processed_at=NOW()
    WHERE file_id=$1
    → Ở Phase 2: set 'processed' ngay sau bước [5].
    → Ở Phase 4+: chỉ set 'processed' sau khi bước [7] thành công (nếu SNS fail ở bước [7], giữ 'uploading' để Phase 5 recovery hoàn tất).
```

**Ý nghĩa nhất quán của các timestamp fields trong `file_jobs`:**
- `created_at`: thời điểm tạo job (`pending`).
- `started_at`: thời điểm bắt đầu xử lý (`processing`).
- `finished_at`: thời điểm DB transaction (`file_records` + `uploading`) commit thành công.
- `processed_at`: thời điểm toàn bộ pipeline hoàn tất (`processed`).
- Khi Phase 3 reset job `failed` hoặc `timeout` về `pending`, reset `started_at = NULL, finished_at = NULL, processed_at = NULL, error_message = NULL`.

**Câu hỏi "Điều gì xảy ra nếu bước X fail?":**

| Bước fail | Hệ quả | Recovery |
|---|---|---|
| Bước 2/3 (download/parse S3) | `status='failed'` (hoặc `'processing'` nếu crash đột ngột) | Phase 3 `POST /process-job` retry (nếu `failed`), hoặc Phase 5 → `timeout` → retry |
| Bước 4 (DB commit) | ROLLBACK đảm bảo không có orphaned records; `status='failed'` | Phase 3 retry |
| Bước 5 (upload S3) | `status='failed'`, DB đã commit (`file_records` đã có) | PutObject idempotent → Phase 3 retry |
| Bước 7 (SNS fail, Phase 4+) | `file_jobs.status='uploading'`, `outbox.status='pending'` | Phase 5 recovery (5-min schedule) retry outbox → `published` + `file_jobs` → `processed` |
| Bước 8 (update processed sau SNS) | SNS đã published, `file_jobs.status='uploading'` | Phase 5 recovery check: nếu outbox đã `published` → cập nhật `file_jobs` → `processed`; nếu stuck > 1h → `timeout` |

**Retry tránh duplicate records:**
- `ON CONFLICT (file_id, row_index) DO NOTHING` đảm bảo INSERT idempotent
- PutObject lên S3 idempotent (overwrite cùng key)
- SNS publish từ outbox chỉ chạy khi outbox record còn `pending`

---

### Luồng xử lý

```
Client
  │
  ├── [Option A] POST /upload-to-s3
  │   Lambda: lambda-file-api-upload-to-s3  ← 128 MB, 30s, VPC
  │   → Tạo file_job record với status='pending' trong RDS
  │   → Tạo presigned URL → Trả URL + fileId cho client
  │   Client dùng presigned URL PUT trực tiếp lên S3 input/{fileId}/original.xlsx
  │
  └── [Option B] CLI: aws s3 cp file.xlsx s3://bucket/input/{fileId}/original.xlsx
      (Nếu chưa có row trong file_jobs, s3-processor tự INSERT ... ON CONFLICT DO NOTHING rồi atomic claim)

S3 Bucket: lambda-file-api-data
  prefix: input/{fileId}/original.xlsx  ← S3 Event trigger ở đây
  prefix: processed/{fileId}/result.xlsx ← KHÔNG trigger (filter rõ ràng)

S3 ObjectCreated Event (chỉ prefix input/)
  │
  ▼
Lambda: lambda-file-api-s3-processor  ← 512 MB, 120s, VPC
  │
  ├── [1] Parse S3 event: lấy bucket, key, fileId từ object key
  ├── [2] Đảm bảo row tồn tại (INSERT ... ON CONFLICT DO NOTHING cho Option B)
  │       + Atomic claim: UPDATE ... WHERE status='pending' → check rows affected
  │       Nếu 0 rows → bỏ qua (tránh race condition khi S3 deliver event 2 lần đồng thời)
  ├── [3] Download file từ S3 vào Lambda /tmp
  ├── [4] Parse Excel: đọc từng row
  ├── [5] BEGIN TRANSACTION
  │       INSERT INTO file_records ... ON CONFLICT DO NOTHING
  │       UPDATE file_jobs SET status='uploading', row_count=N, finished_at=NOW()
  │   COMMIT
  ├── [6] Upload result lên S3 processed/{fileId}/result.xlsx (idempotent PutObject)
  ├── [7] (Phase 4+ nếu SNS_TOPIC_ARN được set): INSERT outbox → Publish SNS → UPDATE outbox='published'
  └── [8] UPDATE file_jobs SET status='processed', processed_key='processed/{fileId}/result.xlsx', processed_at=NOW()

API Routes (query kết quả):
  GET /file/:id          → SELECT * FROM file_jobs WHERE file_id = ?
  GET /file/:id/rows     → SELECT * FROM file_records WHERE file_id = ? LIMIT 100 OFFSET ?
```

> **Tại sao file_job phải được tạo TRƯỚC khi upload?**  
> Presigned URL handler (`upload-to-s3`) nằm trong VPC và tạo record với `status='pending'` trong RDS ngay khi tạo URL. Điều này đảm bảo S3 Processor luôn có record để atomic-claim. Nếu client dùng Option B (upload thẳng lên S3 qua CLI), `s3-processor` thực hiện `INSERT INTO file_jobs ... ON CONFLICT (file_id) DO NOTHING` trước bước atomic `UPDATE ... WHERE status='pending'`, nên vẫn an toàn trước race condition khi S3 gửi duplicate events.

---

### Idempotency và Concurrent Event Handling

**Vấn đề với SELECT-then-UPDATE:**

```
Time   Instance A              Instance B
 0     SELECT status='pending'
 1                             SELECT status='pending'
 2     UPDATE status='processing'
 3                             UPDATE status='processing'  ← cả hai claim!
```

**Giải pháp: Conditional UPDATE (atomic claim)**

```sql
UPDATE file_jobs
SET status = 'processing', started_at = NOW()
WHERE file_id = $1
  AND status = 'pending'
RETURNING file_id;
-- Nếu không có row nào được trả về → bỏ qua, job đã được claim
```

PostgreSQL đảm bảo UPDATE là atomic. Hai instances cạnh tranh sẽ chỉ có một cái thành công trả về row; instance còn lại nhận 0 rows và thoát sớm.

**Unique constraint cho file_records:**
```sql
UNIQUE (file_id, row_index)
-- INSERT ... ON CONFLICT (file_id, row_index) DO NOTHING
-- Đảm bảo idempotent khi retry
```

**Idempotency key trong SQS messages (Phase 3):**

Mỗi SQS message có `jobId` (UUID được tạo bởi producer). Consumer dùng bảng `processing_jobs` với cột `status` (`processing | completed | failed`) để phân biệt message đã hoàn thành với message lỗi cần SQS retry. Xem Phase 3 để biết chi tiết.

---

### PostgreSQL Schema

```sql
-- File upload jobs
CREATE TABLE file_jobs (
  file_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_key  TEXT NOT NULL,           -- S3 key của file gốc: input/{fileId}/original.xlsx
  processed_key TEXT,                    -- S3 key của file đã xử lý: processed/{fileId}/result.xlsx
  status        TEXT NOT NULL DEFAULT 'pending',
                                         -- pending | processing | uploading | processed | failed | timeout
  row_count     INTEGER,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,            -- Thời điểm DB commit xong (bước 5)
  processed_at  TIMESTAMPTZ,            -- Thời điểm toàn bộ pipeline hoàn tất (bước 9)
  CONSTRAINT valid_status CHECK (
    status IN ('pending','processing','uploading','processed','failed','timeout')
  )
);

-- Extracted rows from Excel files
CREATE TABLE file_records (
  id        BIGSERIAL PRIMARY KEY,
  file_id   UUID NOT NULL REFERENCES file_jobs(file_id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  data      JSONB NOT NULL,              -- raw row data, flexible cho nhiều loại Excel
  UNIQUE (file_id, row_index)            -- đảm bảo idempotency khi insert
);

-- SNS Outbox: lightweight transactional outbox cho SNS reliability (schema tạo sẵn ở Phase 2, kích hoạt ở Phase 4)
-- Mục đích: ghi SNS payload (kèm event_id ổn định) trước khi publish; Phase 5 retry nếu publish fail
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID NOT NULL DEFAULT gen_random_uuid(), -- stable idempotency key cho SNS consumers
  file_id      UUID NOT NULL REFERENCES file_jobs(file_id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL DEFAULT 'FILE_PROCESSED',
  payload      JSONB NOT NULL,            -- SNS message payload (chứa eventId)
  status       TEXT NOT NULL DEFAULT 'pending',
                                          -- pending | published | failed
  attempts     INTEGER NOT NULL DEFAULT 0, -- số lần retry ở Phase 5 (max 3)
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  CONSTRAINT valid_outbox_status CHECK (status IN ('pending','published','failed'))
);

-- Audit log: ghi nhận các sự kiện quan trọng (Phase 4)
-- Producer: lambda-audit-consumer (nhận từ SNS → SQS audit-queue)
-- Retention: xóa records > 30 ngày (Phase 5 maintenance)
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,             -- FILE_PROCESSED | FILE_FAILED | MAINTENANCE_RUN | ...
  file_id     UUID REFERENCES file_jobs(file_id) ON DELETE SET NULL,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Daily summary: thống kê hàng ngày (Phase 4)
-- Producer: lambda-summary-consumer (nhận từ SNS → SQS summary-queue)
-- Update strategy: dedup qua consumer_processed_events + UPSERT trong cùng transaction
-- Chỉ ghi khi status='processed' (filter ở SNS subscription)
CREATE TABLE daily_summaries (
  summary_date    DATE PRIMARY KEY,
  files_processed INTEGER NOT NULL DEFAULT 0,
  total_rows      INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Consumer event deduplication (Phase 4)
-- Đảm bảo mỗi SNS consumer (audit-consumer, summary-consumer) xử lý độc lập
-- và idempotent trước cả SQS duplicate delivery lẫn Outbox retry
CREATE TABLE consumer_processed_events (
  consumer_name TEXT NOT NULL,           -- 'audit-consumer' | 'summary-consumer'
  event_id      TEXT NOT NULL,           -- eventId từ SNS payload (outbox.event_id)
  file_id       UUID REFERENCES file_jobs(file_id) ON DELETE SET NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer_name, event_id)
);

-- Indexes
CREATE INDEX idx_file_records_file_id ON file_records(file_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);    -- hỗ trợ cleanup query
CREATE INDEX idx_audit_logs_file_id    ON audit_logs(file_id);       -- hỗ trợ query by file
CREATE INDEX idx_file_jobs_status      ON file_jobs(status);         -- hỗ trợ stuck job detection
CREATE INDEX idx_file_jobs_started_at  ON file_jobs(started_at)      -- hỗ trợ timeout detection
  WHERE status IN ('processing', 'uploading');                        -- partial index
CREATE INDEX idx_outbox_status         ON outbox(status, created_at)
  WHERE status = 'pending';                                           -- hỗ trợ Phase 5 outbox retry
```

**Trách nhiệm rõ ràng của từng bảng:**

| Bảng | Trách nhiệm | Producer | Consumer |
|---|---|---|---|
| `file_jobs` | Vòng đời của mỗi file upload job | `upload-to-s3` (tạo), `s3-processor` (cập nhật), `job-consumer` (cập nhật) | `file-query` (đọc) |
| `file_records` | Dữ liệu rows extracted từ Excel | `s3-processor`, `job-consumer` | `file-query` (đọc) |
| `processing_jobs` | Theo dõi vòng đời & idempotency của SQS `jobId` (Phase 3) | `job-consumer` | `job-consumer` |
| `outbox` | SNS payload chờ publish hoặc retry (kích hoạt ở Phase 4) | `s3-processor`, `job-consumer` | `maintenance` (retry) |
| `audit_logs` | Lịch sử sự kiện quan trọng (Phase 4) | `audit-consumer`, `maintenance` | `maintenance` (xóa cũ) |
| `daily_summaries` | Thống kê ngày (Phase 4) | `summary-consumer` | API hoặc dashboard |
| `consumer_processed_events` | Deduplication độc lập cho từng SNS consumer (Phase 4) | `audit-consumer`, `summary-consumer` | `audit-consumer`, `summary-consumer` |

**Lý do chọn PostgreSQL:**
- Excel rows có cấu trúc (header, data types) → relational model phù hợp hơn key-value
- Cần transaction để đảm bảo: hoặc tất cả rows được ghi, hoặc không có row nào (tránh partial insert)
- Cần JOIN để truy vấn `file_jobs` kèm `file_records` trong một query
- `UNIQUE (file_id, row_index)` tự động handle idempotent inserts từ S3 event delivery

**Tại sao không dùng DynamoDB:**
- DynamoDB không hỗ trợ transaction đa items một cách tự nhiên (TransactWriteItems có limit 25 items)
- Với 1000 rows trong một file, không thể insert toàn bộ trong một transaction
- Không có foreign key constraint → khó đảm bảo data consistency
- DynamoDB phù hợp hơn với access pattern simple key-value, không phải relational queries

---

### Transactional Outbox – Giải thích và Trade-offs (kích hoạt ở Phase 4)

**Vấn đề:** PostgreSQL commit thành công nhưng SNS publish fail. Không có cơ chế phát hiện và retry.

**Giải pháp: Lightweight Outbox (At-Least-Once Publishing)**

```
Bước 6 (Phase 4+): INSERT INTO outbox (file_id, event_type, payload, status='pending')
                    RETURNING id, event_id
                    ← ghi trước khi publish (payload chứa eventId ổn định)

Bước 7 (Phase 4+): sns.publish(payload)
                    → thành công → UPDATE outbox SET status='published', published_at=NOW(), updated_at=NOW()
                    → thất bại  → outbox record còn status='pending'

Phase 5 Recovery (mỗi 5 phút):
  SELECT * FROM outbox WHERE status='pending' AND created_at < NOW() - INTERVAL '5 minutes'
  → retry sns.publish cho từng record
  → thành công → UPDATE outbox SET status='published', published_at=NOW(), updated_at=NOW()
  → thất bại  → attempts = attempts + 1, last_error = $err, updated_at = NOW()
                 nếu attempts >= 3 → UPDATE outbox SET status='failed'
```

**Đảm bảo delivery thực tế (quan trọng):**
- Outbox **KHÔNG** đảm bảo exactly-once publishing. Nếu `sns.publish()` thành công nhưng Lambda crash trước khi `UPDATE outbox SET status='published'`, Phase 5 recovery sẽ publish lại record đó một lần nữa (at-least-once).
- Vì vậy, **mọi downstream consumer (`audit-consumer`, `summary-consumer`) phải idempotent** dựa trên `eventId` ổn định nằm trong payload của outbox (không dùng `SNS MessageId` hay `SQS MessageId` vì mỗi lần publish lại sẽ sinh ID mới).

**Trade-offs so với full distributed transaction:**

| | Outbox nhẹ (approach này) | Full saga / 2PC |
|---|---|---|
| Phức tạp | Thấp – 1 bảng thêm, 1 bước retry | Rất cao |
| Latency | Không thêm latency ở happy path | Thêm latency |
| Độ trễ recovery | 5–10 phút (5m age threshold + 5m EventBridge schedule) | Gần realtime |
| Test được | Dễ: mock SNS fail, check outbox record | Khó test end-to-end |
| Phù hợp với project | ✅ | ❌ |

**Điều kiện chấp nhận được:** Trong learning project này, SNS publish failure sẽ được phát hiện và retry trong vòng 5–10 phút bởi Phase 5 recovery schedule. Đây là trade-off được chấp nhận.

---

### Networking và VPC

```
VPC
  │
  ├── Private Subnet (Lambda cần VPC, RDS)
  │   ├── lambda-file-api-s3-processor  (cần VPC → RDS)
  │   ├── lambda-file-api-file-query    (cần VPC → RDS)
  │   └── RDS PostgreSQL (db.t3.micro, không có Public IP)
  │
  └── Security Groups
      ├── sg-lambda: outbound 5432 → sg-rds
      └── sg-rds: inbound 5432 từ sg-lambda
```

**Lambda nào cần VPC, Lambda nào không:**

| Lambda | VPC? | Lý do |
|---|:---:|---|
| Phase 1 Lambdas (`health`, `info`, `upload-excel`, `generate-excel*`) | ❌ | Không dùng RDS |
| `upload-to-s3` | ✅ | Tạo `file_jobs` record trong RDS (và tạo presigned URL S3) |
| `s3-processor` | ✅ | Phải kết nối RDS |
| `file-query` | ✅ | Phải kết nối RDS |
| `job-producer` | ✅ | Validate `fileId` và reset `status` trong RDS trước khi gửi SQS |
| `job-consumer` | ✅ | Phải kết nối RDS |
| `audit-consumer` | ✅ | Phải kết nối RDS |
| `summary-consumer` | ✅ | Phải kết nối RDS |
| `maintenance` | ✅ | Phải kết nối RDS |

> **Nguyên tắc nhất quán:** RDS PostgreSQL nằm trong Private Subnet (không có Public IP), nên **mọi** Lambda có đọc/ghi PostgreSQL đều bắt buộc phải chạy trong VPC. Chỉ các Lambda Phase 1 (không dùng DB) nằm ngoài VPC.

> **Trade-off cold start:** Lambda trong VPC có cold start chậm hơn khoảng 1–3 giây so với Lambda không trong VPC (AWS đã cải thiện đáng kể từ 2019 với Hyperplane, nhưng vẫn có overhead). Chỉ đặt Lambda vào VPC khi thực sự cần reach private resources.

**Kết nối Lambda → AWS Services từ trong VPC:**

| Service | Endpoint Type | Chi phí |
|---|---|---|
| S3 | Gateway Endpoint | Miễn phí |
| Secrets Manager | Interface Endpoint | ~\$0.01/hour |
| SQS | Interface Endpoint | ~\$0.01/hour |
| SNS | Interface Endpoint | ~\$0.01/hour |

> **Quyết định:** Interface Endpoints (~\$0.01/hour mỗi cái × 3 = ~\$0.03/hour) đắt hơn so với không dùng VPC. Nếu chi phí là ưu tiên, có thể cân nhắc: đặt Lambda không trong VPC và dùng RDS với public endpoint + SSL + Security Group restrict từ Lambda's public IP (phức tạp hơn khi IP không cố định). Quyết định ưu tiên dùng VPC + endpoints vì đây là production pattern đúng và cần học.

**Kết nối Lambda → RDS:**
- Lambda cấu hình `VpcConfig` với subnet IDs và security group IDs
- Lambda dùng IAM Role (không cần NAT để gọi RDS vì RDS ở trong cùng VPC)
- Connection string lưu trong AWS Secrets Manager, Lambda lấy về **một lần duy nhất khi container khởi động** (cached trong global variable)

**Tại sao không dùng RDS Proxy:**
- RDS Proxy giải quyết vấn đề connection exhaustion khi nhiều Lambda instances cùng lúc tạo nhiều DB connections
- Mỗi Lambda instance giữ một connection → 100 concurrent Lambda = 100 connections → RDS max connections bị vượt
- Tuy nhiên RDS Proxy không có Free Tier (~\$0.015/hour per vCPU), chi phí không phù hợp cho học project
- Giải pháp thay thế trong project này: giới hạn concurrency của Lambda (reserved concurrency) + giải thích vấn đề trong report

---

### AWS Resources

| Resource | Tên | Cấu hình | Chi phí |
|---|---|---|---|
| S3 Bucket | `lambda-file-api-data` | SSE-S3, versioning off | Free Tier |
| S3 Notification | Input prefix filter | `input/` prefix ONLY, suffix `.xlsx` | Miễn phí |
| RDS PostgreSQL | `lambda-file-api-db` | db.t3.micro, 20GB, Single-AZ | Free Tier (12 tháng) |
| Secrets Manager | `lambda-file-api/db-credentials` | DB credentials | \$0.40/secret/month |
| Lambda | `lambda-file-api-s3-processor` | 512 MB, 120s, VPC | Free Tier |
| Lambda | `lambda-file-api-upload-to-s3` | 128 MB, 30s, VPC | Free Tier |
| Lambda | `lambda-file-api-file-query` | 256 MB, 30s, VPC | Free Tier |
| VPC Endpoint | S3 Gateway | Gateway type | Miễn phí |
| VPC Endpoints | Secrets Manager, SQS, SNS | Interface type | \$0.01/hour mỗi cái |
| IAM | inline policy trên execution role | S3, Secrets Manager | Miễn phí |

> **S3 Notification Filter (quan trọng – ngăn infinite loop):**  
> Cấu hình S3 Event Notification với `FilterRule`:  
> - Prefix: `input/`  
> - Suffix: `.xlsx`  
>
> File kết quả được upload vào `processed/` → không khớp prefix → Lambda KHÔNG được invoke → không có vòng lặp vô hạn.

### Lambda Functions mới

| Function | Handler | RAM | Timeout | VPC | Trigger |
|---|---|:---:|:---:|:---:|---|
| `lambda-file-api-s3-processor` | `handlers/s3Processor` | 512 MB | 120s | ✅ | S3 Event |
| `lambda-file-api-upload-to-s3` | `handlers/uploadToS3` | 128 MB | 30s | ✅ | API Gateway |
| `lambda-file-api-file-query` | `handlers/fileQuery` | 256 MB | 30s | ✅ | API Gateway |

### API Routes mới

```
POST /upload-to-s3          → Tạo file_job record (status=pending) + trả presigned URL
GET  /file/:id              → Trả trạng thái job và metadata từ PostgreSQL
GET  /file/:id/rows         → Trả extracted rows từ PostgreSQL (LIMIT 100, hỗ trợ offset)
```

### Infra Scripts

| Script | Mô tả |
|---|---|
| `infra/10-s3-rds.sh` | Tạo S3 Bucket (với notification filter), RDS instance, Security Groups, Secrets Manager, VPC Endpoints |
| `infra/11-db-schema.sh` | Chạy DDL SQL: tạo tables, indexes (tất cả 5 bảng) |
| `infra/12-s3-processor.sh` | Deploy 3 Lambda functions, cấu hình VPC, S3 Event trigger |
| `infra/13-s3-test.sh` | End-to-end tests (xem Test Scenarios) |
| `infra/19-cleanup-phase2.sh` | Xóa resources Phase 2 (Lambda, S3, RDS, Secrets Manager, VPC Endpoints, Security Groups) theo thứ tự ngược |

### Test Scenarios

**Normal flow:**
```bash
# 1. Tạo presigned URL (đồng thời tạo file_job record)
RESPONSE=$(curl -s -X POST $API_URL/upload-to-s3)
PRESIGNED_URL=$(echo $RESPONSE | jq -r '.uploadUrl')
FILE_ID=$(echo $RESPONSE | jq -r '.fileId')

# 2. Upload file lên S3 qua presigned URL
curl -X PUT "$PRESIGNED_URL" --data-binary @test-files/generated/medium-1000rows.xlsx

# 3. Chờ Lambda xử lý (~vài giây)
sleep 10

# 4. Verify: status phải là "processed"
STATUS=$(curl -s $API_URL/file/$FILE_ID | jq -r '.status')
echo "Status: $STATUS"  # → processed

# 5. Verify: rows phải có trong DB
ROW_COUNT=$(curl -s "$API_URL/file/$FILE_ID/rows" | jq '.rowCount')
echo "Rows: $ROW_COUNT"  # → 1000
```

**Idempotency – Concurrent duplicate events (quan trọng):**
```bash
# Mục tiêu: chứng minh conditional UPDATE là atomic, không phải SELECT-then-UPDATE

# 1. Lấy fileId đã tồn tại với status='pending'
FILE_ID="..."

# 2. Invoke Lambda processor với cùng event ĐỒNG THỜI (concurrent)
# (simulate S3 event delivered twice at the same time)
aws lambda invoke \
  --function-name lambda-file-api-s3-processor \
  --payload "{\"Records\":[{\"s3\":{\"bucket\":{\"name\":\"lambda-file-api-data\"},\"object\":{\"key\":\"input/$FILE_ID/original.xlsx\"}}}]}" \
  /tmp/output-a.json &

aws lambda invoke \
  --function-name lambda-file-api-s3-processor \
  --payload "{\"Records\":[{\"s3\":{\"bucket\":{\"name\":\"lambda-file-api-data\"},\"object\":{\"key\":\"input/$FILE_ID/original.xlsx\"}}}]}" \
  /tmp/output-b.json &

wait

# 3. Verify: chỉ có 1 set records trong DB (không phải 2)
ROW_COUNT=$(psql -t -c "SELECT COUNT(*) FROM file_records WHERE file_id='$FILE_ID'")
echo "Rows: $ROW_COUNT"  # Phải = số rows trong file, không phải gấp đôi

# 4. Verify: file_jobs status là 'processed' và chỉ có 1 job
psql -c "SELECT status, row_count FROM file_jobs WHERE file_id='$FILE_ID'"
```

**Failure – Transaction rollback:**
```bash
# Inject lỗi vào giữa quá trình insert rows (ví dụ: row malformed)
# → Toàn bộ transaction phải rollback
# → Status phải là 'failed', không có orphaned records trong file_records
psql -c "SELECT COUNT(*) FROM file_records WHERE file_id='$FILE_ID'"  # → 0
psql -c "SELECT status FROM file_jobs WHERE file_id='$FILE_ID'"       # → failed
```

**Infinite loop prevention:**
```bash
# Upload một file thử lên processed/ → xác nhận Lambda KHÔNG được invoke
aws s3 cp test-files/generated/small-10rows.xlsx \
  s3://lambda-file-api-data/processed/loop-test/result.xlsx

# Chờ 10 giây, verify không có invocation mới
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=lambda-file-api-s3-processor \
  --start-time $(date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Sum
# → Sum phải = 0 (không có invocation nào từ processed/)
```

### Concepts học được

1. **S3 Event delivery semantics**: at-least-once, không phải exactly-once → phải handle idempotency bằng atomic UPDATE
2. **Conditional UPDATE thay cho SELECT-then-check**: atomic claim ngăn race condition giữa concurrent instances
3. **State machine cho processing pipeline**: tại sao cần trạng thái `uploading` giữa DB commit và SNS publish
4. **Presigned URL**: client upload trực tiếp lên S3 mà không qua Lambda → không bị giới hạn 4.5 MiB
5. **Lambda in VPC**: trade-offs (cold start chậm hơn, cần VPC Endpoints để reach AWS services), chỉ dùng khi cần thiết
6. **PostgreSQL transactions**: BEGIN / COMMIT / ROLLBACK, tại sao cần atomic insert, ON CONFLICT DO NOTHING
7. **Lightweight transactional outbox**: ghi intent trước khi thực hiện, retry từ persistent state
8. **Connection management từ Lambda**: vấn đề connection exhaustion, tại sao cần pool hoặc limit concurrency

### Completion Criteria

- [ ] Upload Excel lên S3 → S3 Event trigger Lambda → data xuất hiện trong PostgreSQL với `status='processed'`, `processed_at` được ghi
- [ ] Result file xuất hiện tại `processed/{fileId}/result.xlsx`
- [ ] Atomic claim: invoke cùng event 2 lần đồng thời → chỉ có 1 set records trong DB
- [ ] Transaction: lỗi giữa chừng → ROLLBACK, không có orphaned records, `status='failed'`
- [ ] Query API trả đúng status và rows
- [ ] Infinite loop test: upload vào `processed/` → Lambda không được trigger

---

## Phase 3 – SQS + DLQ 🔲

### Tại sao cần Phase này?

S3 Event (Phase 2) xử lý file tự động ngay khi upload. SQS giải quyết bài toán khác: **explicit reprocessing requests** – client muốn chủ động yêu cầu xử lý lại một file đã upload (ví dụ: file trước xử lý failed, hoặc cần reprocess với config khác).

Đây là hai workflow tách biệt với vai trò khác nhau:

| | S3 Event (Phase 2) | SQS Job Queue (Phase 3) |
|---|---|---|
| **Trigger** | File upload tự động | Client gọi POST /process-job |
| **Use case** | Lần đầu xử lý file mới | Reprocess / retry file đã có |
| **Control** | Không có – S3 trigger ngay | Có – queue, rate limit, DLQ |
| **Shared logic** | ✅ | ✅ (cùng Excel processing code) |

**Shared Processing Logic:**

Cả `s3-processor` (Phase 2) và `job-consumer` (Phase 3) đều dùng cùng một hàm xử lý Excel core:

```typescript
// src/lib/processExcelFile.ts  ← shared library
export async function processExcelFile(fileId: string, s3Key: string, db: Pool): Promise<ProcessResult> {
  // 1. Download từ S3
  // 2. Parse Excel
  // 3. Transaction: INSERT file_records + UPDATE file_jobs status='uploading', finished_at=NOW()
  // 4. Upload result lên S3 processed/{fileId}/result.xlsx
  // 5. (Phase 4+ nếu SNS_TOPIC_ARN được set): INSERT outbox → publish SNS → UPDATE outbox='published'
  //    (Nếu SNS fail ở Phase 4+, giữ file_jobs.status='uploading' để Phase 5 recovery xử lý)
  // 6. UPDATE file_jobs SET status='processed', processed_key=..., processed_at=NOW()
  // return { rowCount, processedKey }
}

// s3Processor.ts → atomic claim file_jobs ('pending' → 'processing') → gọi processExcelFile()
// jobConsumer.ts → claim processing_jobs (jobId) + claim file_jobs → gọi processExcelFile()
```

Không duplicate logic. Chỉ có cách trigger và cách claim job là khác nhau.

**Câu hỏi kỹ thuật cần trả lời:**
- Visibility Timeout là gì và tại sao phải set đúng giá trị?
- Tại sao message có thể bị xử lý nhiều hơn 1 lần (at-least-once)?
- DLQ khác Dead-letter target của Lambda thế nào?
- Làm thế nào để xử lý idempotency khi message có thể duplicate?

---

### Scenario cụ thể

> File Excel đã upload lên S3 (ví dụ: trước đây xử lý failed). Client muốn retry/reprocess.

```
Client: POST /process-job { "fileId": "...", "options": {} }
  │
  ▼
Lambda: lambda-file-api-job-producer  ← API route, VPC (cần RDS)
  │
  ├── Validate: fileId tồn tại trong DB
  ├── Validate: status là 'pending', 'failed', hoặc 'timeout' (không queue file đang 'processing'/'uploading')
  ├── Atomic reset: UPDATE file_jobs
  │     SET status='pending', started_at=NULL, finished_at=NULL, processed_at=NULL, error_message=NULL
  │     WHERE file_id=$1 AND status IN ('failed', 'timeout')
  ├── SQS SendMessage: { fileId, s3Key, jobId (UUID), enqueuedAt, requestedBy: 'api' }
  └── Trả ngay: { jobId, status: 'queued', pollUrl: '/file/{fileId}' }

SQS Queue: lambda-file-api-jobs
  Visibility Timeout: 180s   ← > job-consumer Lambda timeout (150s) + buffer
  Max Receive Count: 3
  DLQ: lambda-file-api-jobs-dlq (retention: 7 days)
  │
  ▼
Lambda: lambda-file-api-job-consumer  ← SQS Event Source Mapping, VPC
  Batch size: 1   ← 1 message = 1 file (error isolation)
  Timeout: 150s   ← < Visibility Timeout (180s)
  │
  ├── [1] Parse message: fileId, s3Key, jobId
  ├── [2] Claim/Idempotency trong processing_jobs:
  │       - Chưa có jobId → INSERT (status='processing', attempts=1)
  │       - Đã có với status='completed' → return (duplicate, bỏ qua an toàn)
  │       - Đã có với status='failed' hoặc stale 'processing' (> 150s) → UPDATE status='processing', attempts+1
  │       - Đã có với status='processing' (< 150s) → throw error (đang chạy ở worker khác, để SQS retry sau)
  ├── [3] Atomic claim file_jobs:
  │       UPDATE file_jobs SET status='processing', started_at=NOW(), error_message=NULL
  │       WHERE file_id=$1 AND status IN ('pending', 'failed', 'timeout')
  ├── [4] Gọi processExcelFile(fileId, s3Key, db)  ← shared logic
  │       → Nếu thành công: UPDATE processing_jobs SET status='completed', completed_at=NOW()
  └── Nếu lỗi → UPDATE processing_jobs SET status='failed', updated_at=NOW()
             → UPDATE file_jobs SET status='failed', error_message=$err
             → throw error → SQS retry → sau 3 lần → DLQ

Admin (AWS CLI):
  aws sqs receive-message --queue-url $DLQ_URL         → Xem messages trong DLQ
  aws sqs start-message-move-task --source-arn $DLQ_ARN → Redrive messages từ DLQ về main queue
```

**Tại sao Visibility Timeout = 180s và Lambda timeout = 150s:**

Nếu Lambda timeout = Visibility Timeout, message reappear trong queue ngay khi Lambda đang chạy → message bị xử lý 2 lần song song. Luôn set Visibility Timeout > Lambda timeout + buffer (~30s).

**Message structure:**
```json
{
  "jobId": "uuid-v4",       ← idempotency key (unique per enqueue)
  "fileId": "uuid-v4",      ← FK đến file_jobs
  "s3Key": "input/{fileId}/original.xlsx",
  "enqueuedAt": "ISO8601",
  "requestedBy": "api"      ← 'api' | 'dlq-redrive' | 'manual'
}
```

**SQS Producer vs Consumer responsibilities:**

| | Producer (`job-producer`) | Consumer (`job-consumer`) |
|---|---|---|
| Responsibility | Validate + enqueue + return fast | Process file end-to-end |
| DB access | Validate fileId exists & reset status | Full read/write |
| SQS | SendMessage | ReceiveMessage (via ESM) + DeleteMessage (auto) |
| VPC | ✅ Cần (RDS) | ✅ Cần (RDS) |

---

### Idempotency và Retry với SQS

**Vấn đề:**
1. SQS at-least-once delivery có thể deliver cùng message nhiều lần.
2. Nếu chỉ `INSERT INTO processing_jobs (job_id) ON CONFLICT DO NOTHING` rồi xử lý: khi lần chạy đầu **thất bại**, SQS redeliver cùng `jobId`, consumer thấy `jobId` đã tồn tại và return success → SQS xóa message, **job lỗi sẽ không bao giờ được retry hay vào DLQ!**

**Giải pháp: `processing_jobs` theo dõi trạng thái (`processing | completed | failed`)**

```sql
-- Bảng idempotency & retry state cho SQS consumer (Phase 3)
CREATE TABLE processing_jobs (
  job_id       UUID PRIMARY KEY,
  file_id      UUID NOT NULL REFERENCES file_jobs(file_id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'processing', -- processing | completed | failed
  attempts     INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT valid_processing_job_status CHECK (status IN ('processing', 'completed', 'failed'))
);
```

```typescript
// Consumer logic: phân biệt job đã completed với job failed / stale cần retry
const claimed = await db.query(
  `INSERT INTO processing_jobs (job_id, file_id, status, attempts)
   VALUES ($1, $2, 'processing', 1)
   ON CONFLICT (job_id) DO UPDATE
     SET status = 'processing',
         attempts = processing_jobs.attempts + 1,
         updated_at = NOW()
   WHERE processing_jobs.status = 'failed'
      OR (processing_jobs.status = 'processing'
          AND processing_jobs.updated_at < NOW() - INTERVAL '150 seconds')
   RETURNING job_id, attempts`,
  [message.jobId, message.fileId]
);

if (claimed.rowCount === 0) {
  const existing = await db.query(
    'SELECT status FROM processing_jobs WHERE job_id = $1',
    [message.jobId]
  );
  if (existing.rows[0]?.status === 'completed') {
    console.log(`Duplicate message, jobId=${message.jobId} already completed`);
    return; // SQS xóa message an toàn
  }
  // Đang 'processing' và còn hạn (< 150s) ở worker khác → throw để SQS retry sau Visibility Timeout
  throw new Error(`jobId=${message.jobId} is currently in progress`);
}

try {
  // Claim file_jobs + gọi processExcelFile(message.fileId, message.s3Key, db)
  await db.query(
    `UPDATE processing_jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE job_id = $1`,
    [message.jobId]
  );
} catch (err) {
  await db.query(
    `UPDATE processing_jobs SET status = 'failed', updated_at = NOW() WHERE job_id = $1`,
    [message.jobId]
  );
  await db.query(
    `UPDATE file_jobs SET status = 'failed', error_message = $2
     WHERE file_id = $1 AND status IN ('pending', 'processing')`,
    [message.fileId, err.message]
  );
  throw err; // Quan trọng: throw để SQS retry (tối đa 3 lần) rồi đẩy sang DLQ
}
```

> **Lưu ý:** `processing_jobs` khác với `file_jobs`. Một `fileId` có thể được queue nhiều lần (mỗi lần là một `jobId` khác nhau). `processing_jobs` đảm bảo mỗi `jobId` chỉ chạy thành công một lần, nhưng vẫn cho phép SQS retry khi `status='failed'` hoặc worker crash quá Lambda timeout (`150s`).

---

### AWS Resources

| Resource | Tên | Cấu hình |
|---|---|---|
| SQS Queue | `lambda-file-api-jobs` | Standard, Visibility **180s**, Retention 4 days |
| SQS DLQ | `lambda-file-api-jobs-dlq` | Standard, Retention 7 days |
| Lambda | `lambda-file-api-job-producer` | 128 MB, 30s, VPC |
| Lambda | `lambda-file-api-job-consumer` | 512 MB, **150s**, VPC |
| IAM | SQS SendMessage, ReceiveMessage, DeleteMessage | inline policy |

### Infra Scripts

| Script | Mô tả |
|---|---|
| `infra/20-sqs.sh` | Tạo SQS queue + DLQ, cấu hình redrive policy |
| `infra/21-sqs-lambdas.sh` | Deploy producer + consumer, cấu hình Event Source Mapping |
| `infra/22-sqs-test.sh` | End-to-end test + duplicate message test + DLQ test |
| `infra/29-cleanup-phase3.sh` | Xóa SQS queues + Lambda functions Phase 3 |

### Test Scenarios

**Normal flow:**
```bash
# Submit job cho file đã có status='failed' (hoặc 'pending')
JOB=$(curl -s -X POST $API_URL/process-job -d "{\"fileId\":\"$FILE_ID\"}")
JOB_ID=$(echo $JOB | jq -r '.jobId')

# Poll status
sleep 15
curl $API_URL/file/$FILE_ID | jq '.status'  # → "processed"
```

**Duplicate message idempotency (meaningful test):**
```bash
# Mục tiêu: gửi cùng SQS message 2 lần, verify chỉ xử lý 1 lần

JOB_ID=$(uuidgen)
FILE_ID="..."  # file với status=pending

# Gửi message 1
aws sqs send-message \
  --queue-url $QUEUE_URL \
  --message-body "{\"jobId\":\"$JOB_ID\",\"fileId\":\"$FILE_ID\",\"s3Key\":\"input/$FILE_ID/original.xlsx\"}"

# Gửi lại message với CÙNG jobId (simulate duplicate)
aws sqs send-message \
  --queue-url $QUEUE_URL \
  --message-body "{\"jobId\":\"$JOB_ID\",\"fileId\":\"$FILE_ID\",\"s3Key\":\"input/$FILE_ID/original.xlsx\"}"

# Chờ cả 2 messages được consume
sleep 30

# Verify: processing_jobs chỉ có 1 record cho jobId này
psql -c "SELECT COUNT(*) FROM processing_jobs WHERE job_id='$JOB_ID'"  # → 1

# Verify: file_records không bị duplicate
psql -c "SELECT COUNT(*) FROM file_records WHERE file_id='$FILE_ID'"   # → đúng N rows, không phải 2N
```

**Reprocessing không trigger S3 Event loop:**
```bash
# Khi job-consumer upload result lên processed/ → S3 không trigger event
# (đã được đảm bảo bởi S3 notification filter từ Phase 2)
# Verify: không có invocation mới của s3-processor sau khi job-consumer upload
```

**Visibility Timeout experiment:**
```bash
# 1. Submit job
# 2. Set reserved concurrency = 0 (dừng consumer)
aws lambda put-function-concurrency \
  --function-name lambda-file-api-job-consumer \
  --reserved-concurrent-executions 0
# 3. Message xuất hiện trong queue
aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names ApproximateNumberOfMessages
# 4. Enable lại Lambda sau > Visibility Timeout seconds
aws lambda put-function-concurrency \
  --function-name lambda-file-api-job-consumer \
  --reserved-concurrent-executions 1
# 5. Xác nhận message được xử lý (không bị lost)
```

**DLQ test:**
```bash
# 1. Consumer throw error với fileId cụ thể (inject via env var FORCE_FAIL_FILE_ID)
# 2. Submit job với fileId đó
# 3. Sau 3 lần retry (Visibility Timeout × 3 ≈ 540s), message vào DLQ
# 4. Inspect DLQ
aws sqs receive-message --queue-url $DLQ_URL --max-number-of-messages 10
# 5. Fix consumer, redrive
aws sqs start-message-move-task --source-arn $DLQ_ARN
```

### Concepts học được

1. **At-least-once delivery**: SQS không đảm bảo exactly-once → phải thiết kế idempotent consumer bằng idempotency key table
2. **Visibility Timeout**: phải lớn hơn Lambda timeout; công thức: `VisibilityTimeout > LambdaTimeout + 30s`
3. **DLQ vs Lambda Destination**: DLQ là safety net cho message, không phải cho Lambda execution failure
4. **Message redrive**: quy trình điều tra và phục hồi message lỗi
5. **SQS batch size 1 vs N**: trade-off giữa throughput và error isolation
6. **S3 Event vs SQS**: hai trigger cho hai use case khác nhau; shared processing logic tránh duplication
7. **Idempotency key table**: cách đảm bảo exactly-once processing từ at-least-once delivery

### Completion Criteria

- [ ] POST /process-job trả response ngay (không block chờ processing)
- [ ] Consumer xử lý job, status cập nhật trong PostgreSQL
- [ ] Duplicate message với cùng jobId đã `completed`: consumer bỏ qua lần 2 (`processing_jobs` table)
- [ ] Retry khi lỗi: lần 1 `failed` → SQS redeliver cùng `jobId` → consumer vẫn retry được (không bị skip) và đẩy sang DLQ sau 3 lần → có thể redrive
- [ ] Visibility Timeout: nếu consumer bị kill giữa chừng, message reappear và được retry
- [ ] Reprocessing không trigger S3 Event loop

---

## Phase 4 – SNS → SQS Fan-out 🔲

### Tại sao cần Phase này?

Sau khi một file được xử lý xong, nhiều thành phần khác cần biết:
- **Audit system** cần ghi log event vào PostgreSQL
- **Summary system** cần cập nhật thống kê ngày hôm nay

Có 2 cách làm:
1. Consumer tự gọi trực tiếp cả 2 hệ thống → coupling chặt, nếu một hệ thống chậm thì cả pipeline chậm
2. Consumer publish một SNS event → SNS fan-out đến 2 SQS queues độc lập → mỗi queue có consumer riêng

SNS giải quyết bài toán **one-to-many event distribution**: publisher không cần biết có bao nhiêu subscriber, mỗi subscriber xử lý độc lập, lỗi ở subscriber A không ảnh hưởng subscriber B.

**Câu hỏi kỹ thuật cần trả lời:**
- SNS khác SQS thế nào về đảm bảo delivery?
- Tại sao dùng SNS → SQS thay vì SNS → Lambda trực tiếp?
- SNS Message Filtering hoạt động thế nào?
- Failure isolation: subscriber A fail, subscriber B có nhận được message không?
- SNS publish fail được phát hiện và retry thế nào? (xem Outbox ở Phase 2)

---

### SNS Publisher: Ai publish và khi nào?

SNS được kích hoạt từ **Phase 4** bằng cách cấu hình `SNS_TOPIC_ARN` cho `s3-processor` (Phase 2) và `job-consumer` (Phase 3), thông qua shared processing logic (`processExcelFile`). Không có Lambda riêng chỉ để publish SNS.

**Điều kiện publish SNS:**
- Chỉ publish **sau khi** DB commit thành công VÀ result file đã được upload lên S3
- Status của `file_job` tại thời điểm publish: `uploading`
- SNS payload (chứa `eventId` UUID ổn định) được ghi vào `outbox` table TRƯỚC khi gọi `sns.publish()`
- Nếu publish thành công: `outbox.status` → `published`, `file_jobs.status` → `processed` (`processed_at = NOW()`)
- Nếu publish fail: `outbox.status` giữ `pending`, `file_jobs.status` giữ `uploading` → Phase 5 recovery retry

---

### Scenario cụ thể

```
s3-processor / job-consumer (shared processExcelFile khi SNS_TOPIC_ARN được set)
  │ Sau khi DB commit + upload S3 + ghi outbox (eventId)
  │
  ▼
SNS Topic: lambda-file-api-file-processed
  MessageAttributes: { "status": { DataType: "String", StringValue: "processed" | "failed" } }
  Body: { eventId, fileId, rowCount, processedAt, s3Key }
  │
  ├── Subscription 1: SQS lambda-file-api-audit-queue
  │   Filter Policy: { "status": ["processed", "failed"] }  ← nhận tất cả kết quả
  │   │
  │   ▼
  │   Lambda: lambda-file-api-audit-consumer  ← SQS Event Source Mapping, VPC
  │   └── BEGIN TRANSACTION
  │         INSERT INTO consumer_processed_events (consumer_name, event_id, file_id)
  │           VALUES ('audit-consumer', eventId, fileId) ON CONFLICT DO NOTHING
  │         → Nếu 0 rows → COMMIT & return (duplicate)
  │         INSERT INTO audit_logs (event_type='FILE_PROCESSED', file_id, message)
  │       COMMIT
  │
  └── Subscription 2: SQS lambda-file-api-summary-queue
      Filter Policy: { "status": ["processed"] }  ← chỉ nhận khi thành công
      │
      ▼
      Lambda: lambda-file-api-summary-consumer  ← SQS Event Source Mapping, VPC
      └── BEGIN TRANSACTION
            INSERT INTO consumer_processed_events (consumer_name, event_id, file_id)
              VALUES ('summary-consumer', eventId, fileId) ON CONFLICT DO NOTHING
            → Nếu 0 rows → COMMIT & return (duplicate)
            INSERT INTO daily_summaries (summary_date, files_processed, total_rows)
              VALUES (CURRENT_DATE, 1, rowCount)
              ON CONFLICT (summary_date) DO UPDATE
              SET files_processed = daily_summaries.files_processed + 1,
                  total_rows = daily_summaries.total_rows + EXCLUDED.total_rows,
                  updated_at = NOW()
          COMMIT
```

**Idempotency của `audit-consumer` và `summary-consumer`:**

- Một `UPSERT` dạng `files_processed = files_processed + 1` **KHÔNG** tự nhiên idempotent: nếu chạy 2 lần sẽ cộng `+2`.
- Một file có thể được reprocess nhiều lần ở Phase 3 (mỗi lần tạo một event mới), nên cũng không thể dedup chỉ bằng `(file_id, event_type)`.
- Nếu dùng `SNS MessageId` hoặc `SQS MessageId`: khi Outbox retry gọi `sns.publish()` lần 2, SNS sẽ cấp **MessageId mới** → consumer sẽ không nhận ra duplicate!
- **Giải pháp chuẩn:** dùng bảng `consumer_processed_events` với khóa chính `(consumer_name, event_id)`, trong đó `event_id` là `outbox.event_id` cố định nằm trong payload:
  - `audit-consumer` và `summary-consumer` có `consumer_name` khác nhau → kiểm tra và xử lý **hoàn toàn độc lập** cho cùng một `event_id`.
  - Việc insert vào `consumer_processed_events` và ghi `audit_logs` / `daily_summaries` nằm trong **cùng một PostgreSQL transaction** → nếu consumer crash giữa chừng, cả hai đều rollback để SQS retry; nếu commit xong mà bị deliver lại (do SQS hoặc Outbox at-least-once), `ON CONFLICT DO NOTHING` trả 0 rows và bỏ qua an toàn.

**Tại sao SNS → SQS thay vì SNS → Lambda trực tiếp:**
- SNS → Lambda invoke là synchronous từ góc độ SNS; nếu Lambda throttled, SNS retry nhưng có giới hạn
- SNS → SQS → Lambda: message được buffer trong SQS, không bị mất nếu Lambda throttled
- SQS cũng có DLQ cho từng subscription queue → failure isolation tốt hơn

---

### AWS Resources

| Resource | Tên | Cấu hình |
|---|---|---|
| SNS Topic | `lambda-file-api-file-processed` | Standard Topic |
| SQS Queue | `lambda-file-api-audit-queue` | Visibility 60s, với DLQ |
| SQS Queue | `lambda-file-api-summary-queue` | Visibility 60s, với DLQ |
| SQS DLQ | `lambda-file-api-audit-dlq` | Retention 7 days |
| SQS DLQ | `lambda-file-api-summary-dlq` | Retention 7 days |
| Lambda | `lambda-file-api-audit-consumer` | 128 MB, 30s, VPC |
| Lambda | `lambda-file-api-summary-consumer` | 128 MB, 30s, VPC |
| SNS Subscription | audit-queue subscription | Filter: status IN [processed, failed] |
| SNS Subscription | summary-queue subscription | Filter: status = processed |

### Infra Scripts

| Script | Mô tả |
|---|---|
| `infra/30-sns.sh` | Tạo SNS Topic, 2 SQS queues + DLQs, subscriptions + filter policies |
| `infra/31-sns-lambdas.sh` | Deploy 2 consumer Lambdas + SQS Event Source Mapping |
| `infra/32-sns-test.sh` | Test: 1 SNS publish → 2 consumers → verify PostgreSQL |
| `infra/39-cleanup-phase4.sh` | Xóa SNS, SQS queues, Lambda functions Phase 4 |

### Test Scenarios

**Fan-out verification:**
```bash
# 1. Dùng một FILE_ID (UUID) đã tồn tại trong file_jobs (hoặc tạo row test trong file_jobs)
FILE_ID=$(uuidgen)
EVENT_ID=$(uuidgen)
psql -c "INSERT INTO file_jobs (file_id, original_key, status) VALUES ('$FILE_ID', 'input/$FILE_ID/original.xlsx', 'processed')"

aws sns publish \
  --topic-arn $SNS_ARN \
  --message "{\"eventId\":\"$EVENT_ID\",\"fileId\":\"$FILE_ID\",\"rowCount\":100,\"processedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
  --message-attributes "{\"status\":{\"DataType\":\"String\",\"StringValue\":\"processed\"}}"

# 2. Chờ cả 2 consumers xử lý
sleep 15

# 3. Verify audit log được ghi
psql -c "SELECT event_type, message FROM audit_logs WHERE file_id='$FILE_ID'"

# 4. Verify daily summary được cập nhật
psql -c "SELECT * FROM daily_summaries WHERE summary_date = CURRENT_DATE"
```

**Idempotency – Duplicate SNS message (cùng `eventId`):**
```bash
# Publish cùng payload với CÙNG eventId 2 lần (simulate outbox retry hoặc duplicate delivery)
# Verify: consumer_processed_events có đúng 1 row cho ('audit-consumer', EVENT_ID) và 1 row cho ('summary-consumer', EVENT_ID)
# Verify: audit_logs chỉ có 1 record cho FILE_ID (không phải 2)
# Verify: daily_summaries.files_processed tăng 1, không phải 2
```

**Outbox failure detection (Phase 4):**
```bash
# 1. Tạm cấu hình SNS_TOPIC_ARN không hợp lệ trên s3-processor
# 2. Upload file → DB commit thành công → outbox record tạo ra với status='pending'
psql -c "SELECT status, attempts FROM outbox WHERE file_id='$FILE_ID'"  # → pending, 0
# 3. Status của file_job: giữ ở 'uploading' (chưa thành 'processed')
psql -c "SELECT status FROM file_jobs WHERE file_id='$FILE_ID'"        # → uploading
# 4. Khôi phục SNS_TOPIC_ARN đúng (Phase 5 recovery sẽ retry outbox record này)
```

**Failure isolation:**
```bash
# 1. Tắt summary-consumer Lambda
aws lambda put-function-concurrency \
  --function-name lambda-file-api-summary-consumer \
  --reserved-concurrent-executions 0
# 2. Publish SNS message
# 3. Xác nhận audit-consumer vẫn xử lý được (không bị ảnh hưởng)
psql -c "SELECT COUNT(*) FROM audit_logs WHERE created_at > NOW() - INTERVAL '1 minute'"  # → 1
# 4. Summary message nằm trong SQS summary-queue
aws sqs get-queue-attributes --queue-url $SUMMARY_QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages
# 5. Bật lại summary-consumer → xử lý message từ queue
```

**Message filter:**
```bash
# 1. Publish với status=failed (dùng UUID hợp lệ)
FAIL_FILE_ID=$(uuidgen)
FAIL_EVENT_ID=$(uuidgen)
aws sns publish \
  --topic-arn $SNS_ARN \
  --message "{\"eventId\":\"$FAIL_EVENT_ID\",\"fileId\":\"$FAIL_FILE_ID\",\"rowCount\":0}" \
  --message-attributes "{\"status\":{\"DataType\":\"String\",\"StringValue\":\"failed\"}}"
# 2. Chờ
sleep 10
# 3. audit-consumer nhận (filter cho phép failed) → audit_log được ghi
psql -c "SELECT COUNT(*) FROM audit_logs WHERE message LIKE '%$FAIL_FILE_ID%'"  # → 1
# 4. summary-consumer KHÔNG nhận (filter chỉ cho processed) → summary không thay đổi
aws sqs get-queue-attributes --queue-url $SUMMARY_QUEUE_URL \
  --attribute-names ApproximateNumberOfMessagesNotVisible  # → 0
```

### Concepts học được

1. **SNS vs SQS**: SNS là pub/sub notification, SQS là durable message queue – khác nhau về semantics
2. **Fan-out pattern**: một event phân phối đến nhiều consumers độc lập
3. **SNS → SQS vs SNS → Lambda**: buffering và retry behavior khác nhau
4. **Message Attributes và Filter Policy**: subscriber chỉ nhận message phù hợp với filter
5. **Failure isolation**: DLQ riêng cho mỗi subscription queue → lỗi ở queue A không ảnh hưởng queue B
6. **Idempotent UPSERT**: `ON CONFLICT DO UPDATE` cho aggregate tables, nhưng vẫn cần idempotency key cho increment operations
7. **Outbox pattern**: SNS publish reliability khi DB và SNS không thể participate trong cùng transaction

### Completion Criteria

- [ ] 1 SNS publish → 2 SQS queues đều nhận message
- [ ] Message filter: `status=failed` chỉ đến `audit-queue`, không đến `summary-queue`
- [ ] Failure isolation: tắt `summary-consumer` → `audit-consumer` vẫn hoạt động
- [ ] Idempotency: duplicate message (cùng `eventId`) → mỗi consumer chỉ xử lý 1 lần nhờ `consumer_processed_events`
- [ ] Outbox: khi SNS fail → `outbox.status='pending'`, `file_jobs.status='uploading'`
- [ ] Data đúng trong PostgreSQL: `audit_logs` và `daily_summaries`

---

## Phase 5 – EventBridge Scheduler 🔲

### Tại sao cần Phase này?

Một số task không cần trigger bởi event mà cần chạy định kỳ:
1. **Maintenance**: xóa audit logs cũ hơn 30 ngày khỏi PostgreSQL (database hygiene)
2. **Stuck job detection**: tìm các file_jobs có status='processing' hoặc 'uploading' nhưng started_at > 1 giờ trước → khả năng Lambda processor crash mà không update status → đánh dấu 'timeout'
3. **Outbox retry**: tìm các outbox records với status='pending' và created_at > 5 phút trước → retry SNS publish

EventBridge Scheduler là managed cron service: không cần EC2 chạy 24/7, không cần maintain cron job, có retry policy, có execution history.

**Câu hỏi kỹ thuật cần trả lời:**
- Cron expression trên EventBridge khác gì với Unix cron?
- Flexible time window là gì và tại sao có thể cần?
- IAM role của Scheduler khác role của Lambda thế nào?
- Làm thế nào giám sát execution history và phát hiện lỗi?

---

### Scenario cụ thể

Dùng **1 Lambda function** (`lambda-file-api-maintenance`) với **2 EventBridge Scheduler schedules** tách biệt theo tần suất hợp lý (không cần thêm service):

1. **`lambda-file-api-daily-maintenance`**: `cron(0 1 * * ? *)` (1:00 AM UTC, flexible window 15 minutes) → chạy `cleanup_audit` + ghi `MAINTENANCE_RUN`.
2. **`lambda-file-api-outbox-recovery`**: `rate(5 minutes)` (flexible window off) → chạy `detect_stuck` + `outbox_retry`.
   - **Độ trễ recovery thực tế:** Outbox records có `created_at < NOW() - INTERVAL '5 minutes'` sẽ được phát hiện và retry trong vòng **5–10 phút** (5 phút ngưỡng tuổi + tối đa 5 phút chu kỳ schedule), nhất quán với yêu cầu recovery trong vài phút.

```
EventBridge Scheduler 1: lambda-file-api-daily-maintenance
  Schedule: cron(0 1 * * ? *)  ← 1:00 AM UTC = 8:00 AM ICT
  Payload:  { "mode": "daily" }
  Flexible window: 15 minutes  ← AWS chạy trong khoảng 1:00–1:15 AM UTC
  Retry: 2 lần nếu Lambda lỗi

EventBridge Scheduler 2: lambda-file-api-outbox-recovery
  Schedule: rate(5 minutes)
  Payload:  { "mode": "recovery" }
  Retry: 2 lần nếu Lambda lỗi

Lambda: lambda-file-api-maintenance  ← 256 MB, 300s, VPC
  │
  ├── [Mode: daily] Cleanup audit logs + ghi execution record
  │   DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '30 days'
  │   INSERT INTO audit_logs (event_type='MAINTENANCE_RUN', message=JSON.stringify(summary))
  │   Log: { deletedRows: N, task: 'cleanup_audit' }
  │
  └── [Mode: recovery] (hoặc chạy cả 2 khi manual invoke không truyền mode)
      ├── [Task A] Detect và timeout stuck jobs
      │   UPDATE file_jobs
      │   SET status = 'timeout', error_message = 'processing exceeded 1 hour'
      │   WHERE status IN ('processing', 'uploading')     ← cả 2 trạng thái
      │     AND started_at < NOW() - INTERVAL '1 hour'
      │   RETURNING file_id
      │   Log: { stuckJobs: [fileIds], task: 'detect_stuck' }
      │
      └── [Task B] Retry pending outbox records (tối đa 3 attempts)
          SELECT * FROM outbox WHERE status = 'pending'
            AND created_at < NOW() - INTERVAL '5 minutes'
          FOR EACH record:
            retry sns.publish(record.payload)
            → thành công → UPDATE outbox SET status='published', published_at=NOW(), updated_at=NOW() WHERE id=record.id
                        → UPDATE file_jobs SET status='processed', processed_at=NOW()
                          WHERE file_id=record.file_id AND status='uploading'
            → thất bại  → UPDATE outbox
                          SET attempts = attempts + 1,
                              last_error = $err,
                              updated_at = NOW(),
                              status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END
                          WHERE id=record.id
          Log: { retriedCount, successCount, failedCount, task: 'outbox_retry' }
```

> **Lưu ý:** Chỉ cần 1 Lambda function với 2 schedules khác nhau bằng payload `mode`. Không cần tạo Lambda riêng cho từng task.

---

### AWS Resources

| Resource | Tên | Cấu hình |
|---|---|---|
| EventBridge Scheduler | `lambda-file-api-daily-maintenance` | `cron(0 1 * * ? *)`, Flexible 15 min, `{"mode":"daily"}` |
| EventBridge Scheduler | `lambda-file-api-outbox-recovery` | `rate(5 minutes)`, `{"mode":"recovery"}` |
| Lambda | `lambda-file-api-maintenance` | 256 MB, 300s, VPC |
| IAM Role | `lambda-file-api-scheduler-role` | `scheduler.amazonaws.com` AssumeRole, `lambda:InvokeFunction` |

### Infra Scripts

| Script | Mô tả |
|---|---|
| `infra/40-scheduler.sh` | Tạo Lambda + 2 Schedules + IAM role cho Scheduler |
| `infra/41-scheduler-test.sh` | Manual invoke Lambda, verify PostgreSQL, test stuck job detection, test outbox retry |
| `infra/49-cleanup-phase5.sh` | Xóa cả 2 EventBridge Schedules + Scheduler IAM role + Lambda maintenance |

### Test Scenarios

**Manual invoke (không cần đợi lịch):**
```bash
aws lambda invoke \
  --function-name lambda-file-api-maintenance \
  --payload '{"source":"manual-test"}' \
  /tmp/maintenance-output.json
cat /tmp/maintenance-output.json
```

**Stuck job detection:**
```bash
# 1. Insert file_job giả với status='processing', started_at = 2 giờ trước
psql -c "INSERT INTO file_jobs (file_id, original_key, status, started_at)
         VALUES (gen_random_uuid(), 'input/stuck.xlsx', 'processing', NOW() - INTERVAL '2 hours')"

# 2. Invoke Lambda
# 3. Verify: status phải là 'timeout'
psql -c "SELECT status, error_message FROM file_jobs WHERE original_key = 'input/stuck.xlsx'"
```

**Outbox retry test:**
```bash
# 1. Tạo file_job với status='uploading' và outbox record giả với status='pending', created_at = 10 phút trước
FILE_ID=$(uuidgen)
EVENT_ID=$(uuidgen)
psql -c "INSERT INTO file_jobs (file_id, original_key, status) VALUES ('$FILE_ID', 'input/$FILE_ID/original.xlsx', 'uploading')"
psql -c "INSERT INTO outbox (event_id, file_id, payload, status, created_at)
         VALUES ('$EVENT_ID', '$FILE_ID',
                 '{\"eventId\":\"$EVENT_ID\",\"fileId\":\"$FILE_ID\",\"rowCount\":100}'::jsonb,
                 'pending',
                 NOW() - INTERVAL '10 minutes')"

# 2. Invoke maintenance Lambda (mode=recovery)
# 3. Verify: outbox record → published
psql -c "SELECT status, attempts, published_at FROM outbox WHERE file_id='$FILE_ID'"  # → published
# 4. Verify: file_job → processed, processed_at được set
psql -c "SELECT status, processed_at FROM file_jobs WHERE file_id='$FILE_ID'"         # → processed
```

**Scheduler execution history:**
```bash
aws scheduler get-schedule --name lambda-file-api-daily-maintenance
aws scheduler get-schedule --name lambda-file-api-outbox-recovery
```

### Concepts học được

1. **Cron expression trên EventBridge**: `cron(Minutes Hours Day-of-month Month Day-of-week Year)` – 7 fields, khác Unix cron 5 fields
2. **Flexible time window**: AWS phân phối execution trong 1 cửa sổ thời gian → tránh thundering herd
3. **Scheduler IAM Role**: role dành cho Scheduler service để invoke Lambda, khác với Lambda execution role
4. **Maintenance-as-code**: scheduled task được define trong infra script, có thể version control
5. **Outbox pattern completion**: Phase 5 là nơi vòng lặp outbox retry được khép lại

### Completion Criteria

- [ ] Manual invoke: cleanup xóa audit logs cũ, detect stuck jobs (cả `processing` và `uploading`) cập nhật status = timeout
- [ ] Outbox retry: pending outbox record → SNS published → file_job → processed
- [ ] Scheduler tồn tại và có correct cron expression
- [ ] IAM role của Scheduler có quyền invoke Lambda target
- [ ] Log rõ ràng: bao nhiêu rows bị delete, bao nhiêu jobs bị mark timeout, bao nhiêu outbox records được retry

---

## Phase 6 – Lambda Layer + Caching 🔲

### Tại sao cần Phase này?

Đây là phase về **code reuse** và **performance optimization**. Hai vấn đề thực tế:

1. **Code duplication**: nhiều Lambda functions cùng cần structured logger, DB query helpers, response builder → hiện đang bundle vào từng zip. Lambda Layer cho phép share code mà không duplicate.

2. **Repeated database reads**: Lambda `file-query` phải query PostgreSQL mỗi lần có request. Nếu cùng fileId được query 100 lần trong 60 giây, có thể tránh 99 DB calls bằng container-local cache.

---

### 6A – Lambda Layer (Shared Code)

**Vấn đề hiện tại:**
Nếu phải update logger format, phải update trong từng Lambda function và redeploy tất cả.

**Lambda nào thực sự benefit từ Layer:**

| Lambda | pg-helper | logger | response-builder |
|---|:---:|:---:|:---:|
| `s3-processor` | ✅ | ✅ | ❌ |
| `job-consumer` | ✅ | ✅ | ❌ |
| `audit-consumer` | ✅ | ✅ | ❌ |
| `summary-consumer` | ✅ | ✅ | ❌ |
| `maintenance` | ✅ | ✅ | ❌ |
| `file-query` | ✅ | ✅ | ✅ |
| `upload-to-s3` | ✅ | ✅ | ✅ |
| `job-producer` | ✅ | ✅ | ✅ |

**Layer structure:**
```
Lambda Layer: lambda-file-api-common (v1, v2, ...)
  /nodejs/node_modules/
  ├── pg-helper.js       → Wrapper cho PostgreSQL queries + connection management
  ├── logger.js          → Structured JSON logger (thêm requestId, functionName tự động)
  └── response-builder.js → Chuẩn hóa API response format
```

**Layer versioning:**
- Layer có immutable versions. Khi update code trong layer, tạo version mới (v2).
- Lambda phải update để dùng version mới (không tự động). Đây là trade-off: control vs convenience.

**Thực nghiệm:**
```bash
# 1. Publish layer v1
aws lambda publish-layer-version --layer-name lambda-file-api-common ...

# 2. Update 1 Lambda để dùng layer v1
# 3. Thay đổi logger format → publish layer v2
# 4. Update Lambda để dùng v2, verify log format thay đổi
# 5. Lambda chưa update vẫn dùng v1 format → thấy sự khác biệt
```

---

### 6B – Lambda Container Cache (In-Memory Global Variables)

**Vấn đề:**
Lambda `file-query` nhận nhiều request query cùng 1 file trong vài giây (ví dụ: client poll status liên tục). Mỗi request query DB một lần → không cần thiết.

**Data nào phù hợp để cache trong container:**
- File job status (stale 30s là chấp nhận được khi client polling)
- DB connection config (cache secret, không cần call Secrets Manager mỗi invocation)

**Data nào KHÔNG nên cache:**
- Rows data (thay đổi sau mỗi lần process, không stale được)
- Security credentials cần fresh (ngoại trừ DB config với TTL hợp lý)

**Giải pháp: Global variable cache**
```typescript
// src/handlers/fileQuery.ts

// Global variable tồn tại trong execution environment (container)
// Được tái sử dụng giữa các invocations nếu container còn warm
// KHÔNG chia sẻ giữa các concurrent Lambda instances
const fileJobCache = new Map<string, { data: FileJob; expiresAt: number }>();

export const handler = async (event: APIGatewayProxyEventV2) => {
  const fileId = event.pathParameters?.id;
  const now = Date.now();

  // Check container-local cache
  const cached = fileJobCache.get(fileId);
  if (cached && cached.expiresAt > now) {
    return respond(200, { ...cached.data, source: 'container-cache' });
  }

  // Cache miss → query DB
  const job = await pgHelper.query('SELECT * FROM file_jobs WHERE file_id = $1', [fileId]);
  fileJobCache.set(fileId, { data: job, expiresAt: now + 30_000 }); // TTL: 30 giây

  return respond(200, { ...job, source: 'database' });
};
```

**Cold start test:**
```bash
# 1. Gọi API /file/:id nhiều lần liên tiếp (cùng fileId, cùng container)
for i in {1..5}; do
  curl -s $API_URL/file/$FILE_ID | jq '{ source, status }'
done
# Request 1: source=database (cold cache)
# Request 2-5: source=container-cache (warm, nếu cùng container)

# 2. Thay đổi status trong DB
psql -c "UPDATE file_jobs SET status='updated' WHERE file_id = '$FILE_ID'"

# 3. Gọi lại API ngay → vẫn trả status cũ (cache chưa expire)
# Chờ 30 giây → gọi lại → trả status mới (cache expired)

# 4. Gửi nhiều concurrent requests → thấy mix của database và container-cache
#    vì mỗi Lambda instance có cache riêng
```

**TTL và cache invalidation test:**
```bash
# Chứng minh TTL hoạt động đúng
START=$(date +%s)
curl -s $API_URL/file/$FILE_ID | jq '.source'  # database

# Cập nhật DB
psql -c "UPDATE file_jobs SET status='failed' WHERE file_id='$FILE_ID'"

# Gọi ngay → vẫn trả cache cũ
curl -s $API_URL/file/$FILE_ID | jq '{source, status}'  # container-cache, old status

# Chờ 31 giây
sleep 31
curl -s $API_URL/file/$FILE_ID | jq '{source, status}'  # database, new status=failed
```

**Giới hạn của container cache:**
- Không chia sẻ giữa nhiều Lambda instances chạy song song
- Mất khi container bị recycle (cold start)
- Không phù hợp cho data phải luôn fresh
- Phù hợp cho: config, lookup data, status mà stale 30 giây là chấp nhận được

---

### 6C – ElastiCache (Optional Advanced)

> ⚠️ **ElastiCache không có Free Tier.** Tính phí ngay từ khi tạo (~\$0.017/hour cho cache.t3.micro tại thời điểm viết plan này). Chỉ deploy nếu muốn thực nghiệm thêm. **Phải delete ngay sau khi xong.**

**Lý do muốn shared cache:**
Container cache giải quyết được warm invocation trên cùng instance. Nhưng nếu có 10 concurrent Lambda instances query cùng fileId trong cùng 1 giây, mỗi instance có cache riêng → vẫn có 10 DB calls trong khoảng 30 giây đầu (trước khi mỗi cache warm up).

ElastiCache Redis là shared cache: tất cả Lambda instances đọc/ghi vào cùng Redis cluster → chỉ 1 DB call cho mọi instances.

**Trade-offs so với container cache:**

| | Container Cache | ElastiCache Redis |
|---|---|---|
| Latency | ~0ms (in-process) | ~1-3ms (network) |
| Shared giữa instances | ❌ | ✅ |
| Tồn tại sau cold start | ❌ | ✅ |
| Chi phí | Miễn phí | ~\$12/tháng (t3.micro) |
| Networking | Không cần VPC config thêm | Phải cùng VPC, Security Group |
| Failure risk | Không ảnh hưởng Lambda | Nếu Redis down → phải fallback gracefully |

**Nếu triển khai:**
- Redis nằm trong cùng VPC với Lambda và RDS
- Security Group: inbound port 6379 từ Lambda security group
- Dùng `ioredis` client với connection pooling
- Fallback: nếu Redis unavailable → query PostgreSQL trực tiếp (không throw error)

---

### AWS Resources

| Resource | Tên | Mandatory? |
|---|---|---|
| Lambda Layer | `lambda-file-api-common` | ✅ |
| (Lambda functions cũ attach Layer) | - | ✅ |
| ElastiCache Redis | `lambda-file-api-redis` | ❌ Optional |
| Security Group (Redis) | `lambda-file-api-redis-sg` | ❌ Optional |

### Infra Scripts

| Script | Mô tả |
|---|---|
| `infra/50-layer.sh` | Build + publish Lambda Layer, update existing Lambda functions |
| `infra/51-cache-test.sh` | Test container cache: cold start, warm hit, TTL, stale data, concurrent instances |
| `infra/52-elasticache.sh` | (Optional) Tạo ElastiCache + Security Group |
| `infra/53-redis-test.sh` | (Optional) Test Redis cache: latency comparison, shared state |
| `infra/59-cleanup-phase6.sh` | Xóa Layer versions, (Optional) ElastiCache |

### Completion Criteria

**Mandatory:**
- [ ] Lambda Layer publish thành công, attach vào ít nhất 4 Lambda functions
- [ ] Update layer version → Lambda dùng version mới → verify log format thay đổi
- [ ] Container cache: cold start vs warm hit observable từ `source` field trong API response
- [ ] TTL: stale data sau update DB, fresh data sau 30s
- [ ] Cold start behavior observable từ CloudWatch logs (container lifecycle)

**Optional:**
- [ ] ElastiCache: latency Redis hit (~1ms) vs PostgreSQL miss (~10ms) đo được
- [ ] Multiple Lambda instances đều dùng chung Redis cache (verify qua Redis MONITOR)

---

## Cấu trúc thư mục sau khi mở rộng

```
lambda-file-processing-api/
├── docs/
│   ├── PLAN.md                        ← file này
│   ├── EXPERIMENT_REPORT.md           ← Phase 1 report (giữ nguyên)
│   ├── PHASE2_S3_POSTGRES.md          ← Phase 2 report (sẽ tạo)
│   ├── PHASE3_SQS.md                  ← Phase 3 report (sẽ tạo)
│   ├── PHASE4_SNS.md                  ← Phase 4 report (sẽ tạo)
│   ├── PHASE5_SCHEDULER.md            ← Phase 5 report (sẽ tạo)
│   └── PHASE6_LAYER_CACHE.md          ← Phase 6 report (sẽ tạo)
│
├── src/
│   ├── handlers/                      ← Lambda handlers
│   │   ├── health.ts                  ✅ Phase 1 – không sửa
│   │   ├── info.ts                    ✅ Phase 1 – không sửa
│   │   ├── uploadExcel.ts             ✅ Phase 1 – không sửa
│   │   ├── generateExcel.ts           ✅ Phase 1 – không sửa
│   │   ├── generateExcelStream.ts     ✅ Phase 1 – không sửa
│   │   ├── uploadToS3.ts              🔲 Phase 2 – tạo file_job + presigned URL
│   │   ├── s3Processor.ts             🔲 Phase 2 – S3 Event handler
│   │   ├── fileQuery.ts               🔲 Phase 2 + 6B – query job status + container cache
│   │   ├── jobProducer.ts             🔲 Phase 3 – validate + gửi vào SQS
│   │   ├── jobConsumer.ts             🔲 Phase 3 – xử lý từ SQS (dùng shared processExcelFile)
│   │   ├── auditConsumer.ts           🔲 Phase 4 – ghi audit log từ SNS→SQS
│   │   ├── summaryConsumer.ts         🔲 Phase 4 – cập nhật daily summary
│   │   └── maintenance.ts             🔲 Phase 5 – cleanup + stuck detection + outbox retry
│   │
│   ├── lib/                           ← Shared business logic (Phase 2+)
│   │   └── processExcelFile.ts        🔲 Phase 2 – core Excel processing (dùng bởi s3Processor + jobConsumer)
│   │
│   ├── utils/                         ← Phase 1 utilities (không sửa)
│   │   ├── excelGenerator.ts          ✅
│   │   ├── excelParser.ts             ✅
│   │   └── multipartParser.ts         ✅
│   │
│   └── layer/                         🔲 Phase 6 – Lambda Layer source
│       ├── pg-helper.ts               → PostgreSQL query wrappers + connection pooling
│       ├── logger.ts                  → Structured JSON logger
│       └── response-builder.ts        → API response format
│
├── sql/                               🔲 Phase 2
│   └── schema.sql                     → DDL: CREATE TABLE, indexes (7 bảng: file_jobs, file_records, outbox, audit_logs, daily_summaries, processing_jobs, consumer_processed_events)
│
├── infra/
│   ├── 00-variables.sh                ✅ Phase 1
│   ├── 01-iam.sh                      ✅ Phase 1
│   ├── 02-lambda.sh                   ✅ Phase 1
│   ├── 03-apigateway.sh               ✅ Phase 1
│   ├── 04-function-url.sh             ✅ Phase 1
│   ├── 05-test.sh                     ✅ Phase 1
│   ├── 06-benchmark.sh                ✅ Phase 1
│   ├── 99-cleanup.sh                  ✅ Phase 1 (cần update: thêm cleanup cho Phase 2–6)
│   │
│   ├── 10-s3-rds.sh                   🔲 Phase 2 – S3 + RDS + Secrets + VPC + Endpoints
│   ├── 11-db-schema.sh                🔲 Phase 2 – DDL SQL (schema nền tảng)
│   ├── 12-s3-processor.sh             🔲 Phase 2 – Lambda deploy + S3 Event trigger
│   ├── 13-s3-test.sh                  🔲 Phase 2 – end-to-end tests
│   ├── 19-cleanup-phase2.sh           🔲 Phase 2 – cleanup Phase 2 resources
│   │
│   ├── 20-sqs.sh                      🔲 Phase 3 – SQS + DLQ
│   ├── 21-sqs-lambdas.sh              🔲 Phase 3 – producer + consumer deploy
│   ├── 22-sqs-test.sh                 🔲 Phase 3 – test scenarios incl. duplicate message
│   ├── 29-cleanup-phase3.sh           🔲 Phase 3 – cleanup Phase 3 resources
│   │
│   ├── 30-sns.sh                      🔲 Phase 4 – SNS + subscriptions
│   ├── 31-sns-lambdas.sh              🔲 Phase 4 – consumer deploy
│   ├── 32-sns-test.sh                 🔲 Phase 4 – fan-out test + idempotency
│   ├── 39-cleanup-phase4.sh           🔲 Phase 4 – cleanup Phase 4 resources
│   │
│   ├── 40-scheduler.sh                🔲 Phase 5 – EventBridge + Lambda
│   ├── 41-scheduler-test.sh           🔲 Phase 5 – manual invoke + outbox retry test
│   ├── 49-cleanup-phase5.sh           🔲 Phase 5 – cleanup Phase 5 resources
│   │
│   ├── 50-layer.sh                    🔲 Phase 6 – Lambda Layer
│   ├── 51-cache-test.sh               🔲 Phase 6 – container cache tests
│   ├── 52-elasticache.sh              🔲 Phase 6 (Optional) – ElastiCache
│   ├── 53-redis-test.sh               🔲 Phase 6 (Optional) – Redis test
│   └── 59-cleanup-phase6.sh           🔲 Phase 6 – cleanup Phase 6 resources
```

---

## Thứ tự triển khai và dependencies

```
Phase 1 ✅
   │
   ▼
Phase 2 (S3 + RDS)  ← foundation: tất cả phases sau đều dùng PostgreSQL từ đây
   │                   Schema tạo sẵn: file_jobs, file_records, outbox, audit_logs, daily_summaries, processing_jobs, consumer_processed_events
   │
   ├──► Phase 3 (SQS)       ← job-producer + job-consumer cần VPC + RDS từ Phase 2; dùng processing_jobs table
   │         │
   │         └──► Phase 4 (SNS)  ← kích hoạt outbox + SNS publish; consumers dùng consumer_processed_events
   │                   │
   │                   └──► Phase 5 (Scheduler)  ← cần RDS; outbox-recovery (5m) + daily-maintenance (1d)
   │
   └──► Phase 6 (Layer + Cache)  ← có thể làm sau Phase 2 hoặc sau tất cả (refactoring)
```

**Thứ tự cleanup (ngược lại):**
```
Phase 6 cleanup → Phase 5 cleanup → Phase 4 cleanup → Phase 3 cleanup → Phase 2 cleanup → Phase 1 cleanup
```

---

## IAM Role mở rộng

> Thêm permissions vào `lambda-file-api-execution-role` theo từng phase

| Phase | Permissions cần thêm |
|---|---|
| Phase 2 | `s3:GetObject`, `s3:PutObject`, `secretsmanager:GetSecretValue`, `ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface` |
| Phase 3 | `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`, `sqs:ChangeMessageVisibility` |
| Phase 4 | `sns:Publish` |
| Phase 5 | (không cần thêm nếu dùng cùng role – đã có `sns:Publish` từ Phase 4) |
| Phase 6 | (Optional: ElastiCache không cần IAM permission, dùng auth token hoặc VPC security group) |

Scheduler IAM Role riêng (Phase 5):
```json
{
  "Principal": { "Service": "scheduler.amazonaws.com" },
  "Action": "lambda:InvokeFunction",
  "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:lambda-file-api-maintenance"
}
```

> **Least privilege:** Mỗi Lambda function chỉ có quyền với resources nó thực sự cần. Ví dụ: `upload-to-s3` cần `s3:PutObject` (để ký presigned PUT URL; không có action `s3:GeneratePresignedUrl` riêng trong IAM) và `secretsmanager:GetSecretValue` (kết nối RDS), nhưng không cần `sns:Publish`. Tuy nhiên trong learning project, dùng một execution role với tất cả permissions cho đơn giản – ghi rõ trade-off này trong report.

---

## Naming Convention

```
Lambda:              lambda-file-api-{function-name}
S3 Bucket:           lambda-file-api-data
S3 Key prefix:       input/{fileId}/original.xlsx
                     processed/{fileId}/result.xlsx
RDS Instance:        lambda-file-api-db
Secrets Manager:     lambda-file-api/db-credentials     ← dùng / để namespace
SQS Queue:           lambda-file-api-{queue-name}
SNS Topic:           lambda-file-api-{topic-name}
EventBridge:         lambda-file-api-{scheduler-name}
Lambda Layer:        lambda-file-api-common
IAM Role (Lambda):   lambda-file-api-execution-role     ← đã có từ Phase 1
IAM Role (Scheduler): lambda-file-api-scheduler-role
Security Groups:     lambda-file-api-lambda-sg, lambda-file-api-rds-sg
Log Groups:          /aws/lambda/lambda-file-api-*, /aws/apigateway/lambda-file-api-*
```

> **Lưu ý về Secrets Manager path:** Plan gốc dùng `lambda-file-api-db-secret`. Đã đổi thành `lambda-file-api/db-credentials` để dùng slash làm namespace separator – đây là convention phổ biến trong AWS.

---

## Checklist tổng thể

### Phase 1 ✅
- [x] IAM Execution Role
- [x] 5 Lambda Functions (Node.js 24)
- [x] API Gateway HTTP API + 4 routes
- [x] Lambda Function URLs (BUFFERED + STREAM)
- [x] 21 test cases PASS
- [x] Benchmark: memory scaling, timeout, streaming
- [x] Experiment Report

### Phase 2 – S3 Event + PostgreSQL 🔲
- [ ] S3 Bucket với prefix isolation (`input/` vs `processed/`)
- [ ] S3 Notification Filter: `prefix=input/`, `suffix=.xlsx`
- [ ] RDS PostgreSQL `db.t3.micro`, Security Groups, VPC Endpoints
- [ ] DDL schema: `file_jobs`, `file_records`, `outbox`, `audit_logs`, `daily_summaries`, `processing_jobs`, `consumer_processed_events`
- [ ] Secrets Manager cho DB credentials (path: `lambda-file-api/db-credentials`)
- [ ] Lambda `s3-processor` trong VPC với S3 Event trigger
- [ ] Lambda `upload-to-s3` (tạo `file_job` record + presigned URL) – **VPC** ✅
- [ ] Lambda `file-query` (status + rows) – **VPC** ✅
- [ ] Shared lib: `processExcelFile.ts` (Phase 2 chưa bật SNS publish)
- [ ] Test: upload → trigger → DB → processed file (full state: `processed`, `processed_at` set)
- [ ] Test: idempotency CONCURRENT (atomic UPDATE, không phải SELECT-then-check)
- [ ] Test: transaction rollback (không có orphaned records, `status='failed'`)
- [ ] Test: infinite loop prevention (upload vào `processed/` → không trigger)
- [ ] Phase 2 Experiment Report

### Phase 3 – SQS + DLQ 🔲
- [ ] SQS Queue + DLQ với redrive policy (Visibility Timeout 180s)
- [ ] Lambda `job-producer` (API route, validate/reset `file_jobs` trong RDS + enqueue SQS) – **VPC** ✅
- [ ] Lambda `job-consumer` (SQS Event Source Mapping, timeout 150s) – **VPC** ✅
- [ ] `processing_jobs` table với `status` (`processing | completed | failed`) và `attempts`
- [ ] Test: submit → consumer → DB (reprocessing flow cho `failed`/`timeout`)
- [ ] Test: Visibility Timeout behavior (kill consumer mid-process, verify retry)
- [ ] Test: SQS retry & DLQ (lỗi lần 1 `failed` → vẫn retry được, không bị skip → sau 3 lần vào DLQ → redrive)
- [ ] Test: duplicate message với CÙNG `jobId` đã `completed` → bỏ qua an toàn
- [ ] Test: reprocessing không trigger S3 Event loop
- [ ] Phase 3 Experiment Report

### Phase 4 – SNS Fan-out 🔲
- [ ] SNS Topic + 2 SQS subscriptions với filter policy (kích hoạt `SNS_TOPIC_ARN` + Outbox trên `s3-processor` và `job-consumer`)
- [ ] 2 DLQ riêng cho `audit-queue` và `summary-queue`
- [ ] Lambda `audit-consumer` + `summary-consumer` – **VPC** ✅
- [ ] `consumer_processed_events` table cho idempotency độc lập giữa 2 consumers (dựa trên `outbox.event_id`)
- [ ] Test: 1 publish → 2 consumers nhận
- [ ] Test: filter (`failed` chỉ đến `audit`, không đến `summary`)
- [ ] Test: failure isolation (tắt 1 consumer, cái kia vẫn chạy)
- [ ] Test: duplicate message (cùng `eventId`) → mỗi consumer chỉ xử lý 1 lần
- [ ] Test: outbox record tạo ra khi SNS fail → `outbox.status='pending'`, `file_jobs.status='uploading'`
- [ ] Phase 4 Experiment Report

### Phase 5 – EventBridge Scheduler 🔲
- [ ] 2 EventBridge Scheduler schedules: `daily-maintenance` (`cron(0 1 * * ? *)`) + `outbox-recovery` (`rate(5 minutes)`)
- [ ] IAM Role cho Scheduler → Lambda
- [ ] Lambda `maintenance` (cleanup audit logs > 30d + stuck detection cho cả `processing` và `uploading` + outbox retry max 3 attempts)
- [ ] Test: manual invoke, verify PostgreSQL
- [ ] Test: stuck job detection (insert fake stuck job cả status `processing` và `uploading`)
- [ ] Test: outbox retry (insert fake pending outbox → verify `published` + `file_jobs.status='processed'` sau invoke)
- [ ] Phase 5 Experiment Report

### Phase 6 – Layer + Cache 🔲
- [ ] Lambda Layer publish với pg-helper, logger, response-builder
- [ ] Attach layer vào ít nhất 4 Lambda functions (s3-processor, job-consumer, audit-consumer, summary-consumer)
- [ ] Test: update layer version, verify Lambda dùng version mới
- [ ] Container cache: cold start vs warm hit, TTL, stale data test
- [ ] Cold start behavior observable từ CloudWatch logs
- [ ] (Optional) ElastiCache: latency comparison, shared state

---

## Concepts cần giải thích được cho mentor sau mỗi Phase

### Sau Phase 2
1. Tại sao S3 Event delivery là at-least-once, không phải exactly-once?
2. Conditional UPDATE (`WHERE status='pending'`) atomic hơn SELECT-then-UPDATE thế nào? Race condition là gì?
3. State machine của file_job: tại sao cần trạng thái `uploading` giữa DB commit và SNS publish?
4. Presigned URL hoạt động thế nào, tại sao client upload thẳng lên S3 không qua Lambda?
5. Lambda trong VPC: tại sao cold start chậm hơn, cần VPC Endpoint để gọi AWS services?
6. ON CONFLICT DO NOTHING cho idempotent INSERT là gì?
7. Outbox pattern: ghi intent trước khi thực hiện, tại sao điều này đảm bảo reliability?

### Sau Phase 3
1. Visibility Timeout là gì? Tại sao phải set > Lambda timeout?
2. At-least-once delivery của SQS dẫn đến vấn đề gì, giải quyết bằng cách nào?
3. DLQ khác Dead-letter destination của Lambda thế nào?
4. Idempotency key table (`processing_jobs`): cơ chế hoạt động thế nào?
5. SQS batch size 1 vs N: trade-off là gì?
6. S3 Event và SQS Job Queue: hai trigger cho hai use case khác nhau thế nào?

### Sau Phase 4
1. SNS và SQS khác nhau thế nào về delivery semantics?
2. Tại sao dùng SNS → SQS thay vì SNS → Lambda trực tiếp?
3. Message filter policy hoạt động thế nào?
4. Failure isolation: tại sao lỗi ở audit-queue không ảnh hưởng summary-queue?
5. UPSERT có idempotent không? Khi nào cần thêm idempotency key?

### Sau Phase 5
1. EventBridge cron expression 7 fields khác Unix cron 5 fields thế nào?
2. Flexible time window là gì, khi nào cần?
3. Scheduler IAM role khác Lambda execution role thế nào?
4. Outbox pattern: vòng lặp retry được khép lại thế nào trong Phase 5?

### Sau Phase 6
1. Ba loại caching trong Lambda khác nhau thế nào: Layer (code), container cache (memory), ElastiCache (network)?
2. Lambda Layer versioning: khi nào Lambda tự động dùng version mới, khi nào không?
3. Container cache: tại sao không shared giữa concurrent instances?
4. TTL và cache invalidation: khi nào stale data là chấp nhận được?
5. Cold start: container lifecycle trong Lambda là gì?

---

*Cập nhật lần cuối: 27/11/2026 (Technical Review)*
