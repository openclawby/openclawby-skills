# Binance — trade execution connector

Execute trades on **Binance** (Spot, USDⓈ-M / COIN-M Futures, Margin, Convert, Options, Earn, Wallet…) via the official **`binance-cli`**, running **locally with the user's own Binance API keys**.

> This is an **execution** connector, NOT part of the Clawby data relay. Clawby supplies market **data** (`crypto` interfaces in `api/clawby.yaml`); this connector **places real orders / moves funds** with the user's own credentials. Orders are signed locally and go straight to Binance, never through Clawby (Option B below only *reads* the user's own keys from their Key Vault).

## Prerequisite

`binance-cli` must be installed (`binance-cli --version`). Two builds exist; the commands below work on both, differences are marked **(v2)** / **(v1)**.

**v2.x — official build** (Rust binary, no Node needed; macOS + Linux, x64 / arm64):

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/binance/binance-cli/releases/latest/download/binance-cli-installer.sh | sh
. "$HOME/.cargo/env"       # load the new PATH entry into the current shell
binance-cli --version      # verify
```

The installer writes `~/.cargo/bin/binance-cli` and appends a PATH line to the shell profile (opt out: `BINANCE_CLI_NO_MODIFY_PATH=1`) — tell the user before running it.

**v1.x — legacy npm build** (`@binance/binance-cli`, last npm release 1.3.0; needs Node 20.19+ or 22.13+). Use it on Windows (v2.1+ ships no Windows binary):

```bash
npm install -g @binance/binance-cli
```

Moving from the npm build to v2: `npm uninstall -g @binance/binance-cli` first (Binance's instruction) so the two don't shadow each other.

## Auth

Credentials come from **environment variables**, the **Clawby Key Vault**, or a named **profile** — never hardcoded, never sent anywhere but Binance. Use a key with only the permissions needed (leave withdrawal off unless required) and an IP restriction; `testnet` / `demo` need their own keys from Binance's testnet / demo sites.

**Option A — environment variables** (simplest):

```bash
export BINANCE_API_KEY=...        # API key
export BINANCE_SECRET_KEY=...     # API secret, or a private key (file path or PEM content)
export BINANCE_API_ENV=prod       # prod | testnet | demo  (default prod)
```

**Option B — fetch keys from the Clawby Key Vault** (instead of exporting by hand):
```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/binance -H "X-API-Key: $CLAWBY_API_KEY")
export BINANCE_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
export BINANCE_SECRET_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiSecret"])')
```
Field names are whatever the user stored in the vault. If the user set a trusted-IP whitelist this machine's IP must be on it and the vault retrieval switch must be ON; full error shapes: `rpc/index.yaml`. Keep creds in the environment only, never on disk.

**Option C — named profiles** (the secret is stored in plaintext in the CLI's config dir, so prefer A / B):

```bash
binance-cli profile create --name <name> --api-key <key> --api-secret <secret> --env <prod|testnet|demo> [--select] [-f]   # --select activates it, -f overwrites
binance-cli profile create -i                  # prompts for each value — user runs it in their own terminal (secret stays out of history / logs)
binance-cli profile select --name <name>       # alias: change
binance-cli profile list | view                # list marks the active profile with *
binance-cli profile delete --names <name> [<name2> ...]
```

Append `--profile <name>` to any command to override the active profile. **Precedence: `--profile` > env keys (when both `BINANCE_API_KEY` and `BINANCE_SECRET_KEY` are set) > active profile** — exported / vault keys silently override a selected testnet profile, so with A / B always set `BINANCE_API_ENV` explicitly; with a profile, leave the two key vars unset.

**Security rules (must follow):**
- Never run `printenv` / `env` / bare `export` / source a secrets file.
- Never `grep` env files without anchoring (`^VARNAME=`).
- Never echo, log, or disclose raw credentials or key-file locations.

## ⚠️ Safety — confirm before any real money moves

Any order, transfer, withdrawal, borrow / repay, Earn subscribe / redeem, Convert accept, or position / leverage / margin-mode change on `prod` affects **real funds**. Before executing such a command:
1. Show the user the **exact command** you are about to run.
2. Ask them to type **`CONFIRM`**.
3. Only then run it. When unsure, rehearse first: `spot order-test` / `futures-usds test-order` validate an order without sending it to the matching engine, or use testnet (`BINANCE_API_ENV=testnet` or a testnet profile).

Withdrawals (`wallet withdraw`): restate coin, amount, **network** and destination address verbatim in the prompt — a wrong network or address is irreversible.

Read-only queries (account/balances/market) don't need confirmation.

## Usage

```
binance-cli <group> <endpoint> [--param value ...]
```
- `--help` works at every level: `binance-cli`, `binance-cli spot`, `binance-cli spot new-order --help`.
- Read both **stdout and stderr**.
- Flags take raw API values (`--interval 1h`, `--type LIMIT`, `--side BUY`, `--reduce-only true`). Don't use `-i` (interactive prompts) in agent shells.
- Params can also be passed as `--json '{"symbol":"BTCUSDT","side":"BUY","type":"MARKET","quantity":"0.001"}'` (camelCase API names, numbers as strings) or as the same JSON piped on stdin. A non-TTY stdin is always read as params — if a command hangs in a headless shell, add `< /dev/null`.
- Timestamps (`--start-time` / `--end-time`) are Unix **ms**. Authenticated calls accept `--recv-window <ms>` (≤ 60000).
- For any endpoint not wrapped by a group, use the generic passthrough:
  `binance-cli request GET|POST|PUT|DELETE <url> [--signed] [--param value ...]`  — **(v2)** put `--signed` / `--profile` / `--time-unit` before the extra params.

### Command groups

`spot`, `margin-trading`, `futures-usds` (USDⓈ-M), `futures-coin` (COIN-M), `derivatives-trading-options`, `derivatives-trading-portfolio-margin`(`-pro`) **(v1 names: `derivatives-options`, `derivatives-portfolio-margin`(`-pro`))**, `convert`, `wallet`, `sub-account`, `simple-earn`, `staking`, `dual-investment`, `crypto-loan`, `vip-loan`, `algo`, `copy-trading`, `c2c`, `fiat`, `pay`, `gift-card`, `mining`, `rebate`, `alpha`, plus **(v2 only)** `stocks` (US equities / tokenized stocks) and `w3w-prediction` (Web3 Wallet prediction markets), and `*-streams` variants for websockets (`spot-streams`, `futures-usds-streams`, …). Run `binance-cli <group> --help` for that group's endpoints and params.

Streams run until interrupted — bound them: `binance-cli spot-streams agg-trade --symbol btcusdt --stream-limit 5` (`--stream-limit <n messages>` / `--stream-duration <ms>`, `--pretty` for indented JSON).

### Common examples

```bash
# Account / balances (read-only)
binance-cli spot get-account --omit-zero-balances
binance-cli wallet --help                               # deposit/withdraw/transfer endpoints
binance-cli futures-usds account-information-v3         # USDⓈ-M account (futures has no `get-account`)
binance-cli futures-usds futures-account-balance-v3     # USDⓈ-M balances
binance-cli futures-usds position-information-v3 --symbol BTCUSDT

