#!/usr/bin/env bash
# auto-sweep.sh — "baw 自动归集" (baw auto-sweep).
#
# Moves ALL non-native tokens out of the baw wallet to one fixed destination, KEEPING every chain's
# native gas coin (BNB / ETH / POL / ...). Two triggers work together:
#   • primary (event) — the agent runs `run-once` right AFTER each baw asset action (mint / swap /
#     send / claim / contract-call / ...) while the mode is ON, so a new balance is swept the moment
#     it appears. This is the main path — see exec/baw/baw.md.
#   • safety net (slow poll) — the `start` daemon also sweeps every INTERVAL seconds (default 600 =
#     10 min) to catch anything that arrived while the agent was idle / offline.
# No per-transfer confirmation — that is the whole point. The destination is set ONCE at `start` and
# reused; it is never re-read from anywhere else, so a drainer can't swap it mid-run.
#
#   bash auto-sweep.sh start --to 0x<EVM address>   # confirm the address FIRST (irreversible, ongoing)
#   bash auto-sweep.sh stop                         # disable + stop the safety-net daemon
#   bash auto-sweep.sh status                        # running? destination? last log lines
#   bash auto-sweep.sh run-once [--dry-run]          # the AGENT-HOOK entry: sweep now IF the mode is ON
#   bash auto-sweep.sh run-once --to 0x.. [--dry-run] # explicit one-off sweep (ignores the on/off flag)
#
# ⚠️ This moves real funds on a timer with no confirmation. Only the exact user phrases
#    『开启baw自动归集』 / 『关闭baw自动归集』 arm / disarm it (see exec/baw/baw.md). The agent must
#    restate the full destination address and get an explicit one-time yes before `start`.
#
# Transfers use `baw wallet send`, so the destination MUST be in the Binance App address book
# (else baw returns 351703 — logged, and that token is retried next cycle). Native coins are kept
# so each chain still has gas. Solana / non-EVM balances are skipped (can't reach an EVM address).
#
# Runs locally with the user's own wallet, inherits your shell env (proxy etc.), never routes
# through Clawby. bash + python3 required (python3 parses `baw --json`).
set -eo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$SRC_DIR/_lib.sh"
SELF="$SRC_DIR/auto-sweep.sh"

STATE_DIR="${CLAWBY_SWEEP_DIR:-$HOME/.clawby/baw-auto-sweep}"
STATE="$STATE_DIR/state.json"
PIDFILE="$STATE_DIR/daemon.pid"
LOG="$STATE_DIR/sweep.log"
INTERVAL="${CLAWBY_SWEEP_INTERVAL:-600}"   # safety-net poll; the agent hook is the primary trigger

_log() { mkdir -p "$STATE_DIR"; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# _valid_addr <s> — 0 if s is a 0x + 40 hex EVM address.
_valid_addr() { case "$1" in 0x[0-9a-fA-F]*) [ "${#1}" -eq 42 ] ;; *) return 1 ;; esac; }

_state_get() { # _state_get <key> -> value ("" if absent); JSON bool -> true/false
  python3 -c '
import json,sys
try: v=json.load(open(sys.argv[1])).get(sys.argv[2])
except Exception: v=None
print(("true" if v else "false") if isinstance(v,bool) else ("" if v is None else v))' "$STATE" "$1" 2>/dev/null || true
}

_write_state() { # _write_state <enabled true|false> <destination|"">
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR" 2>/dev/null || true
  python3 -c '
import json,sys,time
p,enabled,dest=sys.argv[1],sys.argv[2],sys.argv[3]
try: cur=json.load(open(p))
except Exception: cur={}
cur["enabled"]=(enabled=="true")
if dest: cur["destination"]=dest
if enabled=="true": cur["startedAt"]=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
cur.setdefault("startedAt","")
json.dump(cur, open(p,"w"), indent=2)
' "$STATE" "$1" "$2"
}

_is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

