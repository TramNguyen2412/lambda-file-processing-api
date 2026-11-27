#!/usr/bin/env bash
# infra/40-scheduler.sh
# Deploys Phase 5 resources:
#   1. Lambda: lambda-file-api-maintenance (256 MB, 300s, VPC)
#   2. IAM Role: lambda-file-api-scheduler-role (scheduler.amazonaws.com)
#   3. 2 EventBridge Scheduler schedules:
#      - lambda-file-api-daily-maintenance: cron(0 1 * * ? *), Flexible 15m, {"mode":"daily"}
#      - lambda-file-api-outbox-recovery:   rate(5 minutes), OFF, {"mode":"recovery"}

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/40-vars-phase5.sh"

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$DB_SECRET_NAME" --query 'ARN' --output text)
TOPIC_ARN=$(aws sns create-topic --name "$SNS_TOPIC_NAME" --query 'TopicArn' --output text)

VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
SG_LAMBDA=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_LAMBDA_NAME" --query 'SecurityGroups[0].GroupId' --output text)

# 1. Deploy maintenance Lambda in VPC
ZIP_FILE="$ZIP_DIR/${FN_MAINTENANCE}.zip"
ENV_VARS="Variables={DB_SECRET_ARN=${SECRET_ARN},SNS_TOPIC_ARN=${TOPIC_ARN}}"
VPC_CFG="SubnetIds=${SUBNET_IDS},SecurityGroupIds=${SG_LAMBDA}"

if aws lambda get-function --function-name "$FN_MAINTENANCE" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN_MAINTENANCE" --zip-file "fileb://${ZIP_FILE}" >/dev/null
  aws lambda wait function-updated --function-name "$FN_MAINTENANCE"
  aws lambda update-function-configuration \
    --function-name "$FN_MAINTENANCE" \
    --handler "handlers/maintenance.handler" \
    --memory-size 256 \
    --timeout 300 \
    --environment "$ENV_VARS" \
    --vpc-config "$VPC_CFG" >/dev/null
else
  aws lambda create-function \
    --function-name "$FN_MAINTENANCE" \
    --runtime nodejs24.x \
    --role "$ROLE_ARN" \
    --handler "handlers/maintenance.handler" \
    --memory-size 256 \
    --timeout 300 \
    --zip-file "fileb://${ZIP_FILE}" \
    --environment "$ENV_VARS" \
    --vpc-config "$VPC_CFG" \
    --tags "Project=${PROJECT},Phase=phase5,ManagedBy=lambda-file-api" >/dev/null
fi
aws lambda wait function-active-v2 --function-name "$FN_MAINTENANCE"
MAINTENANCE_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${FN_MAINTENANCE}"
echo "Deployed: $FN_MAINTENANCE (256 MB, 300s, VPC)"

# 2. Scheduler IAM Role (least-privilege: invoke ONLY maintenance Lambda)
TRUST_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Service": "scheduler.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)
if ! aws iam get-role --role-name "$SCHEDULER_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHEDULER_ROLE_NAME" --assume-role-policy-document "$TRUST_DOC" >/dev/null
  sleep 5
fi

INVOKE_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction"],
      "Resource": "${MAINTENANCE_ARN}"
    }
  ]
}
EOF
)
aws iam put-role-policy \
  --role-name "$SCHEDULER_ROLE_NAME" \
  --policy-name "$SCHEDULER_POLICY_NAME" \
  --policy-document "$INVOKE_DOC"
SCHEDULER_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${SCHEDULER_ROLE_NAME}"
sleep 5

# 3. Create or update EventBridge Schedules (idempotent)
upsert_schedule() {
  local NAME="$1" EXPR="$2" FLEX="$3" INPUT="$4"
  local TARGET_JSON="{\"Arn\":\"${MAINTENANCE_ARN}\",\"RoleArn\":\"${SCHEDULER_ROLE_ARN}\",\"Input\":$(printf '%s' "$INPUT" | node -e "console.log(JSON.stringify(require('fs').readFileSync(0,'utf8')))"),\"RetryPolicy\":{\"MaximumRetryAttempts\":2,\"MaximumEventAgeInSeconds\":3600}}"

  if aws scheduler get-schedule --name "$NAME" >/dev/null 2>&1; then
    aws scheduler update-schedule \
      --name "$NAME" \
      --schedule-expression "$EXPR" \
      --schedule-expression-timezone "UTC" \
      --flexible-time-window "$FLEX" \
      --target "$TARGET_JSON" >/dev/null
    echo "Updated schedule: $NAME ($EXPR UTC)"
  else
    aws scheduler create-schedule \
      --name "$NAME" \
      --schedule-expression "$EXPR" \
      --schedule-expression-timezone "UTC" \
      --flexible-time-window "$FLEX" \
      --target "$TARGET_JSON" >/dev/null
    echo "Created schedule: $NAME ($EXPR UTC)"
  fi
}

upsert_schedule "$SCHEDULE_DAILY_NAME"    "cron(0 1 * * ? *)" '{"Mode":"FLEXIBLE","MaximumWindowInMinutes":15}' '{"mode":"daily"}'
upsert_schedule "$SCHEDULE_RECOVERY_NAME" "rate(5 minutes)"   '{"Mode":"OFF"}'                                  '{"mode":"recovery"}'

echo "=== Phase 5 EventBridge Scheduler deployment complete ==="
