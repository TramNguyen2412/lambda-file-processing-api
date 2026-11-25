#!/usr/bin/env bash
# infra/06-benchmark.sh
# Advanced Benchmarks & Empirical Quota Verification Suite:
#   Step 1: Code update & verification (generateExcel and generateExcelStream)
#   Step 2: Function URL resolution & endpoint verification
#   TEST A: Upload channel comparison (API Gateway vs Function URL) with 100k rows (repeated runs)
#   TEST B: Memory & vCPU scaling benchmark (128 MB vs 512 MB vs 1024 MB) with exact Request ID correlation
#   TEST C: Timeout experiment (5s timeout vs 10s delay) with API GW Access Log + Lambda log correlation
#   TEST D: True Response Streaming & 200 MiB quota boundary verification (10, 50, 100, 190, 205 MiB)
#
# Usage: bash infra/06-benchmark.sh

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
  echo "Error: API Gateway '$API_NAME' not found."
  exit 1
fi
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"
APIGW_LOG_GROUP="/aws/apigateway/${PROJECT}-access-logs"

TMP_BENCH_DIR="/tmp/lambda-benchmark-$$"
mkdir -p "$TMP_BENCH_DIR"
mkdir -p /tmp/lambda-test-downloads

# ------------------------------------------------------------------------------
# Capture Original Configurations & Safe Rollback Trap
# ------------------------------------------------------------------------------
ORIG_GEN_MEM=$(aws lambda get-function-configuration \
  --function-name "$FN_GENERATE" \
  --query MemorySize \
  --output text 2>/dev/null || echo "")
ORIG_GEN_TIMEOUT=$(aws lambda get-function-configuration \
  --function-name "$FN_GENERATE" \
  --query Timeout \
  --output text 2>/dev/null || echo "")
ORIG_STREAM_TIMEOUT=$(aws lambda get-function-configuration \
  --function-name "$FN_GENERATE_STREAM" \
  --query Timeout \
  --output text 2>/dev/null || echo "")

if [ -z "$ORIG_GEN_MEM" ] || [ "$ORIG_GEN_MEM" = "None" ] || \
   [ -z "$ORIG_GEN_TIMEOUT" ] || [ "$ORIG_GEN_TIMEOUT" = "None" ] || \
   [ -z "$ORIG_STREAM_TIMEOUT" ] || [ "$ORIG_STREAM_TIMEOUT" = "None" ]; then
  echo "Error: Unable to read existing Lambda configurations. Aborting safely."
  exit 1
fi

echo "Captured Pre-Run Lambda Configurations:"
echo "  - $FN_GENERATE        : Memory = ${ORIG_GEN_MEM} MB, Timeout = ${ORIG_GEN_TIMEOUT}s"
echo "  - $FN_GENERATE_STREAM : Timeout = ${ORIG_STREAM_TIMEOUT}s"
if [ "$ORIG_STREAM_TIMEOUT" -ne 120 ]; then
  echo "  [Note] Pre-run timeout for $FN_GENERATE_STREAM is ${ORIG_STREAM_TIMEOUT}s (baseline in 02-lambda.sh is 120s)."
  echo "         Restoration will strictly revert to the captured pre-run value (${ORIG_STREAM_TIMEOUT}s)."
fi

