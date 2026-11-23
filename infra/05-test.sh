#!/usr/bin/env bash
# infra/05-test.sh
# End-to-end test suite for API Gateway and Lambda Function URLs.
#
# Key Architectural Layers Tested:
# 1. API Gateway HTTP API Edge Proxy (Hard limit: 10 MB request payload)
# 2. AWS Lambda Synchronous Invocation Boundary (Hard limit: 6 MB Base64 event payload)
#    - Binary payloads uploaded through API Gateway v2 are Base64-encoded, expanding by ~33.3%.
#    - Effective raw upload ceiling via API Gateway is ~4.5 MB.
# 3. Application Handler Layer (Memory guard at 5 MB; XLSX structure validation; HTTP 422 for invalid content)
# 4. Lambda Function URL Response Streaming (Up to 200 MB response payload)
#
# Prerequisites:
# - AWS CLI configured with valid credentials in infra/00-variables.sh
# - Python 3 and Node.js available in local PATH
# - Deployment completed via infra/01-iam.sh -> 02-lambda.sh -> 03-apigateway.sh -> 04-function-url.sh
#
# Usage:
#   source infra/00-variables.sh && bash infra/05-test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

echo "=================================================="
echo "Running Lambda File Processing API - Test Suite"
echo "=================================================="

# Retrieve API Gateway Base URL
API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
  --output text 2>/dev/null || echo "")

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  echo "ERROR: API Gateway '$API_NAME' not found. Please deploy first."
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

# ------------------------------------------------------------------------------
# Helper Functions
# ------------------------------------------------------------------------------
TMP_DIR="/tmp/lambda-test-downloads"
mkdir -p "$TMP_DIR"
RESP_BODY="$TMP_DIR/response_body.json"
RESP_HDRS="$TMP_DIR/response_headers.txt"

TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

record_pass() {
  local MSG="$1"
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  PASSED_TESTS=$((PASSED_TESTS + 1))
  echo "[PASS] $MSG"
}

record_fail() {
  local MSG="$1"
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  FAILED_TESTS=$((FAILED_TESTS + 1))
  echo "[FAIL] $MSG"
}