_connected() { # 0 if baw wallet status == CONNECTED
  local st; st="$(baw wallet status --json 2>&1 || true)"
  printf '%s' "$st" | python3 -c '
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
sys.exit(0 if ((d.get("data") or {}).get("status")=="CONNECTED") else 1)' 2>/dev/null
}

# _sweep_once <dry 0|1> <destination> — one pass over the wallet; keeps native, sweeps the rest.
_sweep_once() {
  local DRY="$1" dest="$2"
  _valid_addr "$dest" || { _log "cycle abort: bad destination '$dest'"; return 0; }
  if ! _connected; then _log "cycle skip: baw wallet not CONNECTED"; return 0; fi

  local BAL rows
  BAL="$(baw wallet balance --json 2>&1 || true)"
  # Emit TSV (chain<TAB>address<TAB>symbol<TAB>balance) for SWEEPABLE tokens only:
  #   drop native (sentinel addr / empty), drop Solana & non-EVM (CT_*), drop zero balance.
  rows="$(printf '%s' "$BAL" | python3 -c '
import sys,json
SENT="0x"+"e"*40
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: sys.exit(0)
data=d.get("data") if isinstance(d,dict) else d
toks=None
if isinstance(data,list): toks=data
elif isinstance(data,dict):
    for k in ("tokens","balances","list","assets","items"):
        if isinstance(data.get(k),list): toks=data[k]; break
    if toks is None:
        for v in data.values():
            if isinstance(v,list): toks=v; break
for t in (toks or []):
    if not isinstance(t,dict): continue
    addr=str(t.get("address") or t.get("tokenAddress") or "").strip()
    chain=str(t.get("binanceChainId") or t.get("chainId") or "").strip()
    sym=str(t.get("symbol") or "?").strip()
    bal=str(t.get("balance") or "0").strip()
    if not chain or chain.upper().startswith("CT_"): continue   # Solana / non-EVM
    if not addr or addr.lower()==SENT: continue                 # native gas -> keep
    try:
        if float(bal)<=0: continue
    except Exception:
        pass
    print("\t".join([chain,addr,sym,bal]))
' 2>/dev/null || true)"

  if [ -z "$rows" ]; then _log "cycle: nothing to sweep"; return 0; fi

  local chain addr sym bal RES SUMMARY
  while IFS=$'\t' read -r chain addr sym bal; do
    [ -n "$chain" ] && [ -n "$addr" ] || continue
    if [ "$DRY" = "1" ]; then
      _log "DRY would sweep $sym ($bal) chain=$chain token=$addr -> $dest"
      continue
    fi
    RES="$(baw wallet send --max --tokenAddress "$addr" --recipient "$dest" --binanceChainId "$chain" --gasLevel HIGH --json 2>&1 || true)"
    SUMMARY="$(printf '%s' "$RES" | python3 -c '
import sys,json
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print("unparseable response"); sys.exit(0)
if d.get("success") is False or d.get("error"):
    e=d.get("error") or {}; code=str(e.get("code","")); msg=str(e.get("message",""))[:160]
    if code=="351703" or "address book" in msg.lower():
        print("ERROR 351703 recipient not in Binance App address book — add it once in the App"); sys.exit(0)
    print("ERROR %s %s" % (code,msg)); sys.exit(0)
tx=(d.get("data") or {}).get("txHash") or (d.get("data") or {}).get("hash") or ""
print(("txHash=%s" % tx) if tx else "submitted (no txHash in response)")' 2>/dev/null || true)"
    _log "sweep $sym chain=$chain token=$addr -> $dest : ${SUMMARY:-no-summary}"
  done <<< "$rows"
  return 0
}

