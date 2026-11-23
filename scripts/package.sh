#!/usr/bin/env bash
# scripts/package.sh
# Compiles TypeScript and packages each Lambda function into a zip file.
# Uses locally installed node_modules (excluding devDependencies).
# Can be run completely offline without AWS credentials.
#
# Output: zips/<function-name>.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DIST_DIR="$PROJECT_ROOT/dist"
ZIP_DIR="$PROJECT_ROOT/zips"
PKG_STAGE="$PROJECT_ROOT/.pkg-stage"

cd "$PROJECT_ROOT"

echo "=== Lambda Package Script ==="
echo "Project root: $PROJECT_ROOT"
echo ""

# -- Step 1: TypeScript type-check -------------------------------------------
echo "Step 1: TypeScript type check..."
npx tsc --noEmit
echo "No type errors"
echo ""

# -- Step 2: Compile TypeScript -----------------------------------------------
echo "Step 2: Compiling TypeScript..."
rm -rf "$DIST_DIR"
npx tsc
echo "Compiled to $DIST_DIR"
echo ""

# -- Step 3: Prepare staging area with production node_modules ----------------
echo "Step 3: Preparing runtime dependencies..."
rm -rf "$PKG_STAGE"
mkdir -p "$PKG_STAGE/node_modules"

# Copy local node_modules excluding development tools (@types, typescript, .bin)
cp -r "$PROJECT_ROOT/node_modules/." "$PKG_STAGE/node_modules/"
rm -rf "$PKG_STAGE/node_modules/@types" \
       "$PKG_STAGE/node_modules/typescript" \
       "$PKG_STAGE/node_modules/.bin" \
       "$PKG_STAGE/node_modules/.package-lock.json"

echo "Production dependencies staged (size: $(du -sh "$PKG_STAGE/node_modules" | cut -f1))"
echo ""

# -- Step 4: Create one zip per Lambda function -------------------------------
echo "Step 4: Creating zip packages..."
mkdir -p "$ZIP_DIR"

PROJECT="${PROJECT:-lambda-file-api}"
FN_HEALTH="${FN_HEALTH:-${PROJECT}-health}"
FN_INFO="${FN_INFO:-${PROJECT}-info}"
FN_UPLOAD="${FN_UPLOAD:-${PROJECT}-upload-excel}"
FN_GENERATE="${FN_GENERATE:-${PROJECT}-generate-excel}"
FN_GENERATE_STREAM="${FN_GENERATE_STREAM:-${PROJECT}-generate-excel-stream}"

create_zip() {
  local FN_NAME="$1"
  local ZIP="$ZIP_DIR/${FN_NAME}.zip"

  rm -f "$ZIP"

  # Build staging directory: dist/ + staged node_modules
  local STAGE="$PKG_STAGE/build"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"

  cp -r "$DIST_DIR/." "$STAGE/"
  cp -r "$PKG_STAGE/node_modules" "$STAGE/"

  cd "$STAGE"
  zip -r "$ZIP" . --quiet
  cd "$PROJECT_ROOT"

  local SIZE
  SIZE=$(du -sh "$ZIP" | cut -f1)
  echo "$ZIP ($SIZE)"
}

create_zip "$FN_HEALTH"
create_zip "$FN_INFO"
create_zip "$FN_UPLOAD"
create_zip "$FN_GENERATE"
create_zip "$FN_GENERATE_STREAM"

# Clean up staging directory
rm -rf "$PKG_STAGE"

echo ""
echo "=== Package complete ==="
echo "Zip files:"
ls -lh "$ZIP_DIR"/*.zip
echo ""
echo "Next: when ready to deploy, run infra/01-iam.sh, then 02-lambda.sh."
