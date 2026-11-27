#!/usr/bin/env bash
# infra/12-s3-processor.sh
# Deploys Phase 2 Lambda functions in VPC, configures S3 Event Notification
# (prefix input/, suffix .xlsx), and adds Phase 2 API Gateway routes.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/10-vars-phase2.sh"

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$DB_SECRET_NAME" --query 'ARN' --output text)
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
SG_LAMBDA=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_LAMBDA_NAME" --query 'SecurityGroups[0].GroupId' --output text)

# 1. Attach Phase 2 least-privilege inline policy (VPC ENI + S3 + Secrets Manager)
POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "${SECRET_ARN}"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}/input/*",
        "arn:aws:s3:::${S3_BUCKET}/processed/*"
      ]
    }
  ]
}
EOF
)
aws iam put-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name "$PHASE2_POLICY_NAME" \
  --policy-document "$POLICY_DOC"
sleep 5

deploy_vpc_lambda() {
  local FN_NAME="$1" HANDLER="$2" MEMORY="$3" TIMEOUT="$4"
  local ZIP_FILE="$ZIP_DIR/${FN_NAME}.zip"
  local ENV_VARS="Variables={S3_BUCKET=${S3_BUCKET},DB_SECRET_ARN=${SECRET_ARN}}"
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

deploy_vpc_lambda "$FN_UPLOAD_TO_S3" "handlers/uploadToS3.handler" 128 30
deploy_vpc_lambda "$FN_S3_PROCESSOR" "handlers/s3Processor.handler" 512 120
deploy_vpc_lambda "$FN_FILE_QUERY"   "handlers/fileQuery.handler"   256 30

# 2. Configure S3 Event Notification (ONLY prefix input/, suffix .xlsx -> prevents infinite loop)
S3_PROC_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${FN_S3_PROCESSOR}"
aws lambda add-permission \
  --function-name "$FN_S3_PROCESSOR" \
  --statement-id "AllowS3Invoke-${S3_BUCKET}" \
  --action "lambda:InvokeFunction" \
  --principal s3.amazonaws.com \
  --source-arn "arn:aws:s3:::${S3_BUCKET}" \
  --source-account "$AWS_ACCOUNT_ID" 2>/dev/null || true

NOTIF_CFG=$(cat <<EOF
{
  "LambdaFunctionConfigurations": [
    {
      "Id": "ProcessInputExcel",
      "LambdaFunctionArn": "${S3_PROC_ARN}",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            {"Name": "prefix", "Value": "input/"},
            {"Name": "suffix", "Value": ".xlsx"}
          ]
        }
      }
    }
  ]
}
EOF
)
aws s3api put-bucket-notification-configuration --bucket "$S3_BUCKET" --notification-configuration "$NOTIF_CFG"
echo "Configured S3 Event Notification on input/*.xlsx -> $FN_S3_PROCESSOR"

# 3. Add API Gateway HTTP API v2 routes
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  add_route() {
    local ROUTE_KEY="$1" FN_NAME="$2"
    local EXISTING_ROUTE
    EXISTING_ROUTE=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='${ROUTE_KEY}'].RouteId | [0]" --output text)
    if [ -n "$EXISTING_ROUTE" ] && [ "$EXISTING_ROUTE" != "None" ]; then
      echo "Route already exists: $ROUTE_KEY ($EXISTING_ROUTE)"
    else
      local FN_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${FN_NAME}"
      local INT_ID
      INT_ID=$(aws apigatewayv2 create-integration \
        --api-id "$API_ID" \
        --integration-type AWS_PROXY \
        --integration-uri "$FN_ARN" \
        --payload-format-version 2.0 \
        --query 'IntegrationId' --output text)
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$ROUTE_KEY" --target "integrations/${INT_ID}" >/dev/null
      echo "Route configured: $ROUTE_KEY -> $FN_NAME"
    fi
    aws lambda add-permission \
      --function-name "$FN_NAME" \
      --statement-id "AllowAPIGW-$(echo "$ROUTE_KEY" | tr -dc 'A-Za-z0-9')" \
      --action "lambda:InvokeFunction" \
      --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${API_ID}/*" 2>/dev/null || true
  }

  add_route "POST /upload-to-s3"  "$FN_UPLOAD_TO_S3"
  add_route "GET /file/{id}"      "$FN_FILE_QUERY"
  add_route "GET /file/{id}/rows" "$FN_FILE_QUERY"
fi

echo "=== Phase 2 Lambda & API deployment complete ==="
