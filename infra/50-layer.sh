#!/usr/bin/env bash
# infra/50-layer.sh
# Publishes a new version of lambda-file-api-common Layer and attaches it
# to Phase 2-5 Lambda functions along with their Layer-slimmed zip packages.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/50-vars-phase6.sh"

LAYER_ZIP="$ZIP_DIR/${PROJECT}-common-layer.zip"
if [ ! -f "$LAYER_ZIP" ]; then
  echo "Missing $LAYER_ZIP. Run `npm run package` first."
  exit 1
fi

echo "=== Phase 6A: Publishing Lambda Layer $LAYER_NAME ==="
LAYER_ARN=$(aws lambda publish-layer-version \
  --layer-name "$LAYER_NAME" \
  --description "Shared pg, pg-helper, logger, response-builder (${LAYER_VERSION_TAG})" \
  --zip-file "fileb://${LAYER_ZIP}" \
  --compatible-runtimes nodejs24.x \
  --query 'LayerVersionArn' --output text)
echo "Published Layer Version: $LAYER_ARN"

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
    # Attach Layer BEFORE uploading slimmed zip so there is no window without the Layer
    aws lambda update-function-configuration \
      --function-name "$FN" \
      --layers "$LAYER_ARN" >/dev/null
    aws lambda wait function-updated --function-name "$FN"
    aws lambda update-function-code --function-name "$FN" --zip-file "fileb://${ZIP_DIR}/${FN}.zip" >/dev/null
    aws lambda wait function-updated --function-name "$FN"
    echo "Attached $LAYER_ARN to $FN"
  else
    echo "Skipped $FN (not deployed)"
  fi
done

echo "=== Phase 6A Layer attachment complete ==="
