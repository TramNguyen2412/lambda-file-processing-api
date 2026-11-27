#!/usr/bin/env bash
# infra/51-cache-test.sh
# Observes Phase 6B container-local cache behavior on GET /file/{id}:
#   1. Sequential requests (cold miss -> warm hit when routed to same containerId)
#   2. Concurrent requests (multiple containerIds -> independent cold misses)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/50-vars-phase6.sh"

API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/dev"

if [ -z "${FILE_ID:-}" ]; then
  echo "Usage: FILE_ID=<uuid> bash infra/51-cache-test.sh"
  exit 1
fi

echo "=== 1. Sequential Requests (observe containerId & source) ==="
for i in $(seq 1 6); do
  curl -sS "$API_URL/file/$FILE_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('req=$i', 'containerId='+d.containerId, 'source='+d.source, 'isColdStart='+d.isColdStart, 'status='+d.status)"
done

echo "=== 2. Concurrent Requests (observe multiple containers) ==="
for i in $(seq 1 6); do
  curl -sS "$API_URL/file/$FILE_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('concurrent=$i', 'containerId='+d.containerId, 'source='+d.source)" &
done
wait
