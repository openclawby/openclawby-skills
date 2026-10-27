#!/usr/bin/env bash
# _lib.sh — shared helpers for script/baw/*. Not run directly; sourced by the others:
#   SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"
# Pure helpers, no side effects on source.

# _need <cmd> [hint] — abort(2) if a required tool is missing.
_need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 required ${2:-}"; exit 2; }; }

# _preview_gate "<preview-json>" — echoes shell-safe `key=value` lines; the caller does
#   eval "$(_preview_gate "$JSON")"
# Sets: verdict(PASS|ABORT) reason requestId expiresAt cautions. Used by every
# preview->execute fast path (contract-call, sign-message). The gate is the SAFETY FLOOR:
# it aborts on preview failure/interception, any RISK-level item or address riskLevel>=4,
# or requireConfirmation=true — and that holds even when the caller was given --yes.
_preview_gate() {
  printf '%s' "$1" | python3 -c '
import sys, json, shlex
def out(**kw):
    for k, v in kw.items(): print("%s=%s" % (k, shlex.quote(str(v))))
try:
    d = json.load(sys.stdin)
except Exception:
    out(verdict="ABORT", reason="preview did not return JSON"); sys.exit(0)
if not d.get("success"):
    e = d.get("error", {}) or {}
    out(verdict="ABORT", reason="preview failed: %s %s" % (e.get("code",""), str(e.get("message",""))[:180])); sys.exit(0)
data = d.get("data", {}) or {}
rid = data.get("requestId") or ""
if not rid:
    out(verdict="ABORT", reason="no requestId (intercepted/blocked)"); sys.exit(0)
risks = data.get("risks") or {}
details = risks.get("riskDetails") or []
hard = [x.get("title","risk") for x in details if x.get("riskType") == "RISK"]
addrs = risks.get("addresses") or {}
hi = [a for a, v in addrs.items() if int((v or {}).get("riskLevel", 0) or 0) >= 4]
if data.get("requireConfirmation"):
    out(verdict="ABORT", reason="requireConfirmation=true - needs Binance App tap, not a fast path", requestId=rid); sys.exit(0)
if hard or hi:
    why = "; ".join(hard) if hard else ("high-risk address: " + ",".join(hi))
    out(verdict="ABORT", reason="risk gate: " + why[:180], requestId=rid); sys.exit(0)
cautions = "; ".join([x.get("title","") for x in details if x.get("riskType") == "CAUTION"])
out(verdict="PASS", requestId=rid, expiresAt=data.get("expiresAt",""), cautions=cautions[:180])
'
}

# _rpc_for_chain <binanceChainId> — echoes a public EVM RPC url for the chain, or "" if
# unknown / non-EVM. Mirrors rpc/index.yaml public_fallback. Used only to poll a tx receipt.
_rpc_for_chain() {
  case "$1" in
    1)     echo "https://ethereum-rpc.publicnode.com" ;;
    56)    echo "https://bsc-dataseed.bnbchain.org" ;;
    8453)  echo "https://mainnet.base.org" ;;
    42161) echo "https://arb1.arbitrum.io/rpc" ;;
    196)   echo "https://rpc.xlayer.tech" ;;
    4663)  echo "https://rpc.mainnet.chain.robinhood.com" ;;
    *)     echo "" ;;
  esac
}

# _poll_evm_receipt <rpc_url> <txhash> [timeout_s] — echoes CONFIRMED | REVERTED | PENDING |
# UNKNOWN. Polls eth_getTransactionReceipt. UNKNOWN when no rpc url (non-EVM/unmapped chain).
_poll_evm_receipt() {
  local rpc="$1" tx="$2" to="${3:-60}" waited=0 resp st
  [ -n "$rpc" ] || { echo "UNKNOWN"; return; }
  local body="{\"jsonrpc\":\"2.0\",\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$tx\"],\"id\":1}"
  while [ "$waited" -lt "$to" ]; do
    resp="$(curl -s -m 10 -X POST "$rpc" -H 'content-type: application/json' --data "$body" 2>/dev/null || true)"
    st="$(printf '%s' "$resp" | python3 -c '
import sys, json
try: r = json.load(sys.stdin).get("result")
except Exception: r = None
print("" if not r else (r.get("status") or "0x1"))' 2>/dev/null || true)"
    case "$st" in
      0x1) echo "CONFIRMED"; return ;;
      0x0) echo "REVERTED"; return ;;
    esac
    sleep "${BAW_POLL_INTERVAL:-3}"; waited=$((waited + ${BAW_POLL_INTERVAL:-3}))
  done
  echo "PENDING"
}
