# Binance — trade execution connector

Execute trades on **Binance** (Spot, USDⓈ-M / COIN-M Futures, Margin, Convert, Options, Earn, Wallet…) via the official **`binance-cli`**, running **locally with the user's own Binance API keys**.

> This is an **execution** connector, NOT part of the Clawby data relay. Clawby supplies market **data** (`crypto` interfaces in `api/clawby.yaml`); this connector **places real orders / moves funds** with the user's own credentials. Keys never go to Clawby.

## Prerequisite

`binance-cli` must be installed:

```bash
npm install -g @binance/binance-cli
binance-cli --help            # verify
```

## Auth

Credentials come from **environment variables** or a named **profile** — never hardcoded, never sent anywhere but Binance.

```bash
# Env vars (simplest)
export BINANCE_API_KEY=...        # API key
export BINANCE_SECRET_KEY=...     # API secret / private key
export BINANCE_API_ENV=prod       # prod | testnet | demo  (default prod)

# Or named profiles
binance-cli profile create --name <name> --api-key <key> --api-secret <secret> --env <prod|testnet|demo>
binance-cli profile select --name <name>
binance-cli profile list | view
```

Append `--profile <name>` to any command to override the active profile.

**Security rules (must follow):**
- Never run `printenv` / `env` / bare `export` / source a secrets file.
- Never `grep` env files without anchoring (`^VARNAME=`).
- Never echo, log, or disclose raw credentials or key-file locations.

## ⚠️ Safety — confirm before any real money moves

Any order, transfer, withdrawal, or position change on `prod` moves **real funds**. Before executing such a command:
1. Show the user the **exact command** you are about to run.
2. Ask them to type **`CONFIRM`**.
3. Only then run it. When unsure, prefer `--env testnet` first.
Read-only queries (account/balances/market) don't need confirmation.

## Usage

```
binance-cli <group> <endpoint> [--param value ...]
```
- `--help` works at every level: `binance-cli`, `binance-cli spot`, `binance-cli spot new-order --help`.
- Read both **stdout and stderr**.
- Timestamps (`--start-time` / `--end-time`) are Unix **ms**. Authenticated calls accept `--recv-window <ms>` (≤ 60000).
- For any endpoint not wrapped by a group, use the generic passthrough:
  `binance-cli request GET|POST|PUT|DELETE <url> [--signed] [--param value ...]`

### Command groups

`spot`, `margin-trading`, `futures-usds` (USDⓈ-M), `futures-coin` (COIN-M), `derivatives-options`, `derivatives-portfolio-margin`(`-pro`), `convert`, `wallet`, `sub-account`, `simple-earn`, `staking`, `dual-investment`, `crypto-loan`, `vip-loan`, `algo`, `copy-trading`, `c2c`, `fiat`, `pay`, `gift-card`, `mining`, `rebate`, `alpha`, plus `*-streams` variants for websockets. Run `binance-cli <group> --help` for that group's endpoints and params.

### Common examples

```bash
# Account / balances (read-only)
binance-cli spot get-account --omit-zero-balances
binance-cli wallet --help                       # deposit/withdraw/transfer endpoints
binance-cli futures-usds get-account            # futures account

# Market data (read-only; prefer Clawby's data relay for analysis)
binance-cli spot ticker-price --symbol BTCUSDT
binance-cli spot klines --symbol BTCUSDT --interval 1h --limit 100

# Spot order  ⚠️ real money on prod → CONFIRM first
binance-cli spot new-order --symbol BTCUSDT --side BUY --type MARKET --quantity 0.001
binance-cli spot new-order --symbol BTCUSDT --side BUY --type LIMIT --time-in-force GTC --price 50000 --quantity 0.001
binance-cli spot delete-order --symbol BTCUSDT --order-id 123456
binance-cli spot get-open-orders --symbol BTCUSDT

# USDⓈ-M futures  ⚠️ CONFIRM first
binance-cli futures-usds new-order --symbol BTCUSDT --side BUY --type MARKET --quantity 0.01

# Convert (quote → accept)  ⚠️ CONFIRM the accept step
binance-cli convert --help
```

Tip: discover exact endpoint names and parameters with `--help` rather than guessing.
