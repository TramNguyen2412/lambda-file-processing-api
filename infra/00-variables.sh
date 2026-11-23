#!/usr/bin/env bash
# infra/00-variables.sh
# Shared environment variables for all infra scripts.
# Usage: source infra/00-variables.sh
#
# Do NOT run this file directly. Source it from the other scripts
# or from your terminal session.

set -euo pipefail

# -- AWS region ---------------------------------------------------------------
# Check environment variable first, then AWS CLI config, then AWS_DEFAULT_REGION
RESOLVED_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo "")}"
if [ -z "$RESOLVED_REGION" ]; then
  RESOLVED_REGION="${AWS_DEFAULT_REGION:-}"
fi

if [ -z "$RESOLVED_REGION" ]; then
  echo "AWS region is not set."
  echo "Please set your region, e.g.:"
  echo "aws configure set region ap-southeast-1"
  echo "or: export AWS_REGION=ap-southeast-1"
  return 1 2>/dev/null || exit 1
fi
export AWS_REGION="$RESOLVED_REGION"

# -- AWS Account ID -----------------------------------------------------------
RESOLVED_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")"
if [ -z "$RESOLVED_ACCOUNT" ] || [ "$RESOLVED_ACCOUNT" = "None" ]; then
  echo "AWS credentials not configured or cannot authenticate."
  echo "Please run: aws configure"
  echo "or export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
  return 1 2>/dev/null || exit 1
fi
export AWS_ACCOUNT_ID="$RESOLVED_ACCOUNT"

# -- Project namespace ---------------------------------------------------------
export PROJECT="lambda-file-api"

# -- Lambda function names -----------------------------------------------------
export FN_HEALTH="${PROJECT}-health"
export FN_INFO="${PROJECT}-info"
export FN_UPLOAD="${PROJECT}-upload-excel"
export FN_GENERATE="${PROJECT}-generate-excel"
export FN_GENERATE_STREAM="${PROJECT}-generate-excel-stream"

# -- IAM -----------------------------------------------------------------------
export LAMBDA_ROLE_NAME="${PROJECT}-execution-role"

# -- API Gateway ---------------------------------------------------------------
export API_NAME="${PROJECT}-http-api"

# -- Local paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DIST_DIR="$PROJECT_ROOT/dist"
export ZIP_DIR="$PROJECT_ROOT/zips"

# -- Summary -------------------------------------------------------------------
echo "Variables loaded"
echo "Account  : $AWS_ACCOUNT_ID"
echo "Region   : $AWS_REGION"
echo "Project  : $PROJECT"
echo "Role     : $LAMBDA_ROLE_NAME"
echo "API name : $API_NAME"
