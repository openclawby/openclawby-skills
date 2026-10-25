# Bitget — trade execution connector

Execute trades on **Bitget** (Spot, Margin and USDT/Coin/USDC Futures in one Unified Trading Account, plus transfers, deposits/withdrawals, sub-accounts, crypto loans) via the official **`bgc`** CLI (npm `@bitget-ai/bitget-agent-cli`; this guide verified against **v3.0.0** on SDK 3.3.1 — the UTA / v3 API), running **locally with the user's own Bitget API keys**.

> Execution connector, NOT part of the Clawby data relay. Clawby supplies market **data**; this **places real orders / moves funds** with the user's own credentials. Keys never go to Clawby (Option B below only *reads* the user's own keys from their Key Vault).

## Prerequisite

```bash
npm install -g @bitget-ai/bitget-agent-cli   # provides `bgc` (Node >= 20)
bgc --version                                # "bgc (bitget-agent-cli) using bitget-agent-sdk 3.x" (if missing, install above)
```
- **Account must be a Unified Trading Account (UTA).** Error `25245` "Account is not in unified (UTA) mode" means it isn't: switch the account to UTA, or (Bitget's route for classic accounts) create an Agent sub-account via the API and use *that* sub-account's key.
- **Replaces the unmaintained `bitget-client`** (v1.1.1; old `bgc <module> <tool>` form, e.g. `bgc spot spot_get_ticker`, which v3 rejects). Bitget renamed the package in May 2026 and v3 rewrote the grammar. Both ship a `bgc` binary: if `bgc --version` says `bitget-client` / `bitget-core` or `bitget-agent-sdk 1.x`, run `npm uninstall -g bitget-client`, then install the line above.
- **Gone in v3** (no operation at all, `raw` included): Copy-trading, Convert execution (history only: `funds_records --action convert`), Earn, P2P — send the user to the Bitget app/web. Only the old v2-grammar CLI (`@bitget-ai/bitget-agent-cli@1.2.0`, not covered here) had them.

## Auth

Credentials from **environment variables only**. Public `market` data and `bgc discover` need none; everything else (account, trading, funds) needs **all three** — a partial set fails with `Partial API credentials detected`. Create the key at bitget.com → Settings → API Management: **Read** (queries), **Trade** (orders, transfers), **Withdraw** only if needed (and IP-whitelist the key).

**Option A — environment variables:**
```bash
export BITGET_API_KEY="..."
export BITGET_SECRET_KEY="..."
export BITGET_PASSPHRASE="..."     # Bitget keys also have a passphrase
```
Optional: `BITGET_API_BASE_URL` (default `https://api.bitget.com`), `BITGET_TIMEOUT_MS` (default 15000), `BITGET_MAX_RETRIES` (default 2).

**Option B — fetch keys from the Clawby Key Vault:**
```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/bitget -H "X-API-Key: $CLAWBY_API_KEY")
export BITGET_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
export BITGET_SECRET_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiSecret"])')
export BITGET_PASSPHRASE=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["passphrase"])')
```
Field names are whatever the user stored in the vault. Trusted-IP whitelist + vault switch rules + error shapes: see `rpc/index.yaml`. Keep creds in the environment only, never on disk.
- The vault's Bitget form stores `apiKey` / `apiSecret` / `passphrase` (used above). A `KeyError` means custom names — list them (not values): `printf '%s' "$RESP" | python3 -c 'import sys,json;print(list(json.load(sys.stdin)["keys"][0]["fields"]))'`.
- A vault holds up to 3 slots, each with a `label` — pick the right one (live vs demo) rather than blindly `keys[0]`. If the fetch returns an error (403 / 404 / 401), tell the user; don't ask for keys in chat.
- Exports live only in that shell: if every tool call is a fresh shell, fetch and run `bgc ...` in the same command, then `unset RESP`.

