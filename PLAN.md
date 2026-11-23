# Lambda File Processing API – Project Plan

> **Stack:** Node.js 24.x (`nodejs24.x`) · TypeScript · AWS Lambda · API Gateway HTTP API · Lambda Function URL
> **Không dùng:** S3, Database, Frontend, Presigned URL
> **Mục tiêu:** Hiểu giới hạn thực tế của từng lớp, cấu hình IAM, benchmark memory/timeout

---

## AWS Limits – Xác nhận trước khi thiết kế

| Layer | Request payload | Response payload | Ghi chú |
|---|---|---|---|
| API Gateway HTTP API | **10 MB** | **10 MB** | Hard limit edge, trả 413 nếu vượt. Timeout integration max 29s. |
| Lambda – Synchronous (buffered) | **6 MB** | **6 MB** | Áp dụng cho invocation từ API GW và Function URL BUFFERED |
| Lambda Function URL – BUFFERED | **6 MB** | **6 MB** | Giống Lambda sync, không khác API GW về payload. Timeout tới 15 phút. |
| Lambda Function URL – RESPONSE_STREAM | **6 MB** | **200 MB** | Nới response lên 200 MB (6MB đầu unthrottled, sau đó 2 MB/s). Request vẫn 6 MB. |
| Lambda – Max timeout | — | — | 15 phút (900s); default khi tạo là 3 giây. (Lưu ý API GW timeout hard limit là 29s). |
| Lambda – Max memory | — | — | 10,240 MB; default 128 MB. 1 vCPU per 1,769 MB. |

> **Những điều quan trọng cần hiểu rõ:**
>
> **[1] Upload qua API GW → Lambda có hai lớp giới hạn:**
> - API Gateway từ chối request > 10 MB ngay tại edge, trả `HTTP 413`.
> - Với request ≤ 10 MB, API Gateway chuyển body sang Lambda. Tuy nhiên Lambda encode binary body sang Base64 trước khi inject vào event JSON → payload JSON thực tế tăng ~33% so với file gốc.
> - Lambda từ chối invocation nếu event JSON > 6 MB → file thực chỉ upload được khoảng **~4.5 MB** trước khi Lambda bị oversize.
> - Khi vượt giới hạn Lambda (6 MB event), API Gateway nhận lỗi integration và trả `HTTP 500` hoặc `HTTP 413`, **không phải lúc nào cũng là 413**. Cần đo thực tế và quan sát CloudWatch để xác định lỗi xảy ra ở layer nào.
>
> **[2] Function URL BUFFERED không bypass giới hạn Lambda sync.** Cả request lẫn response đều bị giới hạn 6 MB giống API GW integration.
>
> **[3] Function URL RESPONSE_STREAM chỉ nới response lên 200 MB**, request vẫn 6 MB. Điều này giúp trả về file Excel lớn, nhưng **không** giúp upload file lớn hơn.
>
> **[4] XLSX là định dạng ZIP-compressed.** File 50,000 rows không nhất thiết vượt 6 MB response limit — kích thước thực tế phụ thuộc vào data content. Cần đo kích thước buffer thực tế sau khi generate thay vì giả định.
>
> **[5] Node.js 24 (`nodejs24.x`) không còn hỗ trợ callback-style handler.** Chỉ dùng `async/await`.

---

## Architecture

```
Core flow:
  Client ──► API Gateway HTTP API ──► Lambda ──► Client

Alternative (experiment):
  Client ──► Lambda Function URL (BUFFERED)        ──► Lambda ──► Client
  Client ──► Lambda Function URL (RESPONSE_STREAM) ──► Lambda ──► Client

Endpoints (API Gateway):
  POST /upload-excel       Nhận file Excel, parse, trả JSON kết quả phân tích
  GET  /generate-excel     Generate Excel, trả file trực tiếp trong response
  GET  /health             Health check + Lambda runtime metadata
  GET  /info               Thông tin giới hạn và cấu hình hiện tại của function

Function URLs (experiment riêng):
  GET  ?rows=N             generate-excel qua BUFFERED  (so sánh limit với API GW)
  GET  ?rows=N             generate-excel qua RESPONSE_STREAM (nới response lên 200 MB)
```

---

## Trạng thái tiến độ dự án

- [x] **Phase 0 – Setup môi trường:** Node.js 24, npm, TypeScript, @types/aws-lambda.
- [x] **Phase 1 – Phát triển mã nguồn:** 5 Handlers (`health`, `info`, `uploadExcel`, `generateExcel`, `generateExcelStream`), utils (`excelGenerator`, `excelParser`, `multipartParser`).
- [x] **Phase 2 – Local Verification:** TypeScript type check (0 errors), Build compile (`dist/`), Local test suite (`test:local`) pass 100%.
- [x] **Phase 3 – Đóng gói Lambda:** Đã tạo 5 gói `.zip` (11 MB/gói) trong `zips/`, tương thích Node.js 24.
- [x] **Phase 4 – Chuẩn bị Test Payloads & Datasets:** Đã tổ chức vào `test-files/generated/` và `test-files/datasets/`.
- [ ] **Phase 5 – AWS Deployment:** Chờ chạy theo thứ tự: `01-iam.sh` -> `02-lambda.sh` -> `03-apigateway.sh` -> `04-function-url.sh`.
- [ ] **Phase 6 – AWS Experiments & Verification:** Chạy `05-test.sh` kiểm thử payload limits, response stream, memory và timeout.

---

## Cấu trúc thư mục

