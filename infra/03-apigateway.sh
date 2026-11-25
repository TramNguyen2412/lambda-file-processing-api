#!/usr/bin/env bash
# infra/03-apigateway.sh
# Creates the API Gateway HTTP API, configures Lambda integrations, routes,
# stage 'dev' with auto-deploy, and grants invocation permissions.
# Idempotent: checks for existing API, routes, and permissions.
#
# Usage: source infra/00-variables.sh && bash infra/03-apigateway.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

echo ""
echo "=== API Gateway HTTP API Deployment ==="
echo "API Name: $API_NAME"
echo ""

# -- 1. Create or retrieve HTTP API -------------------------------------------
EXISTING_API_ID=$(aws apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" \
  --output text 2>/dev/null || echo "")

if [ -n "$EXISTING_API_ID" ] && [ "$EXISTING_API_ID" != "None" ]; then
  echo "Found existing API Gateway (ID: $EXISTING_API_ID)"
  API_ID="$EXISTING_API_ID"
else
  echo "Creating new HTTP API..."
  API_ID=$(aws apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --cors-configuration \
      AllowOrigins='*',AllowMethods='GET,POST,OPTIONS',AllowHeaders='Content-Type,X-Filename,X-Test-Payload' \
    --query ApiId \
    --output text)
  echo "API created with ID: $API_ID"
fi

# -- 2. Helper to configure route, integration, and invoke permission ---------
add_route() {
  local METHOD="$1"
  local ROUTE_PATH="$2"
  local FN_NAME="$3"
  local ROUTE_KEY="$METHOD $ROUTE_PATH"
  local FN_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${FN_NAME}"
  # Statement ID can contain letters, numbers, hyphens, underscores
  local STMT_ID="apigw-${METHOD}-${ROUTE_PATH//\//_}"

  echo "Configuring route: $ROUTE_KEY -> $FN_NAME"

  # Find existing integration for this Lambda ARN or create new
  local INT_ID
  INT_ID=$(aws apigatewayv2 get-integrations \
    --api-id "$API_ID" \
    --query "Items[?IntegrationUri=='${FN_ARN}'].IntegrationId | [0]" \
    --output text 2>/dev/null || echo "")

  if [ -z "$INT_ID" ] || [ "$INT_ID" = "None" ]; then
    INT_ID=$(aws apigatewayv2 create-integration \
      --api-id "$API_ID" \
      --integration-type AWS_PROXY \
      --integration-uri "$FN_ARN" \
      --payload-format-version "2.0" \
      --query IntegrationId \
      --output text)
    echo "Integration created: $INT_ID"
  else
    echo "Existing integration: $INT_ID"
  fi

  # Check if route already exists
  local ROUTE_ID
  ROUTE_ID=$(aws apigatewayv2 get-routes \
    --api-id "$API_ID" \
    --query "Items[?RouteKey=='${ROUTE_KEY}'].RouteId | [0]" \
    --output text 2>/dev/null || echo "")

  if [ -z "$ROUTE_ID" ] || [ "$ROUTE_ID" = "None" ]; then
    aws apigatewayv2 create-route \
      --api-id "$API_ID" \
      --route-key "$ROUTE_KEY" \
      --target "integrations/$INT_ID" > /dev/null
    echo "Route created"
  else
    echo "Route already exists"
  fi

  # Add permission for API Gateway to invoke this Lambda function
  # Check policy first to avoid ResourceConflictException
  if aws lambda get-policy --function-name "$FN_NAME" 2>/dev/null | grep -q "${STMT_ID}"; then
    echo "Invocation permission already exists"
  else
    aws lambda add-permission \
      --function-name "$FN_NAME" \
      --statement-id "$STMT_ID" \
      --action lambda:InvokeFunction \
      --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${API_ID}/*" > /dev/null 2>&1 || true
    echo "Invocation permission granted"
  fi
  echo ""
}

add_route "GET"  "/health"         "$FN_HEALTH"
add_route "GET"  "/info"           "$FN_INFO"
add_route "POST" "/upload-excel"   "$FN_UPLOAD"
add_route "GET"  "/generate-excel" "$FN_GENERATE"

# -- 3. Configure CloudWatch Log Group for API Gateway Access Logs ------------
LOG_GROUP_NAME="/aws/apigateway/${PROJECT}-access-logs"
LOG_GROUP_ARN="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:${LOG_GROUP_NAME}"

EXISTING_LOG_GROUP=$(aws logs describe-log-groups \
  --log-group-name-prefix "$LOG_GROUP_NAME" \
  --query "logGroups[?logGroupName=='${LOG_GROUP_NAME}'].logGroupName | [0]" \
  --output text 2>/dev/null || echo "")

if [ -z "$EXISTING_LOG_GROUP" ] || [ "$EXISTING_LOG_GROUP" = "None" ]; then
  echo "Creating CloudWatch Log Group for Access Logs: $LOG_GROUP_NAME"
  aws logs create-log-group --log-group-name "$LOG_GROUP_NAME" > /dev/null
  aws logs put-retention-policy --log-group-name "$LOG_GROUP_NAME" --retention-in-days 7 > /dev/null
  echo "Log Group created with 7-day retention policy."
else
  echo "CloudWatch Log Group already exists: $LOG_GROUP_NAME"
fi

# Define single-line JSON log format for HTTP API access logging
# Single quotes preserve literal $context expressions for API Gateway evaluation
LOG_FORMAT='{"requestId":"$context.requestId","extendedRequestId":"$context.extendedRequestId","requestTime":"$context.requestTime","httpMethod":"$context.httpMethod","routeKey":"$context.routeKey","status":"$context.status","responseLength":"$context.responseLength","integrationStatus":"$context.integrationStatus","integrationLatency":"$context.integrationLatency","integrationErrorMessage":"$context.integrationErrorMessage","integrationError":"$context.integration.error","integrationRequestId":"$context.integration.requestId"}'

# Construct valid JSON string for --access-log-settings using python helper
ACCESS_LOG_SETTINGS=$(python3 -c "
import json, sys
settings = {
    'DestinationArn': sys.argv[1],
    'Format': sys.argv[2]
}
print(json.dumps(settings))
" "$LOG_GROUP_ARN" "$LOG_FORMAT")

# -- 4. Create or update 'dev' stage with auto-deploy and access logging -------
STAGE_EXISTS=$(aws apigatewayv2 get-stages \
  --api-id "$API_ID" \
  --query "Items[?StageName=='dev'].StageName | [0]" \
  --output text 2>/dev/null || echo "")

if [ -z "$STAGE_EXISTS" ] || [ "$STAGE_EXISTS" = "None" ]; then
  aws apigatewayv2 create-stage \
    --api-id "$API_ID" \
    --stage-name "dev" \
    --auto-deploy \
    --access-log-settings "$ACCESS_LOG_SETTINGS" > /dev/null
  echo "Stage 'dev' created with auto-deploy and structured access logging"
else
  echo "Stage 'dev' already exists. Updating access logging settings..."
  aws apigatewayv2 update-stage \
    --api-id "$API_ID" \
    --stage-name "dev" \
    --auto-deploy \
    --access-log-settings "$ACCESS_LOG_SETTINGS" > /dev/null
  echo "Stage 'dev' updated with structured access logging"
fi

API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"
echo ""
echo "=================================================="
echo "API Gateway setup complete!"
echo "API ID  : $API_ID"
echo "Base URL: $API_URL"
echo ""
echo "Endpoints:"
echo "GET  $API_URL/health"
echo "GET  $API_URL/info"
echo "POST $API_URL/upload-excel"
echo "GET  $API_URL/generate-excel"
echo "=================================================="
