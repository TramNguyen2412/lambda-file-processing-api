#!/usr/bin/env bash
# infra/40-vars-phase5.sh
# Shared environment variables for Phase 5 (EventBridge Scheduler).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/30-vars-phase4.sh"

export FN_MAINTENANCE="${FN_MAINTENANCE:-${PROJECT}-maintenance}"
export SCHEDULER_ROLE_NAME="${SCHEDULER_ROLE_NAME:-${PROJECT}-scheduler-role}"
export SCHEDULER_POLICY_NAME="${SCHEDULER_POLICY_NAME:-${PROJECT}-scheduler-invoke-maintenance}"
export SCHEDULE_DAILY_NAME="${SCHEDULE_DAILY_NAME:-${PROJECT}-daily-maintenance}"
export SCHEDULE_RECOVERY_NAME="${SCHEDULE_RECOVERY_NAME:-${PROJECT}-outbox-recovery}"

echo "Phase 5 vars loaded: FN_MAINTENANCE=$FN_MAINTENANCE"
