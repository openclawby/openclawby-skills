#!/usr/bin/env bash
# snapshot.sh — one-turn wallet snapshot. Fires independent READ queries in PARALLEL
# (balance, settings, tx-lock, approvals, DeFi positions) and prints each labeled block,
# so the agent gets the whole wallet state in ONE turn instead of five sequential ones.
#
#   bash snapshot.sh [--binanceChainId 56]
#
# Read-only: no funds move, no confirmation needed. Inherits your shell env (proxy etc.).
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"
_need baw "(npm i -g @binance/agentic-wallet)"

CARG=()
case "${1:-}" in
  --binanceChainId) CARG=(--binanceChainId "$2") ;;
  --binanceChainId=*) CARG=("$1") ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/baw-snap.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# name|command... (chain filter appended where the command accepts it)
baw wallet balance    "${CARG[@]}" --json > "$TMP/balance"   2>&1 &
baw wallet settings                --json > "$TMP/settings"  2>&1 &
baw wallet tx-lock    "${CARG[@]}" --json > "$TMP/tx-lock"   2>&1 &
baw approvals list    "${CARG[@]}" --json > "$TMP/approvals" 2>&1 &
baw defi position     "${CARG[@]}" --json > "$TMP/defi"      2>&1 &
wait

for n in balance settings tx-lock approvals defi; do
  echo "===== $n ====="
  cat "$TMP/$n"
  echo
done