```
lambda-file-processing-api/
├── PLAN.md
├── package.json
├── tsconfig.json
├── src/
│   ├── handlers/
│   │   ├── health.ts              ← GET /health (metadata, memory)
│   │   ├── info.ts                ← GET /info (AWS quotas, boundaries)
│   │   ├── uploadExcel.ts         ← POST /upload-excel (raw binary & multipart support)
│   │   ├── generateExcel.ts       ← GET /generate-excel (buffered, delay testing)
│   │   └── generateExcelStream.ts ← Function URL RESPONSE_STREAM (excel + synthetic chunked)
│   └── utils/
│       ├── excelGenerator.ts      ← Tạo Excel Buffer
│       ├── excelParser.ts         ← Parse Excel Buffer
│       └── multipartParser.ts     ← Bóc tách file từ multipart/form-data
├── infra/
│   ├── 00-variables.sh            ← Biến môi trường
│   ├── 01-iam.sh                  ← Tạo IAM Role
│   ├── 02-lambda.sh               ← Deploy 5 Lambda functions
│   ├── 03-apigateway.sh           ← Tạo HTTP API Gateway + 4 routes
│   ├── 04-function-url.sh         ← Tạo 2 Function URLs
│   ├── 05-test.sh                 ← Test suite đầy đủ các kịch bản
│   └── 99-cleanup.sh              ← Xóa tài nguyên
├── scripts/
│   ├── package.sh                 ← Đóng gói 5 zip files
│   ├── test-local.mjs             ← Test local logic
│   ├── generate-test-files.mjs    ← Sinh file test Mode A (Rows) & Mode B (Target sizes)
│   └── generate-test-files.sh     ← Wrapper script
└── test-files/                    ← (Được .gitignore bảo vệ 100%)
    ├── generated/                 ← Payload đã sinh (1MB-15MB .bin & .xlsx)
    └── datasets/                  ← Real-world datasets:
        ├── online+retail/         ← Online Retail.xlsx (23 MB)
        ├── onlineretail2/         ← online_retail_II.xlsx (44 MB)
        └── olist/                 ← Olist ecommerce (9 files CSV: 2.6KB - 59MB)
```

---

## Phase 0 – Chuẩn bị môi trường

### 0.1 Kiểm tra tools và AWS identity

```bash
# Kiểm tra versions
node --version    # cần >= 20 để dev local; runtime trên Lambda là nodejs24.x
npm --version
aws --version     # cần >= 2.x

# Xác nhận AWS identity và region đang dùng TRƯỚC KHI làm bất cứ thứ gì
aws sts get-caller-identity
aws configure get region
```

> Xác nhận `Account`, `Arn` và `region` khớp với môi trường muốn deploy. Không hardcode region nếu chưa chắc — lấy từ `aws configure get region` hoặc set `AWS_REGION` sau khi confirm.

### 0.2 `infra/00-variables.sh`

```bash
#!/bin/bash
# Source file này trước khi chạy bất kỳ script infra nào:
#   source infra/00-variables.sh

# Lấy region từ AWS config thay vì hardcode
export AWS_REGION=$(aws configure get region)
if [ -z "$AWS_REGION" ]; then
  echo "AWS region chưa được set. Chạy: aws configure set region <region>"
  return 1
fi

export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PROJECT="lambda-file-api"

# Lambda function names
export FN_HEALTH="${PROJECT}-health"
export FN_INFO="${PROJECT}-info"
export FN_UPLOAD="${PROJECT}-upload-excel"
export FN_GENERATE="${PROJECT}-generate-excel"
export FN_GENERATE_STREAM="${PROJECT}-generate-excel-stream"

# IAM
export LAMBDA_ROLE_NAME="${PROJECT}-execution-role"

# API Gateway
export API_NAME="${PROJECT}-http-api"

# Paths (relative to project root)
export DIST_DIR="$(pwd)/dist"
export ZIP_DIR="$(pwd)/zips"

echo "Variables loaded"
echo "   Account : $AWS_ACCOUNT_ID"
echo "   Region  : $AWS_REGION"
echo "   Project : $PROJECT"
```

---

## Phase 1 – IAM Role

> **Học gì:** IAM Execution Role, Trust Policy, Permission Policy, principle of least privilege.

### Khái niệm

```
IAM Role: lambda-file-api-execution-role
 ├── Trust Policy   → cho phép lambda.amazonaws.com gọi sts:AssumeRole
 └── Permission Policy (AWS Managed)
      └── AWSLambdaBasicExecutionRole
           → logs:CreateLogGroup
           → logs:CreateLogStream
           → logs:PutLogEvents
           (Project không dùng S3 → không cần quyền S3)
```

### `infra/01-iam.sh`

```bash
#!/bin/bash
set -e
source infra/00-variables.sh

MANAGED_POLICY="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

# Kiểm tra role đã tồn tại chưa
if aws iam get-role --role-name "$LAMBDA_ROLE_NAME" 2>/dev/null | grep -q RoleName; then
  echo " Role $LAMBDA_ROLE_NAME đã tồn tại, bỏ qua tạo mới."
else
  echo "Tạo IAM Role: $LAMBDA_ROLE_NAME"

  cat > /tmp/trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

  aws iam create-role \
    --role-name "$LAMBDA_ROLE_NAME" \
    --assume-role-policy-document file:///tmp/trust-policy.json \
    --description "Execution role for $PROJECT - CloudWatch Logs only"

  aws iam attach-role-policy \
    --role-name "$LAMBDA_ROLE_NAME" \
    --policy-arn "$MANAGED_POLICY"

  echo "  Role created và policy attached"
  echo "  Đợi 10 giây để IAM propagate..."
  sleep 10
fi

# Verify
echo ""
echo "Role details:"
aws iam get-role \
  --role-name "$LAMBDA_ROLE_NAME" \
  --query 'Role.{Arn:Arn, CreateDate:CreateDate}'

echo ""
echo "Attached policies:"
aws iam list-attached-role-policies \
  --role-name "$LAMBDA_ROLE_NAME" \
  --query 'AttachedPolicies[*].PolicyName'
```

---

## Phase 2 – Code TypeScript

### 2.1 Khởi tạo project

```bash
cd /home/intern-ntntram2/Projects/lambda-file-processing-api

npm init -y

# Dev dependencies
npm install --save-dev typescript @types/node @types/aws-lambda

# Runtime dependency
npm install exceljs
```

> **Node.js 24 & ExcelJS:** ExcelJS hoạt động trên Node.js 24 (pure JavaScript, không dùng native addon). Có thể xuất hiện deprecation warning từ sub-dependencies cũ khi `npm install` — đây chỉ là noise, không ảnh hưởng runtime. Wrap mọi parse/generate trong try/catch để xử lý OOM với file rất lớn.

### 2.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

> `ES2022` target phù hợp với Node.js 24.

### 2.3 `src/utils/excelGenerator.ts`