# Dynamically extracts the exact data row count from a local XLSX file (excluding header)
get_xlsx_data_rows() {
  local FILE="$1"
  python3 -c "
import sys, zipfile, xml.etree.ElementTree as ET
try:
    with zipfile.ZipFile('$FILE') as z:
        with z.open('xl/worksheets/sheet1.xml') as f:
            tree = ET.parse(f)
            rows = len(tree.getroot().findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'))
            print(max(0, rows - 1))
except Exception:
    print(-1)
" 2>/dev/null
}

# Truncates a string or JSON body snippet for clean reporting
format_snippet() {
  local FILE="$1"
  local MAX_CHARS="${2:-160}"
  tr -d '\n\r' < "$FILE" | head -c "$MAX_CHARS"
}

# Validates that a downloaded file is a genuine, uncorrupted OpenXML SpreadsheetML (.xlsx) archive
validate_downloaded_xlsx() {
  local FILE="$1"
  local MIN_BYTES="${2:-10000}"
  python3 -c "
import sys, os, zipfile, xml.etree.ElementTree as ET

path = '$FILE'
min_bytes = int('$MIN_BYTES')

if not os.path.exists(path):
    print('ERROR: File does not exist')
    sys.exit(1)

size = os.path.getsize(path)
if size < min_bytes:
    print(f'ERROR: File size ({size} bytes) below minimum expected ({min_bytes} bytes)')
    sys.exit(1)

try:
    with zipfile.ZipFile(path, 'r') as z:
        # Check ZIP CRC integrity for all archive entries
        bad = z.testzip()
        if bad:
            print(f'ERROR: Corrupt zip entry: {bad}')
            sys.exit(1)

        namelist = z.namelist()
        # Verify required OpenXML spreadsheet structure
        if '[Content_Types].xml' not in namelist or 'xl/workbook.xml' not in namelist:
            print('ERROR: Missing required OpenXML SpreadsheetML structures ([Content_Types].xml / xl/workbook.xml)')
            sys.exit(1)

        sheets = [n for n in namelist if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')]
        if not sheets:
            print('ERROR: No worksheet xml found in archive')
            sys.exit(1)

        # Open and parse the worksheet XML locally to verify readability
        with z.open(sheets[0]) as sf:
            tree = ET.parse(sf)
            rows = len(tree.getroot().findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'))
            data_rows = max(0, rows - 1)
            print(f'VALID: {size} bytes, {data_rows} data rows parsed')
            sys.exit(0)
except Exception as e:
    print(f'ERROR: {str(e)}')
    sys.exit(1)
" 2>/dev/null
}

# ------------------------------------------------------------------------------
# Prerequisite: Explicit Required-File Generation Logic
# ------------------------------------------------------------------------------
# Check and explicitly generate baseline row-count files if missing
if [ ! -f "test-files/generated/small-100rows.xlsx" ] || [ ! -f "test-files/generated/medium-1000rows.xlsx" ]; then
  echo "Baseline row-count test files missing. Generating with --rows..."
  node scripts/generate-test-files.mjs --rows
fi

# Check required target sizes: 1, 3, 5, 12 MB
MISSING_TARGETS=()
for MB in 1 3 5 12; do
  if [ ! -f "test-files/generated/excel-${MB}mb.xlsx" ]; then
    MISSING_TARGETS+=("$MB")
  fi
done

if [ ${#MISSING_TARGETS[@]} -gt 0 ]; then
  echo "Missing required target Excel files: ${MISSING_TARGETS[*]}. Generating explicitly with target sizes..."
  node scripts/generate-test-files.mjs "${MISSING_TARGETS[@]}"
  echo ""
fi

# Ensure invalid test file exists for HTTP 422 testing
if [ ! -f "test-files/generated/invalid-corrupted.xlsx" ]; then
  echo "Generating invalid-corrupted.xlsx for validation testing..."
  echo "NOT_A_VALID_ZIP_ARCHIVE: Plain text masquerading as .xlsx for testing HTTP 422 validation." > test-files/generated/invalid-corrupted.xlsx
fi

# =============================================================================
# [CORE-1] Health Check: GET /health
# =============================================================================
echo "=================================================="
echo "[CORE-1] Health Check: GET $API_URL/health"
echo "=================================================="
HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" "$API_URL/health")
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

if [ "$HTTP_CODE" = "200" ] && python3 -c "import sys, json; data=json.load(open('$RESP_BODY')); sys.exit(0 if data.get('status')=='ok' else 1)" 2>/dev/null; then
  record_pass "CORE-1: Health check returned HTTP 200 with status='ok'"
else
  record_fail "CORE-1: Health check failed (HTTP $HTTP_CODE, body: $(format_snippet "$RESP_BODY"))"
fi
echo ""

# =============================================================================
# [CORE-2] Info & Limits: GET /info
# =============================================================================
echo "=================================================="
echo "[CORE-2] Info & Limits: GET $API_URL/info"
echo "=================================================="
HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" "$API_URL/info")
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

if [ "$HTTP_CODE" = "200" ] && python3 -c "import sys, json; data=json.load(open('$RESP_BODY')); sys.exit(0 if 'awsDocumentedLimits' in data else 1)" 2>/dev/null; then
  record_pass "CORE-2: Info endpoint returned HTTP 200 with documented limit definitions"
else
  record_fail "CORE-2: Info endpoint failed (HTTP $HTTP_CODE, body: $(format_snippet "$RESP_BODY"))"
fi
echo ""

# =============================================================================
# [CORE-3A] Upload Small Excel (Raw Binary): POST /upload-excel
# =============================================================================
echo "=================================================="
echo "[CORE-3A] Upload Small Excel (Raw Binary - 100 rows): POST $API_URL/upload-excel"
echo "=================================================="
EXPECTED_ROWS=$(get_xlsx_data_rows "test-files/generated/small-100rows.xlsx")

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/small-100rows.xlsx)
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

VALID_PARSED=$(python3 -c "
import sys, json
try:
    data = json.load(open('$RESP_BODY'))
    assert data.get('success') is True
    assert data.get('excel', {}).get('rowCount') == $EXPECTED_ROWS
    print('yes')
except Exception:
    print('no')
" 2>/dev/null || echo "no")

if [ "$HTTP_CODE" = "200" ] && [ "$VALID_PARSED" = "yes" ]; then
  record_pass "CORE-3A: Small Excel uploaded as raw binary and parsed successfully ($EXPECTED_ROWS rows)"
else
  record_fail "CORE-3A: Small Excel upload raw binary failed or parsed incorrectly (HTTP $HTTP_CODE, body: $(format_snippet "$RESP_BODY"))"
fi
echo ""

# =============================================================================
# [CORE-3B] Upload Small Excel (Multipart Form-Data): POST /upload-excel
# =============================================================================
echo "=================================================="
echo "[CORE-3B] Upload Small Excel (Multipart Form-Data - 100 rows): POST $API_URL/upload-excel"
echo "=================================================="
EXPECTED_ROWS=$(get_xlsx_data_rows "test-files/generated/small-100rows.xlsx")

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -F "file=@test-files/generated/small-100rows.xlsx")
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

VALID_PARSED=$(python3 -c "
import sys, json
try:
    data = json.load(open('$RESP_BODY'))
    assert data.get('success') is True
    assert data.get('excel', {}).get('rowCount') == $EXPECTED_ROWS
    print('yes')
except Exception:
    print('no')
" 2>/dev/null || echo "no")

if [ "$HTTP_CODE" = "200" ] && [ "$VALID_PARSED" = "yes" ]; then
  record_pass "CORE-3B: Small Excel uploaded as multipart form-data and parsed successfully ($EXPECTED_ROWS rows)"
else
  record_fail "CORE-3B: Small Excel upload multipart failed or parsed incorrectly (HTTP $HTTP_CODE, body: $(format_snippet "$RESP_BODY"))"
fi
echo ""

# =============================================================================
# [CORE-4] Upload Medium Excel (1,000 rows): POST /upload-excel
# =============================================================================
echo "=================================================="
echo "[CORE-4] Upload Medium Excel (1,000 rows, ~45 KB): POST $API_URL/upload-excel"
echo "=================================================="
EXPECTED_ROWS=$(get_xlsx_data_rows "test-files/generated/medium-1000rows.xlsx")

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/medium-1000rows.xlsx)
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

VALID_PARSED=$(python3 -c "
import sys, json
try:
    data = json.load(open('$RESP_BODY'))
    assert data.get('success') is True
    assert data.get('excel', {}).get('rowCount') == $EXPECTED_ROWS
    print('yes')
except Exception:
    print('no')
" 2>/dev/null || echo "no")

if [ "$HTTP_CODE" = "200" ] && [ "$VALID_PARSED" = "yes" ]; then
  record_pass "CORE-4: Medium Excel uploaded and parsed successfully ($EXPECTED_ROWS rows)"
else
  record_fail "CORE-4: Medium Excel upload failed or parsed incorrectly (HTTP $HTTP_CODE, body: $(format_snippet "$RESP_BODY"))"
fi
echo ""

# =============================================================================
# [CORE-5] Boundary Testing with Valid Excel Files
# =============================================================================
echo "=================================================="
echo "[CORE-5] Boundary Testing: Valid Excel Files Across Architectural Layers"
echo "=================================================="

# --- Test 5.1: Upload excel-1mb.xlsx (~1 MB valid .xlsx) ---
echo "--- 5.1: Uploading excel-1mb.xlsx (~1 MB valid Excel) ---"
echo "Architectural Expectation: Safe upload baseline (< 4.5 MB raw upload ceiling)."
EXPECTED_1MB_ROWS=$(get_xlsx_data_rows "test-files/generated/excel-1mb.xlsx")
echo "Local file row count: $EXPECTED_1MB_ROWS rows"

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/excel-1mb.xlsx)
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

VALID_1MB_PARSED=$(python3 -c "
import sys, json
try:
    data = json.load(open('$RESP_BODY'))
    assert data.get('success') is True
    assert data.get('excel', {}).get('rowCount') == $EXPECTED_1MB_ROWS
    print('yes')
except Exception:
    print('no')
" 2>/dev/null || echo "no")

if [ "$HTTP_CODE" = "200" ] && [ "$VALID_1MB_PARSED" = "yes" ]; then
  record_pass "CORE-5.1: excel-1mb.xlsx uploaded and parsed successfully ($EXPECTED_1MB_ROWS rows matched local file)"
else
  record_fail "CORE-5.1: excel-1mb.xlsx expected HTTP 200 with $EXPECTED_1MB_ROWS rows, got HTTP $HTTP_CODE (body: $(format_snippet "$RESP_BODY"))"
fi
echo ""

# --- Test 5.2: Upload excel-3mb.xlsx (~3 MB valid .xlsx) ---
echo "--- 5.2: Uploading excel-3mb.xlsx (~3 MB valid Excel) ---"
echo "Architectural Expectation: Near safe upper boundary (Base64 expands to ~4.1 MB, within Lambda 6 MB limit)."
EXPECTED_3MB_ROWS=$(get_xlsx_data_rows "test-files/generated/excel-3mb.xlsx")
echo "Local file row count: $EXPECTED_3MB_ROWS rows"

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/excel-3mb.xlsx)
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

VALID_3MB_PARSED=$(python3 -c "
import sys, json
try:
    data = json.load(open('$RESP_BODY'))
    assert data.get('success') is True
    assert data.get('excel', {}).get('rowCount') == $EXPECTED_3MB_ROWS
    print('yes')
except Exception:
    print('no')
" 2>/dev/null || echo "no")

if [ "$HTTP_CODE" = "200" ] && [ "$VALID_3MB_PARSED" = "yes" ]; then
  record_pass "CORE-5.2: excel-3mb.xlsx uploaded and parsed successfully ($EXPECTED_3MB_ROWS rows matched local file)"
else
  record_fail "CORE-5.2: excel-3mb.xlsx expected HTTP 200 with $EXPECTED_3MB_ROWS rows, got HTTP $HTTP_CODE (body: $(format_snippet "$RESP_BODY"))"
fi
echo ""

# --- Test 5.3: Upload excel-5mb.xlsx (~5.1 MB valid .xlsx) ---
echo "--- 5.3: Uploading excel-5mb.xlsx (~5.1 MB valid Excel) ---"
echo "Architectural Expectation: Rejection at AWS Lambda 6 MB synchronous invocation boundary."
echo "Explanation: 5.1 MB raw file expands to ~6.8 MB Base64 event JSON, exceeding Lambda's 6,291,456 bytes limit."
echo "Expected Response: HTTP 413, HTTP 500, or HTTP 502 with architectural layer verification."

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/excel-5mb.xlsx)
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

BODY_SNIPPET=$(format_snippet "$RESP_BODY")

if [ "$HTTP_CODE" = "413" ]; then
  # Application-level memory guard in Lambda handler (MAX_PARSE_BYTES = 5 MB)
  if grep -q "maximum parse limit" "$RESP_BODY" 2>/dev/null; then
    record_pass "CORE-5.3: excel-5mb.xlsx verified application-level rejection by Lambda memory guard (HTTP 413: $BODY_SNIPPET)"
  # AWS Edge / Service payload rejection
  elif grep -qi "payload too large" "$RESP_BODY" 2>/dev/null || grep -qi "request entity too large" "$RESP_BODY" 2>/dev/null; then
    record_pass "CORE-5.3: excel-5mb.xlsx verified AWS infrastructure payload limit rejection (HTTP 413: $BODY_SNIPPET)"
  else
    record_fail "CORE-5.3: INCONCLUSIVE / UNVERIFIED - Received HTTP 413 with unidentifiable response body: $BODY_SNIPPET. Cannot conclusively identify whether rejection was application-level or AWS infrastructure."
  fi
elif [ "$HTTP_CODE" = "500" ] || [ "$HTTP_CODE" = "502" ]; then
  # In API Gateway HTTP API v2, exceeding the 6 MB event size at the Lambda integration boundary
  # produces an HTTP 500 or 502 integration error. However, unhandled runtime crashes also produce
  # HTTP 500/502. Without CloudWatch inspection, the rejection layer cannot be conclusively identified.
  record_fail "CORE-5.3: INCONCLUSIVE / UNVERIFIED - Received HTTP $HTTP_CODE (body: $BODY_SNIPPET). Rejection layer cannot be conclusively identified as Lambda 6 MB payload boundary vs runtime crash without CloudWatch inspection ('aws logs tail /aws/lambda/\$FN_UPLOAD --since 2m')."
elif [ "$HTTP_CODE" = "200" ]; then
  record_fail "CORE-5.3: excel-5mb.xlsx unexpectedly passed with HTTP 200. A 5.1 MB raw file in Base64 must exceed the 6 MB event limit!"
else
  record_fail "CORE-5.3: excel-5mb.xlsx returned unexpected status HTTP $HTTP_CODE (body: $BODY_SNIPPET)"
fi
echo ""

# --- Test 5.4: Upload excel-12mb.xlsx (~12.2 MB valid .xlsx) ---
echo "--- 5.4: Uploading excel-12mb.xlsx (~12.2 MB valid Excel) ---"
echo "Architectural Expectation: Rejection by API Gateway HTTP API edge proxy (Hard limit: 10 MB)."
echo "Expected Response: HTTP 413 Request Entity Too Large."

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/excel-12mb.xlsx)
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

BODY_SNIPPET=$(format_snippet "$RESP_BODY")

if [ "$HTTP_CODE" = "413" ]; then
  record_pass "CORE-5.4: excel-12mb.xlsx rejected at API Gateway Edge Proxy (> 10 MB edge limit) (HTTP 413: $BODY_SNIPPET)"
else
  record_fail "CORE-5.4: excel-12mb.xlsx expected HTTP 413 at edge, got HTTP $HTTP_CODE (body: $BODY_SNIPPET)"
fi
echo ""

# --- Test 5.5: Real-World Dataset: Online Retail.xlsx (23 MB) ---
if [ -f "test-files/datasets/online+retail/Online Retail.xlsx" ]; then
  echo "--- 5.5: Real-World Dataset: Online Retail.xlsx (23 MB) ---"
  echo "Architectural Expectation: Rejection by API Gateway HTTP API edge proxy (exceeds 10 MB)."
  echo "Expected Response: HTTP 413 Request Entity Too Large."

  HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
    -X POST "$API_URL/upload-excel" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"test-files/datasets/online+retail/Online Retail.xlsx")
  echo "HTTP Status: $HTTP_CODE"
  cat "$RESP_BODY"
  echo ""

  BODY_SNIPPET=$(format_snippet "$RESP_BODY")

  if [ "$HTTP_CODE" = "413" ]; then
    record_pass "CORE-5.5: Online Retail.xlsx (23 MB) rejected at API Gateway Edge Proxy with HTTP 413 ($BODY_SNIPPET)"
  else
    record_fail "CORE-5.5: Online Retail.xlsx expected HTTP 413 at edge, got HTTP $HTTP_CODE (body: $BODY_SNIPPET)"
  fi
  echo ""
fi

# --- Test 5.6: Validation Error Testing: Upload non-ZIP / corrupted file ---
echo "--- 5.6: Validation Error: Upload invalid-corrupted.xlsx (non-ZIP file) ---"
echo "Architectural Expectation: Successfully reaches Lambda, but rejected with HTTP 422 Unprocessable Entity."

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$RESP_BODY" -w "%{http_code}" \
  -X POST "$API_URL/upload-excel" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-files/generated/invalid-corrupted.xlsx)
echo "HTTP Status: $HTTP_CODE"
cat "$RESP_BODY"
echo ""

BODY_SNIPPET=$(format_snippet "$RESP_BODY")

if [ "$HTTP_CODE" = "422" ] && python3 -c "
import sys, json
data = json.load(open('$RESP_BODY'))
assert data.get('success') is False
assert 'error' in data
" 2>/dev/null; then
  record_pass "CORE-5.6: invalid-corrupted.xlsx cleanly rejected with HTTP 422 by handler validation (body: $BODY_SNIPPET)"
else
  record_fail "CORE-5.6: invalid-corrupted.xlsx expected HTTP 422 with error JSON, got HTTP $HTTP_CODE (body: $BODY_SNIPPET)"
fi
echo ""

# =============================================================================
# [CORE-6] Generate Excel Small (1,000 rows): GET /generate-excel?rows=1000
# =============================================================================
echo "=================================================="
echo "[CORE-6] Generate Excel Small (1,000 rows) via API Gateway"
echo "=================================================="
DOWNLOAD_FILE="$TMP_DIR/gen-1k.xlsx"
rm -f "$DOWNLOAD_FILE"

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$DOWNLOAD_FILE" -w "%{http_code}" \
  "$API_URL/generate-excel?rows=1000")
echo "HTTP Status: $HTTP_CODE"
ls -lh "$DOWNLOAD_FILE" || true

VAL_OUTPUT=$(validate_downloaded_xlsx "$DOWNLOAD_FILE" 10000)
VAL_CODE=$?

if [ "$HTTP_CODE" = "200" ] && [ "$VAL_CODE" -eq 0 ]; then
  record_pass "CORE-6: Small Excel generated and validated as genuine XLSX ($VAL_OUTPUT)"
else
  record_fail "CORE-6: Small Excel generation failed (HTTP $HTTP_CODE, validation: $VAL_OUTPUT)"
fi
echo ""

# =============================================================================
# [CORE-7] Generate Excel Large (50,000 rows) via API Gateway
# =============================================================================
echo "=================================================="
echo "[CORE-7] Generate Excel Large (50,000 rows) via API Gateway"
echo "=================================================="
DOWNLOAD_FILE="$TMP_DIR/gen-50k-apigw.xlsx"
rm -f "$DOWNLOAD_FILE"

HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$DOWNLOAD_FILE" -w "%{http_code}" \
  "$API_URL/generate-excel?rows=50000")
echo "HTTP Status: $HTTP_CODE"
ls -lh "$DOWNLOAD_FILE" || true

VAL_OUTPUT=$(validate_downloaded_xlsx "$DOWNLOAD_FILE" 1000000)
VAL_CODE=$?

if [ "$HTTP_CODE" = "200" ] && [ "$VAL_CODE" -eq 0 ]; then
  record_pass "CORE-7: Large Excel (50k rows) generated and validated as genuine XLSX ($VAL_OUTPUT)"
else
  record_fail "CORE-7: Large Excel generation failed (HTTP $HTTP_CODE, validation: $VAL_OUTPUT)"
fi
echo ""

# =============================================================================
# [EXP-1] Function URL BUFFERED: 50,000 rows
# =============================================================================
if [ -n "$BUFFERED_URL" ] && [ "$BUFFERED_URL" != "None" ]; then
  echo "=================================================="
  echo "[EXP-1] Function URL BUFFERED: 50,000 rows"
  echo "=================================================="
  DOWNLOAD_FILE="$TMP_DIR/gen-50k-buffered.xlsx"
  rm -f "$DOWNLOAD_FILE"

  HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$DOWNLOAD_FILE" -w "%{http_code}" \
    "${BUFFERED_URL}?rows=50000")
  echo "HTTP Status: $HTTP_CODE"
  ls -lh "$DOWNLOAD_FILE" || true

  VAL_OUTPUT=$(validate_downloaded_xlsx "$DOWNLOAD_FILE" 1000000)
  VAL_CODE=$?

  if [ "$HTTP_CODE" = "200" ] && [ "$VAL_CODE" -eq 0 ]; then
    record_pass "EXP-1: Function URL BUFFERED generated and validated as genuine XLSX ($VAL_OUTPUT)"
  else
    record_fail "EXP-1: Function URL BUFFERED failed (HTTP $HTTP_CODE, validation: $VAL_OUTPUT)"
  fi
  echo ""
fi

# =============================================================================
# [EXP-2A] Function URL RESPONSE_STREAM: Excel Mode (50,000 rows)
# =============================================================================
if [ -n "$STREAM_URL" ] && [ "$STREAM_URL" != "None" ]; then
  echo "=================================================="
  echo "[EXP-2A] Function URL RESPONSE_STREAM: Excel Mode (50,000 rows)"
  echo "=================================================="
  DOWNLOAD_FILE="$TMP_DIR/gen-50k-stream.xlsx"
  rm -f "$DOWNLOAD_FILE"

  HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$DOWNLOAD_FILE" -w "%{http_code}" \
    "${STREAM_URL}?rows=50000")
  echo "HTTP Status: $HTTP_CODE"
  ls -lh "$DOWNLOAD_FILE" || true

  FILE_SIZE=$(wc -c < "$DOWNLOAD_FILE" 2>/dev/null || echo "0")

  # Detect Lambda runtime initialization or import error JSON (e.g. Runtime.ImportModuleError)
  IS_RUNTIME_ERROR=$(python3 -c "
import sys
try:
    with open('$DOWNLOAD_FILE', 'rb') as f:
        content = f.read(2048).decode('utf-8', errors='ignore')
    sys.exit(0 if ('errorType' in content or 'Runtime.ImportModuleError' in content or 'errorMessage' in content) else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null && echo "yes" || echo "no")

  VAL_OUTPUT=$(validate_downloaded_xlsx "$DOWNLOAD_FILE" 1000000)
  VAL_CODE=$?

  if [ "$IS_RUNTIME_ERROR" = "yes" ] || [ "$FILE_SIZE" -lt 1000 ]; then
    RECORD_SNIPPET=$(format_snippet "$DOWNLOAD_FILE" 200)
    record_fail "EXP-2A: Function URL returned Lambda runtime error rather than response stream (HTTP $HTTP_CODE, Size: $FILE_SIZE bytes: $RECORD_SNIPPET). Deployed Lambda requires zip update to eliminate 'aws-lambda' import error!"
  elif [ "$HTTP_CODE" = "200" ] && [ "$VAL_CODE" -eq 0 ]; then
    record_pass "EXP-2A: Function URL RESPONSE_STREAM generated and validated as genuine XLSX ($VAL_OUTPUT)"
  else
    record_fail "EXP-2A: Function URL RESPONSE_STREAM failed (HTTP $HTTP_CODE, Size: $FILE_SIZE bytes, validation: $VAL_OUTPUT)"
  fi
  echo ""

  # =============================================================================
  # [EXP-2B] Function URL RESPONSE_STREAM: Synthetic Chunked Streaming
  # =============================================================================
  echo "=================================================="
  echo "[EXP-2B] Function URL RESPONSE_STREAM: Synthetic Chunked Streaming"
  echo "=================================================="

  for SIZE_MB in 1 5 10 25 50; do
    echo "--- Streaming ${SIZE_MB} MB chunked (64 KB chunks) ---"
    STREAM_FILE="$TMP_DIR/stream-${SIZE_MB}mb.csv"
    rm -f "$STREAM_FILE"

    START_TIME=$(date +%s%N)
    HTTP_CODE=$(curl -s -D "$RESP_HDRS" -o "$STREAM_FILE" -w "%{http_code}" \
      "${STREAM_URL}?mode=synthetic&sizeMB=${SIZE_MB}&chunkKB=64&format=csv")
    END_TIME=$(date +%s%N)
    ELAPSED_MS=$(( (END_TIME - START_TIME) / 1000000 ))

    ACTUAL_BYTES=$(wc -c < "$STREAM_FILE" 2>/dev/null || echo "0")
    EXPECTED_BYTES=$(( SIZE_MB * 1024 * 1024 ))

    IS_RUNTIME_ERR=$(python3 -c "
import sys
try:
    with open('$STREAM_FILE', 'rb') as f:
        content = f.read(2048).decode('utf-8', errors='ignore')
    sys.exit(0 if ('errorType' in content or 'Runtime.ImportModuleError' in content or 'errorMessage' in content) else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null && echo "yes" || echo "no")

    echo "HTTP Status       : $HTTP_CODE"
    echo "Downloaded Bytes  : $ACTUAL_BYTES (Expected: $EXPECTED_BYTES bytes)"
    echo "Elapsed Time      : ${ELAPSED_MS} ms"

    STREAM_SNIPPET=$(format_snippet "$STREAM_FILE" 200)

    if [ "$IS_RUNTIME_ERR" = "yes" ] || [ "$ACTUAL_BYTES" -lt 1000 ]; then
      record_fail "EXP-2B (${SIZE_MB} MB): Function URL returned runtime error instead of stream (HTTP $HTTP_CODE, Size: $ACTUAL_BYTES bytes: $STREAM_SNIPPET). Needs zip update on AWS!"
    elif [ "$HTTP_CODE" = "200" ] && [ "$ACTUAL_BYTES" -eq "$EXPECTED_BYTES" ]; then
      THROUGHPUT_MB_S=$(python3 -c "print(round(($ACTUAL_BYTES / 1024 / 1024) / ($ELAPSED_MS / 1000), 2))" 2>/dev/null || echo "N/A")
      record_pass "EXP-2B (${SIZE_MB} MB): Exact size match ($ACTUAL_BYTES bytes streamed, Throughput: ${THROUGHPUT_MB_S} MB/s in ${ELAPSED_MS}ms)"
    else
      record_fail "EXP-2B (${SIZE_MB} MB): Stream failed (HTTP $HTTP_CODE, Downloaded: $ACTUAL_BYTES / Expected: $EXPECTED_BYTES bytes, details: $STREAM_SNIPPET)"
    fi
    echo ""
  done
fi

# =============================================================================
# Summary
# =============================================================================
echo "=================================================="
echo "TEST SUITE EXECUTION SUMMARY"
echo "=================================================="
echo "Total Tests Executed : $TOTAL_TESTS"
echo "Tests Passed         : $PASSED_TESTS"
echo "Tests Failed         : $FAILED_TESTS"
echo "=================================================="

if [ "$FAILED_TESTS" -eq 0 ]; then
  echo "ALL TESTS PASSED!"
  exit 0
else
  echo "SOME TESTS FAILED (See diagnostics above)."
  echo "NOTE: If RESPONSE_STREAM tests failed with ~569 bytes, update function code with:"
  echo "  aws lambda update-function-code --function-name \$FN_GENERATE_STREAM --zip-file fileb://zips/\${FN_GENERATE_STREAM}.zip"
  exit 1
fi
