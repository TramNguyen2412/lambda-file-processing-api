#!/usr/bin/env bash
# infra/31-sns-lambdas.sh
# Deploys audit-consumer & summary-consumer in VPC, attaches SQS Event Source Mappings,
# grants sns:Publish, and enables SNS_TOPIC_ARN on s3-processor & job-consumer.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/30-vars-phase4.sh"

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$DB_SECRET_NAME" --query 'ARN' --output text)
TOPIC_ARN=$(aws sns create-topic --name "$SNS_TOPIC_NAME" --query 'TopicArn' --output text)
AUDIT_Q_URL=$(aws sqs get-queue-url --queue-name "$AUDIT_QUEUE_NAME" --query 'QueueUrl' --output text)
AUDIT_Q_ARN=$(aws sqs get-queue-attributes --queue-url "$AUDIT_Q_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
SUMMARY_Q_URL=$(aws sqs get-queue-url --queue-name "$SUMMARY_QUEUE_NAME" --query 'QueueUrl' --output text)
SUMMARY_Q_ARN=$(aws sqs get-queue-attributes --queue-url "$SUMMARY_Q_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
JOBS_Q_URL=$(aws sqs get-queue-url --queue-name "$SQS_QUEUE_NAME" --query 'QueueUrl' --output text)

VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
SG_LAMBDA=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_LAMBDA_NAME" --query 'SecurityGroups[0].GroupId' --output text)

# 1. Phase 4 least-privilege inline policy
POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["sns:Publish"],
      "Resource": "${TOPIC_ARN}"
    },
    {
      "Effect": "Allow",
      "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      "Resource": ["${AUDIT_Q_ARN}", "${SUMMARY_Q_ARN}"]
    }
  ]
}
EOF
)
aws iam put-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name "$PHASE4_POLICY_NAME" \
  --policy-document "$POLICY_DOC"
sleep 5

deploy_consumer() {
  local FN_NAME="$1" HANDLER="$2" Q_ARN="$3"
  local ZIP_FILE="$ZIP_DIR/${FN_NAME}.zip"
  local ENV_VARS="Variables={DB_SECRET_ARN=${SECRET_ARN}}"
  local VPC_CFG="SubnetIds=${SUBNET_IDS},SecurityGroupIds=${SG_LAMBDA}"

  if aws lambda get-function --function-name "$FN_NAME" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FN_NAME" --zip-file "fileb://${ZIP_FILE}" >/dev/null
    aws lambda wait function-updated --function-name "$FN_NAME"
    aws lambda update-function-configuration \
      --function-name "$FN_NAME" \
      --handler "$HANDLER" \
      --memory-size 128 \
      --timeout 30 \
      --environment "$ENV_VARS" \
      --vpc-config "$VPC_CFG" >/dev/null
  else
    aws lambda create-function \
      --function-name "$FN_NAME" \
      --runtime nodejs24.x \
      --role "$ROLE_ARN" \
      --handler "$HANDLER" \
      --memory-size 128 \
      --timeout 30 \
      --zip-file "fileb://${ZIP_FILE}" \
      --environment "$ENV_VARS" \
      --vpc-config "$VPC_CFG" >/dev/null
  fi
  aws lambda wait function-active-v2 --function-name "$FN_NAME"

  local ESM_UUID
  ESM_UUID=$(aws lambda list-event-source-mappings --function-name "$FN_NAME" --event-source-arn "$Q_ARN" --query 'EventSourceMappings[0].UUID' --output text)
  if [ -z "$ESM_UUID" ] || [ "$ESM_UUID" = "None" ]; then
    aws lambda create-event-source-mapping --function-name "$FN_NAME" --event-source-arn "$Q_ARN" --batch-size 1 >/dev/null
  fi
  echo "Deployed fan-out consumer: $FN_NAME"
}

deploy_consumer "$FN_AUDIT_CONSUMER"   "handlers/auditConsumer.handler"   "$AUDIT_Q_ARN"
deploy_consumer "$FN_SUMMARY_CONSUMER" "handlers/summaryConsumer.handler" "$SUMMARY_Q_ARN"

# 2. Enable SNS_TOPIC_ARN on s3-processor & job-consumer
aws lambda update-function-code --function-name "$FN_S3_PROCESSOR" --zip-file "fileb://${ZIP_DIR}/${FN_S3_PROCESSOR}.zip" >/dev/null
aws lambda wait function-updated --function-name "$FN_S3_PROCESSOR"
aws lambda update-function-configuration --function-name "$FN_S3_PROCESSOR" \
  --environment "Variables={S3_BUCKET=${S3_BUCKET},DB_SECRET_ARN=${SECRET_ARN},SNS_TOPIC_ARN=${TOPIC_ARN}}" >/dev/null

aws lambda update-function-code --function-name "$FN_JOB_CONSUMER" --zip-file "fileb://${ZIP_DIR}/${FN_JOB_CONSUMER}.zip" >/dev/null
aws lambda wait function-updated --function-name "$FN_JOB_CONSUMER"
aws lambda update-function-configuration --function-name "$FN_JOB_CONSUMER" \
  --environment "Variables={S3_BUCKET=${S3_BUCKET},DB_SECRET_ARN=${SECRET_ARN},SQS_QUEUE_URL=${JOBS_Q_URL},SNS_TOPIC_ARN=${TOPIC_ARN}}" >/dev/null

echo "=== Phase 4 Lambdas & SNS_TOPIC_ARN enabled ==="
