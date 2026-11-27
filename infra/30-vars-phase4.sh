#!/usr/bin/env bash
# infra/30-vars-phase4.sh
# Shared environment variables for Phase 4 (SNS -> SQS Fan-out).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/20-vars-phase3.sh"

export SNS_TOPIC_NAME="${SNS_TOPIC_NAME:-${PROJECT}-file-processed}"
export AUDIT_QUEUE_NAME="${AUDIT_QUEUE_NAME:-${PROJECT}-audit-queue}"
export AUDIT_DLQ_NAME="${AUDIT_DLQ_NAME:-${PROJECT}-audit-dlq}"
export SUMMARY_QUEUE_NAME="${SUMMARY_QUEUE_NAME:-${PROJECT}-summary-queue}"
export SUMMARY_DLQ_NAME="${SUMMARY_DLQ_NAME:-${PROJECT}-summary-dlq}"

export FN_AUDIT_CONSUMER="${FN_AUDIT_CONSUMER:-${PROJECT}-audit-consumer}"
export FN_SUMMARY_CONSUMER="${FN_SUMMARY_CONSUMER:-${PROJECT}-summary-consumer}"
export PHASE4_POLICY_NAME="${PHASE4_POLICY_NAME:-${PROJECT}-phase4-sns-fanout}"

echo "Phase 4 vars loaded: SNS_TOPIC=$SNS_TOPIC_NAME"
