#!/usr/bin/env bash
# infra/05-test.sh
# End-to-end test script for the deployed API Gateway and Lambda Function URLs.
# Runs core tests and experiment benchmarks as specified in PLAN.md.
#
# Usage: source infra/00-variables.sh && bash infra/05-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

echo "=================================================="
echo "Running Tests & Experiments"
echo "=================================================="

# Retrieve API Gateway Base URL
API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
  --output text 2>/dev/null || echo "")

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  echo "API Gateway '$API_NAME' not found. Please deploy first."
  exit 1
fi
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"

# Retrieve Function URLs
BUFFERED_URL=$(aws lambda get-function-url-config \
  --function-name "$FN_GENERATE" \
  --query FunctionUrl \
  --output text 2>/dev/null || echo "")

STREAM_URL=$(aws lambda get-function-url-config \
  --function-name "$FN_GENERATE_STREAM" \
  --query FunctionUrl \
  --output text 2>/dev/null || echo "")

echo "API Gateway URL : $API_URL"
echo "Buffered URL    : $BUFFERED_URL"
echo "Streaming URL   : $STREAM_URL"
echo ""

# Ensure test files exist
if [ ! -f "test-files/generated/small-100rows.xlsx" ] || [ ! -f "test-files/generated/payload-5mb.bin" ]; then
  echo "Generating local test files..."
  npm run gen:test-files
fi

mkdir -p /tmp/lambda-test-downloads

echo "=================================================="
echo "[CORE-1] Health Check: GET $API_URL/health"
echo "=================================================="
curl -si "$API_URL/health"
echo -e "\n"

echo "=================================================="
echo "[CORE-2] Info & Limits: GET $API_URL/info"
echo "=================================================="
curl -si "$API_URL/info"
echo -e "\n"

echo "=================================================="
echo "[CORE-3A] Upload Small Excel (Raw Binary): POST $API_URL/upload-excel"
echo "=================================================="
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/small-100rows.xlsx
echo -e "\n"

echo "=================================================="
echo "[CORE-3B] Upload Small Excel (Multipart Form-Data): POST $API_URL/upload-excel"
echo "=================================================="
curl -si -X POST "$API_URL/upload-excel" \
  -F "file=@test-files/generated/small-100rows.xlsx"
echo -e "\n"

echo "=================================================="
echo "[CORE-4] Upload Medium Excel (~1 MB): POST $API_URL/upload-excel"
echo "=================================================="
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/medium-1000rows.xlsx
echo -e "\n"

echo "=================================================="
echo "[CORE-5] Boundary Testing: Upload Payloads Across Layers"
echo "=================================================="

# Test 5.1: 1 MB payload (Baseline safe upload)
echo "--- 5.1: Uploading payload-1mb.bin (1 MB) -> Expect HTTP 200 or 422 diagnostic ---"
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/payload-1mb.bin \
  -w "\n[Metrics] HTTP %{http_code} | Sent: %{size_upload} bytes | Total time: %{time_total}s\n"
echo ""

# Test 5.2: 3 MB payload (Upper limit for raw file before Base64 overhead hits 6 MB)
echo "--- 5.2: Uploading payload-3mb.bin (3 MB) -> Expect HTTP 200 or 422 diagnostic ---"
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/payload-3mb.bin \
  -w "\n[Metrics] HTTP %{http_code} | Sent: %{size_upload} bytes | Total time: %{time_total}s\n"
echo ""

# Test 5.3: 5 MB payload (Exceeds Lambda 6 MB synchronous event limit after Base64)
# 5 MB raw -> 6.67 MB Base64 string in JSON event -> Lambda synchronous limit exceeded!
echo "--- 5.3: Uploading payload-5mb.bin (5 MB) -> Expect HTTP 500/502 (Lambda 6 MB event limit) ---"
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/payload-5mb.bin \
  -w "\n[Metrics] HTTP %{http_code} | Sent: %{size_upload} bytes | Total time: %{time_total}s\n"
echo ""

# Test 5.4: 15 MB payload (Exceeds API Gateway 10 MB limit)
echo "--- 5.4: Uploading payload-15mb.bin (15 MB) -> Expect HTTP 413 (API Gateway limit) ---"
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/payload-15mb.bin \
  -w "\n[Metrics] HTTP %{http_code} | Sent: %{size_upload} bytes | Total time: %{time_total}s\n"
