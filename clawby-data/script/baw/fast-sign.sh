#!/usr/bin/env bash
# fast-sign.sh — one-shot EIP-712 message signature (Permit / Permit2 / typed data).
#
# Same shape as fast-contract-call.sh, for `sign-message`: preview -> shared risk gate
# (_lib.sh) -> (only with --yes) execute, ONE process = ONE agent turn.
#
#   bash fast-sign.sh --binanceChainId 1 --signType EIP712 --message '<eth_signTypedData_v4 json>' [--yes]
#
# --message is a FULL eth_signTypedData_v4 request string:
#   {"method":"eth_signTypedData_v4","params":["<yourWallet>","<typedDataJson>"]}
# --yes = the user's one-shot 'yolo' pre-authorization (see README). Without it: preview +
# gate + STOP. SAFETY (fires even with --yes): aborts on preview failure, any RISK item /
# high-risk address, or requireConfirmation=true. For Permit/Permit2, the preview's
# parsedMessage shows the authority being granted — review it before signing.
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"

YES=0; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

_need baw "(npm i -g @binance/agentic-wallet)"; _need python3
[ ${#ARGS[@]} -gt 0 ] || { echo "ERROR: pass sign-message preview flags: --binanceChainId <id> --signType EIP712 --message '<json>'"; exit 2; }

PREVIEW="$(baw sign-message preview "${ARGS[@]}" --json 2>&1)" || true
verdict=ABORT; reason=""; requestId=""; expiresAt=""; cautions=""
eval "$(_preview_gate "$PREVIEW")"

echo "----- preview -----"; printf '%s\n' "$PREVIEW"; echo "-------------------"
[ -n "$cautions" ] && echo "CAUTION: $cautions"
if [ "$verdict" != "PASS" ]; then echo "ABORTED: ${reason:-unknown}"; exit 1; fi

if [ "$YES" -ne 1 ]; then
  echo "Preview OK. requestId=$requestId (expiresAt=$expiresAt)"
  echo "NOT signed — re-run with --yes to sign (agent: only when the user said 'yolo')."
  exit 0
fi

echo "Signing (--yes) requestId=$requestId ..."
RES="$(baw sign-message execute --requestId "$requestId" --json 2>&1)" || true
printf '%s\n' "$RES"
# gate guarantees requireConfirmation=false, so execute should return COMPLETED directly;
# if it unexpectedly needs App approval, surface it (do not silently poll forever).
printf '%s' "$RES" | grep -q 'PENDING_CONFIRMATION' && \
  echo "NOTE: needs Binance App approval — poll: baw sign-message result --order-id <orderId> --json"
exit 0
