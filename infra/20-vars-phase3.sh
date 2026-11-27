#!/usr/bin/env bash
# infra/20-vars-phase3.sh
# Shared environment variables for Phase 3 (SQS + DLQ).
# Sources Phase 2 infra/10-vars-phase2.sh without modifying it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/10-vars-phase2.sh"

export SQS_QUEUE_NAME="${SQS_QUEUE_NAME:-${PROJECT}-jobs}"
export SQS_DLQ_NAME="${SQS_DLQ_NAME:-${PROJECT}-jobs-dlq}"

export FN_JOB_PRODUCER="${FN_JOB_PRODUCER:-${PROJECT}-job-producer}"
export FN_JOB_CONSUMER="${FN_JOB_CONSUMER:-${PROJECT}-job-consumer}"
export PHASE3_POLICY_NAME="${PHASE3_POLICY_NAME:-${PROJECT}-phase3-sqs}"

echo "Phase 3 vars loaded: SQS_QUEUE=$SQS_QUEUE_NAME DLQ=$SQS_DLQ_NAME"