echo ""

# Test 5.5: Real-world Dataset Upload (Online Retail 23 MB -> Expect HTTP 413 at edge)
if [ -f "test-files/datasets/online+retail/Online Retail.xlsx" ]; then
  echo "--- 5.5: Real-world Dataset: Online Retail.xlsx (23 MB) -> Expect HTTP 413 at API Gateway ---"
  curl -si -X POST "$API_URL/upload-excel" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"test-files/datasets/online+retail/Online Retail.xlsx" \
    -w "\n[Metrics] HTTP %{http_code} | Sent: %{size_upload} bytes | Total time: %{time_total}s\n"
  echo ""
fi

echo "=================================================="
echo "[CORE-6] Generate Excel Small (1,000 rows): GET $API_URL/generate-excel?rows=1000"
echo "=================================================="
curl -si "$API_URL/generate-excel?rows=1000" \
  -o /tmp/lambda-test-downloads/gen-1k.xlsx \
  -D /tmp/lambda-test-downloads/gen-1k-headers.txt \
  -w "\n[Download metrics] HTTP %{http_code} | Size: %{size_download} bytes | Total time: %{time_total}s\n"
grep -E "HTTP/|X-" /tmp/lambda-test-downloads/gen-1k-headers.txt || true
ls -lh /tmp/lambda-test-downloads/gen-1k.xlsx
echo ""

echo "=================================================="
echo "[CORE-7] Generate Excel Large (50,000 rows) via API Gateway"
echo "=================================================="
curl -si "$API_URL/generate-excel?rows=50000" \
  -o /tmp/lambda-test-downloads/gen-50k-apigw.xlsx \
  -D /tmp/lambda-test-downloads/gen-50k-headers.txt \
  -w "\n[Download metrics] HTTP %{http_code} | Size: %{size_download} bytes | Total time: %{time_total}s\n"
grep -E "HTTP/|X-" /tmp/lambda-test-downloads/gen-50k-headers.txt || true
echo ""

if [ -n "$BUFFERED_URL" ] && [ "$BUFFERED_URL" != "None" ]; then
  echo "=================================================="
  echo "[EXP-1] Function URL BUFFERED: 50,000 rows (Tests 6 MB response limit)"
  echo "=================================================="
  curl -si "${BUFFERED_URL}?rows=50000" \
    -o /tmp/lambda-test-downloads/gen-50k-buffered.xlsx \
    -w "\n[Download metrics] HTTP %{http_code} | Size: %{size_download} bytes | Total time: %{time_total}s\n"
  echo ""
fi

if [ -n "$STREAM_URL" ] && [ "$STREAM_URL" != "None" ]; then
  echo "=================================================="
  echo "[EXP-2A] Function URL RESPONSE_STREAM: Excel Mode (50,000 rows)"
  echo "=================================================="
  curl -si "${STREAM_URL}?rows=50000" \
    -o /tmp/lambda-test-downloads/gen-50k-stream.xlsx \
    -w "\n[Download metrics] HTTP %{http_code} | Size: %{size_download} bytes | Total time: %{time_total}s\n"
  ls -lh /tmp/lambda-test-downloads/gen-50k-stream.xlsx || true
  echo ""

  echo "=================================================="
  echo "[EXP-2B] Function URL RESPONSE_STREAM: Synthetic Chunked Streaming"
  echo "=================================================="
  for SIZE in 1 5 10 25 50 100; do
    echo "--- Streaming ${SIZE} MB chunked (64 KB chunks) ---"
    curl -si "${STREAM_URL}?mode=synthetic&sizeMB=${SIZE}&chunkKB=64&format=csv" \
      -o /tmp/lambda-test-downloads/stream-${SIZE}mb.csv \
      -w "\n[Stream metrics] HTTP %{http_code} | Downloaded: %{size_download} bytes | TTFB: %{time_starttransfer}s | Total time: %{time_total}s\n"
    ls -lh /tmp/lambda-test-downloads/stream-${SIZE}mb.csv
    echo ""
  done
fi

echo "=================================================="
echo "Core tests & streaming experiments completed."
echo "For Memory (EXP-3) and Timeout (EXP-4) benchmarks, see PLAN.md Phase 7."
echo "=================================================="
