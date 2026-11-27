#!/usr/bin/env bash
# infra/32-sns-test.sh
# End-to-end AWS verification for Phase 4 (SNS -> SQS Fan-out).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/30-vars-phase4.sh"

TOPIC_ARN=$(aws sns create-topic --name "$SNS_TOPIC_NAME" --query 'TopicArn' --output text)
SUMMARY_Q_URL=$(aws sqs get-queue-url --queue-name "$SUMMARY_QUEUE_NAME" --query 'QueueUrl' --output text)

echo "=== Phase 4 AWS Fan-out & Filter Tests ==="
echo "Topic ARN: $TOPIC_ARN"
echo "Summary Queue URL: $SUMMARY_Q_URL"
echo "Run end-to-end upload via POST /upload-to-s3 and verify audit_logs + daily_summaries in PostgreSQL."