```typescript
import ExcelJS from 'exceljs';

export interface GenerateResult {
  buffer: Buffer;
  rowCount: number;
  fileSizeBytes: number;
  fileSizeMB: number;
  elapsedMs: number;
}

export async function generateExcel(numRows: number): Promise<GenerateResult> {
  const startTime = Date.now();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');

  sheet.columns = [
    { header: 'ID',       key: 'id',       width: 10 },
    { header: 'Date',     key: 'date',      width: 15 },
    { header: 'Name',     key: 'name',      width: 20 },
    { header: 'Category', key: 'category',  width: 15 },
    { header: 'Qty',      key: 'qty',       width: 10 },
    { header: 'Price',    key: 'price',     width: 12 },
    { header: 'Total',    key: 'total',     width: 14 },
    { header: 'Status',   key: 'status',    width: 12 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF366092' } };

  const statuses = ['Completed', 'Pending', 'Cancelled', 'Processing'];
  const categories = ['Electronics', 'Clothing', 'Food', 'Books', 'Sports'];
  const baseDate = new Date('2024-01-01').getTime();

  for (let i = 1; i <= numRows; i++) {
    const qty = Math.ceil(Math.random() * 100);
    const price = Math.round(Math.random() * 49000 + 1000) / 100;
    sheet.addRow({
      id: i,
      date: new Date(baseDate + i * 86400000).toISOString().slice(0, 10),
      name: `Customer_${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      category: categories[i % categories.length],
      qty,
      price,
      total: Math.round(qty * price * 100) / 100,
      status: statuses[i % statuses.length],
    });
  }

  const rawBuffer = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(rawBuffer);
  const elapsedMs = Date.now() - startTime;

  return {
    buffer,
    rowCount: numRows,
    fileSizeBytes: buffer.byteLength,
    fileSizeMB: Math.round((buffer.byteLength / (1024 * 1024)) * 1000) / 1000,
    elapsedMs,
  };
}
```

> **Lưu ý:** `generateExcel` tạo toàn bộ file vào **Buffer trong memory** trước, sau đó trả về. XLSX là ZIP-compressed nên kích thước file thực tế nhỏ hơn nhiều so với raw data. Với 50,000 rows, file có thể chỉ ~3–6 MB tùy data — cần đo thực tế, không giả định trước.

### 2.4 `src/utils/excelParser.ts`

```typescript
import ExcelJS from 'exceljs';

export interface ParseResult {
  sheetName: string;
  rowCount: number;      // số data row (không tính header)
  columnCount: number;
  fileSizeBytes: number;
  fileSizeKB: number;
  previewRows: Record<string, unknown>[];  // 5 rows đầu
}

export async function parseExcel(buffer: Buffer): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('File Excel không có worksheet nào');

  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell) => {
    headers.push(String(cell.value ?? ''));
  });

  const previewRows: Record<string, unknown>[] = [];
  const previewLimit = Math.min(6, sheet.rowCount);
  for (let r = 2; r <= previewLimit; r++) {
    const row: Record<string, unknown> = {};
    sheet.getRow(r).eachCell((cell, colNum) => {
      const header = headers[colNum - 1] ?? `col${colNum}`;
      row[header] = cell.value;
    });
    previewRows.push(row);
  }

  return {
    sheetName: sheet.name,
    rowCount: Math.max(0, sheet.rowCount - 1),
    columnCount: sheet.columnCount,
    fileSizeBytes: buffer.byteLength,
    fileSizeKB: Math.round(buffer.byteLength / 1024),
    previewRows,
  };
}
```

### 2.5 `src/handlers/health.ts`

```typescript
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';

// Node.js 24: handler phải là async, không dùng callback
export const handler = async (
  _event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
      runtime: process.version,
      lambda: {
        functionName: context.functionName,
        functionVersion: context.functionVersion,
        memoryLimitMB: context.memoryLimitInMB,
        remainingTimeMS: context.getRemainingTimeInMillis(),
        logGroupName: context.logGroupName,
        logStreamName: context.logStreamName,
      },
    }),
  };
};
```

### 2.6 `src/handlers/info.ts`

```typescript
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';

export const handler = async (
  _event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      awsLimits: {
        apiGatewayHttpApi: {
          maxRequestMB: 10,
          maxResponseMB: 10,
          note: 'Trả HTTP 413 nếu request vượt 10 MB',
        },
        lambdaSynchronousBuffered: {
          maxRequestEventMB: 6,
          maxResponseMB: 6,
          uploadNote: 'Body binary được Base64-encode trước khi inject vào event JSON → file thực upload được ~4.5 MB',
          appliesTo: 'API Gateway integration, Function URL BUFFERED',
        },
        lambdaFunctionUrlResponseStream: {
          maxRequestEventMB: 6,
          maxResponseMB: 200,
          note: 'Chỉ nới response; request vẫn giới hạn 6 MB',
        },
      },
      thisFunction: {
        functionName: context.functionName,
        memoryLimitMB: context.memoryLimitInMB,
        remainingTimeMS: context.getRemainingTimeInMillis(),
        runtime: process.version,
      },
    }),
  };
};
```

### 2.7 `src/handlers/uploadExcel.ts`

```typescript
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { parseExcel } from '../utils/excelParser';

