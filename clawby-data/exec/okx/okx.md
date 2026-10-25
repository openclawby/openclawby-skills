# OKX — trade execution connector

Execute on **OKX** (Spot, Perp Swap, Futures, Options, Event contracts, Earn, Bots, plus market data, smart-money analytics & news/sentiment) via the official **`okx`** CLI (npm `@okx_ai/okx-trade-cli`; this guide verified against **v1.4.9**), running **locally with the user's own OKX credentials**.

> Execution connector, NOT part of the Clawby data relay. Trading **moves real funds** with the user's own keys; keys never go to Clawby. (For general market analysis prefer Clawby's data interfaces; the OKX read-only commands below are handy when working OKX-specifically.)

Covers the OKX agent skills (all current in v1.4.9): `okx-cex-trade` (spot / swap / futures / option / event contracts), `okx-cex-market`, `okx-cex-portfolio`, `okx-cex-bot` (grid / DCA / smart-portfolio), `okx-cex-earn`, `okx-cex-auth`, `okx-cex-smartmoney`, `okx-sentiment-tracker`, plus `okx-cex-skill-mp` (skills marketplace) and `earn-hunter` (earn-opportunity monitor).

## Prerequisite

```bash
npm install -g @okx_ai/okx-trade-cli   # provides the `okx` command (Node >= 18)
okx --version                          # prints e.g. "1.4.9 (<githash>)"
```
If a command below comes back "Unknown", the CLI is probably older: `okx upgrade --check`, then (with the user's OK) `okx upgrade`.

## Auth (okx-cex-auth)

Public `market` data needs no credentials; everything else (trade, account, bot, earn, event, smartmoney, news, skill) does. **Never ask for, accept or echo credentials in chat** (no `printenv`, no `okx config show --json`). Create API keys with **Read + Trade only (no Withdraw)**, ideally on a dedicated sub-account, and test with `--demo` first.

**Option A — the user's own login / credentials:**
```bash
okx auth login --site <global|eea|us|tr>   # OAuth device flow: user approves in the browser; blocks until done
okx auth login --manual --site <site>      # for AGENTS: prints {"verificationUri","userCode","expiresIn"} and exits —
                                           # show the URL + code to the user, wait for "done" (don't poll), then check status:
okx auth status --json                     # logged_in | pending | not_logged_in (+ site, scopes);  okx auth logout
# — or API key/secret/passphrase —
export OKX_API_KEY="..."
export OKX_SECRET_KEY="..."
export OKX_PASSPHRASE="..."                # all three together; env vars override config.toml
okx config init | show | set default_profile <name>   # wizard (user runs it in their own terminal) -> named profiles in ~/.okx/config.toml; pick one with --profile <name>
```
- **Site**: ask which OKX site the account is on — `global` (www.okx.com) · `eea` (my.okx.com) · `us` (app.okx.com) · `tr` (tr.okx.com); never default silently. A key/login only works on its own site; override per call with `--site` / `OKX_SITE`.
- An API key (env or profile) **always wins over OAuth** (no fallback); `okx auth login` is skipped when a profile already has an `api_key`. A bad key is fixed by replacing it, not by logging in.
- `~/.okx/config.toml` holds the secret in plaintext and the CLI doesn't restrict its permissions: `chmod 600 ~/.okx/config.toml`. `okx config show` masks the key; **`okx config show --json` prints `secret_key` and `passphrase` in cleartext — don't run it.**
- `Failed to spawn okx-auth` -> `okx auth install` (the `auth` commands use a small helper binary).

**Option B — fetch keys from the Clawby Key Vault:**
```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/okx -H "X-API-Key: $CLAWBY_API_KEY")
export OKX_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
export OKX_SECRET_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiSecret"])')
export OKX_PASSPHRASE=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["passphrase"])')
```
Field names are whatever the user stored in the vault. Trusted-IP whitelist + vault switch rules + error shapes: see `rpc/index.yaml`. Keep creds in the environment only, never on disk.
- Map the stored fields onto the three env vars (OKX needs key + secret + passphrase). A vault holds several slots, each with a `label` — pick the right one (e.g. live vs demo) rather than blindly `keys[0]`. If the fetch returns an error (403 / 404 / 401), tell the user; don't ask for keys in chat.
- Match the key's environment: a demo key needs `--demo` (or `export OKX_DEMO=1`), a live key must not have it (mismatch = OKX `50101`); non-global account -> `export OKX_SITE=eea|us|tr`.
- Exports live only in that shell: if every tool call is a fresh shell, fetch and run `okx ...` in the same command, then `unset RESP`. Env vars beat `config.toml`, so skip `okx config init` (it writes secrets to disk).

## Global flags & usage

```
okx [--profile <name>] [--demo | --live] [--json] <module> <action> [args] [--param value ...]
```
- `--demo` = simulated/paper trading (same as `OKX_DEMO=1` or a `demo = true` profile); `--live` forces live (overrides a profile's `demo = true`; can't combine with `--demo`). **In a demo session add `--demo` to every command** (on `market` queries it selects the simulated feed — omit it for live prices). Demo keys only work in demo mode, live keys only in live mode. Not available in demo: `news`, and `earn` write actions.
- `--json` machine-readable output (`--json --env` wraps it as `{env, profile, data}` so live/demo is visible); `--verbose` request/response log on stderr; `--site <global|eea|us|tr>`.
- `okx <module> [<sub>] --help` and `okx list-tools --json` give every action + params.
- **Syntax**: `market` commands take the instrument **positionally** (`okx market ticker BTC-USDT`); order/account commands use flags (`--instId`; `cancel` and `swap positions` accept either). Flags are strict — an unknown one errors (`--coins` not `--coin`; `--authorId` not `--authorIds` on `trader-positions`). A value starting with `-` needs the `=` form: `--tpOrdPx=-1`.
- Exit code `0` = success, `1` = any failure — including a batch where only some items failed (check each item's `sCode`).

## ⚠️ Safety — confirm before any real money moves

Before any order / close / transfer / leverage or position-mode change / earn subscribe / bot create / skill install: summarize exactly what it does and ask the user to confirm. Prefer `--demo` when testing. Read-only queries don't need confirmation.
- **Live or demo?** Ask if unclear, and state the active mode in every reply.
- **Sizing units** (easy to get wrong): spot **market BUY** `--sz` is the *quote* amount (USDT) by default — `--sz 100` spends 100 USDT; pass `--tgtCcy base_ccy` to size in coin. Other spot orders are in base coin. Swap/futures/option `--sz` is **contracts**: read `ctVal` from `okx market instruments --instType SWAP --instId <id>`; for a USDT figure ask whether it is notional (`--tgtCcy quote_ccy`) or margin cost (`--tgtCcy margin`). Swap/futures `--tdMode` defaults to `cross`.
- **Closing swap/futures positions**: check `okx <swap|futures> positions` first for `posSide`; use `okx <swap|futures> close --instId <id> --mgnMode <isolated|cross> [--posSide long|short]` (don't just place an opposite order blindly).
- **Leverage** in isolated + hedge mode: `posSide` is required, set long and short separately. Portfolio-margin accounts can't change cross leverage on swap/futures.
- **Attached TP/SL and algo orders**: each trigger needs its order price (`--tpOrdPx` / `--slOrdPx`; `-1` = market at trigger).
- **Transfers**: show currency, amount and from -> to accounts (`6` = funding, `18` = trading). The CLI has no withdraw-to-address command; keep Withdraw permission off the key.
- **Error-suggested fixes** that cancel orders / close positions / stop bots: report the error, diagnose with read-only queries, and wait for the user's confirmation. Never auto-remediate.
- **Verify after writes** with a read: `okx spot|swap|futures orders`, `okx swap|futures positions`, `okx event orders`.

## Modules & key actions

### Trade — spot / swap / futures / option  (okx-cex-trade)
```bash
okx spot place    --instId BTC-USDT --side buy --ordType limit --px 60000 --sz 0.01      # spot --tdMode defaults to cash
okx spot cancel   --instId BTC-USDT --ordId <id>
okx spot orders   --instId BTC-USDT                      # open orders; add --history for past ones
okx swap place    --instId BTC-USDT-SWAP --tdMode cross --side buy --posSide long --ordType market --sz 1 \
                  --tpTriggerPx 70000 --tpOrdPx=-1 --slTriggerPx 55000 --slOrdPx=-1      # attached TP/SL (-1 = market)
okx swap close    --instId BTC-USDT-SWAP --mgnMode cross --posSide long
okx swap leverage --instId BTC-USDT-SWAP --lever 10 --mgnMode cross
okx futures place|close|leverage ...        # same shape as swap (delivery contracts, instId BTC-USDT-<YYMMDD>)
okx option instruments --uly BTC-USD        # then: greeks --uly BTC-USD | place | positions | cancel | amend  (buyers --tdMode cash; sellers cross/isolated)
```
`--posSide` is needed only in hedge (long/short) position mode; `okx account config` shows the mode. Each module also has `orders`, `get`, `fills`, `amend`, `batch --action place|amend|cancel --orders '<json>'` (spot/swap/futures; option has `batch-cancel`), `positions` (swap/futures/option), `get-leverage` (swap/futures), `spot leverage` (spot margin), and `algo place|amend|cancel|orders|trail` (TP/SL, trailing, trigger, chase, iceberg, twap; option has no `trail`).

### Event contracts  (okx-cex-trade)
OKX CEX binary event contracts (Yes/No, Up/Down) — not Polymarket/Kalshi (those are Clawby relay interfaces / `exec/polymarket`). If the user's target isn't in `event browse` / `series`, say so; don't substitute. Needs credentials even to browse.
```bash
okx event browse [--underlying BTC-USD]                       # live contracts grouped by type
okx event series | events <seriesId> | markets <seriesId> --state live      # get the instId from `markets` — never guess one
okx event place <instId> <side> <outcome> <sz> [--ordType limit --px 0.55]   # side buy=open / sell=close; outcome YES|NO|UP|DOWN
okx event amend <instId> <ordId> [--px ..] [--sz ..]   ·   okx event cancel <instId> <ordId>
okx event orders [--status open|history|archive]   ·   okx event fills [--archive]   ·   okx account positions --instType EVENTS
```
`px` is the contract price 0.01–0.99 (about the implied probability), not the asset price. Market order `--sz` = quote amount; limit order `--sz` = number of contracts and `--px` is required.

### Market data (okx-cex-market)  — public, no credentials
```bash
okx market ticker BTC-USDT                               # instId is positional here
okx market candles BTC-USDT-SWAP --bar 1H [--limit 100]  # --bar is case-sensitive (1m != 1M)
okx market funding-rate BTC-USDT-SWAP [--history --limit 10]
okx market open-interest --instType SWAP
okx market filter --instType SWAP --sortBy volUsd24h --limit 20     # multi-criteria screener (price/volume/OI/funding/market cap)
okx market indicator rsi BTC-USDT-SWAP --bar 1H          # 70+ indicators: `okx market indicator list`
```
Also: `tickers <instType>`, `orderbook`, `trades`, `mark-price`, `index-ticker`, `index-candles`, `price-limit`, `instruments --instType`, `instruments-by-category --instCategory 4|5|6|7` (metals / commodities / forex / bonds), `oi-history`, `oi-change` (OI accumulation scanner), `pair-spread`.

### Portfolio / account (okx-cex-portfolio)
```bash
okx account balance-all          # trading + funding snapshot (+ valuation)
okx account positions [--instType SWAP]
okx account bills [--archive] | fees --instType SWAP | config | max-size | max-avail-size | max-withdrawal | positions-history | asset-balance | audit
okx account transfer --ccy USDT --amt 100 --from 6 --to 18        # 6=funding, 18=trading; confirm first
okx account set-position-mode --posMode <long_short_mode|net_mode>      # confirm first
```
`balance [<ccy>]` is the trading account only; `asset-balance` is funding. `max-size` / `max-avail-size` need `--instId --tdMode`. `audit` reads this CLI's local call log.

### Bots (okx-cex-bot)
```bash
okx bot grid create --instId BTC-USDT --algoOrdType grid --maxPx 100000 --minPx 80000 --gridNum 10 --quoteSz 100     # spot grid
okx bot grid create --instId BTC-USDT-SWAP --algoOrdType contract_grid --maxPx 100000 --minPx 80000 --gridNum 10 \
                    --direction neutral --lever 3 --sz 100                                                          # contract grid
okx bot grid orders --algoOrdType grid [--history]    # also: details | sub-orders [--pending] | amend | positions | liquidate-price | close-position
okx bot grid stop --algoId <id> --algoOrdType <grid|contract_grid> --instId <id> [--stopType 1|2]
okx bot dca create --algoOrdType contract_dca --instId BTC-USDT-SWAP --direction long --lever 3 --initOrdAmt 100 \
                   --safetyOrdAmt 50 --maxSafetyOrds 3 --pxSteps 0.03 --pxStepsMult 1 --volMult 1 --tpPct 0.03     # confirm create/stop
okx bot dca orders | details | sub-orders | stop | add-margin | reduce-margin | update-tp      # spot_dca also supported
okx bot smart-portfolio create | orders | details | stop | amend-rebalance | instant-rebalance | recommend-zones | zones-backtest
```
`--stopType`: 1 = sell/close everything (grid default), 2 = keep holdings/position (contract grid: then `bot grid close-position --algoId <id> --mktClose`); required for `spot_dca`. `moon_grid` is list/query only. Smart-portfolio = auto-rebalancing multi-asset basket.

### Earn (okx-cex-earn)
```bash
okx earn savings balance [<ccy>] | purchase --ccy USDT --amt 100 | redeem --ccy USDT --amt 100 | fixed-products
okx earn savings fixed-purchase --ccy USDT --amt 100 --term <term> [--confirm]     # preview only until --confirm; funds locked to maturity
okx earn onchain offers | purchase --productId <id> --ccy <ccy> --amt <n> | redeem --ordId <id> --protocolType <t> | orders | history
okx earn auto-earn status [<ccy>] | on <ccy> | off <ccy>
okx earn flash-earn projects [--status 0|100|0,100]
okx earn dcd pairs | products --baseCcy BTC --quoteCcy USDT --optType C | quote-and-buy --productId <id> --sz <n> --notionalCcy <ccy> | redeem-execute --ordId <id> | orders
```
Also: `savings set-rate | lending-history | rate-history | fixed-orders | fixed-redeem`, `onchain cancel`, `dcd order`. Earn write actions don't work in `--demo`; `dcd quote-and-buy` / `redeem-execute` execute immediately.

### Smart money (okx-cex-smartmoney)  — read-only analytics, needs credentials
```bash
okx smartmoney traders-by-filter [--period 30 --sortBy pnl --limit 10]       # leaderboard
okx smartmoney signal-overview-by-filter [--topInstruments 20 | --instCcyList BTC,ETH]   # consensus signal
okx smartmoney trader-positions --authorId <id>                              # singular --authorId
```
Also: `performance-by-trader --authorIds a,b`, `trader-positions-history`, `trader-orders-history`, `search-trader --keyword <name>`, `signal-overview-by-trader`, `signal-trend-by-filter --instCcy BTC`, `signal-trend-by-trader`. (The old composite `smartmoney trader` is gone.)

### News & sentiment (okx-sentiment-tracker)  — read-only, needs credentials
```bash
okx news latest [--coins BTC,ETH --limit 20] | important | by-coin --coins BTC | search --keyword "ETF"
okx news coin-sentiment --coins BTC [--period 24h]   ·   okx news sentiment-rank [--period 24h --sort-by hot|bullish|bearish]   ·   okx news economic-calendar [--region <r> --importance 3]
```
Also: `detail <id>`, `platforms`, `coin-trend <coin> --points 24`, `by-sentiment --sentiment bullish`, `list-regions`; `--lang zh-CN|en-US` (default en-US). Not available in `--demo`.

### Skills marketplace & utilities  (okx-cex-skill-mp)
```bash
okx skill search [--keyword <kw>] | categories | list | add <name> | download <name> | check <name> | verify <name> | remove <name>
okx upgrade --check  ·  okx diagnose [--cli|--mcp|--all]  ·  okx setup --client <claude-desktop|cursor|windsurf|vscode|claude-code>  ·  okx pilot status|install|remove
```
`skill` needs credentials; `skill add` installs third-party agent skills, so confirm with the user first. `pilot` is an auto-managed network helper; ignore unless `okx diagnose` points at it.

## Common errors

- `Unknown option '--x'` / `Missing required parameter "instId"` -> flag typo, or a `market` command given `--instId` instead of a positional instrument.
- `50101 APIKey does not match current environment` -> demo key without `--demo` (or live key with it). `50110` -> the key is IP-bound on OKX; add this machine's IP there. `50111` / `50112` / `50113` -> bad key / signature / passphrase.
- `51155` / `51734` -> region or KYC restriction: wrong `--site` for the account (don't retry).
- `No credentials found` -> set up Option A or B above.

Tip: discover exact params with `okx <module> <action> --help` or `okx list-tools --json`.
