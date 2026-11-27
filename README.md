# AWS Serverless Learning Project

> **Thực nghiệm sâu AWS Serverless** – từ upload file Excel đến S3 Event, SQS, SNS, EventBridge Scheduler, Lambda Layers và caching  
> **Runtime:** Node.js 24 (`nodejs24.x`) · TypeScript · AWS Lambda · API Gateway HTTP API  
> **Database:** Amazon RDS for PostgreSQL

---

## Tổng quan

Project được xây dựng theo từng phase, mỗi phase trả lời một câu hỏi kỹ thuật cụ thể nhằm hiểu rõ **tại sao** mỗi AWS service được chọn:

| Phase | Trạng thái | Câu hỏi kỹ thuật | Services & Lý do sử dụng |
|---|:---:|---|---|
| **1** | ✅ | Giới hạn thực tế của Lambda khi xử lý file nhị phân là gì? | **Lambda, API Gateway, Function URL** – Đo giới hạn payload (~4.5 MiB Base64), memory scaling và response streaming |
| **2** | 🔲 | File lớn và event-driven processing hoạt động thế nào? | **S3, S3 Event, RDS PostgreSQL** – Presigned URL vượt giới hạn payload; S3 Event kích hoạt xử lý bất đồng bộ; PostgreSQL lưu dữ liệu có cấu trúc với ACID transaction |
| **3** | 🔲 | Làm thế nào tách bước tiếp nhận request khỏi xử lý thực tế? | **SQS, DLQ** – Hàng đợi cho reprocessing (`failed`/`timeout`), kiểm soát retry theo Visibility Timeout và cô lập lỗi vào DLQ |
| **4** | 🔲 | Khi nhiều hệ thống cần biết cùng một event, dùng gì? | **SNS → SQS Fan-out** – Phát event một lần qua Outbox tới nhiều consumer độc lập (`audit`, `summary`) kèm message filtering và idempotency |
| **5** | 🔲 | Maintenance task định kỳ không cần người kích hoạt? | **EventBridge Scheduler** – Tự động dọn `audit_logs` cũ (daily), phát hiện stuck jobs và retry pending outbox (5-min recovery) |
| **6** | 🔲 | Ba loại caching trong Lambda khác nhau thế nào? | **Lambda Layer, Container Cache, ElastiCache (optional)** – So sánh code reuse (Layer), in-memory per-instance (Container) và shared network cache (Redis) |

---

## Kiến trúc tổng thể (Phase 1 ✅ · Phase 2–6 planned)

```
Client / cURL
     │
     ├─── API Gateway HTTP API ────────────────────────────────────────────────┐
     │         │                                                                │
     │         ├── [Phase 1 ✅] GET /health, GET /info                         │
     │         ├── [Phase 1 ✅] POST /upload-excel → Lambda (in-memory)         │
     │         ├── [Phase 1 ✅] GET /generate-excel (+ Function URL stream)     │
     │         │                                                               │
     │         ├── [Phase 2 🔲] POST /upload-to-s3 → Lambda (VPC: RDS + S3 URL)│
     │         │                Client PUT trực tiếp lên S3 input/             │
     │         ├── [Phase 2 🔲] GET /file/:id, GET /file/:id/rows → Lambda(VPC)│
     │         └── [Phase 3 🔲] POST /process-job → Lambda (VPC: RDS) → SQS    │
     │                                                                         │
     S3 Event (chỉ prefix input/, suffix .xlsx)                                │
          │                                                                    │
          ▼                                                                    │
    Lambda: s3-processor (VPC) ────────────────────────────────────────────────┘
          │
          ├── Parse Excel & INSERT file_records (PostgreSQL transaction)
          ├── Upload result → S3 processed/ (không trigger lại S3 Event)
          └── [Phase 4+ 🔲] Outbox → Publish SNS Topic: file-processed (FILE_PROCESSED | FILE_FAILED)
                                           │
                                 ┌─────────┴──────────┐
                                 ▼                    ▼
                         SQS: audit-queue      SQS: summary-queue
                         (processed, failed)   (only processed)
                                 │                    │
                         Lambda: audit-consumer  Lambda: summary-consumer (VPC)
                                 │                    │
                         INSERT audit_logs        UPSERT daily_summaries
                              (dedup qua consumer_processed_events)

    SQS jobs-queue (Phase 3 🔲)
          │
          ▼
    Lambda: job-consumer (VPC, shared Excel logic + processing_jobs retry state)

    EventBridge Scheduler (Phase 5 🔲: daily 1:00 AM UTC + 5-min recovery)
          │
          ▼
    Lambda: maintenance (VPC)
          ├── [daily]    DELETE audit_logs > 30 ngày
          ├── [recovery] UPDATE stuck file_jobs ('processing'/'uploading' > 1h) → 'timeout' (+ FILE_FAILED outbox)
          └── [recovery] Fenced lease retry pending outbox > 5 phút → SNS (lease 10 phút, ngưỡng attempts >= 3)

    Lambda Layer: common-layer (Phase 6 🔲)
          └── pg, pg-helper, logger, response-builder (dùng chung cho các Phase 2–5 Lambdas)
```

