#!/usr/bin/env bash
# infra/06-benchmark.sh
# Comprehensive deep-dive experiments:
#   1. Updates generateExcelStream with the fixed package (fixes Cannot find module 'aws-lambda')
#   2. Configures Function URL for upload-excel (so we can test Upload via BOTH API Gateway and Function URL)
#   3. Upload benchmark with heavy Excel files (3MB, 5MB, 100k rows) via both channels
#   4. Memory Benchmark: Tests 128 MB vs 512 MB vs 1024 MB with heavy workload & CloudWatch REPORT inspection
#   5. Timeout Experiment: Configures 5s timeout, simulates 10s workload, verifies HTTP 504 and CloudWatch error
#   6. True Response Streaming: Streams 1 MB, 10 MB, 25 MB, 50 MB, 100 MB chunks
#
# Usage: source infra/00-variables.sh && bash infra/06-benchmark.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

echo "=================================================="
echo "ADVANCED BENCHMARK & EXPERIMENTS SUITE"
echo "=================================================="

API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
  --output text 2>/dev/null || echo "")

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  echo "API Gateway '$API_NAME' not found."
  exit 1
fi
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"

mkdir -p /tmp/lambda-test-downloads

# ------------------------------------------------------------------------------
# STEP 1: Update generate-excel-stream function code with the fix
# ------------------------------------------------------------------------------
echo ""
echo "--- Step 1: Updating generate-excel-stream with fixed package ---"
aws lambda update-function-code \
  --function-name "$FN_GENERATE_STREAM" \
  --zip-file "fileb://$ZIP_DIR/${FN_GENERATE_STREAM}.zip" > /dev/null

echo "Waiting for update..."
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE_STREAM"
echo "generate-excel-stream updated successfully."

# ------------------------------------------------------------------------------
# STEP 2: Configure Function URL for upload-excel (Channel B)
# ------------------------------------------------------------------------------
echo ""
echo "--- Step 2: Creating Function URL for upload-excel (Channel B) ---"
UPLOAD_URL=$(aws lambda get-function-url-config \
  --function-name "$FN_UPLOAD" \
  --query FunctionUrl \
  --output text 2>/dev/null || echo "")

if [ -z "$UPLOAD_URL" ] || [ "$UPLOAD_URL" = "None" ]; then
  UPLOAD_URL=$(aws lambda create-function-url-config \
    --function-name "$FN_UPLOAD" \
    --auth-type NONE \
    --cors AllowOrigins='*',AllowMethods='POST',AllowHeaders='Content-Type' \
    --query FunctionUrl \
    --output text)

  aws lambda add-permission \
    --function-name "$FN_UPLOAD" \
    --statement-id "funcurl-public-invoke-fn" \
    --action lambda:InvokeFunction \
    --principal "*" > /dev/null 2>&1 || true

  aws lambda add-permission \
    --function-name "$FN_UPLOAD" \
    --statement-id "funcurl-public-invoke-url" \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE > /dev/null 2>&1 || true
fi

STREAM_URL=$(aws lambda get-function-url-config \
  --function-name "$FN_GENERATE_STREAM" \
  --query FunctionUrl \
  --output text)

echo "API Gateway URL : $API_URL"
echo "Upload Func URL : $UPLOAD_URL"
echo "Stream Func URL : $STREAM_URL"

# ------------------------------------------------------------------------------
# STEP 3: Compare Upload Channels (API Gateway vs Function URL) with Heavy Files
# ------------------------------------------------------------------------------
echo ""
echo "=================================================="
echo "TEST A: Uploading Heavy Excel Files via Both Channels"
echo "=================================================="

# A1: Upload 100k rows (3.8 MB XLSX) via API Gateway
echo "1. Uploading 100,000 rows (3.8 MB Excel) via API Gateway:"
curl -si -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/xxlarge-100000rows.xlsx \
  -w "\n[Metrics] HTTP %{http_code} | Sent: %{size_upload} bytes | Total time: %{time_total}s\n"
echo ""

