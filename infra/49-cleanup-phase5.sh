#!/usr/bin/env bash
# infra/49-cleanup-phase5.sh
# Deletes ONLY Phase 5 resources (2 EventBridge Schedules, Scheduler IAM Role, maintenance Lambda).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/40-vars-phase5.sh"

echo "=== Cleaning up Phase 5 resources ==="

aws scheduler delete-schedule --name "$SCHEDULE_DAILY_NAME" 2>/dev/null || true
aws scheduler delete-schedule --name "$SCHEDULE_RECOVERY_NAME" 2>/dev/null || true

aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "$SCHEDULER_POLICY_NAME" 2>/dev/null || true
aws iam delete-role --role-name "$SCHEDULER_ROLE_NAME" 2>/dev/null || true

aws lambda delete-function --function-name "$FN_MAINTENANCE" 2>/dev/null || true

echo "=== Phase 5 cleanup complete ==="
