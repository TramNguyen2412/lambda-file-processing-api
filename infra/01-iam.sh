#!/usr/bin/env bash
# infra/01-iam.sh
# Creates the IAM execution role for all Lambda functions in this project.
# The role grants only CloudWatch Logs permissions (AWSLambdaBasicExecutionRole).
# No S3 or other permissions are needed for this project.
#
# This script is idempotent: re-running it when the role already exists
# will print an info message and skip creation.
#
# Usage: source infra/00-variables.sh && bash infra/01-iam.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

MANAGED_POLICY_ARN="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

echo ""
echo "=== IAM Role Setup ==="
echo "Role name : $LAMBDA_ROLE_NAME"
echo ""

# -- Check if role already exists ---------------------------------------------
ROLE_EXISTS=$(aws iam get-role \
  --role-name "$LAMBDA_ROLE_NAME" \
  --query 'Role.RoleName' \
  --output text 2>/dev/null || echo "")

if [ -n "$ROLE_EXISTS" ]; then
  echo "Role already exists. Skipping creation."
else
  echo "Creating IAM Role: $LAMBDA_ROLE_NAME"

  TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}'

  aws iam create-role \
    --role-name "$LAMBDA_ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Execution role for $PROJECT - CloudWatch Logs only, no S3"

  echo "Role created"

  # Attach the AWS-managed policy for basic Lambda execution
  aws iam attach-role-policy \
    --role-name "$LAMBDA_ROLE_NAME" \
    --policy-arn "$MANAGED_POLICY_ARN"

  echo "Policy attached: AWSLambdaBasicExecutionRole"

  # IAM changes take a few seconds to propagate globally.
  # Lambda create-function will fail with "role cannot be assumed" if we proceed too fast.
  echo "Waiting 15 seconds for IAM propagation..."
  sleep 15
fi

# -- Verify --------------------------------------------------------------------
echo ""
echo "Role details:"
aws iam get-role \
  --role-name "$LAMBDA_ROLE_NAME" \
  --query 'Role.{Arn:Arn, Created:CreateDate}' \
  --output table

echo ""
echo "Attached policies:"
aws iam list-attached-role-policies \
  --role-name "$LAMBDA_ROLE_NAME" \
  --query 'AttachedPolicies[*].{Name:PolicyName, Arn:PolicyArn}' \
  --output table

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
echo ""
echo "IAM setup complete"
echo "Role ARN: $ROLE_ARN"
