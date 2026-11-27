#!/usr/bin/env bash
# infra/59-cleanup-phase6.sh
# Safely removes Phase 6 Lambda Layer without breaking Phase 2-5 functions:
#   1. Rebuilds standalone (USE_LAYER=false) Phase 2-5 zips.
#   2. Restores standalone zip on each deployed function BEFORE detaching the Layer.
#   3. Detaches the Layer only if standalone code update succeeded.
#   4. Deletes published versions of lambda-file-api-common.
# Preserves all Phase 1-5 resources.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/50-vars-phase6.sh"

echo "=== Cleaning up Phase 6 resources ==="
echo "Step 1: Rebuilding standalone zips (USE_LAYER=false)..."
USE_LAYER=false bash "$PROJECT_ROOT/scripts/package.sh" >/dev/null

LAYER_FUNCTIONS=(
  "$FN_UPLOAD_TO_S3"
  "$FN_S3_PROCESSOR"
  "$FN_FILE_QUERY"
  "$FN_JOB_PRODUCER"
  "$FN_JOB_CONSUMER"
  "$FN_AUDIT_CONSUMER"
  "$FN_SUMMARY_CONSUMER"
  "$FN_MAINTENANCE"
)

for FN in "${LAYER_FUNCTIONS[@]}"; do
  if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
    # Restore standalone code BEFORE detaching Layer so function never lacks pg/pg-helper
    if aws lambda update-function-code --function-name "$FN" --zip-file "fileb://${ZIP_DIR}/${FN}.zip" >/dev/null; then
      aws lambda wait function-updated --function-name "$FN"
      aws lambda update-function-configuration --function-name "$FN" --layers '[]' >/dev/null
      aws lambda wait function-updated --function-name "$FN"
      echo "Restored standalone code and detached layer: $FN"
    else
      echo "ERROR: Failed to restore standalone code for $FN; keeping Layer attached to avoid breaking function."
      exit 1
    fi
  fi
done

VERSIONS=$(aws lambda list-layer-versions --layer-name "$LAYER_NAME" --query 'LayerVersions[*].Version' --output text 2>/dev/null || echo "")
for V in $VERSIONS; do
  aws lambda delete-layer-version --layer-name "$LAYER_NAME" --version-number "$V" 2>/dev/null || true
  echo "Deleted layer version: $LAYER_NAME:$V"
done

echo "=== Phase 6 cleanup complete ==="
