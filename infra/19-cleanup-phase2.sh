#!/usr/bin/env bash
# infra/19-cleanup-phase2.sh
# Deletes ONLY Phase 2 AWS resources in reverse dependency order.
# Preserves all Phase 1 resources.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/10-vars-phase2.sh"

echo "=== Cleaning up Phase 2 resources ==="

# 1. Remove Phase 2 API Gateway routes (keep Phase 1 API & routes intact)
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null || echo "")
if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  for ROUTE_KEY in "POST /upload-to-s3" "GET /file/{id}" "GET /file/{id}/rows"; do
    ROUTE_ID=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='${ROUTE_KEY}'].RouteId | [0]" --output text 2>/dev/null || echo "")
    if [ -n "$ROUTE_ID" ] && [ "$ROUTE_ID" != "None" ]; then
      aws apigatewayv2 delete-route --api-id "$API_ID" --route-id "$ROUTE_ID" 2>/dev/null || true
    fi
  done
fi

# 2. Delete Phase 2 Lambdas
for FN in "$FN_UPLOAD_TO_S3" "$FN_S3_PROCESSOR" "$FN_FILE_QUERY"; do
  aws lambda delete-function --function-name "$FN" 2>/dev/null || true
done

# 3. Remove Phase 2 inline IAM policy
aws iam delete-role-policy --role-name "$LAMBDA_ROLE_NAME" --policy-name "$PHASE2_POLICY_NAME" 2>/dev/null || true

# 4. Empty and delete S3 bucket
aws s3 rm "s3://${S3_BUCKET}" --recursive 2>/dev/null || true
aws s3api delete-bucket --bucket "$S3_BUCKET" 2>/dev/null || true

# 5. Delete RDS instance (skip final snapshot for lab cleanup)
if aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" >/dev/null 2>&1; then
  aws rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" --skip-final-snapshot >/dev/null
  echo "Waiting for RDS deletion..."
  aws rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE_ID"
fi
aws rds delete-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP_NAME" 2>/dev/null || true

# 6. Delete Secrets Manager secret immediately
aws secretsmanager delete-secret --secret-id "$DB_SECRET_NAME" --force-delete-without-recovery 2>/dev/null || true

# 7. Delete ONLY Phase 2 VPC Endpoints created & tagged by this project (never pre-existing/shared ones)
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
VPCE_IDS=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:Project,Values=${PROJECT}" "Name=tag:Phase,Values=phase2" --query 'VpcEndpoints[*].VpcEndpointId' --output text)
if [ -n "$VPCE_IDS" ] && [ "$VPCE_IDS" != "None" ]; then
  aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $VPCE_IDS >/dev/null || true
fi

# 8. Delete Security Groups (may require waiting 1-3 min if Lambda Hyperplane ENIs are still detaching)
for SG_NAME in "$SG_RDS_NAME" "$SG_LAMBDA_NAME"; do
  SG_ID=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SG_NAME" --query 'SecurityGroups[0].GroupId' --output text)
  if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
    if ! aws ec2 delete-security-group --group-id "$SG_ID" 2>/dev/null; then
      echo "Note: $SG_NAME ($SG_ID) still has detaching Lambda ENIs; re-run delete-security-group after 2-3 minutes if needed."
    fi
  fi
done

echo "=== Phase 2 cleanup complete ==="
