#!/usr/bin/env bash
# infra/29-cleanup-phase3.sh
# Deletes ONLY Phase 3 AWS resources (keeps Phase 1 & Phase 2 intact).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/20-vars-phase3.sh"

echo "=== Cleaning up Phase 3 resources ==="

# 1. Remove POST /process-job API Gateway route
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null || echo "")
if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  ROUTE_ID=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='POST /process-job'].RouteId | [0]" --output text 2>/dev/null || echo "")
  if [ -n "$ROUTE_ID" ] && [ "$ROUTE_ID" != "None" ]; then
    aws apigatewayv2 delete-route --api-id "$API_ID" --route-id "$ROUTE_ID" 2>/dev/null || true
  fi
fi

# 2. Delete SQS Event Source Mapping & Phase 3 Lambdas
ESM_IDS=$(aws lambda list-event-source-mappings --function-name "$FN_JOB_CONSUMER" --query 'EventSourceMappings[*].UUID' --output text 2>/dev/null || echo "")
for UUID in $ESM_IDS; do
  aws lambda delete-event-source-mapping --uuid "$UUID" 2>/dev/null || true
done

for FN in "$FN_JOB_PRODUCER" "$FN_JOB_CONSUMER"; do
  aws lambda delete-function --function-name "$FN" 2>/dev/null || true
done

# 3. Remove Phase 3 inline IAM policy
aws iam delete-role-policy --role-name "$LAMBDA_ROLE_NAME" --policy-name "$PHASE3_POLICY_NAME" 2>/dev/null || true

# 4. Delete SQS queues
for Q_NAME in "$SQS_QUEUE_NAME" "$SQS_DLQ_NAME"; do
  Q_URL=$(aws sqs get-queue-url --queue-name "$Q_NAME" --query 'QueueUrl' --output text 2>/dev/null || echo "")
  if [ -n "$Q_URL" ] && [ "$Q_URL" != "None" ]; then
    aws sqs delete-queue --queue-url "$Q_URL" 2>/dev/null || true
  fi
done

# 5. Delete ONLY Phase 3 VPC Endpoints tagged by this project
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
VPCE_IDS=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:Project,Values=${PROJECT}" "Name=tag:Phase,Values=phase3" --query 'VpcEndpoints[*].VpcEndpointId' --output text)
if [ -n "$VPCE_IDS" ] && [ "$VPCE_IDS" != "None" ]; then
  aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $VPCE_IDS >/dev/null || true
fi

echo "=== Phase 3 cleanup complete ==="