const MAX_ALLOWED_BYTES = 5 * 1024 * 1024; // 5 MB guard trước khi parse

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const startTime = Date.now();

  if (!event.body) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'No body. Gửi file Excel (.xlsx) dưới dạng raw binary.',
        hint: 'curl -X POST <url>/upload-excel -H "Content-Type: application/octet-stream" --data-binary @file.xlsx',
      }),
    };
  }

  // API Gateway HTTP API (payload format v2.0) encode binary body sang Base64
  const buffer = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf-8');

  if (buffer.byteLength > MAX_ALLOWED_BYTES) {
    return {
      statusCode: 413,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `File quá lớn: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB. Giới hạn xử lý: 5 MB.`,
        receivedBytes: buffer.byteLength,
        isBase64Encoded: event.isBase64Encoded,
      }),
    };
  }

  try {
    const parseResult = await parseExcel(buffer);
    const elapsedMs = Date.now() - startTime;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        file: {
          receivedBytes: buffer.byteLength,
          receivedSizeMB: Math.round((buffer.byteLength / 1024 / 1024) * 1000) / 1000,
          isBase64Encoded: event.isBase64Encoded,
        },
        excel: parseResult,
        performance: {
          parseElapsedMs: elapsedMs,
          lambdaMemoryMB: context.memoryLimitInMB,
          remainingTimeMS: context.getRemainingTimeInMillis(),
        },
      }),
    };
  } catch (err: unknown) {
    return {
      statusCode: 422,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Không parse được file Excel',
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
```

### 2.8 `src/handlers/generateExcel.ts` – Buffered (API GW + Function URL BUFFERED)

```typescript
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { generateExcel } from '../utils/excelGenerator';

// Giới hạn rows để tránh gây workload không kiểm soát
// Với buffered response, response >6 MB sẽ bị Lambda từ chối
// Rows thực tế có thể generate thành công phụ thuộc vào kích thước file thực tế (cần đo)
const MAX_ROWS = 100_000;
const DEFAULT_ROWS = 1_000;

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  const rawRows = parseInt(event.queryStringParameters?.rows ?? String(DEFAULT_ROWS), 10);

  if (isNaN(rawRows) || rawRows < 1) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `rows phải là số nguyên dương. Nhận: ${event.queryStringParameters?.rows}` }),
    };
  }

  const rows = Math.min(rawRows, MAX_ROWS);
  const result = await generateExcel(rows);
  const filename = `report_${rows}rows_${Date.now()}.xlsx`;

  // Ghi log kích thước để quan sát trong CloudWatch
  console.log(JSON.stringify({
    event: 'generate_excel',
    rows,
    fileSizeMB: result.fileSizeMB,
    fileSizeBytes: result.fileSizeBytes,
    generateElapsedMs: result.elapsedMs,
    lambdaMemoryMB: context.memoryLimitInMB,
  }));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Row-Count': String(rows),
      'X-File-Size-MB': String(result.fileSizeMB),
      'X-File-Size-Bytes': String(result.fileSizeBytes),
      'X-Generate-Elapsed-MS': String(result.elapsedMs),
      'X-Lambda-Memory-MB': String(context.memoryLimitInMB),
      'X-Remaining-Time-MS': String(context.getRemainingTimeInMillis()),
    },
    body: result.buffer.toString('base64'),
    isBase64Encoded: true,
  };
};
```

### 2.9 `src/handlers/generateExcelStream.ts` – Response Streaming (Function URL RESPONSE_STREAM only)

```typescript
// Handler này chỉ hoạt động khi Function URL được set InvokeMode = RESPONSE_STREAM.
// Nếu invoke qua API Gateway hoặc Function URL BUFFERED → sẽ lỗi vì awslambda.streamifyResponse
// không phải standard Lambda handler signature.
//
// Streaming ở đây là streaming HTTP response (toàn bộ buffer được write một lần vào stream),
// KHÔNG phải streaming quá trình generate Excel.
// ExcelJS vẫn tạo toàn bộ workbook trong memory trước (generateExcel trả Buffer),
// sau đó buffer đó được write vào responseStream.
// Lợi ích thực tế: response không bị buffer toàn bộ ở Lambda runtime trước khi trả client
// → không bị giới hạn 6 MB response của buffered mode.
//
// `awslambda` là global object inject bởi Lambda Node.js runtime. Không cần import.
// TypeScript cần khai báo type cho nó:

declare const awslambda: {
  streamifyResponse: (
    handler: (
      event: AWSLambda.APIGatewayProxyEventV2,
      responseStream: NodeJS.WritableStream,
      context: AWSLambda.Context,
    ) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (
      stream: NodeJS.WritableStream,
      metadata: { statusCode: number; headers: Record<string, string> },
    ) => NodeJS.WritableStream & { write(chunk: Buffer | string): void; end(): void };
  };
};

import { generateExcel } from '../utils/excelGenerator';

export const handler = awslambda.streamifyResponse(
  async (
    event: AWSLambda.APIGatewayProxyEventV2,
    responseStream: NodeJS.WritableStream,
    context: AWSLambda.Context,
  ): Promise<void> => {
    const params = event.queryStringParameters ?? {};
    const rawRows = parseInt(params.rows ?? '10000', 10);
    const rows = Math.min(isNaN(rawRows) ? 10000 : rawRows, 500_000);

    const result = await generateExcel(rows);
    const filename = `stream_report_${rows}rows_${Date.now()}.xlsx`;

    console.log(JSON.stringify({
      event: 'generate_excel_stream',
      rows,
      fileSizeMB: result.fileSizeMB,
      fileSizeBytes: result.fileSizeBytes,
      generateElapsedMs: result.elapsedMs,
      lambdaMemoryMB: context.memoryLimitInMB,
    }));

    const metadataStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Row-Count': String(rows),
        'X-File-Size-MB': String(result.fileSizeMB),
        'X-Generate-Elapsed-MS': String(result.elapsedMs),
        'X-Lambda-Memory-MB': String(context.memoryLimitInMB),
      },
    });

    metadataStream.write(result.buffer);
    metadataStream.end();
  },
);
```

---

## Phase 3 – Build & Package

### `scripts/generate-test-files.sh`

```bash
#!/bin/bash
# Tạo file Excel test – chạy sau npm install

mkdir -p test-files

node -e "
const ExcelJS = require('exceljs');
const fs = require('fs');

async function gen(rows, file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.columns = [
    { header: 'ID',    key: 'id',    width: 10 },
    { header: 'Name',  key: 'name',  width: 25 },
    { header: 'Value', key: 'value', width: 15 },
    { header: 'Date',  key: 'date',  width: 15 },
    { header: 'Note',  key: 'note',  width: 30 },
  ];
  for (let i = 1; i <= rows; i++) {
    ws.addRow({
      id: i,
      name: 'Row_' + i + '_' + Math.random().toString(36).slice(2, 8),
      value: Math.round(Math.random() * 100000) / 100,
      date: new Date(2024, 0, 1 + (i % 365)).toISOString().slice(0, 10),
      note: 'Sample data row ' + i + ' for testing purposes',
    });
  }
  await wb.xlsx.writeFile(file);
  const size = fs.statSync(file).size;
  console.log('Created:', file, (size / 1024).toFixed(1) + ' KB (' + (size / 1024 / 1024).toFixed(3) + ' MB)');
}

(async () => {
  await gen(100,    'test-files/small-100rows.xlsx');
  await gen(1000,   'test-files/medium-1000rows.xlsx');
  await gen(10000,  'test-files/large-10000rows.xlsx');
  await gen(50000,  'test-files/xlarge-50000rows.xlsx');
})().catch(console.error);
"

echo ""
echo "Test files created. Sizes:"
ls -lh test-files/
```

> **Lưu ý:** Chạy script này và quan sát kích thước thực tế của từng file. Kết quả sẽ cho biết row count nào sẽ vượt giới hạn response 6 MB.

### Build script – trong `package.json`

```json
{
  "scripts": {
    "build": "tsc --noEmit && tsc",
    "build:check": "tsc --noEmit",
    "package": "bash scripts/package.sh"
  }
}
```

> `tsc --noEmit` chạy trước để bắt lỗi TypeScript mà không tạo file, `tsc` sau để build thực.

### `scripts/package.sh`

```bash
#!/bin/bash
# Package dist/ + node_modules vào zip cho từng Lambda function
set -e
source infra/00-variables.sh

