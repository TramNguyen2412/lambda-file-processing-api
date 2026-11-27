#!/usr/bin/env bash
# infra/10-s3-rds.sh
# Creates Phase 2 infrastructure:
#   1. S3 Bucket (SSE-S3)
#   2. Security Groups (sg-lambda -> sg-rds:5432)
#   3. Secrets Manager secret for RDS credentials
#   4. RDS PostgreSQL db.t3.micro (Single-AZ, Private, no Public IP)
#   5. VPC Endpoints: S3 Gateway (free) + Secrets Manager Interface (~$0.01/h/AZ)
#
# NOTE: Review costs in docs/PLAN.md before running.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/10-vars-phase2.sh"

echo "=== Phase 2: Provisioning S3, VPC Endpoints, Secrets Manager & RDS ==="

# 1. S3 Bucket
if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  echo "S3 bucket already exists: $S3_BUCKET"
else
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$S3_BUCKET"
  else
    aws s3api create-bucket --bucket "$S3_BUCKET" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
  aws s3api put-bucket-encryption --bucket "$S3_BUCKET" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-public-access-block --bucket "$S3_BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "Created S3 bucket: $S3_BUCKET"
fi

# 2. Discover Default VPC and Private/Default Subnets
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)}"
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  echo "ERROR: No default VPC found. Export VPC_ID and SUBNET_IDS manually."
  exit 1
fi
SUBNET_IDS="${SUBNET_IDS:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC_ID" --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')}"
ROUTE_TABLE_IDS="${ROUTE_TABLE_IDS:-$(aws ec2 describe-route-tables --filters Name=vpc-id,Values="$VPC_ID" --query 'RouteTables[*].RouteTableId' --output text)}"

echo "Using VPC: $VPC_ID (Subnets: $SUBNET_IDS)"

# 3. Security Groups
ensure_sg() {
  local NAME="$1" DESC="$2"
  local SG_ID
  SG_ID=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text)
  if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
    SG_ID=$(aws ec2 create-security-group --group-name "$NAME" --description "$DESC" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
  fi
  echo "$SG_ID"
}

SG_LAMBDA=$(ensure_sg "$SG_LAMBDA_NAME" "Lambda VPC SG for $PROJECT")
SG_RDS=$(ensure_sg "$SG_RDS_NAME" "RDS PostgreSQL SG for $PROJECT")

aws ec2 authorize-security-group-ingress --group-id "$SG_RDS" \
  --protocol tcp --port 5432 --source-group "$SG_LAMBDA" 2>/dev/null || true

# Allow HTTPS (443) inside VPC for Secrets Manager Interface Endpoint & S3 Gateway Endpoint
aws ec2 authorize-security-group-ingress --group-id "$SG_LAMBDA" \
  --protocol tcp --port 443 --source-group "$SG_LAMBDA" 2>/dev/null || true

echo "Security Groups: SG_LAMBDA=$SG_LAMBDA, SG_RDS=$SG_RDS"

# 4. VPC Endpoints (S3 Gateway = free; Secrets Manager Interface = paid per AZ/hour)
if ! aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=service-name,Values=com.amazonaws.${AWS_REGION}.s3" --query 'VpcEndpoints[0].VpcEndpointId' --output text | grep -q '^vpce-'; then
  aws ec2 create-vpc-endpoint \
    --vpc-id "$VPC_ID" \
    --vpc-endpoint-type Gateway \
    --service-name "com.amazonaws.${AWS_REGION}.s3" \
    --route-table-ids $ROUTE_TABLE_IDS \
    --tag-specifications "ResourceType=vpc-endpoint,Tags=[{Key=Project,Value=${PROJECT}},{Key=Phase,Value=phase2},{Key=ManagedBy,Value=lambda-file-api}]" >/dev/null
  echo "Created S3 Gateway VPC Endpoint"
fi

if ! aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" "Name=service-name,Values=com.amazonaws.${AWS_REGION}.secretsmanager" --query 'VpcEndpoints[0].VpcEndpointId' --output text | grep -q '^vpce-'; then
  # Use first subnet to minimize hourly AZ cost (~$0.01/h) in lab; add more subnets if HA needed
  FIRST_SUBNET="${SUBNET_IDS%%,*}"
  aws ec2 create-vpc-endpoint \
    --vpc-id "$VPC_ID" \
    --vpc-endpoint-type Interface \
    --service-name "com.amazonaws.${AWS_REGION}.secretsmanager" \
    --subnet-ids "$FIRST_SUBNET" \
    --security-group-ids "$SG_LAMBDA" \
    --private-dns-enabled \
    --tag-specifications "ResourceType=vpc-endpoint,Tags=[{Key=Project,Value=${PROJECT}},{Key=Phase,Value=phase2},{Key=ManagedBy,Value=lambda-file-api}]" >/dev/null
  echo "Created Secrets Manager Interface VPC Endpoint (subnet: $FIRST_SUBNET)"
fi

# 5. DB Subnet Group (RDS requires >= 2 distinct Availability Zones) & RDS PostgreSQL
if ! aws rds describe-db-subnet-groups --db-subnet-group-name "$DB_SUBNET_GROUP_NAME" >/dev/null 2>&1; then
  RDS_SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[*].[SubnetId,AvailabilityZone]' --output text | awk '!seen[$2]++ {print $1}' | paste -sd ' ' -)
  aws rds create-db-subnet-group \
    --db-subnet-group-name "$DB_SUBNET_GROUP_NAME" \
    --db-subnet-group-description "Subnet group for $PROJECT" \
    --subnet-ids $RDS_SUBNETS >/dev/null
  echo "Created DB Subnet Group: $DB_SUBNET_GROUP_NAME (subnets: $RDS_SUBNETS)"
fi

DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)}"

if ! aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" >/dev/null 2>&1; then
  aws rds create-db-instance \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --db-instance-class db.t3.micro \
    --engine postgres \
    --master-username "$DB_USERNAME" \
    --master-user-password "$DB_PASSWORD" \
    --db-name "$DB_NAME" \
    --allocated-storage 20 \
    --storage-type gp2 \
    --no-publicly-accessible \
    --vpc-security-group-ids "$SG_RDS" \
    --db-subnet-group-name "$DB_SUBNET_GROUP_NAME" \
    --backup-retention-period 0 >/dev/null
  echo "Waiting for RDS instance $DB_INSTANCE_ID to become available (several minutes)..."
  aws rds wait db-instance-available --db-instance-identifier "$DB_INSTANCE_ID"
fi

DB_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
echo "RDS Endpoint: $DB_ENDPOINT"

# 6. Secrets Manager Secret
SECRET_JSON=$(printf '{"host":"%s","port":5432,"dbname":"%s","username":"%s","password":"%s"}' "$DB_ENDPOINT" "$DB_NAME" "$DB_USERNAME" "$DB_PASSWORD")
if aws secretsmanager describe-secret --secret-id "$DB_SECRET_NAME" >/dev/null 2>&1; then
  echo "Secret already exists: $DB_SECRET_NAME"
else
  aws secretsmanager create-secret \
    --name "$DB_SECRET_NAME" \
    --secret-string "$SECRET_JSON" >/dev/null
  echo "Created Secrets Manager secret: $DB_SECRET_NAME"
fi

echo "=== Phase 2 S3 + RDS + VPC setup complete ==="
