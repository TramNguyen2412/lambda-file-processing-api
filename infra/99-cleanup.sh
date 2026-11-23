#!/usr/bin/env bash
# infra/99-cleanup.sh
# Deletes ALL AWS resources created specifically for this project:
#   1. API Gateway HTTP API ($API_NAME)
#   2. Lambda Function URLs
#   3. Lambda Functions ($FN_HEALTH, $FN_INFO, $FN_UPLOAD, $FN_GENERATE, $FN_GENERATE_STREAM)
#   4. IAM Execution Role ($LAMBDA_ROLE_NAME)
#
# Idempotent: safe to run even if some resources are already deleted.
# Only deletes resources prefixed with or matching this project's configuration.
#
# Usage: source infra/00-variables.sh && bash infra/99-cleanup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

echo "=================================================="
echo "CLEANUP: Deleting resources for project '$PROJECT'"
echo "Account : $AWS_ACCOUNT_ID"
echo "Region  : $AWS_REGION"
echo "=================================================="
echo ""

# -- 1. Delete API Gateway HTTP API -------------------------------------------
echo "1. Checking API Gateway: $API_NAME"
API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
  --output text 2>/dev/null || echo "")

if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  echo "Deleting API Gateway ID: $API_ID..."
  aws apigatewayv2 delete-api --api-id "$API_ID"
  echo "Deleted API Gateway"
else
  echo "API Gateway not found, skipping."
fi
echo ""

# -- 2. Delete Function URLs --------------------------------------------------
echo "2. Checking Lambda Function URLs..."
for FN in "$FN_GENERATE" "$FN_GENERATE_STREAM"; do
  URL_EXISTS=$(aws lambda get-function-url-config --function-name "$FN" 2>/dev/null || echo "")
  if [ -n "$URL_EXISTS" ]; then
    echo "Deleting Function URL for $FN..."
    aws lambda delete-function-url-config --function-name "$FN"
    echo "Deleted Function URL for $FN"
  else
    echo "No Function URL for $FN, skipping."
  fi
done
echo ""

# -- 3. Delete Lambda Functions -----------------------------------------------
echo "3. Checking Lambda Functions..."
ALL_FUNCTIONS=("$FN_HEALTH" "$FN_INFO" "$FN_UPLOAD" "$FN_GENERATE" "$FN_GENERATE_STREAM")

for FN in "${ALL_FUNCTIONS[@]}"; do
  FN_EXISTS=$(aws lambda get-function --function-name "$FN" 2>/dev/null || echo "")
  if [ -n "$FN_EXISTS" ]; then
    echo "Deleting Lambda function: $FN..."
    aws lambda delete-function --function-name "$FN"
    echo "Deleted function: $FN"
  else
    echo "Function $FN not found, skipping."
  fi
done
echo ""

# -- 4. Delete IAM Role -------------------------------------------------------
echo "4. Checking IAM Role: $LAMBDA_ROLE_NAME"
ROLE_EXISTS=$(aws iam get-role --role-name "$LAMBDA_ROLE_NAME" 2>/dev/null || echo "")

if [ -n "$ROLE_EXISTS" ]; then
  MANAGED_POLICY="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

  echo "Detaching managed policy: $MANAGED_POLICY..."
  aws iam detach-role-policy \
    --role-name "$LAMBDA_ROLE_NAME" \
    --policy-arn "$MANAGED_POLICY" 2>/dev/null || echo "Policy was not attached"

  echo "Deleting IAM Role: $LAMBDA_ROLE_NAME..."
  aws iam delete-role --role-name "$LAMBDA_ROLE_NAME"
  echo "Deleted IAM Role"
else
  echo "IAM Role not found, skipping."
fi

echo ""
echo "=================================================="
echo "Cleanup complete! All project resources removed."
echo "=================================================="
