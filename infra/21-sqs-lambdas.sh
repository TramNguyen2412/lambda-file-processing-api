#!/usr/bin/env bash
# infra/21-sqs-lambdas.sh
# Deploys job-producer & job-consumer in VPC, attaches SQS Event Source Mapping
# (BatchSize=1), and adds POST /process-job route to API Gateway.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/20-vars-phase3.sh"

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$DB_SECRET_NAME" --query 'ARN' --output text)
QUEUE_URL=$(aws sqs get-queue-url --queue-name "$SQS_QUEUE_NAME" --query 'QueueUrl' --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
SG_LAMBDA=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_LAMBDA_NAME" --query 'SecurityGroups[0].GroupId' --output text)

# 1. Least-privilege SQS inline policy
POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "${QUEUE_ARN}"
    }
  ]
}
EOF
)
aws iam put-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name "$PHASE3_POLICY_NAME" \
  --policy-document "$POLICY_DOC"
sleep 5

deploy_sqs_lambda() {
  local FN_NAME="$1" HANDLER="$2" MEMORY="$3" TIMEOUT="$4"
  local ZIP_FILE="$ZIP_DIR/${FN_NAME}.zip"
  local ENV_VARS="Variables={S3_BUCKET=${S3_BUCKET},DB_SECRET_ARN=${SECRET_ARN},SQS_QUEUE_URL=${QUEUE_URL}}"
  local VPC_CFG="SubnetIds=${SUBNET_IDS},SecurityGroupIds=${SG_LAMBDA}"

  if aws lambda get-function --function-name "$FN_NAME" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FN_NAME" --zip-file "fileb://${ZIP_FILE}" >/dev/null
    aws lambda wait function-updated --function-name "$FN_NAME"
    aws lambda update-function-configuration \
      --function-name "$FN_NAME" \
      --handler "$HANDLER" \
      --memory-size "$MEMORY" \
      --timeout "$TIMEOUT" \
      --environment "$ENV_VARS" \
      --vpc-config "$VPC_CFG" >/dev/null
  else
    aws lambda create-function \
      --function-name "$FN_NAME" \
      --runtime nodejs24.x \
      --role "$ROLE_ARN" \
      --handler "$HANDLER" \
      --memory-size "$MEMORY" \
      --timeout "$TIMEOUT" \
      --zip-file "fileb://${ZIP_FILE}" \
      --environment "$ENV_VARS" \
      --vpc-config "$VPC_CFG" >/dev/null
  fi
  aws lambda wait function-active-v2 --function-name "$FN_NAME"
  echo "Deployed: $FN_NAME ($MEMORY MB, ${TIMEOUT}s, VPC)"
}

deploy_sqs_lambda "$FN_JOB_PRODUCER" "handlers/jobProducer.handler" 128 30
deploy_sqs_lambda "$FN_JOB_CONSUMER" "handlers/jobConsumer.handler" 512 150

# 2. SQS Event Source Mapping (BatchSize=1)
EXISTING_ESM=$(aws lambda list-event-source-mappings \
  --function-name "$FN_JOB_CONSUMER" \
  --event-source-arn "$QUEUE_ARN" \
  --query 'EventSourceMappings[0].UUID' --output text)
if [ -z "$EXISTING_ESM" ] || [ "$EXISTING_ESM" = "None" ]; then
  aws lambda create-event-source-mapping \
    --function-name "$FN_JOB_CONSUMER" \
    --event-source-arn "$QUEUE_ARN" \
    --batch-size 1 >/dev/null
  echo "Created SQS Event Source Mapping (BatchSize=1)"
else
  echo "SQS Event Source Mapping already exists: $EXISTING_ESM"
fi

# 3. Add POST /process-job route to API Gateway (idempotent)
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  EXISTING_ROUTE=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='POST /process-job'].RouteId | [0]" --output text)
  if [ -z "$EXISTING_ROUTE" ] || [ "$EXISTING_ROUTE" = "None" ]; then
    FN_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${FN_JOB_PRODUCER}"
    INT_ID=$(aws apigatewayv2 create-integration \
      --api-id "$API_ID" \
      --integration-type AWS_PROXY \
      --integration-uri "$FN_ARN" \
      --payload-format-version 2.0 \
      --query 'IntegrationId' --output text)
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "POST /process-job" --target "integrations/${INT_ID}" >/dev/null
    echo "Route configured: POST /process-job -> $FN_JOB_PRODUCER"
  fi
  aws lambda add-permission \
    --function-name "$FN_JOB_PRODUCER" \
    --statement-id "AllowAPIGW-POSTprocessjob" \
    --action "lambda:InvokeFunction" \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${API_ID}/*" 2>/dev/null || true
fi

echo "=== Phase 3 Lambda & ESM deployment complete ==="
