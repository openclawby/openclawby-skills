#!/usr/bin/env bash
# preview-stage.sh — pre-build a contract-call preview AHEAD of the time-sensitive moment.
#
# Runs `baw contract-call preview` + the shared risk gate (_lib.sh), and on PASS saves the
# requestId (+ expiresAt + chain) to a stage file. Does NOT execute. Pair with
# fire-execute.sh, which pays only for the `execute` the instant your condition hits.
#
#   bash preview-stage.sh --binanceChainId 56 --from 0x.. --to 0x.. [--value <wei>] [--inputData 0x..]
#
# Stage file: $BAW_STAGE_FILE, else ${TMPDIR:-/tmp}/baw-stage.json. A preview EXPIRES
# (expiresAt) — if fire-execute.sh later reports expired, re-run this.
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"

STAGE="${BAW_STAGE_FILE:-${TMPDIR:-/tmp}/baw-stage.json}"
CHAIN=""; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
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

printf '{"requestId":"%s","expiresAt":"%s","binanceChainId":"%s","staged_at":"%s"}\n' \
  "$requestId" "$expiresAt" "$CHAIN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE"
echo "STAGED requestId=$requestId expiresAt=$expiresAt chain=$CHAIN -> $STAGE"
echo "Fire with: bash fire-execute.sh   (reads this stage file)"
