#!/usr/bin/env bash
# infra/20-sqs.sh
# Creates Phase 3 SQS resources:
#   1. Dead-Letter Queue (retention: 7 days)
#   2. Main Queue (VisibilityTimeout: 900s = 6x 150s Lambda timeout, maxReceiveCount: 3)
#   3. SQS Interface VPC Endpoint (tagged with Project & Phase=phase3)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/20-vars-phase3.sh"

echo "=== Phase 3: Provisioning SQS Queue, DLQ & SQS VPC Endpoint ==="

# 1. Dead-Letter Queue (7 days = 604800s)
DLQ_URL=$(aws sqs create-queue \
  --queue-name "$SQS_DLQ_NAME" \
  --attributes MessageRetentionPeriod=604800 \
  --query 'QueueUrl' --output text)
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)
echo "DLQ URL: $DLQ_URL"

# 2. Main SQS Queue (VisibilityTimeout=900s, Retention=4 days=345600s, maxReceiveCount=3)
REDRIVE=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"3"}' "$DLQ_ARN")
ATTRS=$(cat <<EOF
{
  "VisibilityTimeout": "900",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": $(printf '%s' "$REDRIVE" | node -e "console.log(JSON.stringify(require('fs').readFileSync(0,'utf8')))")
}
EOF
)
QUEUE_URL=$(aws sqs create-queue \
  --queue-name "$SQS_QUEUE_NAME" \
  --attributes "$ATTRS" \
  --query 'QueueUrl' --output text 2>/dev/null || aws sqs get-queue-url --queue-name "$SQS_QUEUE_NAME" --query 'QueueUrl' --output text)
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "$ATTRS" >/dev/null
echo "Queue URL: $QUEUE_URL"

# 3. SQS Interface VPC Endpoint (for job-producer inside VPC)
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
SG_LAMBDA=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_LAMBDA_NAME" --query 'SecurityGroups[0].GroupId' --output text)

if ! aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=service-name,Values=com.amazonaws.${AWS_REGION}.sqs" --query 'VpcEndpoints[0].VpcEndpointId' --output text | grep -q '^vpce-'; then
  FIRST_SUBNET="${SUBNET_IDS%%,*}"
  aws ec2 create-vpc-endpoint \
    --vpc-id "$VPC_ID" \
    --vpc-endpoint-type Interface \
    --service-name "com.amazonaws.${AWS_REGION}.sqs" \
    --subnet-ids "$FIRST_SUBNET" \
    --security-group-ids "$SG_LAMBDA" \
    --private-dns-enabled \
    --tag-specifications "ResourceType=vpc-endpoint,Tags=[{Key=Project,Value=${PROJECT}},{Key=Phase,Value=phase3},{Key=ManagedBy,Value=lambda-file-api}]" >/dev/null
  echo "Created SQS Interface VPC Endpoint (subnet: $FIRST_SUBNET)"
fi

echo "=== Phase 3 SQS setup complete ==="
