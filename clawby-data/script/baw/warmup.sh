#!/usr/bin/env bash
# warmup.sh — one-time readiness check so the hot path skips these round-trips.
#
# Run this ONCE at the start of a time-sensitive session. It reports whether you are
# signed in, whether Developer Mode is on (required for contract-call) and when it / the
# session expire — so you fix those BEFORE the critical moment, not during it.
#
#   bash warmup.sh
#
# Read-only: no funds move. Inherits your shell env (proxy etc.).
set -eo pipefail

command -v baw >/dev/null 2>&1 || { echo "ERROR: baw not found (npm i -g @binance/agentic-wallet)"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 2; }

STATUS="$(baw wallet status --json 2>&1 || true)"
SETTINGS="$(baw wallet settings --json 2>&1 || true)"
ADDR="$(baw wallet address --json 2>&1 || true)"

printf '%s\n----\n%s\n----\n%s\n' "$STATUS" "$SETTINGS" "$ADDR" | python3 -c '
import sys, json
blocks = sys.stdin.read().split("\n----\n")
def load(i):
    try: return json.loads(blocks[i])
    except Exception: return {}
st, se, ad = load(0), load(1), load(2)
sd = (st.get("data") or {}) if isinstance(st, dict) else {}
connected = sd.get("status") == "CONNECTED"
dse = (se.get("data") or {}) if isinstance(se, dict) else {}
dev = (dse.get("devMode") or {})
addr = ((ad.get("data") or {}) if isinstance(ad, dict) else {}).get("address") or dse.get("address") or "?"

print("connected       :", "YES" if connected else "NO  (run: baw auth signin -> auth verify)")
print("developer mode  :", "ON" if dev.get("enabled") else "OFF (needed for contract-call; enable in Binance App)",
      ("expiresAt=%s" % dev.get("expiresAt")) if dev.get("enabled") else "")
print("session expiry  :", dse.get("sessionExpireTime", "?"), "(sign-out is silent — re-auth if near)")
print("wallet address  :", addr)
print()
if not connected:
    print("ACTION: not signed in — do it now, not at the trigger moment.")
elif not dev.get("enabled"):
    print("ACTION: Developer Mode OFF — turn it on in the Binance App before any contract-call (lasts 7 days).")
else:
    print("READY: signed in + Developer Mode on. Hot-path scripts can skip these checks.")
'