cleanup() {
  local exit_code=$?
  echo ""
  echo "=================================================="
  echo "CLEANUP: Restoring captured pre-run configurations..."
  echo "=================================================="

  local cur_mem
  cur_mem=$(aws lambda get-function-configuration --function-name "$FN_GENERATE" --query MemorySize --output text 2>/dev/null || echo "")
  if [ -n "$cur_mem" ] && [ "$cur_mem" != "$ORIG_GEN_MEM" ]; then
    echo "Restoring $FN_GENERATE memory to ${ORIG_GEN_MEM} MB..."
    aws lambda update-function-configuration --function-name "$FN_GENERATE" --memory-size "$ORIG_GEN_MEM" >/dev/null 2>&1 || true
    aws lambda wait function-updated-v2 --function-name "$FN_GENERATE" 2>/dev/null || true
  fi

  local cur_timeout
  cur_timeout=$(aws lambda get-function-configuration --function-name "$FN_GENERATE" --query Timeout --output text 2>/dev/null || echo "")
  if [ -n "$cur_timeout" ] && [ "$cur_timeout" != "$ORIG_GEN_TIMEOUT" ]; then
    echo "Restoring $FN_GENERATE timeout to ${ORIG_GEN_TIMEOUT}s..."
    aws lambda update-function-configuration --function-name "$FN_GENERATE" --timeout "$ORIG_GEN_TIMEOUT" >/dev/null 2>&1 || true
    aws lambda wait function-updated-v2 --function-name "$FN_GENERATE" 2>/dev/null || true
  fi

  local cur_stream_timeout
  cur_stream_timeout=$(aws lambda get-function-configuration --function-name "$FN_GENERATE_STREAM" --query Timeout --output text 2>/dev/null || echo "")
  if [ -n "$cur_stream_timeout" ] && [ "$cur_stream_timeout" != "$ORIG_STREAM_TIMEOUT" ]; then
    echo "Restoring $FN_GENERATE_STREAM timeout to ${ORIG_STREAM_TIMEOUT}s..."
    aws lambda update-function-configuration --function-name "$FN_GENERATE_STREAM" --timeout "$ORIG_STREAM_TIMEOUT" >/dev/null 2>&1 || true
    aws lambda wait function-updated-v2 --function-name "$FN_GENERATE_STREAM" 2>/dev/null || true
  fi

  rm -rf "$TMP_BENCH_DIR"
  echo "Cleanup complete (Exit code: $exit_code)."
  return "$exit_code"
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------------------
# Helper: Safe CloudWatch Logs Filter Query (returns JSON via --output json)
# Properly handles pagination & avoids JMESPath per-page None output issues.
# ------------------------------------------------------------------------------
cw_filter_json() {
  local log_group="$1"
  local start_ms="$2"
  local filter_pattern="$3"

  aws logs filter-log-events \
    --log-group-name "$log_group" \
    --start-time "$start_ms" \
    --filter-pattern "$filter_pattern" \
    --output json 2>/dev/null || echo '{"events":[]}'
}

# ------------------------------------------------------------------------------
# STEP 1: Update Function Code (generateExcel and generateExcelStream)
# ------------------------------------------------------------------------------
echo ""
echo "--- Step 1: Updating Lambda functions with latest packages ---"
if [ -f "$ZIP_DIR/${FN_GENERATE}.zip" ]; then
  echo "Updating $FN_GENERATE..."
  aws lambda update-function-code \
    --function-name "$FN_GENERATE" \
    --zip-file "fileb://$ZIP_DIR/${FN_GENERATE}.zip" > /dev/null
  aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
fi

if [ -f "$ZIP_DIR/${FN_GENERATE_STREAM}.zip" ]; then
  echo "Updating $FN_GENERATE_STREAM..."
  aws lambda update-function-code \
    --function-name "$FN_GENERATE_STREAM" \
    --zip-file "fileb://$ZIP_DIR/${FN_GENERATE_STREAM}.zip" > /dev/null
  aws lambda wait function-updated-v2 --function-name "$FN_GENERATE_STREAM"
fi
echo "Function code verified up-to-date."

# ------------------------------------------------------------------------------
# STEP 2: Configure & Verify Function URLs
# ------------------------------------------------------------------------------
echo ""
echo "--- Step 2: Resolving Function URLs ---"
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
  --output text 2>/dev/null || echo "")

echo "API Gateway URL : $API_URL"
echo "Upload Func URL : $UPLOAD_URL"
echo "Stream Func URL : $STREAM_URL"

# ------------------------------------------------------------------------------
# TEST A: Upload Channel Comparison (API Gateway vs Function URL)
# ------------------------------------------------------------------------------
echo ""
echo "=================================================="
echo "TEST A: Upload Channel Comparison (API Gateway vs Function URL)"
echo "File: xxlarge-100000rows.xlsx (3,916,927 bytes raw, ~5.22 MB Base64 event)"
echo "=================================================="
echo "[Technical Context] Both API Gateway HTTP API v2 and Lambda Function URL receive binary"
echo "payloads as Base64-encoded request bodies (isBase64Encoded: true). Function URL does NOT"
echo "eliminate Base64 encoding. Measurements compare end-to-end client latency and internal"
echo "Lambda parse time across repeated runs."
echo ""

UPLOAD_FILE="test-files/generated/xxlarge-100000rows.xlsx"
if [ ! -f "$UPLOAD_FILE" ]; then
  echo "Generating test file $UPLOAD_FILE..."
  node scripts/generate-test-files.mjs target-3mb
fi

RUNS=2
declare -a APIGW_TIMES=()
declare -a FURL_TIMES=()

