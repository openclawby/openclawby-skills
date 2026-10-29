#!/usr/bin/env bash
# fast-swap.sh — one-shot market swap: submit + POLL TO TERMINAL in one process = one turn.
#
# An orderId is NOT a completed swap (it can still end FAILED). The agent would otherwise
# spend several turns polling `market-order list` to a terminal state; this script does the
# swap and the polling in one process and reports the TERMINAL result.
#
#   bash fast-swap.sh --fromTokenQty 0.1 --fromToken 0x.. --toToken 0x.. --binanceChainId 56 \
#        [--slippage auto] [--mev true] [--gasLevel HIGH] [--yes]
#
# Default gas level is HIGH (fastest inclusion); override with --gasLevel. Without --yes:
# prints a QUOTE (expected output) and STOPS. With --yes (passed only while yolo mode is on):
# swaps, then polls to FINISHED / FAILED and reports txHash + received amount (+ any refund
# = partial fill). You MUST still run the swap SECURITY PRE-CHECK on the target token first
# (see exec/baw/baw.md / security.md) — a script cannot audit the token for you.
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"

YES=0; HAS_GAS=0; QTY=""; FROM=""; TO=""; CHAIN=""; SLIP=""; SWAP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --gasLevel|--gasLevel=*) HAS_GAS=1; SWAP_ARGS+=("$1"); [ "$1" = "--gasLevel" ] && { SWAP_ARGS+=("$2"); shift; } ;;
    --fromTokenQty) QTY="$2"; SWAP_ARGS+=("$1" "$2"); shift ;;
    --fromToken) FROM="$2"; SWAP_ARGS+=("$1" "$2"); shift ;;
    --toToken) TO="$2"; SWAP_ARGS+=("$1" "$2"); shift ;;
    --binanceChainId) CHAIN="$2"; SWAP_ARGS+=("$1" "$2"); shift ;;
    --slippage) SLIP="$2"; SWAP_ARGS+=("$1" "$2"); shift ;;
    *) SWAP_ARGS+=("$1") ;;
  esac
  shift
done
[ "$HAS_GAS" -eq 0 ] && SWAP_ARGS+=(--gasLevel HIGH)

_need baw "(npm i -g @binance/agentic-wallet)"; _need python3
{ [ -n "$QTY" ] && [ -n "$FROM" ] && [ -n "$TO" ] && [ -n "$CHAIN" ]; } || { echo "ERROR: need --fromTokenQty --fromToken --toToken --binanceChainId"; exit 2; }

if [ "$YES" -ne 1 ]; then
  echo "Quote (no swap — add --yes to execute; the agent passes it only while yolo mode is on):"
  Q=(--fromTokenQty "$QTY" --fromToken "$FROM" --toToken "$TO" --binanceChainId "$CHAIN")
  [ -n "$SLIP" ] && Q+=(--slippage "$SLIP")
  baw market-order quote "${Q[@]}" --json
  echo "Reminder: run the swap security pre-check on $TO before executing."
  exit 0
fi

echo "Swapping (--yes) ..."
RES="$(baw market-order swap "${SWAP_ARGS[@]}" --json 2>&1)" || true
printf '%s\n' "$RES"
OID="$(printf '%s' "$RES" | python3 -c 'import sys,json
try: print((json.load(sys.stdin).get("data") or {}).get("orderId") or "")
except Exception: print("")' 2>/dev/null || true)"
[ -n "$OID" ] || { echo "ABORTED: swap did not return an orderId (not submitted)."; exit 1; }

echo "Submitted orderId=$OID — polling to terminal (FINISHED/FAILED) ..."
to="${BAW_CONFIRM_TIMEOUT:-60}"; waited=0
while [ "$waited" -lt "$to" ]; do
  L="$(baw market-order list --orderId "$OID" --json 2>&1 || true)"
  VER="$(printf '%s' "$L" | python3 -c '
import sys, json, shlex
def out(**k):
    for a,b in k.items(): print("%s=%s"%(a, shlex.quote(str(b))))
try: o=(json.load(sys.stdin).get("data") or {}).get("list") or []
except Exception: o=[]
if not o: out(status="PENDING"); sys.exit(0)
r=o[0]; refund=r.get("refund") or []
out(status=r.get("status","PENDING"), txHash=r.get("txHash") or "",
    got=r.get("toTokenActualQty") or r.get("toCoinAmount") or "",
    refund=("yes" if refund else "no"))
')"
  status=PENDING; txHash=""; got=""; refund="no"; eval "$VER"
  case "$status" in
    FINISHED) echo "RESULT: FINISHED txHash=$txHash received=$got partial_fill=$refund"; exit 0 ;;
    FAILED)   echo "RESULT: FAILED (txHash=${txHash:-null}) — swap did not execute."; exit 1 ;;
  esac
  sleep "${BAW_POLL_INTERVAL:-3}"; waited=$((waited + ${BAW_POLL_INTERVAL:-3}))
done
echo "RESULT: still PENDING after ${to}s — not confirmed. Re-check: baw market-order list --orderId $OID --json"
exit 0
