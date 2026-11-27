#!/usr/bin/env bash
# infra/10-vars-phase2.sh
# Shared environment variables for Phase 2 (S3 + RDS PostgreSQL + VPC).
# Sources Phase 1 infra/00-variables.sh without modifying it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/00-variables.sh"

# -- S3 ------------------------------------------------------------------------
export S3_BUCKET="${S3_BUCKET:-${PROJECT}-data-${AWS_ACCOUNT_ID}}"

# -- RDS PostgreSQL ------------------------------------------------------------
export DB_INSTANCE_ID="${DB_INSTANCE_ID:-${PROJECT}-db}"
export DB_NAME="${DB_NAME:-fileapi}"
export DB_USERNAME="${DB_USERNAME:-postgres}"
export DB_SECRET_NAME="${DB_SECRET_NAME:-${PROJECT}/db-credentials}"
export DB_SUBNET_GROUP_NAME="${DB_SUBNET_GROUP_NAME:-${PROJECT}-db-subnet-group}"

# -- VPC & Security Groups -----------------------------------------------------
export SG_LAMBDA_NAME="${SG_LAMBDA_NAME:-${PROJECT}-sg-lambda}"
export SG_RDS_NAME="${SG_RDS_NAME:-${PROJECT}-sg-rds}"

# -- Phase 2 Lambda Functions --------------------------------------------------
export FN_UPLOAD_TO_S3="${FN_UPLOAD_TO_S3:-${PROJECT}-upload-to-s3}"
export FN_S3_PROCESSOR="${FN_S3_PROCESSOR:-${PROJECT}-s3-processor}"
export FN_FILE_QUERY="${FN_FILE_QUERY:-${PROJECT}-file-query}"
export PHASE2_POLICY_NAME="${PHASE2_POLICY_NAME:-${PROJECT}-phase2-vpc-s3-secrets}"

echo "Phase 2 vars loaded: S3_BUCKET=$S3_BUCKET DB=$DB_INSTANCE_ID"