# Market data (read-only; prefer Clawby's data relay for analysis)
binance-cli spot ticker-price --symbol BTCUSDT
binance-cli spot klines --symbol BTCUSDT --interval 1h --limit 100

# Spot dry run (safe): validated, never sent to the matching engine
binance-cli spot order-test --symbol BTCUSDT --side BUY --type MARKET --quantity 0.001

# Spot order  ⚠️ real money on prod → CONFIRM first
binance-cli spot new-order --symbol BTCUSDT --side BUY --type MARKET --quantity 0.001
binance-cli spot new-order --symbol BTCUSDT --side BUY --type LIMIT --time-in-force GTC --price 50000 --quantity 0.001
binance-cli spot delete-order --symbol BTCUSDT --order-id 123456
binance-cli spot get-open-orders --symbol BTCUSDT

# USDⓈ-M futures  ⚠️ CONFIRM first
binance-cli futures-usds change-initial-leverage --symbol BTCUSDT --leverage 5
binance-cli futures-usds new-order --symbol BTCUSDT --side BUY --type MARKET --quantity 0.01        # hedge mode: also --position-side LONG|SHORT
binance-cli futures-usds new-algo-order --algo-type CONDITIONAL --symbol BTCUSDT --side SELL --type STOP_MARKET --trigger-price 60000 --close-position true   # stop-loss / take-profit / trailing stop
binance-cli futures-usds cancel-algo-order --algo-id 123456
binance-cli futures-usds test-order --symbol BTCUSDT --side BUY --type MARKET --quantity 0.01       # dry run (safe)

# Convert (quote → accept)  ⚠️ CONFIRM the accept step
binance-cli convert send-quote-request --from-asset USDT --to-asset BTC --from-amount 10    # returns quoteId + rate; valid 10s by default (--valid-time 30s|1m)
binance-cli convert accept-quote --quote-id <quoteId>
```

### Gotchas

- **Futures stop-loss / take-profit / trailing stop** are conditional orders placed via `futures-usds new-algo-order --algo-type CONDITIONAL --type STOP_MARKET|TAKE_PROFIT_MARKET|STOP|TAKE_PROFIT|TRAILING_STOP_MARKET`, not `new-order`. Cancel with `cancel-algo-order`.
- **Futures position mode**: hedge mode requires `--position-side LONG|SHORT` on every order; `--reduce-only true` is one-way mode only (close = opposite `--side` + `--reduce-only true`).
- **Convert** is two-step: show the quoted rate to the user, then `accept-quote` only after CONFIRM, before the quote expires.

Tip: discover exact endpoint names and parameters with `--help` rather than guessing.

<!-- Verified 2026-10-25 against binance-cli v2.2.0 (GitHub release 2026-10-20, Rust) and @binance/binance-cli v1.3.0 (npm, 2026-06-04). -->