Both options:
- **Precedence:** env creds win; with none set, `bgc` silently falls back to `~/.bitget/oauth_token.json` (Bitget's "Agentic" OAuth login, if one exists on this machine) — possibly a different account. Run `bgc account_overview` to see which account you are on before the first write.
- Never echo/log credentials or `$RESP` (it holds the whole vault entry); never `printenv`/bare `export`.

## ⚠️ Safety — confirm before any real money moves

Before any **write operation** (place/modify/cancel orders, close position, transfer, withdraw, set leverage or position mode, borrow/repay): summarize exactly what it does and ask the user to confirm. Never silently execute — an ordinary write goes **live the moment `--dry-run` is omitted**. Preview with `--dry-run`: it prints the exact `wouldSend` payload and sends nothing (works even under `--read-only`).
- **`--confirm` is not the user's OK.** It is a CLI gate for only 4 high-risk operations: `position --action close|closeAll`, `order --action cancelAll`, `withdraw --action submit` (and broker sub-account withdraw). Without it the call returns `{confirmationRequired:true}` — nothing sent, stdout, exit 0, not an error. Get the user's go-ahead first, then re-run with `--confirm`. Ordinary writes take no `--confirm`.
- **Withdrawals**: always show **coin + chain name + destination address + size** in the prompt — wrong chain is irreversible; if no chain given, list options and ask. Params: `--coin --transferType on_chain|internal_transfer --address --chain --size` (the amount is `--size`, not `--amount`).
- **Spot/Margin market BUY**: `--qty` is in **quote coin (USDT)**, not base — confirm intent to avoid mistakes (units table below).
- **After a write — and before retrying one that errored or timed out — verify with a read** (`order --action open|detail|history`, `position --action info`). Never blind-resubmit.
- `--read-only` rejects every write before any request is sent (reads still work): `bgc --read-only ...`. Mutually exclusive with `--paper-trading`.
- Read-only queries (prices/balances/positions) don't need confirmation.

## Usage

```
bgc <verb> [--action <name>] [--<param> <value> ...]                         # verb FIRST; params are the exact camelCase API fields
bgc discover [--domain <d> | --tool <verb> [--action <a>] | --search <q>]   # live self-description of the CLI, no credentials
bgc raw --operationId <id> --args '<json>'                                   # any of the 109 API operations by id (same safety gates)
```
- **Discover, don't guess:** `bgc discover` (domains) → `--domain trade` (verbs) → `--tool order` (actions) → `--tool order --action place` (exact required/optional params, enums, `riskLevel`). Read the action contract before building any trading command.
- One `--category` selects the market: `SPOT` / `MARGIN` / `USDT-FUTURES` / `COIN-FUTURES` / `USDC-FUTURES`; symbols look like `BTCUSDT`. There are no separate spot / futures modules.
- Values: `true`/`false` → boolean; a value starting with `[` or `{` → JSON (`--orders '[{...}]'`); everything else stays a string. Valueless flags (`--dry-run`, `--confirm`) must come **after** the verb, or they swallow it as their value. `--read-only` / `--paper-trading` / `--pretty` take no value and can sit anywhere (convention: right after `bgc`).
- **Output:** success → JSON `{ endpoint, requestTime, data }` on **stdout**, exit 0 (so are `--dry-run` previews and `confirmationRequired` gates). Failure → `{ ok:false, error:{ type, code, category, message, suggestion, retryable } }` on **stderr**, exit 1 (use `2>&1` to capture it).
- **On error, branch on `error.category`:** `auth` / `param` → fix the request; `balance` / `risk` → tell the user; `rate` / `network` → back off and retry (`retryable:true`); `config` → check account mode (UTA).
- **Big payloads:** `--view summary|full` (default summary) and `--fields a,b`; paged reads take `--fetchAll true`, `--limit`, `--cursor`.

**Verbs** († = high-risk, needs `--confirm`; hidden `broker` / `inst_loan` modules are opt-in via `--modules broker`):

| Verb | Use for (`--action ...`) |
|------|---------------------------|
| `market` | public data, no creds: `tickers` `orderbook` `candles` `candlesHistory` `instruments` `fundingRate` `fundingRateHistory` `openInterest` `recentFills` ... |
| `order` | `place` (single, or batch via `--orders '[...]'`) `cancel` `modify` `cancelAll`† `open` `detail` `history` `fills` `maxOpen` `countdownCancel` |
| `position` | `info` `history` `adlRank` `close`† (one symbol, at market) `closeAll`† (a whole category) |
| `strategy_order` | trigger / TP-SL plan orders: `place` `cancel` `modify` `open` `history` |
| `account_overview` | one-call snapshot: assets + settings (incl. `holdMode`) + funding assets; add `--category --symbol` for positions + fee rate |
| `account_config` | `setLeverage` `setHoldingMode` `setAccountMode` + reads (`oiLimit` ...) |
| `transfer_funds` | `internal` (between your UTA and classic accounts) `mainToSub` `subToMain`; `--preflight true` = max transferable, moves nothing |
| `deposit` / `withdraw` / `funds_records` | deposit address & records / withdraw `submit`† `records` / ledger, convert history, sub-transfer records |
| `repayment` / `loan` / `subaccount` / `tax` | repay liabilities / crypto loans / sub-accounts & their API keys / tax records |

### Examples

```bash
# Public market data (no creds) — but prefer Clawby's data relay for analysis
bgc market --action tickers --category SPOT --symbol BTCUSDT
bgc market --action fundingRate --symbol BTCUSDT

# Account (creds required)
bgc account_overview --coin USDT
bgc position --action info --category USDT-FUTURES --symbol BTCUSDT

# Write ops — CONFIRM first (append --dry-run to preview without sending)
bgc order --action place --category SPOT --symbol BTCUSDT --side buy --orderType limit --price 70000 --qty 0.01
bgc account_config --action setLeverage --category USDT-FUTURES --symbol BTCUSDT --leverage 10
bgc transfer_funds --action internal --fromType spot --toType uta --coin USDT --amount 100   # classic Spot/Funding -> UTA
```

### Futures: closing positions (most common mistake)

First read the position and the mode: position side (long/short), size, **liquidation price** (always show it when reporting positions) and `holdMode` (`one_way_mode` / `hedge_mode`):
```bash
bgc position --action info --category USDT-FUTURES --symbol BTCUSDT
bgc account_overview            # mode: data.settings.data.holdMode
```
Then close **at market** (needs `--confirm`; `--symbol` is mandatory for `close`, so it can never flatten a whole category by omission):
```bash
bgc position --action close --category USDT-FUTURES --symbol BTCUSDT --confirm                   # one-way mode
bgc position --action close --category USDT-FUTURES --symbol BTCUSDT --posSide long --confirm   # hedge mode: name the book you close
bgc position --action closeAll --category USDT-FUTURES --confirm                                # EVERY position in the category (optionally --symbol)
```
or **at your own price / partially** — an opposite-side `order --action place`:

| Mode | Position | `--side` to close | Extra param |
|------|----------|-------------------|-------------|
| One-way | Long | `sell` | `--reduceOnly yes` |
| One-way | Short | `buy` | `--reduceOnly yes` |
| Hedge | Long | `sell` | `--posSide long` |
| Hedge | Short | `buy` | `--posSide short` |

> Selling to "close" a short actually opens MORE short — use the table. Hedge mode needs `--posSide` on every order (open and close); limit orders need `--price`, market orders take none.

**TP/SL:** preset at entry — `--takeProfit` / `--stopLoss` on the opening `order --action place` (triggers default to market price; `--tpTriggerBy mark` / `--slTriggerBy mark` for mark price; limit exits via `--tpOrderType limit --tpLimitPrice ...`). Or after entry via `strategy_order --action place --category USDT-FUTURES --symbol BTCUSDT --posSide long --qty 0.01 --takeProfit ... --stopLoss ...` (then `open` / `modify` / `cancel` / `history`). Batch orders (`--orders`) support neither `reduceOnly` nor TP/SL — close and set TP/SL with single orders.

### Other gotchas

- **`--qty` units:** Spot/Margin **market BUY** = quote coin (USDT); Spot/Margin limit and market SELL = base coin; USDT-/USDC-FUTURES = base coin; COIN-FUTURES = quote coin. `--qty 100` on a spot market buy spends 100 USDT.
- **Formats:** `--reduceOnly yes|no` are lowercase strings, not booleans; symbols are `BTCUSDT`, not `BTC/USDT`.
- **Idempotency:** `order place`, `strategy_order place` and `withdraw submit` auto-generate a `clientOid` (pass your own to make a retry safe); a duplicate one fails with `25212`. The SDK auto-retries only reads and writes that carry a `clientOid`.
- **Leverage / mode:** `account_config --action setLeverage` needs `--symbol` for futures (`--coin` for margin). `setHoldingMode --holdMode one_way_mode|hedge_mode` is account-wide and can be refused (`25010`, "not allowed in the current state"). v3 has no standalone cross/isolated margin-mode switch.
- **Transfers:** UTA is one pooled account (spot + margin + futures), so there is no spot → futures transfer. `transfer_funds` moves funds between UTA and classic accounts (`--fromType` / `--toType` ∈ `spot` `p2p` `coin_futures` `usdt_futures` `usdc_futures` `crossed_margin` `isolated_margin` `uta`) and between main and sub-accounts.

## Demo / paper trading

Needs a Bitget **Demo** API key (Bitget → Demo Trading mode → Personal Center → API Key Management); export it in the same `BITGET_*` variables (there are no `BITGET_DEMO_*` ones). Add `--paper-trading` (right after `bgc`) to **every** command in the session — demo keys only work with it, live keys must not be used with it (never mix demo and live). Mutually exclusive with `--read-only`. Account reads and writes hit the demo account; public `market` prices are the real ones. With Option B, pick the vault slot whose `label` is the demo key.

```bash
bgc --paper-trading position --action info --category USDT-FUTURES
```
