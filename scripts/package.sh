#!/usr/bin/env bash
# scripts/package.sh
# Compiles TypeScript, assembles the Lambda Layer, and packages each Lambda
# function into zips/<function-name>.zip.
#
# Optimized for WSL (/mnt/d/...): stages dependencies in /tmp (native Linux fs)
# and builds shared base zip archives once instead of re-zipping 57 MB 13 times.
#
# Modes:
#   USE_LAYER=false (default): standalone ZIPs for all functions
#   USE_LAYER=true           : Phase 2-5 ZIPs exclude Layer modules (pg, pg-helper, logger, response-builder)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DIST_DIR="$PROJECT_ROOT/dist"
ZIP_DIR="$PROJECT_ROOT/zips"
PKG_STAGE="$(mktemp -d /tmp/lambda-pkg-XXXXXX)"

cleanup() {
  rm -rf "$PKG_STAGE"
}
trap cleanup EXIT

cd "$PROJECT_ROOT"

echo "=== Lambda Package Script ==="
echo "Project root : $PROJECT_ROOT"
echo "Staging dir  : $PKG_STAGE"
echo "USE_LAYER    : ${USE_LAYER:-false}"
echo ""

# -- Step 1: TypeScript type-check -------------------------------------------
echo "Step 1: TypeScript type check..."
npx tsc --noEmit
echo "No type errors"
echo ""

# -- Step 2: Compile TypeScript & assemble Layer ------------------------------
echo "Step 2: Compiling TypeScript & assembling Layer..."
rm -rf "$DIST_DIR"
npx tsc
node "$PROJECT_ROOT/scripts/build-layer.mjs"
echo "Compiled to $DIST_DIR and assembled Layer"
echo ""

# -- Step 3: Stage runtime dependencies once in /tmp --------------------------
echo "Step 3: Preparing runtime dependencies in $PKG_STAGE..."
mkdir -p "$PKG_STAGE/base-full"
cp -r "$DIST_DIR/." "$PKG_STAGE/base-full/"
cp -r "$PROJECT_ROOT/node_modules" "$PKG_STAGE/base-full/"

rm -rf "$PKG_STAGE/base-full/node_modules/@types" \
       "$PKG_STAGE/base-full/node_modules/typescript" \
       "$PKG_STAGE/base-full/node_modules/.bin" \
       "$PKG_STAGE/base-full/node_modules/.package-lock.json"

echo "Production dependencies staged (size: $(du -sh "$PKG_STAGE/base-full/node_modules" | cut -f1))"

(
  cd "$PKG_STAGE/base-full"
  zip -r "$PKG_STAGE/base-full.zip" . --quiet
)
echo "Base standalone archive built ($(du -sh "$PKG_STAGE/base-full.zip" | cut -f1))"

if [ "${USE_LAYER:-false}" = "true" ]; then
  mkdir -p "$PKG_STAGE/base-layer"
  cp -r "$PKG_STAGE/base-full/." "$PKG_STAGE/base-layer/"
  rm -rf "$PKG_STAGE/base-layer/layer" \
         "$PKG_STAGE/base-layer/node_modules/pg" \
         "$PKG_STAGE/base-layer/node_modules/pg-"* \
         "$PKG_STAGE/base-layer/node_modules/pgpass" \
         "$PKG_STAGE/base-layer/node_modules/postgres-"* \
         "$PKG_STAGE/base-layer/node_modules/pg-helper" \
         "$PKG_STAGE/base-layer/node_modules/logger" \
         "$PKG_STAGE/base-layer/node_modules/response-builder"
  (
    cd "$PKG_STAGE/base-layer"
    zip -r "$PKG_STAGE/base-layer.zip" . --quiet
  )
  echo "Base with-layer archive built ($(du -sh "$PKG_STAGE/base-layer.zip" | cut -f1))"
fi
echo ""

# -- Step 4: Emit one zip per Lambda function ---------------------------------
echo "Step 4: Creating zip packages..."
mkdir -p "$ZIP_DIR"

PROJECT="${PROJECT:-lambda-file-api}"
FN_HEALTH="${FN_HEALTH:-${PROJECT}-health}"
FN_INFO="${FN_INFO:-${PROJECT}-info}"
FN_UPLOAD="${FN_UPLOAD:-${PROJECT}-upload-excel}"
FN_GENERATE="${FN_GENERATE:-${PROJECT}-generate-excel}"
FN_GENERATE_STREAM="${FN_GENERATE_STREAM:-${PROJECT}-generate-excel-stream}"
FN_UPLOAD_TO_S3="${FN_UPLOAD_TO_S3:-${PROJECT}-upload-to-s3}"
FN_S3_PROCESSOR="${FN_S3_PROCESSOR:-${PROJECT}-s3-processor}"
FN_FILE_QUERY="${FN_FILE_QUERY:-${PROJECT}-file-query}"
FN_JOB_PRODUCER="${FN_JOB_PRODUCER:-${PROJECT}-job-producer}"
FN_JOB_CONSUMER="${FN_JOB_CONSUMER:-${PROJECT}-job-consumer}"
FN_AUDIT_CONSUMER="${FN_AUDIT_CONSUMER:-${PROJECT}-audit-consumer}"
FN_SUMMARY_CONSUMER="${FN_SUMMARY_CONSUMER:-${PROJECT}-summary-consumer}"
FN_MAINTENANCE="${FN_MAINTENANCE:-${PROJECT}-maintenance}"

emit_zip() {
  local FN_NAME="$1"
  local MODE="${2:-standalone}"
  local ZIP="$ZIP_DIR/${FN_NAME}.zip"

  rm -f "$ZIP"
  if [ "$MODE" = "with-layer" ] && [ "${USE_LAYER:-false}" = "true" ]; then
    cp "$PKG_STAGE/base-layer.zip" "$ZIP"
  else
    cp "$PKG_STAGE/base-full.zip" "$ZIP"
  fi

  local SIZE
  SIZE=$(du -sh "$ZIP" | cut -f1)
  echo "$ZIP ($SIZE)"
}

emit_zip "$FN_HEALTH"
emit_zip "$FN_INFO"
emit_zip "$FN_UPLOAD"
emit_zip "$FN_GENERATE"
emit_zip "$FN_GENERATE_STREAM"
emit_zip "$FN_UPLOAD_TO_S3" "with-layer"
emit_zip "$FN_S3_PROCESSOR" "with-layer"
emit_zip "$FN_FILE_QUERY" "with-layer"
emit_zip "$FN_JOB_PRODUCER" "with-layer"
emit_zip "$FN_JOB_CONSUMER" "with-layer"
emit_zip "$FN_AUDIT_CONSUMER" "with-layer"
emit_zip "$FN_SUMMARY_CONSUMER" "with-layer"
emit_zip "$FN_MAINTENANCE" "with-layer"

# Package Lambda Layer zip in /tmp first, then copy to zips/
LAYER_ZIP="$ZIP_DIR/${PROJECT}-common-layer.zip"
rm -f "$LAYER_ZIP"
cp -r "$PROJECT_ROOT/layer" "$PKG_STAGE/layer-src"
(
  cd "$PKG_STAGE/layer-src"
  zip -r "$PKG_STAGE/common-layer.zip" nodejs --quiet
)
cp "$PKG_STAGE/common-layer.zip" "$LAYER_ZIP"
echo "$LAYER_ZIP ($(du -sh "$LAYER_ZIP" | cut -f1))"

echo ""
echo "=== Package complete ==="
echo "Zip files:"
ls -lh "$ZIP_DIR"/*.zip