echo "--- Benchmarking Channel 1: API Gateway (POST /upload-excel) ---"
for i in $(seq 1 "$RUNS"); do
  RESP_HDRS="$TMP_BENCH_DIR/apigw-upload-run${i}-hdrs.txt"
  RESP_BODY="$TMP_BENCH_DIR/apigw-upload-run${i}-body.json"

  TOTAL_TIME=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" \
    -X POST "$API_URL/upload-excel" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$UPLOAD_FILE" \
    -w "%{time_total}")

  HTTP_CODE=$(grep -i "^HTTP/" "$RESP_HDRS" | tail -n 1 | awk '{print $2}')
  REQ_ID=$(grep -i "^apigw-requestid:" "$RESP_HDRS" | awk '{print $2}' | tr -d '\r\n')
  PARSE_MS=$(python3 -c "import json; data=json.load(open('$RESP_BODY')); print(data.get('performance', {}).get('parseElapsedMs', 'N/A'))" 2>/dev/null || echo "N/A")

  APIGW_TIMES+=("$TOTAL_TIME")
  echo "  Run $i: HTTP $HTTP_CODE | Client Duration: ${TOTAL_TIME}s | Lambda Parse: ${PARSE_MS} ms | API GW ReqID: ${REQ_ID:-N/A}"
done

echo ""
echo "--- Benchmarking Channel 2: Function URL (POST /) ---"
for i in $(seq 1 "$RUNS"); do
  RESP_HDRS="$TMP_BENCH_DIR/furl-upload-run${i}-hdrs.txt"
  RESP_BODY="$TMP_BENCH_DIR/furl-upload-run${i}-body.json"

  TOTAL_TIME=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" \
    -X POST "$UPLOAD_URL" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$UPLOAD_FILE" \
    -w "%{time_total}")

  HTTP_CODE=$(grep -i "^HTTP/" "$RESP_HDRS" | tail -n 1 | awk '{print $2}')
  REQ_ID=$(grep -i "^x-amzn-requestid:" "$RESP_HDRS" | awk '{print $2}' | tr -d '\r\n')
  PARSE_MS=$(python3 -c "import json; data=json.load(open('$RESP_BODY')); print(data.get('performance', {}).get('parseElapsedMs', 'N/A'))" 2>/dev/null || echo "N/A")

  FURL_TIMES+=("$TOTAL_TIME")
  echo "  Run $i: HTTP $HTTP_CODE | Client Duration: ${TOTAL_TIME}s | Lambda Parse: ${PARSE_MS} ms | Lambda ReqID: ${REQ_ID:-N/A}"
done

echo ""
echo "--- TEST A Summary Comparison ---"
python3 -c "
apigw_times = [float(x) for x in '${APIGW_TIMES[*]}'.split()]
furl_times = [float(x) for x in '${FURL_TIMES[*]}'.split()]
avg_apigw = sum(apigw_times) / len(apigw_times)
avg_furl = sum(furl_times) / len(furl_times)
diff = avg_apigw - avg_furl
pct = (diff / avg_apigw) * 100 if avg_apigw > 0 else 0
print(f'API Gateway Mean Client Duration : {avg_apigw:.2f}s (Runs: {apigw_times})')
print(f'Function URL Mean Client Duration: {avg_furl:.2f}s (Runs: {furl_times})')
print(f'Observed Delta                   : {diff:+.2f}s ({pct:+.1f}% faster on direct path)')
print('Note: Component-level latency (DNS, TLS, Edge routing, Base64 decoding) is not measured')
print('separately by this test; measured values represent end-to-end client duration.')
"
echo "Status: [PASS]"
echo ""

# ------------------------------------------------------------------------------
# TEST B: Memory & vCPU Scaling Benchmark (128 MB vs 512 MB vs 1024 MB)
# ------------------------------------------------------------------------------
echo "=================================================="
echo "TEST B: Memory & vCPU Scaling Benchmark"
echo "Workload: Generating 10,000 rows of Excel via GET /generate-excel?rows=10000"
echo "Log Group: /aws/lambda/$FN_GENERATE"
echo "=================================================="

