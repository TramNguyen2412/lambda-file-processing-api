#!/usr/bin/env bash
# infra/50-vars-phase6.sh
# Shared environment variables for Phase 6 (Lambda Layer + Container Cache).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/40-vars-phase5.sh"

export LAYER_NAME="${LAYER_NAME:-${PROJECT}-common}"
export LAYER_VERSION_TAG="${LAYER_VERSION_TAG:-v1}"

echo "Phase 6 vars loaded: LAYER_NAME=$LAYER_NAME"