PROJECT_ROOT="$(pwd)"
mkdir -p "$ZIP_DIR"

echo "TypeScript build check..."
npm run build:check

echo "TypeScript compile..."
npx tsc

echo "Installing production dependencies..."
cp package.json "$DIST_DIR/"
cd "$DIST_DIR"
npm install --omit=dev --quiet
cd "$PROJECT_ROOT"

echo " Packaging zips..."
# Zip toàn bộ dist (gồm cả node_modules của dist)
# Project nhỏ → không cần tách riêng từng function
for FN_NAME in "$FN_HEALTH" "$FN_INFO" "$FN_UPLOAD" "$FN_GENERATE" "$FN_GENERATE_STREAM"; do
  ZIP="$ZIP_DIR/${FN_NAME}.zip"
  rm -f "$ZIP"
  cd "$DIST_DIR"
  zip -r "$ZIP" . -x "*.ts" -x "package.json" > /dev/null
  cd "$PROJECT_ROOT"
  echo "  $ZIP ($(du -sh "$ZIP" | cut -f1))"
done

echo "Package complete"
```

---

## Phase 4 – Deploy Lambda

### `infra/02-lambda.sh`

```bash
#!/bin/bash
set -e
source infra/00-variables.sh

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"

deploy_fn() {
  local FN_NAME=$1
  local HANDLER=$2      # e.g. "handlers/health.handler"
  local TIMEOUT=${3:-30}
  local MEMORY=${4:-256}
  local ZIP="$ZIP_DIR/${FN_NAME}.zip"

  if [ ! -f "$ZIP" ]; then
    echo "Zip không tồn tại: $ZIP. Chạy scripts/package.sh trước."
    exit 1
  fi

  echo "Deploying $FN_NAME (timeout=${TIMEOUT}s, memory=${MEMORY}MB)..."

  if aws lambda get-function --function-name "$FN_NAME" 2>/dev/null | grep -q '"FunctionName"'; then
    echo "  → Updating existing function..."

    aws lambda update-function-code \
      --function-name "$FN_NAME" \
      --zip-file "fileb://$ZIP" > /dev/null

    # Phải đợi update-code xong trước khi update-configuration
    aws lambda wait function-updated-v2 --function-name "$FN_NAME"

    aws lambda update-function-configuration \
      --function-name "$FN_NAME" \
      --runtime nodejs24.x \
      --timeout "$TIMEOUT" \
      --memory-size "$MEMORY" \
      --handler "$HANDLER" > /dev/null

    aws lambda wait function-updated-v2 --function-name "$FN_NAME"
  else
    echo "  → Creating new function..."

    aws lambda create-function \
      --function-name "$FN_NAME" \
      --runtime nodejs24.x \
      --role "$ROLE_ARN" \
      --handler "$HANDLER" \
      --zip-file "fileb://$ZIP" \
      --timeout "$TIMEOUT" \
      --memory-size "$MEMORY"

    aws lambda wait function-active-v2 --function-name "$FN_NAME"
  fi

  echo "  $FN_NAME ready"
}

# Deploy theo thứ tự từ nhẹ đến nặng
deploy_fn "$FN_HEALTH"          "handlers/health.handler"              10   128
deploy_fn "$FN_INFO"            "handlers/info.handler"                10   128
deploy_fn "$FN_UPLOAD"          "handlers/uploadExcel.handler"         60   512
deploy_fn "$FN_GENERATE"        "handlers/generateExcel.handler"       120  1024
deploy_fn "$FN_GENERATE_STREAM" "handlers/generateExcelStream.handler" 120  1024

echo ""
echo "All Lambda functions deployed"

# Verify tất cả
echo ""
echo "Function configurations:"
for FN_NAME in "$FN_HEALTH" "$FN_INFO" "$FN_UPLOAD" "$FN_GENERATE" "$FN_GENERATE_STREAM"; do
  aws lambda get-function-configuration \
    --function-name "$FN_NAME" \
    --query '{Name:FunctionName, Runtime:Runtime, Memory:MemorySize, Timeout:Timeout, State:State}' \
    --output table
done
```

---

## Phase 5 – API Gateway HTTP API

### `infra/03-apigateway.sh`

```bash
#!/bin/bash
set -e
source infra/00-variables.sh

# Kiểm tra API đã tồn tại chưa
EXISTING_API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
  --output text 2>/dev/null)

if [ "$EXISTING_API_ID" != "None" ] && [ -n "$EXISTING_API_ID" ]; then
  echo " API $API_NAME đã tồn tại (ID: $EXISTING_API_ID)"
  API_ID="$EXISTING_API_ID"
else
  echo "Tạo API Gateway HTTP API: $API_NAME"
  API_ID=$(aws apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --cors-configuration \
      AllowOrigins='*',AllowMethods='GET,POST,OPTIONS',AllowHeaders='Content-Type' \
    --query ApiId --output text)
  echo "  API created: $API_ID"
fi