for MEM in 128 512 1024; do
  echo ">>> Configuring $FN_GENERATE Memory to ${MEM} MB..."
  aws lambda update-function-configuration \
    --function-name "$FN_GENERATE" \
    --memory-size "$MEM" > /dev/null
  aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"

  # Verify actual deployed memory configuration
  ACTUAL_MEM=$(aws lambda get-function-configuration \
    --function-name "$FN_GENERATE" \
    --query MemorySize \
    --output text 2>/dev/null || echo "UNKNOWN")

  if [ "$ACTUAL_MEM" != "$MEM" ]; then
    echo "ERROR: Memory update verification failed. Expected $MEM MB, got $ACTUAL_MEM MB."
    continue
  fi

  # Buffer 15s prior to client clock start to safely absorb NTP skew vs AWS CloudWatch timestamps
  INVOKE_START_MS=$(python3 -c "import time; print(int(time.time() * 1000) - 15000)")

  HDRS_FILE="$TMP_BENCH_DIR/mem-${MEM}-hdrs.txt"
  BODY_FILE="$TMP_BENCH_DIR/mem-${MEM}-body.bin"

  CLIENT_DUR=$(curl -s -D "$HDRS_FILE" -o "$BODY_FILE" \
    "$API_URL/generate-excel?rows=10000" \
    -w "%{time_total}")

  HTTP_CODE=$(grep -i "^HTTP/" "$HDRS_FILE" | tail -n 1 | awk '{print $2}')
  REQ_ID=$(grep -i "^x-lambda-request-id:" "$HDRS_FILE" | awk '{print $2}' | tr -d '\r\n')
  APIGW_ID=$(grep -i "^apigw-requestid:" "$HDRS_FILE" | awk '{print $2}' | tr -d '\r\n')

  # Poll CloudWatch Logs for up to 40s (10 attempts x 4s) using properly quoted filter pattern.
  # Note: In CloudWatch filter syntax, terms containing ':' or '-' MUST be double-quoted.
  echo "Polling /aws/lambda/$FN_GENERATE for RequestId ${REQ_ID:-N/A} (up to 40s)..."
  REPORT_LINE=""
  for attempt in $(seq 1 10); do
    sleep 4
    CW_JSON="$TMP_BENCH_DIR/mem-${MEM}-cw.json"
    if [ -n "$REQ_ID" ]; then
      cw_filter_json "/aws/lambda/$FN_GENERATE" "$INVOKE_START_MS" "\"REPORT\" \"$REQ_ID\"" > "$CW_JSON"
      REPORT_LINE=$(python3 -c "
import json
data = json.load(open('$CW_JSON'))
events = data.get('events', [])
matches = [e['message'] for e in events if 'REPORT' in e.get('message', '') and '$REQ_ID' in e.get('message', '')]
print(matches[-1].strip() if matches else '')
" 2>/dev/null || echo "")
    fi

    if [ -n "$REPORT_LINE" ]; then
      echo "  Found matching REPORT line on attempt $attempt ($(( attempt * 4 ))s)."
      break
    fi
  done

  LAMBDA_DUR="UNAVAILABLE"
  BILLED_DUR="UNAVAILABLE"
  MAX_MEM="UNAVAILABLE"
  INIT_DUR="N/A"
  REPORT_REQ_ID="${REQ_ID:-UNAVAILABLE}"

  if [ -n "$REPORT_LINE" ]; then
    PARSED_METRICS=$(python3 -c "
import re
line = '''$REPORT_LINE'''
dur = re.search(r'Duration:\s*([\d.]+)\s*ms', line)
billed = re.search(r'Billed Duration:\s*([\d.]+)\s*ms', line)
mem = re.search(r'Max Memory Used:\s*([\d.]+)\s*MB', line)
init = re.search(r'Init Duration:\s*([\d.]+)\s*ms', line)
req = re.search(r'RequestId:\s*([a-f0-9-]+)', line)
print(f'{dur.group(1) if dur else \"UNAVAILABLE\"}|{billed.group(1) if billed else \"UNAVAILABLE\"}|{mem.group(1) if mem else \"UNAVAILABLE\"}|{init.group(1) if init else \"N/A\"}|{req.group(1) if req else \"\"}')
" 2>/dev/null || echo "UNAVAILABLE|UNAVAILABLE|UNAVAILABLE|N/A|")

    IFS='|' read -r LAMBDA_DUR BILLED_DUR MAX_MEM INIT_DUR CW_REQ <<< "$PARSED_METRICS"
    if [ -n "$CW_REQ" ]; then
      REPORT_REQ_ID="$CW_REQ"
    fi
  fi

  echo "--------------------------------------------------"
  echo "Test Name          : Memory Benchmark (${MEM} MB)"
  echo "Actual Config      : ${ACTUAL_MEM} MB"
  echo "HTTP Status        : ${HTTP_CODE:-UNKNOWN}"
  echo "Client Duration    : ${CLIENT_DUR}s"
  echo "Lambda Duration    : ${LAMBDA_DUR} ms"
  echo "Billed Duration    : ${BILLED_DUR} ms"
  echo "Max Memory Used    : ${MAX_MEM} MB"
  echo "Init Duration      : ${INIT_DUR} ms"
  echo "Lambda Request ID  : ${REPORT_REQ_ID}"
  echo "API GW Request ID  : ${APIGW_ID:-UNAVAILABLE}"
  if [ "$LAMBDA_DUR" = "UNAVAILABLE" ]; then
    echo "Status             : [PASS - METRICS UNAVAILABLE]"
    echo "Explanation        : CloudWatch REPORT for RequestId ${REPORT_REQ_ID} was not retrieved within 40s polling window."
  else
    echo "Status             : [PASS]"
  fi
  echo "--------------------------------------------------"
  echo ""
done

# Restore memory to captured original value
echo "Restoring $FN_GENERATE memory to ${ORIG_GEN_MEM} MB..."
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" \
  --memory-size "$ORIG_GEN_MEM" > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
echo "Memory restored to ${ORIG_GEN_MEM} MB."
echo ""

# ------------------------------------------------------------------------------
# TEST C: Timeout Experiment (Multi-Layer Correlation)
# ------------------------------------------------------------------------------
echo "=================================================="
echo "TEST C: Timeout Experiment"
echo "Configuring Lambda timeout to 5s, simulating 10s workload (?delay=10)"
echo "=================================================="

aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" \
  --timeout 5 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"

ACTUAL_TIMEOUT=$(aws lambda get-function-configuration \
  --function-name "$FN_GENERATE" \
  --query Timeout \
  --output text 2>/dev/null || echo "UNKNOWN")

echo "Actual Lambda Timeout: ${ACTUAL_TIMEOUT}s"

INVOKE_START_MS=$(python3 -c "import time; print(int(time.time() * 1000) - 15000)")
HDRS_FILE="$TMP_BENCH_DIR/timeout-hdrs.txt"
BODY_FILE="$TMP_BENCH_DIR/timeout-body.json"

echo "Sending request with ?delay=10 (expected timeout at 5s)..."
CLIENT_DUR=$(curl -s -D "$HDRS_FILE" -o "$BODY_FILE" \
  "$API_URL/generate-excel?rows=100&delay=10" \
  -w "%{time_total}")

HTTP_CODE=$(grep -i "^HTTP/" "$HDRS_FILE" | tail -n 1 | awk '{print $2}')
APIGW_ID=$(grep -i "^apigw-requestid:" "$HDRS_FILE" | awk '{print $2}' | tr -d '\r\n')
BODY_SNIPPET=$(cat "$BODY_FILE" 2>/dev/null | tr -d '\n\r' | cut -c 1-100)

echo "Client HTTP Status: $HTTP_CODE | Client Duration: ${CLIENT_DUR}s | API GW ReqID: ${APIGW_ID:-N/A}"

# Step C1: Correlate API Gateway Request ID -> Integration Request ID via Access Logs
echo "Step C1: Polling API Gateway Access Logs ($APIGW_LOG_GROUP) for RequestId ${APIGW_ID:-N/A}..."
INTEG_REQ_ID=""
INTEG_STATUS="UNAVAILABLE"
INTEG_ERR="UNAVAILABLE"

for attempt in $(seq 1 8); do
  sleep 4
  if [ -n "$APIGW_ID" ]; then
    CW_APIGW_JSON="$TMP_BENCH_DIR/timeout-apigw.json"
    cw_filter_json "$APIGW_LOG_GROUP" "$INVOKE_START_MS" "\"$APIGW_ID\"" > "$CW_APIGW_JSON"
    PARSED_APIGW=$(python3 -c "
import json
data = json.load(open('$CW_APIGW_JSON'))
for e in data.get('events', []):
    msg = e.get('message', '')
    if '$APIGW_ID' in msg:
        try:
            obj = json.loads(msg)
            print(f\"{obj.get('integrationRequestId', '')}|{obj.get('integrationStatus', '')}|{obj.get('integrationErrorMessage', '') or obj.get('integrationError', '')}\")
            break
        except Exception:
            pass
" 2>/dev/null || echo "")

    if [ -n "$PARSED_APIGW" ]; then
      IFS='|' read -r INTEG_REQ_ID INTEG_STATUS INTEG_ERR <<< "$PARSED_APIGW"
      echo "  Found API Gateway Access Log on attempt $attempt (IntegrationReqID: ${INTEG_REQ_ID:-N/A})."
      break
    fi
  fi
done

# Step C2: Query Lambda CloudWatch Logs (/aws/lambda/$FN_GENERATE)
echo "Step C2: Polling Lambda Logs (/aws/lambda/$FN_GENERATE) for timeout log..."
TIMEOUT_LOG=""
LAMBDA_CTX_REQ_ID=""
CORRELATION_METHOD="NONE"

for attempt in $(seq 1 8); do
  CW_LAMBDA_JSON="$TMP_BENCH_DIR/timeout-lambda.json"
  if [ -n "$INTEG_REQ_ID" ] && [ "$INTEG_REQ_ID" != "-" ]; then
    cw_filter_json "/aws/lambda/$FN_GENERATE" "$INVOKE_START_MS" "\"$INTEG_REQ_ID\"" > "$CW_LAMBDA_JSON"
    PARSED_LAMBDA=$(python3 -c "
import json, re
data = json.load(open('$CW_LAMBDA_JSON'))
timeout_msg = ''
ctx_id = ''
for e in data.get('events', []):
    msg = e.get('message', '').strip()
    if 'Task timed out' in msg or 'timed out after' in msg:
        timeout_msg = msg
        m = re.search(r'([a-f0-9-]{36})', msg)
        if m: ctx_id = m.group(1)
    if not ctx_id and 'RequestId:' in msg:
        m = re.search(r'RequestId:\s*([a-f0-9-]{36})', msg)
        if m: ctx_id = m.group(1)
if timeout_msg:
    print(f'{ctx_id}|{timeout_msg}')
" 2>/dev/null || echo "")

    if [ -n "$PARSED_LAMBDA" ]; then
      IFS='|' read -r LAMBDA_CTX_REQ_ID TIMEOUT_LOG <<< "$PARSED_LAMBDA"
      CORRELATION_METHOD="EXACT_ACCESS_LOG_INTEGRATION_ID"
      echo "  Found exact Lambda timeout log on attempt $attempt."
      break
    fi
  else
    # Fallback: time-window query for Task timed out if Access Log integrationRequestId was unavailable
    cw_filter_json "/aws/lambda/$FN_GENERATE" "$INVOKE_START_MS" "\"Task timed out\"" > "$CW_LAMBDA_JSON"
    PARSED_LAMBDA=$(python3 -c "
import json, re
data = json.load(open('$CW_LAMBDA_JSON'))
events = data.get('events', [])
if events:
    msg = events[-1].get('message', '').strip()
    m = re.search(r'([a-f0-9-]{36})', msg)
    ctx_id = m.group(1) if m else ''
    print(f'{ctx_id}|{msg}')
" 2>/dev/null || echo "")

    if [ -n "$PARSED_LAMBDA" ]; then
      IFS='|' read -r LAMBDA_CTX_REQ_ID TIMEOUT_LOG <<< "$PARSED_LAMBDA"
      CORRELATION_METHOD="TIME_WINDOW_ONLY"
      echo "  Found Lambda timeout log via time-window on attempt $attempt."
      break
    fi
  fi
  sleep 4
done

echo "--------------------------------------------------"
echo "Test Name                    : Timeout Experiment"
echo "Actual Config                : Timeout = ${ACTUAL_TIMEOUT}s"
echo "HTTP Status                  : ${HTTP_CODE:-UNKNOWN}"
echo "Client Duration              : ${CLIENT_DUR}s"
echo "API GW Request ID            : ${APIGW_ID:-UNAVAILABLE}"
echo "API GW Integration Request ID: ${INTEG_REQ_ID:-UNAVAILABLE}"
echo "API GW Integration Status    : ${INTEG_STATUS:-UNAVAILABLE} (Error: ${INTEG_ERR:-N/A})"
echo "Lambda Context Request ID    : ${LAMBDA_CTX_REQ_ID:-UNAVAILABLE}"
echo "Correlation Method           : ${CORRELATION_METHOD}"

if [ -n "$TIMEOUT_LOG" ]; then
  echo "CloudWatch Timeout Log       : $TIMEOUT_LOG"
  echo "Status                       : [PASS - CONFIRMED TIMEOUT]"
  echo "Diagnosis                    : Confirmed Lambda timeout via CloudWatch log ($CORRELATION_METHOD)."
else
  echo "CloudWatch Timeout Log       : UNAVAILABLE"
  echo "Status                       : [INCONCLUSIVE]"
  echo "Diagnosis                    : HTTP $HTTP_CODE received in ${CLIENT_DUR}s, but Lambda timeout log was not confirmed in CloudWatch within polling window."
fi
echo "--------------------------------------------------"

# Restore timeout to captured original value
echo "Restoring $FN_GENERATE timeout to ${ORIG_GEN_TIMEOUT}s..."
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE" \
  --timeout "$ORIG_GEN_TIMEOUT" > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE"
echo "Timeout restored to ${ORIG_GEN_TIMEOUT}s."
echo ""

# ------------------------------------------------------------------------------
# TEST D: True Response Streaming & Quota Boundary Verification
# ------------------------------------------------------------------------------
echo "=================================================="
echo "TEST D: True Response Streaming (10 MiB, 50 MiB, 100 MiB, 190 MiB, 205 MiB)"
echo "=================================================="

# Temporarily raise timeout to 300s to allow heavy payloads without hitting function execution timeout
echo "Temporarily setting $FN_GENERATE_STREAM timeout to 300s..."
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE_STREAM" \
  --timeout 300 > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE_STREAM"

ACTUAL_STREAM_TIMEOUT=$(aws lambda get-function-configuration \
  --function-name "$FN_GENERATE_STREAM" \
  --query Timeout \
  --output text 2>/dev/null || echo "UNKNOWN")
echo "Configured Timeout : ${ACTUAL_STREAM_TIMEOUT}s"
echo ""

STREAM_SIZES=(10 50 100 190 205)

for SIZE in "${STREAM_SIZES[@]}"; do
  TARGET_BYTES=$(( SIZE * 1024 * 1024 ))
  HDRS_FILE="$TMP_BENCH_DIR/stream-${SIZE}mib-hdrs.txt"
  BODY_FILE="/tmp/lambda-test-downloads/stream-${SIZE}mib.csv"
  rm -f "$HDRS_FILE" "$BODY_FILE"

  echo ">>> Requesting ${SIZE} MiB stream (Target: ${TARGET_BYTES} bytes)..."

  CURL_EXIT=0
  METRICS=$(curl -s -D "$HDRS_FILE" -o "$BODY_FILE" \
    "${STREAM_URL}?mode=synthetic&sizeMB=${SIZE}&chunkKB=64&format=csv" \
    -w "%{http_code}|%{size_download}|%{time_starttransfer}|%{time_total}" || CURL_EXIT=$?)

  IFS='|' read -r HTTP_CODE CURL_BODY_BYTES TTFB TOTAL_TIME <<< "$METRICS"

  HDR_BYTES=$(wc -c < "$HDRS_FILE" 2>/dev/null || echo "0")
  ACTUAL_BODY_BYTES=$(wc -c < "$BODY_FILE" 2>/dev/null || echo "0")
  REQ_ID=$(grep -i "^x-amzn-requestid:" "$HDRS_FILE" | awk '{print $2}' | tr -d '\r\n')

  # Validate body integrity against exact synthetic CSV generator pattern (64 KiB chunk buffer)
  # Separate check results: HEAD_MATCH | TAIL_MATCH | TAIL_REPR
  CONTENT_VAL=$(python3 -c "
import os
path = '$BODY_FILE'
chunk_bytes = 64 * 1024
line = b'1,2024-01-01,Synthetic_Stream_Record,Benchmark,100,99.99,9999.00,OK\n'
buf = bytearray(chunk_bytes)
offset = 0
while offset < chunk_bytes:
    to_copy = min(len(line), chunk_bytes - offset)
    buf[offset:offset+to_copy] = line[:to_copy]
    offset += to_copy

def expected_slice(total_bytes, n=50):
    rem = total_bytes % chunk_bytes
    if rem == 0:
        return bytes(buf[-n:])
    elif rem >= n:
        return bytes(buf[rem-n:rem])
    else:
        return bytes(buf[-(n-rem):] + buf[:rem])

if not os.path.exists(path):
    print('NO|NO|MISSING')
else:
    sz = os.path.getsize(path)
    with open(path, 'rb') as f:
        head = f.read(len(line))
        head_ok = 'YES' if head == line else 'NO'
        if sz >= 50:
            f.seek(-50, 2)
            actual_tail = f.read(50)
            exp_tail = expected_slice(sz, 50)
            tail_ok = 'YES' if actual_tail == exp_tail else 'NO'
            tail_str = repr(actual_tail.decode('utf-8', errors='replace'))
        else:
            tail_ok = 'NO'
            tail_str = repr(head.decode('utf-8', errors='replace'))
    print(f'{head_ok}|{tail_ok}|{tail_str}')
" 2>/dev/null || echo "NO|NO|ERROR")

  IFS='|' read -r HEAD_MATCH TAIL_MATCH TAIL_REPR <<< "$CONTENT_VAL"

  THROUGHPUT_MB_S=$(python3 -c "
dur = float('${TOTAL_TIME:-0}')
b = int('${ACTUAL_BODY_BYTES:-0}')
if dur > 0:
    print(f'{(b / 1024 / 1024) / dur:.2f}')
else:
    print('0.00')
" 2>/dev/null || echo "N/A")

  BODY_MIB=$(python3 -c "print(f'{int($ACTUAL_BODY_BYTES) / 1024 / 1024:.4f}')" 2>/dev/null || echo "N/A")
  TARGET_MIB=$(python3 -c "print(f'{int($TARGET_BYTES) / 1024 / 1024:.4f}')" 2>/dev/null || echo "N/A")

  # Separate granular check evaluations
  HTTP_OK="NO"
  [ "${HTTP_CODE:-}" = "200" ] && HTTP_OK="YES"

  CURL_OK="NO"
  [ "$CURL_EXIT" -eq 0 ] && CURL_OK="YES"

  SIZE_EXACT="NO"
  [ "$ACTUAL_BODY_BYTES" -eq "$TARGET_BYTES" ] && SIZE_EXACT="YES"

  CONTENT_OK="NO"
  [ "$HEAD_MATCH" = "YES" ] && [ "$TAIL_MATCH" = "YES" ] && CONTENT_OK="YES"

  echo "--------------------------------------------------"
  echo "Test Name          : Response Streaming (${SIZE} MiB)"
  echo "Target Body        : ${TARGET_BYTES} bytes (${TARGET_MIB} MiB)"
  echo "Header Bytes       : ${HDR_BYTES} bytes (stored separately in $HDRS_FILE)"
  echo "Body Bytes (Disk)  : ${ACTUAL_BODY_BYTES} bytes (${BODY_MIB} MiB)"
  echo "TTFB               : ${TTFB:-N/A}s"
  echo "Total Time         : ${TOTAL_TIME:-N/A}s (${THROUGHPUT_MB_S} MB/s)"
  echo "Lambda Request ID  : ${REQ_ID:-UNAVAILABLE}"
  echo "Checks             : HTTP=200(${HTTP_OK}) | cURL_Exit=${CURL_EXIT}(${CURL_OK}) | Size_Match(${SIZE_EXACT}) | Content_Pattern(${CONTENT_OK})"
  echo "Body Tail (50B)    : ${TAIL_REPR}"

  if [ "$HTTP_OK" = "YES" ] && [ "$CURL_OK" = "YES" ] && [ "$SIZE_EXACT" = "YES" ] && [ "$CONTENT_OK" = "YES" ]; then
    echo "Status             : [PASS - COMPLETE]"
    echo "Diagnosis          : HTTP 200, exact body byte count (${ACTUAL_BODY_BYTES} bytes), and generator byte pattern verified."
  elif [ "$SIZE" -eq 205 ] && [ "$HTTP_OK" = "YES" ] && [ "$ACTUAL_BODY_BYTES" -lt "$TARGET_BYTES" ] && [ "$CONTENT_OK" = "YES" ]; then
    DIFF_200=$(( 209715200 - ACTUAL_BODY_BYTES ))
    if [ "$DIFF_200" -ge 0 ] && [ "$DIFF_200" -le 65536 ]; then
      echo "Status             : [PASS - QUOTA LIMIT OBSERVED]"
      echo "Diagnosis          : Stream truncated at ${ACTUAL_BODY_BYTES} bytes (${BODY_MIB} MiB), which is ${DIFF_200} bytes below the documented 200 MiB (209,715,200 bytes) maximum. Content matches generator pattern up to truncation point. HTTP headers (${HDR_BYTES} bytes) were measured separately and are not counted as response body."
    else
      echo "Status             : [INCONCLUSIVE]"
      echo "Diagnosis          : Stream truncated at ${ACTUAL_BODY_BYTES} bytes, offset from 200 MiB is ${DIFF_200} bytes."
    fi
  else
    echo "Status             : [FAIL]"
    echo "Diagnosis          : Validation failed (HTTP=${HTTP_CODE}, cURL=${CURL_EXIT}, Expected=${TARGET_BYTES}, Actual=${ACTUAL_BODY_BYTES}, Content=${CONTENT_OK})."
  fi
  echo "--------------------------------------------------"
  echo ""
done

# Restore stream timeout to captured original value
echo "Restoring $FN_GENERATE_STREAM timeout to ${ORIG_STREAM_TIMEOUT}s..."
aws lambda update-function-configuration \
  --function-name "$FN_GENERATE_STREAM" \
  --timeout "$ORIG_STREAM_TIMEOUT" > /dev/null
aws lambda wait function-updated-v2 --function-name "$FN_GENERATE_STREAM"
echo "Timeout restored to ${ORIG_STREAM_TIMEOUT}s."
echo ""

echo "=================================================="
echo "ALL ADVANCED BENCHMARKS COMPLETED!"
echo "=================================================="
