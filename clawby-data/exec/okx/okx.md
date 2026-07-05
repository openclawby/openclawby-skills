# OKX — trade execution connector

Execute on **OKX** (Spot, Perp Swap, Futures, Options, Earn, Bots, plus market data, smart-money analytics & news/sentiment) via the official **`okx`** CLI, running **locally with the user's own OKX credentials**.

> Execution connector, NOT part of the Clawby data relay. Trading **moves real funds** with the user's own keys; keys never go to Clawby. (For general market analysis prefer Clawby's data interfaces; the OKX read-only commands below are handy when working OKX-specifically.)

Covers the OKX agent skills: `okx-cex-trade`, `okx-cex-market`, `okx-cex-portfolio`, `okx-cex-bot`, `okx-cex-earn`, `okx-cex-auth`, `okx-cex-smartmoney`, `okx-sentiment-tracker`.

## Prerequisite

```bash
npm install -g @okx_ai/okx-trade-cli   # provides the `okx` command
okx --version
```

## Auth (okx-cex-auth)

Either log in to your OKX account, or set API credentials as env vars:

```bash
okx auth login                          # interactive account login
# — or API key/secret/passphrase —
export OKX_API_KEY="..."
export OKX_SECRET_KEY="..."
export OKX_PASSPHRASE="..."
okx config init | show | set            # manage named profiles (~/.okx/config.toml)
```
Public market data needs no credentials. Never echo/log credentials.

## Global flags & usage

```
okx [--profile <name>] [--demo | --live] [--json] <module> <action> [--param value ...]
```
- `--demo` = simulated/paper trading; `--live` forces live. **In a demo session add `--demo` to every command.**
- `--json` for machine-readable output. `okx <module> --help` and `okx list-tools --json` give full actions + params.

## ⚠️ Safety — confirm before any real money moves

Before any order / close / transfer / leverage change / earn subscribe / bot create: summarize exactly what it does and ask the user to confirm. Prefer `--demo` when testing. Read-only queries don't need confirmation.
- **Closing swap/futures positions**: check `okx <swap|futures> positions` first for `posSide`; use `okx <swap|futures> close --instId <id> --mgnMode <isolated|cross> [--posSide long|short]` (don't just place an opposite order blindly).
- **Leverage** in isolated + hedge mode: `posSide` is required, set long and short separately.
- **Transfers/withdrawals**: show amount, accounts, (and chain/address if withdrawing) in the confirmation.

## Modules & key actions

### Trade — spot / swap / futures / option  (okx-cex-trade)
```bash
okx spot place    --instId BTC-USDT --tdMode cash --side buy --ordType limit --px 60000 --sz 0.01
okx spot cancel   --instId BTC-USDT --ordId <id>
okx spot orders   --instId BTC-USDT --status open
okx swap place    --instId BTC-USDT-SWAP --tdMode cross --side buy --posSide long --ordType market --sz 1 \
                  --tpTriggerPx 70000 --slTriggerPx 55000     # attached TP/SL
okx swap close    --instId BTC-USDT-SWAP --mgnMode cross --posSide long
okx swap leverage --instId BTC-USDT-SWAP --lever 10 --mgnMode cross
okx futures place|close|leverage ...        # same shape as swap
okx option place|positions|greeks ...
```
Each module also has `amend`, `batch`, `fills`, `get`, and `algo place|amend|cancel|trail|orders` (TP/SL, trailing, iceberg, twap, chase).

### Market data (okx-cex-market)
```bash
okx market ticker --instId BTC-USDT
okx market candles --instId BTC-USDT-SWAP --bar 1H
okx market funding-rate --instId BTC-USDT-SWAP
okx market open-interest --instType SWAP
okx market filter ...        # multi-criteria screener   ·   okx market indicator rsi BTC-USDT-SWAP
```
Also: orderbook, trades, mark-price, instruments, oi-history/oi-change, pair-spread, indicators.

### Portfolio / account (okx-cex-portfolio)
```bash
okx account balance-all          # trading + funding snapshot
okx account positions
okx account bills | fees | config | max-avail-size | max-withdrawal
okx account transfer --ccy USDT --amt 100 --from <acct> --to <acct>     # confirm first
```

### Bots (okx-cex-bot)
```bash
okx bot grid create | amend | stop | orders | details
okx bot dca  create | stop | orders | details          # confirm create/stop
```

### Earn (okx-cex-earn)
```bash
okx earn savings purchase|redeem|fixed-products|balance
okx earn onchain offers|purchase|redeem
okx earn auto-earn on|off|status   ·   okx earn dcd products|quote-and-buy
```

### Smart money (okx-cex-smartmoney)  — read-only analytics
```bash
okx smartmoney traders-by-filter
okx smartmoney signal-overview-by-filter
okx smartmoney trader-positions --authorIds <id>
```

### News & sentiment (okx-sentiment-tracker)  — read-only
```bash
okx news latest | important | by-coin --coin BTC | search --keyword "ETF"
okx news coin-sentiment --coin BTC   ·   okx news sentiment-rank   ·   okx news economic-calendar
```

Tip: discover exact params with `okx <module> <action> --help` or `okx list-tools --json`.
