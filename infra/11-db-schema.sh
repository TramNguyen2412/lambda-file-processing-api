#!/usr/bin/env bash
# infra/11-db-schema.sh
# Applies sql/schema.sql to private RDS PostgreSQL.
#   - If DATABASE_URL is set, runs psql directly.
#   - Otherwise, deploys a temporary one-shot VPC Lambda (db-init),
#     executes sql/schema.sql inside the VPC, and deletes the temporary Lambda.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/10-vars-phase2.sh"

SCHEMA_FILE="$PROJECT_ROOT/sql/schema.sql"

if [ -n "${DATABASE_URL:-}" ]; then
  echo "Applying $SCHEMA_FILE via DATABASE_URL..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE"
  echo "Schema applied successfully."
  exit 0
fi

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$DB_SECRET_NAME" --query 'ARN' --output text)
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
SG_LAMBDA=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_LAMBDA_NAME" --query 'SecurityGroups[0].GroupId' --output text)

FN_DB_INIT="${PROJECT}-db-init"
ZIP_FILE="$ZIP_DIR/${FN_UPLOAD_TO_S3}.zip"

if [ ! -f "$ZIP_FILE" ]; then
  echo "Missing $ZIP_FILE. Run 'npm run package' first."
  exit 1
fi

# Ensure Phase 2 inline policy is attached so db-init can create VPC ENI & read Secrets Manager
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

cleanup_db_init() {
  aws lambda delete-function --function-name "$FN_DB_INIT" >/dev/null 2>&1 || true
}
trap cleanup_db_init EXIT

echo "Deploying temporary $FN_DB_INIT in VPC..."
aws lambda delete-function --function-name "$FN_DB_INIT" >/dev/null 2>&1 || true
aws lambda create-function \
  --function-name "$FN_DB_INIT" \
  --runtime nodejs24.x \
  --role "$ROLE_ARN" \
  --handler "handlers/dbInit.handler" \
  --memory-size 128 \
  --timeout 60 \
  --zip-file "fileb://${ZIP_FILE}" \
  --environment "Variables={DB_SECRET_ARN=${SECRET_ARN}}" \
  --vpc-config "SubnetIds=${SUBNET_IDS},SecurityGroupIds=${SG_LAMBDA}" >/dev/null

aws lambda wait function-active-v2 --function-name "$FN_DB_INIT"

PAYLOAD=$(node -e "const fs=require('fs');console.log(JSON.stringify({sql:fs.readFileSync(process.argv[1],'utf8')}))" "$SCHEMA_FILE")
OUT_FILE="/tmp/db-init-out.json"
echo "Applying $SCHEMA_FILE to RDS via $FN_DB_INIT..."
aws lambda invoke \
  --function-name "$FN_DB_INIT" \
  --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" \
  "$OUT_FILE" >/dev/null

cat "$OUT_FILE"
echo ""
echo "Schema applied successfully."
