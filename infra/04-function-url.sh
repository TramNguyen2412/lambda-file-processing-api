#!/usr/bin/env bash
# infra/04-function-url.sh
# Creates and configures Lambda Function URLs:
#   1. $FN_GENERATE with InvokeMode BUFFERED (for direct baseline comparison with API Gateway)
#   2. $FN_GENERATE_STREAM with InvokeMode RESPONSE_STREAM (for large response payloads up to 200 MB)
# Configures AuthType NONE (public access) with required IAM permissions.
# Idempotent: safe to run multiple times.
#
# Usage: source infra/00-variables.sh && bash infra/04-function-url.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

echo ""
echo "=== Lambda Function URL Configuration ==="
echo ""

configure_function_url() {
  local FN_NAME="$1"
  local INVOKE_MODE="$2" # BUFFERED or RESPONSE_STREAM

  echo "Configuring Function URL for: $FN_NAME"
  echo "Invoke mode: $INVOKE_MODE"

  # Check if Function URL already exists
  local EXISTING_URL
  EXISTING_URL=$(aws lambda get-function-url-config \
    --function-name "$FN_NAME" \
    --query FunctionUrl \
    --output text 2>/dev/null || echo "")

  local URL=""
  if [ -n "$EXISTING_URL" ] && [ "$EXISTING_URL" != "None" ]; then
    echo "Function URL already exists: $EXISTING_URL"
    echo "Updating invoke mode to $INVOKE_MODE..."
    aws lambda update-function-url-config \
      --function-name "$FN_NAME" \
      --auth-type NONE \
      --invoke-mode "$INVOKE_MODE" \
      --cors AllowOrigins='*',AllowMethods='GET,POST',AllowHeaders='Content-Type,X-Filename,X-Test-Payload' > /dev/null
    URL="$EXISTING_URL"
  else
    echo "Creating new Function URL..."
    URL=$(aws lambda create-function-url-config \
      --function-name "$FN_NAME" \
      --auth-type NONE \
      --invoke-mode "$INVOKE_MODE" \
      --cors AllowOrigins='*',AllowMethods='GET,POST',AllowHeaders='Content-Type,X-Filename,X-Test-Payload' \
      --query FunctionUrl \
      --output text)
    echo "Created: $URL"
  fi

  # Policy check for idempotent permissions
  local CURRENT_POLICY
  CURRENT_POLICY=$(aws lambda get-policy --function-name "$FN_NAME" 2>/dev/null || echo "")

  # Permission 1: lambda:InvokeFunction
  local STMT_INVOKE="funcurl-public-invoke-fn"
  if ! echo "$CURRENT_POLICY" | grep -q "\"Sid\": \"${STMT_INVOKE}\""; then
    aws lambda add-permission \
      --function-name "$FN_NAME" \
      --statement-id "$STMT_INVOKE" \
      --action lambda:InvokeFunction \
      --principal "*" > /dev/null
    echo "Granted lambda:InvokeFunction permission"
  else
    echo "lambda:InvokeFunction permission already exists"
  fi

  # Permission 2: lambda:InvokeFunctionUrl (AuthType NONE requires this specific action)
  local STMT_URL="funcurl-public-invoke-url"
  if ! echo "$CURRENT_POLICY" | grep -q "\"Sid\": \"${STMT_URL}\""; then
    aws lambda add-permission \
      --function-name "$FN_NAME" \
      --statement-id "$STMT_URL" \
      --action lambda:InvokeFunctionUrl \
      --principal "*" \
      --function-url-auth-type NONE > /dev/null
    echo "Granted lambda:InvokeFunctionUrl permission"
  else
    echo "lambda:InvokeFunctionUrl permission already exists"
  fi

  echo "Final Function URL: $URL"
  echo ""
}

# 1. BUFFERED Function URL
configure_function_url "$FN_GENERATE" "BUFFERED"

# 2. RESPONSE_STREAM Function URL
configure_function_url "$FN_GENERATE_STREAM" "RESPONSE_STREAM"

echo "=================================================="
echo "Function URLs configured successfully!"
echo "=================================================="
echo "Buffered URL (6 MB limit):"
aws lambda get-function-url-config --function-name "$FN_GENERATE" --query FunctionUrl --output text
echo ""
echo "Streaming URL (200 MB response limit):"
aws lambda get-function-url-config --function-name "$FN_GENERATE_STREAM" --query FunctionUrl --output text
echo "=================================================="
