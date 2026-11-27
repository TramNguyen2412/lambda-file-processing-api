#!/usr/bin/env bash
# infra/41-scheduler-test.sh
# Verifies Phase 5 EventBridge Schedules & invokes lambda-file-api-maintenance manually.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/40-vars-phase5.sh"

echo "=== 1. Inspect EventBridge Schedules ==="
aws scheduler get-schedule --name "$SCHEDULE_DAILY_NAME" --query '{Name:Name,Expression:ScheduleExpression,State:State}'
aws scheduler get-schedule --name "$SCHEDULE_RECOVERY_NAME" --query '{Name:Name,Expression:ScheduleExpression,State:State}'

echo "=== 2. Manual Invoke Maintenance Lambda (mode=all) ==="
OUT_FILE="/tmp/maintenance-output.json"
aws lambda invoke \
  --function-name "$FN_MAINTENANCE" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"source":"manual-test"}' \
  "$OUT_FILE" >/dev/null
cat "$OUT_FILE"
echo ""
