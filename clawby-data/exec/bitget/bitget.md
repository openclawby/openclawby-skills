# Bitget — trade execution connector

Execute trades on **Bitget** (Spot, USDT/Coin Futures, Margin, Copy-trading, Convert, Earn, P2P) via the official **`bgc`** CLI, running **locally with the user's own Bitget API keys**.

> Execution connector, NOT part of the Clawby data relay. Clawby supplies market **data**; this **places real orders / moves funds** with the user's own credentials. Keys never go to Clawby.

## Prerequisite

```bash
npm install -g bitget-client
bgc --version            # verify (if missing, install above)
```

## Auth

Credentials from **environment variables only** (private endpoints — account, trading; public market data needs none):

```bash
export BITGET_API_KEY="..."
export BITGET_SECRET_KEY="..."
export BITGET_PASSPHRASE="..."     # Bitget keys also have a passphrase
```
Create at bitget.com → Settings → API Management (Read and/or Trade permissions).

- `--read-only` (first flag) disables all write operations: `bgc --read-only ...`
- Never echo/log credentials; never `printenv`/bare `export`.

## ⚠️ Safety — confirm before any real money moves

Before any **write operation** (place/cancel order, transfer, withdraw, set leverage, borrow, redeem): summarize exactly what it does and ask the user to confirm. Never silently execute.
- **Withdrawals**: always show **chain name + destination address** in the prompt — wrong chain is irreversible; if no chain given, list options and ask.
- **Spot market BUY**: `size` is in **quote coin (USDT)**, not base — confirm intent to avoid mistakes.
- Read-only queries (prices/balances/positions) don't need confirmation.

## Usage

```
bgc <module> <tool_name> [--param value ...]
```
Output is JSON: `{ data, endpoint, requestTime }` (errors: `ok:false` + `error.suggestion`). Discover a module's tools with `bgc <module>` / `bgc <module> --help`.

**Modules:** `spot`, `futures`, `account`, `margin`, `copytrading`, `convert`, `earn`, `p2p`, `broker`.

### Examples

```bash
# Public market data (no creds) — but prefer Clawby's data relay for analysis
bgc spot spot_get_ticker --symbol BTCUSDT
bgc futures futures_get_funding_rate --productType USDT-FUTURES --symbol BTCUSDT

# Account (creds required)
bgc account get_account_assets
bgc futures futures_get_positions --productType USDT-FUTURES --symbol BTCUSDT

# Write ops — CONFIRM first
bgc spot spot_place_order --orders '[{"symbol":"BTCUSDT","side":"buy","orderType":"limit","price":"70000","size":"0.01"}]'
bgc futures futures_set_leverage --productType USDT-FUTURES --symbol BTCUSDT --marginCoin USDT --leverage 10
bgc account transfer --fromAccountType spot --toAccountType futures_usdt --coin USDT --amount 100
```

### Futures: closing positions (most common mistake)

Always check the position first (`bgc futures futures_get_positions …`) for `holdSide` and `posMode`, then:

| Position | `side` to close | Extra param |
|----------|-----------------|-------------|
| Long, one-way mode | `sell` | `reduceOnly: "YES"` |
| Short, one-way mode | `buy` | `reduceOnly: "YES"` |
| Long, hedge mode | `sell` | `tradeSide: "close"` |
| Short, hedge mode | `buy` | `tradeSide: "close"` |

> Selling to "close" a short actually opens MORE short — use the table.

**TP/SL:** preset at entry (`presetStopSurplusPrice`/`presetStopLossPrice`), or after entry via `futures_modify_order` (`newPresetStopSurplusPrice`/`newPresetStopLossPrice`; `"0"` deletes). Always show **liquidation price** when reporting positions.

### Other gotchas

- **Convert** is two-step: `convert_get_quote` (quote id + rate, ~10s valid) → show the rate to the user → `convert_execute`.
- **Copy-trading** positions are separate: manage with `copy_get_positions` / `copy_close_position`, not `futures_*`.

## Demo / paper trading

Needs a Bitget Demo API key. Add `--paper-trading` as the **first** flag on **every** command in the session (never mix demo and live):

```bash
bgc --paper-trading futures futures_get_positions --productType USDT-FUTURES
```
