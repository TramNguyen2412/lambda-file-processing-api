#!/usr/bin/env bash
# infra/22-sqs-test.sh
# End-to-end AWS tests for Phase 3 (SQS + DLQ):
#   1. Reprocess a failed file via POST /process-job
#   2. Duplicate SQS message idempotency test
#   3. Check DLQ depth

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/20-vars-phase3.sh"

API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"
QUEUE_URL=$(aws sqs get-queue-url --queue-name "$SQS_QUEUE_NAME" --query 'QueueUrl' --output text)
DLQ_URL=$(aws sqs get-queue-url --queue-name "$SQS_DLQ_NAME" --query 'QueueUrl' --output text)

if [ -z "${FAILED_FILE_ID:-}" ]; then
  echo "Usage: FAILED_FILE_ID=<uuid-of-failed-job> bash infra/22-sqs-test.sh"
  exit 1
fi

echo "=== 1. POST /process-job for failed file $FAILED_FILE_ID ==="
RESP=$(curl -sS -X POST "$API_URL/process-job" -H "Content-Type: application/json" -d "{\"fileId\":\"$FAILED_FILE_ID\"}")
echo "Producer response: $RESP"
sleep 15
curl -sS "$API_URL/file/$FAILED_FILE_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('Final status:', d.status, 'rowCount:', d.rowCount)"

echo "=== 2. Duplicate SQS Message Idempotency ==="
DUP_JOB_ID=$(node -e "console.log(require('crypto').randomUUID())")
MSG="{\"jobId\":\"$DUP_JOB_ID\",\"fileId\":\"$FAILED_FILE_ID\",\"s3Key\":\"input/$FAILED_FILE_ID/original.xlsx\",\"enqueuedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"requestedBy\":\"manual\"}"
aws sqs send-message --queue-url "$QUEUE_URL" --message-body "$MSG" >/dev/null
aws sqs send-message --queue-url "$QUEUE_URL" --message-body "$MSG" >/dev/null
echo "Sent duplicate SQS messages for jobId=$DUP_JOB_ID; waiting 10s..."
sleep 10

echo "=== 3. DLQ Message Count ==="
aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text
