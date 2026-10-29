#!/usr/bin/env bash
# fast-send.sh — one-shot token transfer, optionally confirmed on-chain, in one turn.
#
#   bash fast-send.sh --amount 10 --recipient 0x..5678 --binanceChainId 56 --tokenAddress 0x.. \
#        [--gasLevel HIGH] [--yes] [--confirm]
#   bash fast-send.sh --max --recipient 0x..5678 --binanceChainId 56 --tokenAddress 0x.. --yes
#
# Default gas level is HIGH. Without --yes: prints the intended transfer and STOPS.
# With --yes (passed only while yolo mode is on): sends; with --confirm, polls the chain's public
# RPC for the receipt (EVM only) and reports CONFIRMED / REVERTED / PENDING.
#
# NOTE: --recipient must be a raw address already in the Binance App address book. A DOMAIN
# (alice.eth / .bnb / .ai) must be resolved FIRST with `baw wallet resolve-domain`, the
# resolved address confirmed by the user, then passed here — never pass a domain string.
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"

YES=0; CONFIRM=0; HAS_GAS=0; CHAIN=""; RECIP=""; TOKEN=""; SEND_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --confirm) CONFIRM=1 ;;
    --gasLevel|--gasLevel=*) HAS_GAS=1; SEND_ARGS+=("$1"); [ "$1" = "--gasLevel" ] && { SEND_ARGS+=("$2"); shift; } ;;
    --binanceChainId) CHAIN="$2"; SEND_ARGS+=("$1" "$2"); shift ;;
    --recipient) RECIP="$2"; SEND_ARGS+=("$1" "$2"); shift ;;
    --tokenAddress) TOKEN="$2"; SEND_ARGS+=("$1" "$2"); shift ;;
    *) SEND_ARGS+=("$1") ;;
  esac
  shift
done
[ "$HAS_GAS" -eq 0 ] && SEND_ARGS+=(--gasLevel HIGH)

_need baw "(npm i -g @binance/agentic-wallet)"
{ [ -n "$RECIP" ] && [ -n "$CHAIN" ] && [ -n "$TOKEN" ]; } || { echo "ERROR: need --recipient --binanceChainId --tokenAddress (+ --amount or --max)"; exit 2; }
case "$RECIP" in *.eth|*.bnb|*.ai|*.*[a-zA-Z]) echo "ERROR: --recipient looks like a domain ('$RECIP'). Resolve it with 'baw wallet resolve-domain' first, confirm the address, then pass the raw 0x address."; exit 2 ;; esac

if [ "$YES" -ne 1 ]; then
  echo "Would send to $RECIP on chain $CHAIN token $TOKEN (gas HIGH). NOT sent."
  echo "Add --yes to broadcast (the agent passes it only while yolo mode is on)."
  exit 0
fi

echo "Sending (--yes) ..."
RES="$(baw wallet send "${SEND_ARGS[@]}" --json 2>&1)" || true
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
    echo "on-chain: no txHash in response (nothing to confirm)."
  fi
fi