---

## Technology Stack

| Category | Technology |
|---|---|
| Runtime | Node.js 24 (`nodejs24.x`), TypeScript |
| Compute | AWS Lambda |
| API Gateway | Amazon API Gateway HTTP API (v2) |
| File Storage | Amazon S3 |
| Database | Amazon RDS for PostgreSQL (db.t3.micro) |
| Credentials | AWS Secrets Manager |
| Async Queue | Amazon SQS (Standard Queue) |
| Event Bus | Amazon SNS (Standard Topic) |
| Scheduler | Amazon EventBridge Scheduler |
| Shared Code | Lambda Layer |
| Cache (optional) | Amazon ElastiCache (Valkey / Redis OSS) |
| Observability | Amazon CloudWatch Logs |
| Networking | VPC, Security Groups, VPC Endpoints |

---

## Phase 1 – Completed ✅

Tìm hiểu giới hạn thực tế của AWS Lambda khi xử lý file nhị phân **mà không dùng S3 hay Database**.

**Kết quả thực nghiệm chính:**
- Base64 Inflation: file thô tối đa ~4.50 MiB qua API Gateway (giải thích tại sao cần S3 ở Phase 2)
- Memory scaling: 128 MB → 1024 MB, nhanh hơn 10.04×
- Response Streaming: thành công tới 190 MiB via Function URL RESPONSE_STREAM
- 21/21 test cases PASS

📄 Chi tiết: [docs/EXPERIMENT_REPORT.md](docs/EXPERIMENT_REPORT.md)

---

## Cấu trúc thư mục

```
lambda-file-processing-api/
├── docs/
│   ├── PLAN.md                  ← Kế hoạch triển khai Phase 2–6 (đọc trước)
│   ├── EXPERIMENT_REPORT.md     ← Báo cáo thực nghiệm Phase 1
│   └── PHASE{N}_*.md            ← Báo cáo từng phase (tạo sau khi hoàn thành)
│
├── src/
│   ├── handlers/                ← Lambda handlers (5 handlers Phase 1 ✅ + Phase 2–5 planned)
│   ├── lib/                     ← Shared processing logic (Phase 2 planned)
│   ├── utils/                   ← Utilities Phase 1 ✅ (excelGenerator, excelParser, multipartParser)
│   └── layer/                   ← Lambda Layer source (Phase 6 planned)
│
├── sql/                         ← PostgreSQL schema (Phase 2 planned)
│   └── schema.sql
│
├── infra/
│   ├── 00–06, 99-*.sh           ← Phase 1 scripts ✅ (không sửa)
│   ├── 10–19-*.sh               ← Phase 2 (planned): S3 + RDS + PostgreSQL
│   ├── 20–29-*.sh               ← Phase 3 (planned): SQS + DLQ
│   ├── 30–39-*.sh               ← Phase 4 (planned): SNS Fan-out
│   ├── 40–49-*.sh               ← Phase 5 (planned): EventBridge Scheduler
│   └── 50–59-*.sh               ← Phase 6 (planned): Layer + Cache
│
├── scripts/                     ← Build helpers (Phase 1)
└── test-files/                  ← Test Excel files (Phase 1)
```

---

## Bắt đầu

```bash
# Phase 1 – Đã hoàn thành, xem kết quả
cat docs/EXPERIMENT_REPORT.md

# Phase 2+ – Xem kế hoạch chi tiết
cat docs/PLAN.md
```

📄 **Kế hoạch chi tiết từng phase:** [docs/PLAN.md](docs/PLAN.md)
📋 **Quy tắc thực thi cho coding agent (local-only):** [AGENT_RULES.md](AGENT_RULES.md)
