#!/usr/bin/env bash
# infra/39-cleanup-phase4.sh
# Deletes ONLY Phase 4 AWS resources and removes SNS_TOPIC_ARN from Phase 2/3 Lambdas.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/30-vars-phase4.sh"

echo "=== Cleaning up Phase 4 resources ==="

# 1. Remove SNS_TOPIC_ARN from Phase 2/3 Lambdas if still deployed
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$DB_SECRET_NAME" --query 'ARN' --output text 2>/dev/null || echo "")
JOBS_Q_URL=$(aws sqs get-queue-url --queue-name "$SQS_QUEUE_NAME" --query 'QueueUrl' --output text 2>/dev/null || echo "")
if [ -n "$SECRET_ARN" ]; then
  aws lambda update-function-configuration --function-name "$FN_S3_PROCESSOR" \
    --environment "Variables={S3_BUCKET=${S3_BUCKET},DB_SECRET_ARN=${SECRET_ARN}}" >/dev/null 2>&1 || true
  if [ -n "$JOBS_Q_URL" ]; then
    aws lambda update-function-configuration --function-name "$FN_JOB_CONSUMER" \
      --environment "Variables={S3_BUCKET=${S3_BUCKET},DB_SECRET_ARN=${SECRET_ARN},SQS_QUEUE_URL=${JOBS_Q_URL}}" >/dev/null 2>&1 || true
  fi
fi

# 2. Delete ESMs and Phase 4 consumer Lambdas
for FN in "$FN_AUDIT_CONSUMER" "$FN_SUMMARY_CONSUMER"; do
  ESM_IDS=$(aws lambda list-event-source-mappings --function-name "$FN" --query 'EventSourceMappings[*].UUID' --output text 2>/dev/null || echo "")
  for UUID in $ESM_IDS; do
    aws lambda delete-event-source-mapping --uuid "$UUID" 2>/dev/null || true
  done
  aws lambda delete-function --function-name "$FN" 2>/dev/null || true
done

# 3. Remove Phase 4 inline IAM policy
aws iam delete-role-policy --role-name "$LAMBDA_ROLE_NAME" --policy-name "$PHASE4_POLICY_NAME" 2>/dev/null || true

# 4. Delete SNS Subscriptions & Topic
TOPIC_ARN=$(aws sns list-topics --query "Topics[?ends_with(TopicArn, ':${SNS_TOPIC_NAME}')].TopicArn | [0]" --output text 2>/dev/null || echo "")
if [ -n "$TOPIC_ARN" ] && [ "$TOPIC_ARN" != "None" ]; then
  SUB_ARNS=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query 'Subscriptions[*].SubscriptionArn' --output text 2>/dev/null || echo "")
  for SUB in $SUB_ARNS; do
    if [ "$SUB" != "PendingConfirmation" ] && [ "$SUB" != "None" ]; then
      aws sns unsubscribe --subscription-arn "$SUB" 2>/dev/null || true
    fi
  done
  aws sns delete-topic --topic-arn "$TOPIC_ARN" 2>/dev/null || true
fi

# 5. Delete Phase 4 SQS queues & DLQs
for Q_NAME in "$AUDIT_QUEUE_NAME" "$AUDIT_DLQ_NAME" "$SUMMARY_QUEUE_NAME" "$SUMMARY_DLQ_NAME"; do
  Q_URL=$(aws sqs get-queue-url --queue-name "$Q_NAME" --query 'QueueUrl' --output text 2>/dev/null || echo "")
  if [ -n "$Q_URL" ] && [ "$Q_URL" != "None" ]; then
    aws sqs delete-queue --queue-url "$Q_URL" 2>/dev/null || true
  fi
done

# 6. Delete ONLY Phase 4 VPC Endpoints tagged by this project
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
VPCE_IDS=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:Project,Values=${PROJECT}" "Name=tag:Phase,Values=phase4" --query 'VpcEndpoints[*].VpcEndpointId' --output text)
if [ -n "$VPCE_IDS" ] && [ "$VPCE_IDS" != "None" ]; then
  aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $VPCE_IDS >/dev/null || true
fi

echo "=== Phase 4 cleanup complete ==="
