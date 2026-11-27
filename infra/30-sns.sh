#!/usr/bin/env bash
# infra/30-sns.sh
# Creates Phase 4 SNS -> SQS Fan-out resources:
#   1. SNS Standard Topic (lambda-file-api-file-processed)
#   2. 2 SQS Queues + 2 DLQs (audit-queue/dlq, summary-queue/dlq)
#   3. SQS Queue Policies allowing sns.amazonaws.com SendMessage
#   4. SNS Subscriptions with Filter Policies:
#      - audit-queue:   {"status": ["processed", "failed"]}
#      - summary-queue: {"status": ["processed"]}
#   5. SNS Interface VPC Endpoint (tagged with Project & Phase=phase4)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/30-vars-phase4.sh"

echo "=== Phase 4: Provisioning SNS Topic, Fan-out SQS Queues & VPC Endpoint ==="

TOPIC_ARN=$(aws sns create-topic --name "$SNS_TOPIC_NAME" --query 'TopicArn' --output text)
echo "SNS Topic ARN: $TOPIC_ARN"

create_fanout_queue() {
  local Q_NAME="$1" DLQ_NAME="$2" FILTER_POLICY="$3"
  local DLQ_URL DLQ_ARN Q_URL Q_ARN ATTRS POLICY_DOC

  DLQ_URL=$(aws sqs create-queue --queue-name "$DLQ_NAME" --attributes MessageRetentionPeriod=604800 --query 'QueueUrl' --output text 2>/dev/null || aws sqs get-queue-url --queue-name "$DLQ_NAME" --query 'QueueUrl' --output text)
  DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

  local REDRIVE
  REDRIVE=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"3"}' "$DLQ_ARN")
  ATTRS=$(cat <<EOF
{
  "VisibilityTimeout": "60",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": $(printf '%s' "$REDRIVE" | node -e "console.log(JSON.stringify(require('fs').readFileSync(0,'utf8')))")
}
EOF
)
  Q_URL=$(aws sqs create-queue --queue-name "$Q_NAME" --attributes "$ATTRS" --query 'QueueUrl' --output text 2>/dev/null || aws sqs get-queue-url --queue-name "$Q_NAME" --query 'QueueUrl' --output text)
  aws sqs set-queue-attributes --queue-url "$Q_URL" --attributes "$ATTRS" >/dev/null
  Q_ARN=$(aws sqs get-queue-attributes --queue-url "$Q_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

  POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Service": "sns.amazonaws.com"},
      "Action": "sqs:SendMessage",
      "Resource": "${Q_ARN}",
      "Condition": {"ArnEquals": {"aws:SourceArn": "${TOPIC_ARN}"}}
    }
  ]
}
EOF
)
  aws sqs set-queue-attributes --queue-url "$Q_URL" --attributes "{\"Policy\": $(printf '%s' "$POLICY_DOC" | node -e "console.log(JSON.stringify(require('fs').readFileSync(0,'utf8')))")}" >/dev/null

  local SUB_ARN
  SUB_ARN=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query "Subscriptions[?Endpoint=='${Q_ARN}'].SubscriptionArn | [0]" --output text)
  if [ -z "$SUB_ARN" ] || [ "$SUB_ARN" = "None" ]; then
    SUB_ARN=$(aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$Q_ARN" --query 'SubscriptionArn' --output text)
  fi
  aws sns set-subscription-attributes --subscription-arn "$SUB_ARN" --attribute-name FilterPolicy --attribute-value "$FILTER_POLICY" >/dev/null
  echo "Configured subscription: $Q_NAME <- $SNS_TOPIC_NAME (Filter: $FILTER_POLICY)"
}

create_fanout_queue "$AUDIT_QUEUE_NAME"   "$AUDIT_DLQ_NAME"   '{"status":["processed","failed"]}'
create_fanout_queue "$SUMMARY_QUEUE_NAME" "$SUMMARY_DLQ_NAME" '{"status":["processed"]}'

# SNS Interface VPC Endpoint (for s3-processor, job-consumer, and Phase 5 maintenance inside VPC)
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
SG_LAMBDA=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_LAMBDA_NAME" --query 'SecurityGroups[0].GroupId' --output text)

if ! aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=service-name,Values=com.amazonaws.${AWS_REGION}.sns" --query 'VpcEndpoints[0].VpcEndpointId' --output text | grep -q '^vpce-'; then
  FIRST_SUBNET="${SUBNET_IDS%%,*}"
  aws ec2 create-vpc-endpoint \
    --vpc-id "$VPC_ID" \
    --vpc-endpoint-type Interface \
    --service-name "com.amazonaws.${AWS_REGION}.sns" \
    --subnet-ids "$FIRST_SUBNET" \
    --security-group-ids "$SG_LAMBDA" \
    --private-dns-enabled \
    --tag-specifications "ResourceType=vpc-endpoint,Tags=[{Key=Project,Value=${PROJECT}},{Key=Phase,Value=phase4},{Key=ManagedBy,Value=lambda-file-api}]" >/dev/null
  echo "Created SNS Interface VPC Endpoint (subnet: $FIRST_SUBNET)"
fi

echo "=== Phase 4 SNS setup complete ==="
