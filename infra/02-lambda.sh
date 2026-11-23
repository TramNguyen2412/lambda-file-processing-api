#!/usr/bin/env bash
# infra/02-lambda.sh
# Deploys all 5 Lambda functions using the zip archives built by scripts/package.sh.
# Idempotent: updates existing functions or creates them if not present.
# Uses runtime: nodejs24.x
#
# Usage: source infra/00-variables.sh && bash infra/02-lambda.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"

echo ""
echo "=== Lambda Deployment ==="
echo "Account  : $AWS_ACCOUNT_ID"
echo "Region   : $AWS_REGION"
echo "Role ARN : $ROLE_ARN"
echo ""

deploy_fn() {
  local FN_NAME="$1"
  local HANDLER="$2"     # e.g. "handlers/health.handler"
  local TIMEOUT="${3:-30}"
  local MEMORY="${4:-256}"
  local ZIP="$ZIP_DIR/${FN_NAME}.zip"

  if [ ! -f "$ZIP" ]; then
    echo "Zip file not found: $ZIP"
    echo "Run: npm run package (or bash scripts/package.sh) first."
    exit 1
  fi

  echo "Deploying $FN_NAME..."
  echo "Handler: $HANDLER | Timeout: ${TIMEOUT}s | Memory: ${MEMORY}MB"

  if aws lambda get-function --function-name "$FN_NAME" 2>/dev/null | grep -q '"FunctionName"'; then
    echo "   -> Function exists. Updating code..."
    aws lambda update-function-code \
      --function-name "$FN_NAME" \
      --zip-file "fileb://$ZIP" > /dev/null

    echo "   -> Waiting for code update to complete..."
    aws lambda wait function-updated-v2 --function-name "$FN_NAME"

    echo "   -> Updating configuration..."
    aws lambda update-function-configuration \
      --function-name "$FN_NAME" \
      --runtime nodejs24.x \
      --role "$ROLE_ARN" \
      --handler "$HANDLER" \
      --timeout "$TIMEOUT" \
      --memory-size "$MEMORY" > /dev/null

    aws lambda wait function-updated-v2 --function-name "$FN_NAME"
    echo "   $FN_NAME updated"
  else
    echo "   -> Function does not exist. Creating..."
    aws lambda create-function \
      --function-name "$FN_NAME" \
      --runtime nodejs24.x \
      --role "$ROLE_ARN" \
      --handler "$HANDLER" \
      --zip-file "fileb://$ZIP" \
      --timeout "$TIMEOUT" \
      --memory-size "$MEMORY" > /dev/null

    echo "   -> Waiting for function to become active..."
    aws lambda wait function-active-v2 --function-name "$FN_NAME"
    echo "   $FN_NAME created"
  fi
  echo ""
}

# Deploy functions
deploy_fn "$FN_HEALTH"          "handlers/health.handler"              10   128
deploy_fn "$FN_INFO"            "handlers/info.handler"                10   128
deploy_fn "$FN_UPLOAD"          "handlers/uploadExcel.handler"         60   512
deploy_fn "$FN_GENERATE"        "handlers/generateExcel.handler"       120  1024
deploy_fn "$FN_GENERATE_STREAM" "handlers/generateExcelStream.handler" 120  1024

echo "=================================================="
echo "Summary of deployed Lambda functions:"
echo "=================================================="
for FN_NAME in "$FN_HEALTH" "$FN_INFO" "$FN_UPLOAD" "$FN_GENERATE" "$FN_GENERATE_STREAM"; do
  aws lambda get-function-configuration \
    --function-name "$FN_NAME" \
    --query '{Name:FunctionName, Runtime:Runtime, Memory:MemorySize, Timeout:Timeout, State:State}' \
    --output table
done

echo ""
echo "All Lambda functions deployed successfully."