# Helper: tạo integration + route + lambda permission
add_route() {
  local METHOD=$1
  local ROUTE_PATH=$2
  local FN_NAME=$3
  local FN_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${FN_NAME}"
  local STMT_ID="apigw-${METHOD}-${ROUTE_PATH//\//_}"

  local INT_ID
  INT_ID=$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type AWS_PROXY \
    --integration-uri "$FN_ARN" \
    --payload-format-version "2.0" \
    --query IntegrationId --output text)

  aws apigatewayv2 create-route \
    --api-id "$API_ID" \
    --route-key "$METHOD $ROUTE_PATH" \
    --target "integrations/$INT_ID" > /dev/null

  # Cấp quyền cho API GW invoke Lambda
  # Dùng 2>/dev/null || true để idempotent khi chạy lại
  aws lambda add-permission \
    --function-name "$FN_NAME" \
    --statement-id "$STMT_ID" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${API_ID}/*" \
    2>/dev/null || echo "    (permission $STMT_ID đã tồn tại)"

  echo "  $METHOD $ROUTE_PATH → $FN_NAME"
}

add_route "GET"  "/health"         "$FN_HEALTH"
add_route "GET"  "/info"           "$FN_INFO"
add_route "POST" "/upload-excel"   "$FN_UPLOAD"
add_route "GET"  "/generate-excel" "$FN_GENERATE"

# Tạo stage dev với auto-deploy
aws apigatewayv2 create-stage \
  --api-id "$API_ID" \
  --stage-name "dev" \
  --auto-deploy > /dev/null 2>&1 || \
  echo " Stage 'dev' đã tồn tại"

API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"
echo ""
echo "API Gateway ready"
echo "   API_ID  = $API_ID"
echo "   API_URL = $API_URL"
```

---

## Phase 6 – Lambda Function URLs

> **IAM cho Function URL AuthType NONE:** Cần hai permission:
> - `lambda:InvokeFunction` – cho phép invoke function
> - `lambda:InvokeFunctionUrl` – specific cho Function URL invocation
>
> Cả hai cần `--principal "*"` với `--function-url-auth-type NONE`.

### `infra/04-function-url.sh`

```bash
#!/bin/bash
set -e
source infra/00-variables.sh

create_or_get_function_url() {
  local FN_NAME=$1
  local INVOKE_MODE=${2:-BUFFERED}  # BUFFERED hoặc RESPONSE_STREAM

  # Kiểm tra Function URL đã tồn tại chưa
  EXISTING_URL=$(aws lambda get-function-url-config \
    --function-name "$FN_NAME" \
    --query FunctionUrl --output text 2>/dev/null || echo "")

  if [ -n "$EXISTING_URL" ] && [ "$EXISTING_URL" != "None" ]; then
    echo " Function URL cho $FN_NAME đã tồn tại"
    # Update invoke-mode nếu cần
    aws lambda update-function-url-config \
      --function-name "$FN_NAME" \
      --invoke-mode "$INVOKE_MODE" > /dev/null
    echo "  InvokeMode updated: $INVOKE_MODE"
    URL="$EXISTING_URL"
  else
    URL=$(aws lambda create-function-url-config \
      --function-name "$FN_NAME" \
      --auth-type NONE \
      --invoke-mode "$INVOKE_MODE" \
      --cors AllowOrigins='*',AllowMethods='GET,POST',AllowHeaders='Content-Type' \
      --query FunctionUrl --output text)
    echo "  Function URL created ($INVOKE_MODE)"
  fi

  # Permission 1: lambda:InvokeFunction (cần thiết cho invocation)
  aws lambda add-permission \
    --function-name "$FN_NAME" \
    --statement-id "funcurl-invoke-fn" \
    --action lambda:InvokeFunction \
    --principal "*" \
    2>/dev/null || echo "    (InvokeFunction permission đã tồn tại)"

  # Permission 2: lambda:InvokeFunctionUrl (specific cho Function URL)
  aws lambda add-permission \
    --function-name "$FN_NAME" \
    --statement-id "funcurl-invoke-url" \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    2>/dev/null || echo "    (InvokeFunctionUrl permission đã tồn tại)"

  echo "  URL: $URL"
  echo ""
}

echo "Setting up Lambda Function URLs..."
echo ""

echo "--- $FN_GENERATE (BUFFERED) ---"
create_or_get_function_url "$FN_GENERATE" "BUFFERED"

echo "--- $FN_GENERATE_STREAM (RESPONSE_STREAM) ---"
create_or_get_function_url "$FN_GENERATE_STREAM" "RESPONSE_STREAM"

echo "Function URLs ready"
echo ""
echo "Final URLs:"
aws lambda get-function-url-config --function-name "$FN_GENERATE" --query FunctionUrl --output text
aws lambda get-function-url-config --function-name "$FN_GENERATE_STREAM" --query FunctionUrl --output text
```

---

## Phase 7 – Test Cases

### Chuẩn bị: lấy URLs

```bash
source infra/00-variables.sh

API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"

BUFFERED_URL=$(aws lambda get-function-url-config \
  --function-name "$FN_GENERATE" --query FunctionUrl --output text)

STREAM_URL=$(aws lambda get-function-url-config \
  --function-name "$FN_GENERATE_STREAM" --query FunctionUrl --output text)

echo "API_URL      = $API_URL"
echo "BUFFERED_URL = $BUFFERED_URL"
echo "STREAM_URL   = $STREAM_URL"
```

---

### CORE-1: Health check

```bash
curl -si "$API_URL/health"
# Expected: HTTP 200, JSON với status ok, lambda.memoryLimitMB, runtime (Node.js version)
```

---

### CORE-2: Info endpoint

```bash
curl -s "$API_URL/info" | python3 -m json.tool
# Expected: HTTP 200, awsLimits object với 3 layer giới hạn, thisFunction.memoryLimitMB
```

---

### CORE-3: Upload Excel nhỏ

```bash
# Tạo test files trước nếu chưa có
bash scripts/generate-test-files.sh

curl -s -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/small-100rows.xlsx \
  | python3 -m json.tool

# Expected: HTTP 200, excel.rowCount = 100, file.receivedSizeMB < 0.1
```

---

### CORE-4: Upload Excel medium (~1 MB)

```bash
curl -s -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/medium-1000rows.xlsx \
  | python3 -m json.tool

# Expected: HTTP 200, parse OK
```

---

### CORE-5: Xác định giới hạn upload thực tế

> **Mục đích:** Tìm ngưỡng thực tế, không giả định trước.
> Base64 encode tăng kích thước ~33%, nên file ~4.5 MB → event JSON ~6 MB → sát limit Lambda.

```bash
# Test với 10,000 rows (~1 MB, an toàn)
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/large-10000rows.xlsx \
  -w "\n--- HTTP %{http_code} | %{size_upload} bytes sent | %{time_total}s ---\n"

# Test với 50,000 rows (xem size thực tế sau khi tạo file)
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/xlarge-50000rows.xlsx \
  -w "\n--- HTTP %{http_code} | %{size_upload} bytes sent | %{time_total}s ---\n"
```

> **Ghi nhận kết quả:**
> - `HTTP 413` ngay lập tức (< 1s): API Gateway từ chối (request > 10 MB)
> - `HTTP 500` hoặc `HTTP 413` sau vài giây: Lambda từ chối do event > 6 MB
> - Kiểm tra CloudWatch để phân biệt: nếu Lambda không được invoke → lỗi ở API GW; nếu có log → lỗi trong Lambda
>
> ```bash
> # Kiểm tra CloudWatch sau test
> aws logs tail "/aws/lambda/$FN_UPLOAD" --since 2m
> ```

---

### CORE-6: Generate Excel nhỏ qua API GW

```bash
curl -si "$API_URL/generate-excel?rows=1000" \
  -o /tmp/gen-1k.xlsx \
  -D /tmp/gen-1k-headers.txt

cat /tmp/gen-1k-headers.txt | grep -E "HTTP/|X-"
ls -lh /tmp/gen-1k.xlsx
# Mở file để verify nội dung
```

---

### CORE-7: Generate Excel lớn – xác định giới hạn response

```bash
# Dùng số rows từ file test đã tạo (xlarge-50000rows.xlsx) làm tham chiếu kích thước
curl -si "$API_URL/generate-excel?rows=50000" \
  -o /tmp/gen-50k.xlsx \
  -D /tmp/gen-50k-headers.txt \
  -w "\n--- HTTP %{http_code} | %{size_download} bytes | %{time_total}s ---\n"

cat /tmp/gen-50k-headers.txt | grep -E "HTTP/|X-"
ls -lh /tmp/gen-50k.xlsx 2>/dev/null
```

> **Ghi nhận kết quả:**
> - Nếu HTTP 200 → response < 6 MB, file nhận được thành công
> - Nếu HTTP 500/502 → Lambda response vượt 6 MB limit, bị Lambda runtime từ chối
> - Kiểm tra `X-File-Size-MB` header và CloudWatch log để xem kích thước thực tế Lambda tạo ra

---

### EXP-1: So sánh API GW vs Function URL BUFFERED

```bash
# Cùng workload, cùng limit 6 MB response → kết quả phải giống nhau
echo "--- API Gateway ---"
curl -s "$API_URL/generate-excel?rows=50000" \
  -o /tmp/apigw-50k.xlsx \
  -w "HTTP %{http_code} | %{size_download} bytes | %{time_total}s\n"

echo "--- Function URL BUFFERED ---"
curl -s "${BUFFERED_URL}?rows=50000" \
  -o /tmp/funcurl-buffered-50k.xlsx \
  -w "HTTP %{http_code} | %{size_download} bytes | %{time_total}s\n"

# Mục đích: xác nhận Function URL BUFFERED KHÔNG bypass giới hạn 6 MB response
```

---

### EXP-2: Function URL RESPONSE_STREAM

```bash
echo "--- Function URL RESPONSE_STREAM ---"
curl -s "${STREAM_URL}?rows=50000" \
  -o /tmp/funcurl-stream-50k.xlsx \
  -w "HTTP %{http_code} | %{size_download} bytes | %{time_total}s\n"

ls -lh /tmp/funcurl-stream-50k.xlsx
# Expected: thành công ngay cả khi file > 6 MB vì RESPONSE_STREAM cho phép 200 MB response
```

---

### EXP-3: Benchmark Memory

```bash
source infra/00-variables.sh

run_benchmark() {
  local MEMORY=$1
  local ROWS=10000

  aws lambda update-function-configuration \
    --function-name "$FN_GENERATE" \
    --memory-size "$MEMORY" > /dev/null
  aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
  echo -n "  Memory ${MEMORY}MB, ${ROWS} rows: "

  # Chạy 3 lần để bỏ cold start
  for run in 1 2 3; do
    curl -s "$API_URL/generate-excel?rows=$ROWS" -o /dev/null \
      -w "run${run}=%{time_total}s " 2>/dev/null
  done
  echo ""
}

echo "[ EXP-3 ] Memory Benchmark"
run_benchmark 128
run_benchmark 512
run_benchmark 1024

# Khôi phục memory gốc
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" --memory-size 1024 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"

echo ""
echo "Xem kết quả chi tiết trong CloudWatch:"
echo "  aws logs tail /aws/lambda/$FN_GENERATE --since 5m"
echo "  Filter: REPORT → Duration, Max Memory Used"
```

> **Lưu ý khi đọc kết quả:**
> - `time_total` của curl bao gồm cả network, cold start, billed duration.
> - Đọc `Duration` và `Max Memory Used` trong CloudWatch REPORT log để có số chính xác.
> - Memory tăng → Lambda được cấp vCPU theo tỉ lệ → code CPU-bound (như Excel generation) chạy nhanh hơn.

---

### EXP-4: Test Timeout có kiểm soát

> **Vấn đề với timeout test dùng row count:** Thời gian generate Excel không ổn định và khó dự đoán chính xác. Dùng `delaySeconds` parameter trong handler để kiểm soát và tái hiện được.

**Thêm vào `generateExcel.ts` (dev/test only):**

```typescript
// Chỉ dùng cho timeout experiment; không để trong production
const delaySeconds = parseInt(event.queryStringParameters?.delay ?? '0', 10);
if (delaySeconds > 0 && delaySeconds <= 60) {
  console.log(`[TEST] Sleeping ${delaySeconds}s to simulate heavy workload...`);
  await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
}
```

**Test script:**

```bash
source infra/00-variables.sh

echo "[ EXP-4 ] Timeout test"

# Set timeout ngắn
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" --timeout 5 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
echo "  → Lambda timeout set to 5s"

# Gọi với delay 10s (dài hơn timeout) → Lambda sẽ timeout
echo "  → Calling with delay=10 (expect timeout)..."
curl -si "$API_URL/generate-excel?rows=100&delay=10" \
  -w "\nHTTP %{http_code} | %{time_total}s\n"

# Expected: HTTP 504 từ API Gateway sau ~5–29s (API GW timeout của integration)
# CloudWatch sẽ có: "Task timed out after 5.00 seconds"
echo ""
echo "  → Kiểm tra CloudWatch:"
echo "     aws logs tail /aws/lambda/$FN_GENERATE --since 2m"
echo "     Tìm: 'Task timed out after'"

# Khôi phục timeout
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" --timeout 120 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
echo "  → Timeout restored to 120s"
```

> **Response khi Lambda timeout:**
> - API Gateway HTTP API integration timeout mặc định là 29 giây.
> - Nếu Lambda timeout < 29s: client nhận `HTTP 504 Gateway Timeout`.
> - Nếu Lambda timeout > 29s: API GW timeout trước, trả `HTTP 504`.
> - CloudWatch log sẽ có line: `Task timed out after X.XX seconds`.

---

### EXP-5: Quan sát CloudWatch REPORT

```bash
source infra/00-variables.sh

# Xem log real-time (Ctrl+C để dừng)
aws logs tail "/aws/lambda/$FN_GENERATE" --follow

# Lọc chỉ REPORT lines (có Duration, Memory Used)
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$FN_GENERATE" \
  --filter-pattern "REPORT" \
  --query 'events[*].message' \
  --output text | tail -10
```

> **Đọc REPORT log:**
> ```
> REPORT RequestId: abc-123
>   Duration: 1234.56 ms          ← thời gian Lambda chạy thực tế
>   Billed Duration: 1235 ms      ← làm tròn lên
>   Memory Size: 1024 MB          ← cấu hình memory
>   Max Memory Used: 312 MB       ← RAM thực tế dùng
>   Init Duration: 456.78 ms      ← cold start (chỉ có lần đầu)
> ```

---

## Phase 8 – Cleanup

### `infra/99-cleanup.sh`

```bash
#!/bin/bash
source infra/00-variables.sh

echo " Cleanup bắt đầu..."

# Xóa API Gateway
API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null)
if [ "$API_ID" != "None" ] && [ -n "$API_ID" ]; then
  aws apigatewayv2 delete-api --api-id "$API_ID"
  echo "  API Gateway deleted: $API_ID"
fi

# Xóa Function URLs
for FN_NAME in "$FN_GENERATE" "$FN_GENERATE_STREAM"; do
  aws lambda delete-function-url-config \
    --function-name "$FN_NAME" 2>/dev/null && \
    echo "  Function URL deleted: $FN_NAME" || true
done

# Xóa Lambda functions
for FN_NAME in "$FN_HEALTH" "$FN_INFO" "$FN_UPLOAD" "$FN_GENERATE" "$FN_GENERATE_STREAM"; do
  aws lambda delete-function --function-name "$FN_NAME" 2>/dev/null && \
    echo "  Lambda deleted: $FN_NAME" || \
    echo "   $FN_NAME không tồn tại (bỏ qua)"
done

# Xóa IAM (phải detach trước)
aws iam detach-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" \
  2>/dev/null || true
aws iam delete-role \
  --role-name "$LAMBDA_ROLE_NAME" 2>/dev/null && \
  echo "  IAM Role deleted" || \
  echo "   IAM Role không tồn tại (bỏ qua)"

echo ""
echo "Cleanup complete"
```

---

## Checklist Demo

### Infrastructure
- [ ] `aws sts get-caller-identity` xác nhận đúng account và region
- [ ] IAM Role tồn tại, chỉ có `AWSLambdaBasicExecutionRole`
- [ ] 5 Lambda functions với đúng runtime `nodejs24.x`, memory, timeout
- [ ] API Gateway HTTP API có 4 routes: GET /health, GET /info, POST /upload-excel, GET /generate-excel
- [ ] Function URLs: 1 BUFFERED (generate-excel), 1 RESPONSE_STREAM (generate-excel-stream)

### Core flow
- [ ] `GET /health` → HTTP 200, JSON với `runtime` (Node.js version), `lambda.memoryLimitMB`
- [ ] `GET /info` → HTTP 200, hiển thị đúng 3 layer giới hạn và upload note về Base64
- [ ] `POST /upload-excel` file nhỏ → HTTP 200, JSON với `excel.rowCount`, `file.receivedSizeMB`
- [ ] `GET /generate-excel?rows=1000` → HTTP 200, download file .xlsx, verify file mở được

### Upload limit experiment
- [ ] Upload file tăng dần kích thước và ghi nhận HTTP status code, response body
- [ ] Kiểm tra CloudWatch sau mỗi test để xác định lỗi xảy ra ở API GW hay Lambda
- [ ] Giải thích được: Base64 encoding làm file thực chỉ upload được ~4.5 MB

### Generate limit experiment
- [ ] Đo kích thước thực tế của file `xlarge-50000rows.xlsx` từ generate-test-files.sh
- [ ] Generate 50k rows qua API GW → ghi nhận HTTP status và `X-File-Size-MB` header
- [ ] Generate 50k rows qua Function URL BUFFERED → kết quả giống API GW (cùng limit)
- [ ] Generate 50k rows qua Function URL RESPONSE_STREAM → thành công nếu file < 200 MB

### Configuration experiments
- [ ] Memory benchmark: ghi nhận Duration và Max Memory Used cho 128 MB vs 512 MB vs 1024 MB
- [ ] Timeout test: set 5s timeout, dùng `delay=10` → HTTP 504, CloudWatch có "Task timed out"
- [ ] Giải thích REPORT log: Duration, Billed Duration, Max Memory Used, Init Duration (cold start)

### Concepts cần giải thích
- [ ] IAM Trust Policy vs Permission Policy; tại sao Lambda cần role
- [ ] Hai lớp giới hạn: API Gateway (10 MB) vs Lambda sync (6 MB); Base64 overhead
- [ ] BUFFERED vs RESPONSE_STREAM: chỉ response được nới rộng, request vẫn 6 MB
- [ ] Memory tăng → vCPU tăng theo tỉ lệ → ảnh hưởng đến CPU-bound workload
- [ ] Cold start = Init Duration trong REPORT; warm invocation không có Init Duration
- [ ] Node.js 24: không còn callback handler, chỉ dùng async/await

---

## Timeline và Prioritization

### Core tasks (phải hoàn thành)

| Thứ tự | Việc | Ước tính |
|---|---|---|
| 1 | Phase 0: Verify AWS CLI, setup variables | 5 phút |
| 2 | Phase 1: IAM Role | 5 phút |
| 3 | Phase 2: Viết code (copy từ plan) + npm install | 20 phút |
| 4 | Phase 3: Build, TypeScript check, package zip | 10 phút |
| 5 | Phase 4: Deploy Lambda | 10 phút |
| 6 | Phase 5: API Gateway | 10 phút |
| 7 | CORE-1 đến CORE-7: Test full flow | 15 phút |

**Tổng core: ~75 phút**

### Optional experiments (nếu còn thời gian)

| Experiment | Ước tính |
|---|---|
| Phase 6: Function URLs + EXP-1, EXP-2 | 15 phút |
| EXP-3: Memory benchmark | 10 phút |
| EXP-4: Timeout test | 10 phút |
| EXP-5: CloudWatch deep dive | 10 phút |

> Core flow và kết quả upload/download là ưu tiên hàng đầu để demo. Experiments là phần bổ sung để học thêm về configuration.

---

*Last updated: 2026-11-23 | nodejs24.x | TypeScript | Không dùng S3*
