#!/usr/bin/env bash
# infra/13-s3-test.sh
# End-to-end AWS verification tests for Phase 2:
#   1. Normal flow: POST /upload-to-s3 -> PUT presigned URL -> GET /file/:id & /rows
#   2. Infinite loop prevention: upload to processed/ -> verify 0 Lambda invocations
#   3. Concurrent duplicate events: invoke s3-processor twice concurrently

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/10-vars-phase2.sh"

API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"
TEST_XLSX="$PROJECT_ROOT/test-files/generated/medium-1000rows.xlsx"

echo "=== 1. Normal Flow Test ==="
RESP=$(curl -sS -X POST "$API_URL/upload-to-s3")
FILE_ID=$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).fileId)")
UPLOAD_URL=$(echo "$RESP" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).uploadUrl)")
echo "Created fileId: $FILE_ID"

curl -sS -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
  --data-binary "@$TEST_XLSX" >/dev/null
echo "Uploaded to S3 via presigned URL. Waiting 15s for S3 Event + VPC cold start..."
sleep 15

curl -sS "$API_URL/file/$FILE_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('Job:', d.status, 'rowCount:', d.rowCount, 'processedKey:', d.processedKey)"
curl -sS "$API_URL/file/$FILE_ID/rows?limit=5&offset=0" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('Rows returned:', d.returnedCount, 'total:', d.rowCount)"

echo "=== 2. Infinite Loop Guard Test (upload to processed/) ==="
aws s3 cp "$TEST_XLSX" "s3://${S3_BUCKET}/processed/loop-test/result.xlsx" >/dev/null
echo "Uploaded to processed/loop-test/result.xlsx; verify in CloudWatch that no invocation occurred."