cmd_start() {
  local dest="$1"
  _valid_addr "$dest" || { echo "ERROR: --to must be a 0x EVM address (42 chars)"; exit 2; }
  _need baw "(npm i -g @binance/agentic-wallet)"; _need python3
  if _is_running; then
    echo "baw 自动归集 already running (pid $(cat "$PIDFILE")). Run 'stop' first to change the destination."
    exit 0
  fi
  _connected || { echo "ERROR: baw wallet not CONNECTED — run: baw auth signin → baw auth verify"; exit 2; }
  _write_state true "$dest"
  nohup bash "$SELF" __loop >/dev/null 2>&1 &
  echo $! > "$PIDFILE"
  _log "START destination=$dest pid=$(cat "$PIDFILE") interval=${INTERVAL}s"
  echo "baw 自动归集 STARTED — destination=$dest pid=$(cat "$PIDFILE")"
  echo "Primary trigger: the agent sweeps right after each baw action while this is ON."
  echo "Safety net: this daemon also sweeps every ${INTERVAL}s. Keeps native gas; sweeps all other tokens."
  echo "Destination must be in your Binance App address book. Log: $LOG"
}

cmd_stop() {
  if _is_running; then
    local pid; pid="$(cat "$PIDFILE")"
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    _log "STOP pid=$pid"
    echo "baw 自动归集 STOPPED (pid $pid)."
  else
    echo "baw 自动归集 not running."
  fi
  rm -f "$PIDFILE"
  [ -f "$STATE" ] && _write_state false "" || true
}

cmd_status() {
  echo "=== baw 自动归集 status ==="
  if _is_running; then echo "running: YES (pid $(cat "$PIDFILE"))"; else echo "running: NO"; fi
  echo "destination: $(_state_get destination)"
  echo "startedAt:   $(_state_get startedAt)"
  echo "interval:    ${INTERVAL}s"
  echo "log:         $LOG"
  echo "--- last log lines ---"
  if [ -f "$LOG" ]; then tail -n 20 "$LOG"; else echo "(no log yet)"; fi
}

cmd_loop() {
  _log "LOOP start interval=${INTERVAL}s"
  local dest
  while :; do
    [ "$(_state_get enabled)" = "true" ] || { _log "LOOP exit (disabled)"; break; }
    dest="$(_state_get destination)"
    _sweep_once 0 "$dest" || _log "cycle error (continuing)"
    sleep "$INTERVAL"
  done
}

cmd_once() {
  local DRY="$1" TO="$2" dest
  _need baw "(npm i -g @binance/agentic-wallet)"; _need python3
  if [ -n "$TO" ]; then
    dest="$TO"                                   # explicit one-off: runs regardless of the on/off flag
  else
    # agent-hook path: do nothing unless the mode is ON (so a `stop` truly stops sweeping)
    if [ "$(_state_get enabled)" != "true" ]; then
      echo "baw 自动归集 is OFF — nothing to do (enable with: start --to 0x<addr>)."
      return 0
    fi
    dest="$(_state_get destination)"
  fi
  [ -n "$dest" ] || { echo "ERROR: no destination — pass --to 0x.. or run 'start' first"; exit 2; }
  _valid_addr "$dest" || { echo "ERROR: destination must be a 0x EVM address (42 chars)"; exit 2; }
  _sweep_once "$DRY" "$dest"
  echo "--- sweep.log tail ---"; if [ -f "$LOG" ]; then tail -n 30 "$LOG"; fi
}

SUB="${1:-}"; [ $# -gt 0 ] && shift || true
case "$SUB" in
  start)
    TO=""; while [ $# -gt 0 ]; do case "$1" in --to) TO="$2"; shift ;; --to=*) TO="${1#*=}" ;; esac; shift; done
    [ -n "$TO" ] || { echo "usage: auto-sweep.sh start --to 0x<EVM address>"; exit 2; }
    cmd_start "$TO" ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  run-once)
    DRY=0; TO=""
    while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=1 ;; --to) TO="$2"; shift ;; --to=*) TO="${1#*=}" ;; esac; shift; done
    cmd_once "$DRY" "$TO" ;;
  __loop) cmd_loop ;;
  *) echo "usage: auto-sweep.sh start --to 0x<addr> | stop | status | run-once [--to 0x<addr>] [--dry-run]"; exit 2 ;;
esac
