#!/usr/bin/env bash
# fire-execute.sh — the trigger-instant call: broadcast a pre-staged contract-call.
#
# Runs `baw contract-call execute --requestId <id>` — the fastest "go". Gets the requestId
# from --requestId, else from the stage file written by preview-stage.sh.
#
#   bash fire-execute.sh                        # read requestId (+ chain) from the stage file
#   bash fire-execute.sh --requestId a1b2c3...   # or pass it explicitly
#   bash fire-execute.sh --confirm               # also poll the public RPC for the receipt
#
# This BROADCASTS — the agent runs it only while yolo mode is on (ask the user to enable it). If baw
# reports an expired preview, re-run preview-stage.sh (the staged requestId has lapsed).
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"

STAGE="${BAW_STAGE_FILE:-${TMPDIR:-/tmp}/baw-stage.json}"
RID=""; CHAIN=""; CONFIRM=0
while [ $# -gt 0 ]; do
  case "$1" in
    --requestId) RID="$2"; shift 2 ;;
    --requestId=*) RID="${1#*=}"; shift ;;
    --binanceChainId) CHAIN="$2"; shift 2 ;;
    --binanceChainId=*) CHAIN="${1#*=}"; shift ;;
    --confirm) CONFIRM=1; shift ;;
    *) shift ;;
  esac
done

_need baw "(npm i -g @binance/agentic-wallet)"

if [ -z "$RID" ]; then
  [ -f "$STAGE" ] || { echo "ERROR: no --requestId and no stage file at $STAGE (run preview-stage.sh first)"; exit 2; }
  _need python3
  RID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("requestId",""))' "$STAGE" 2>/dev/null || true)"
  EXP="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("expiresAt",""))' "$STAGE" 2>/dev/null || true)"
  [ -z "$CHAIN" ] && CHAIN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("binanceChainId",""))' "$STAGE" 2>/dev/null || true)"
  [ -n "$RID" ] || { echo "ERROR: stage file $STAGE has no requestId"; exit 2; }
  if [ -n "$EXP" ]; then
    NOWMS=$(( $(date -u +%s) * 1000 ))
    if [ "$EXP" -gt 0 ] 2>/dev/null && [ "$NOWMS" -gt "$EXP" ] 2>/dev/null; then
      echo "ERROR: staged preview expired (expiresAt=$EXP). Re-run preview-stage.sh."; exit 1
    fi
  fi
fi

echo "Firing execute requestId=$RID ..."
RES="$(baw contract-call execute --requestId "$RID" --json 2>&1)" || true
printf '%s\n' "$RES"

if [ "$CONFIRM" -eq 1 ]; then
  _need python3
  TX="$(printf '%s' "$RES" | python3 -c 'import sys,json
try: print((json.load(sys.stdin).get("data") or {}).get("txHash") or "")
except Exception: print("")' 2>/dev/null || true)"
  if [ -n "$TX" ]; then
    echo "Confirming $TX on-chain ..."
    echo "on-chain: $(_poll_evm_receipt "$(_rpc_for_chain "$CHAIN")" "$TX" "${BAW_CONFIRM_TIMEOUT:-60}")"
  else
    echo "on-chain: no txHash yet (likely PENDING_CONFIRMATION — approve in the Binance App)."
  fi
fi
