#!/usr/bin/env bash
# fast-contract-call.sh — one-shot Binance Agentic Wallet contract call.
#
# Collapses `baw contract-call preview -> (confirm) -> execute [-> on-chain confirm]` into
# ONE process = ONE agent turn, for TIME-SENSITIVE calls. Forwards the standard preview
# flags to baw, applies the shared risk gate (_lib.sh), and executes ONLY with --yes.
#
#   bash fast-contract-call.sh --binanceChainId 56 --from 0x.. --to 0x.. [--value <wei>] \
#        [--inputData 0x..] [--gasLimit <n>] [--yes] [--confirm]
#
# --yes   = the user's ONE-SHOT pre-authorization. Per skill rule (README), the agent passes
#           --yes ONLY while yolo mode is ON (the agent asks the user to enable it first).
#           Without --yes: preview + gate + STOP (prints requestId, does not broadcast).
# --confirm = after a BROADCASTED txHash, poll the chain's public RPC for the receipt and
#           report CONFIRMED / REVERTED / PENDING (EVM chains only).
#
# SAFETY (fires even with --yes): aborts on preview failure/interception, any RISK-level
# item or address riskLevel>=4, or requireConfirmation=true. Value is wei. Requires baw
# signed in + Developer Mode ON (run warmup.sh first). Inherits your shell env (proxy etc.).
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"

YES=0; CONFIRM=0; CHAIN=""; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --confirm) CONFIRM=1 ;;
    --binanceChainId) CHAIN="$2"; ARGS+=("$1" "$2"); shift ;;
    --binanceChainId=*) CHAIN="${1#*=}"; ARGS+=("$1") ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

_need baw "(npm i -g @binance/agentic-wallet)"; _need python3
[ ${#ARGS[@]} -gt 0 ] || { echo "ERROR: pass contract-call preview flags, e.g. --binanceChainId 56 --from 0x.. --to 0x.."; exit 2; }

PREVIEW="$(baw contract-call preview "${ARGS[@]}" --json 2>&1)" || true
verdict=ABORT; reason=""; requestId=""; expiresAt=""; cautions=""
eval "$(_preview_gate "$PREVIEW")"

echo "----- preview -----"; printf '%s\n' "$PREVIEW"; echo "-------------------"
[ -n "$cautions" ] && echo "CAUTION: $cautions"
if [ "$verdict" != "PASS" ]; then echo "ABORTED: ${reason:-unknown}"; exit 1; fi

if [ "$YES" -ne 1 ]; then
  echo "Preview OK. requestId=$requestId (expiresAt=$expiresAt)"
  echo "NOT executed — re-run with --yes to broadcast (agent: only while yolo mode is on)."
  exit 0
fi

echo "Executing (--yes) requestId=$requestId ..."
RES="$(baw contract-call execute --requestId "$requestId" --json 2>&1)" || true
printf '%s\n' "$RES"

if [ "$CONFIRM" -eq 1 ]; then
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