# A2: Upload 100k rows (3.8 MB XLSX) via Function URL directly
echo "2. Uploading 100,000 rows (3.8 MB Excel) via Function URL directly:"
curl -si -X POST "$UPLOAD_URL" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/xxlarge-100000rows.xlsx \
  -w "\n[Metrics] HTTP %{http_code} | Sent: %{size_upload} bytes | Total time: %{time_total}s\n"
echo ""

# ------------------------------------------------------------------------------
# STEP 4: Memory Benchmark (128 MB vs 512 MB vs 1024 MB) & CloudWatch REPORT
# ------------------------------------------------------------------------------
echo "=================================================="
echo "TEST B: Memory Benchmark (128 MB vs 512 MB vs 1024 MB)"
echo "Workload: Generating 10,000 rows of Excel"
echo "=================================================="

for MEM in 128 512 1024; do
  echo ">>> Testing with Memory = ${MEM} MB..."
  aws lambda update-function-configuration \
    --function-name "$FN_GENERATE" \
    --memory-size "$MEM" > /dev/null

  aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"

  # Invoke workload
  curl -s "$API_URL/generate-excel?rows=10000" -o /dev/null \
    -w "HTTP %{http_code} | Client Duration: %{time_total}s\n"

  sleep 2

  # Fetch latest CloudWatch REPORT log line
  echo "Latest CloudWatch REPORT line for ${MEM} MB:"
  aws logs filter-log-events \
    --log-group-name "/aws/lambda/$FN_GENERATE" \
    --filter-pattern "REPORT" \
    --query 'events[-1].message' \
    --output text 2>/dev/null || echo "(Log event buffering in CloudWatch...)"
  echo ""
done

# Restore memory to 1024 MB
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" \
  --memory-size 1024 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
echo "Restored memory to 1024 MB."
echo ""

# ------------------------------------------------------------------------------
# STEP 5: Timeout Experiment (5s timeout vs 10s simulated workload)
# ------------------------------------------------------------------------------
echo "=================================================="
echo "TEST C: Timeout Experiment"
echo "Setting Lambda timeout to 5s, simulating 10s workload"
echo "=================================================="

aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" \
  --timeout 5 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
echo "Lambda timeout set to 5s."

echo "Sending request with ?delay=10 (should timeout after 5s)..."
curl -si "$API_URL/generate-excel?rows=100&delay=10" \
  -w "\n[Metrics] HTTP %{http_code} | Total time: %{time_total}s\n"

sleep 3
echo ""
echo "Checking CloudWatch Logs for timeout message:"
aws logs filter-log-events \
  --log-group-name "/aws/lambda/$FN_GENERATE" \
  --filter-pattern "timed out" \
  --query 'events[-1].message' \
  --output text 2>/dev/null || echo "(Check CloudWatch Console /aws/lambda/$FN_GENERATE)"

# Restore timeout to 120s
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" \
  --timeout 120 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
echo "Restored Lambda timeout to 120s."
echo ""

# ------------------------------------------------------------------------------
# STEP 6: True Response Streaming with Fixed Package
# ------------------------------------------------------------------------------
echo "=================================================="
echo "TEST D: True Response Streaming (1 MB, 10 MB, 50 MB, 100 MB)"
echo "=================================================="

for SIZE in 1 10 50 100; do
  echo "Streaming ${SIZE} MB chunked from Lambda Function URL..."
  curl -si "${STREAM_URL}?mode=synthetic&sizeMB=${SIZE}&chunkKB=64&format=csv" \
    -o "/tmp/lambda-test-downloads/stream-${SIZE}mb.csv" \
    -w "\n[Metrics] HTTP %{http_code} | Downloaded: %{size_download} bytes | TTFB: %{time_starttransfer}s | Total time: %{time_total}s\n"
  ls -lh "/tmp/lambda-test-downloads/stream-${SIZE}mb.csv"
  head -n 3 "/tmp/lambda-test-downloads/stream-${SIZE}mb.csv"
  echo ""
done

echo "=================================================="
echo "ALL ADVANCED BENCHMARKS COMPLETED!"
echo "=================================================="
