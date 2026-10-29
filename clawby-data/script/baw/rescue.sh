#!/usr/bin/env bash
# rescue.sh — unstick a pending transaction fast: find the first pending tx and speed it up
# (higher gas) or cancel it, in one turn. For the "my tx is stuck, race it" scenario.
#
#   bash rescue.sh [--binanceChainId 56] [--cancel] [--level HIGH] [--yes]
#
# Default action is SPEED-UP (resubmit with higher gas, --level HIGH); --cancel replaces it
# with a 0-value self-send instead. Only the FIRST pending tx (confirmedNonce+1) can be
# acted on — baw enforces this; this script targets transactions[0]. speed-up/cancel need
# NO Binance App approval. Without --yes: lists the actionable tx and STOPS. With --yes
# (passed only while yolo mode is on): performs the action and prints the replacement txHash.
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"

YES=0; CANCEL=0; LEVEL="HIGH"; CHAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --cancel) CANCEL=1 ;;
    --level) LEVEL="$2"; shift ;;
    --level=*) LEVEL="${1#*=}" ;;
    --binanceChainId) CHAIN="$2"; shift ;;
    --binanceChainId=*) CHAIN="${1#*=}" ;;
  esac
  shift
done

_need baw "(npm i -g @binance/agentic-wallet)"; _need python3
CARG=(); [ -n "$CHAIN" ] && CARG=(--binanceChainId "$CHAIN")

PEND="$(baw wallet tx-history --type pending "${CARG[@]}" --json 2>&1)" || true
INFO="$(printf '%s' "$PEND" | python3 -c '
import sys, json, shlex
def out(**k):
    for a,b in k.items(): print("%s=%s"%(a, shlex.quote(str(b))))
try: txs=(json.load(sys.stdin).get("data") or {}).get("transactions") or []
except Exception: txs=[]
if not txs: out(found="0"); sys.exit(0)
t=txs[0]
out(found="1", txHash=t.get("txHash") or "", chain=t.get("binanceChainId") or "", kind=t.get("txType") or "")
')"
found=0; txHash=""; chain=""; kind=""; eval "$INFO"

if [ "$found" != "1" ] || [ -z "$txHash" ]; then
  echo "No actionable pending transaction found."
  printf '%s\n' "$PEND"
  exit 0
fi

echo "First pending (only this one is actionable): txHash=$txHash chain=$chain type=$kind"
[ -z "$CHAIN" ] && [ -n "$chain" ] && CARG=(--binanceChainId "$chain")

if [ "$YES" -ne 1 ]; then
  act="speed-up (--level $LEVEL)"; [ "$CANCEL" -eq 1 ] && act="cancel"
  echo "Would $act this tx. NOT done — add --yes (enable yolo mode first)."
  exit 0
fi

if [ "$CANCEL" -eq 1 ]; then
  echo "Cancelling $txHash ..."
  baw wallet cancel "$txHash" "${CARG[@]}" --json
else
  echo "Speeding up $txHash (--level $LEVEL) ..."
  baw wallet speed-up "$txHash" --level "$LEVEL" "${CARG[@]}" --json
fi
