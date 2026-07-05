# GMGN — on-chain DEX trade-execution connector

Execute on-chain DEX trades (memecoin **swap**, multi-wallet swap, limit/strategy orders, and token **launch/create**) via the official **`gmgn-cli`**, running **locally with the user's own GMGN credentials**.

> Execution connector — **not** part of the Clawby data relay. Swaps / order creation / token launches **move real funds**; the signing key stays local and never goes to Clawby.

## Routing — queries vs execution (IMPORTANT)

- **Read-only DEX / memecoin queries → use the Clawby data relay** (the `dex_*` interfaces: `dex_token_info`, `dex_token_security`, `dex_trending`, `dex_wallet_stats`, `dex_new_launches`, …). That is the default for token info, security, holders, trending, wallets, signals, quotes, etc.
- **Execution → use this connector** (`gmgn-cli`): `swap`, `multi-swap`, `order strategy …`, `cooking create`.
- Only fall back to `gmgn-cli`'s own **query** subcommands (`token …`, `market …`, `portfolio …`, `track …`) when the **user explicitly asks to use the GMGN executor for queries** (e.g. needs a field the relay doesn't expose, or wants to run it against their own bound account).

## Prerequisite

```bash
npm install -g gmgn-cli      # provides the `gmgn-cli` command
gmgn-cli --version
```

## Auth

Config lives in `~/.config/gmgn/.env` (global, recommended) or a project `.env`:

```bash
# Required for everything:
GMGN_API_KEY=gmgn_xxx                 # apply at the GMGN AI page
# Required only for execution / signed commands (swap, orders, cooking create, holdings, follow-wallet):
GMGN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n<base64>\n-----END PRIVATE KEY-----\n"
```

- `GMGN_PRIVATE_KEY` is a **request-signing key** (Ed25519 or RSA PEM), NOT a blockchain wallet key. Keep it secret; `chmod 600` the file; never echo/commit it.
- The `--from` / wallet in execution commands must be a wallet **bound to the API Key** (else `TRADE_WALLET_MISMATCH`).
- All commands accept `--raw` for single-line JSON.

## ⚠️ Safety — confirm before any funds move

Before any `swap`, `multi-swap`, `order strategy create/cancel`, or `cooking create`: summarize exactly what it does (chain, tokens, amount, wallet, fees) and **ask the user to confirm**. Read-only queries need no confirmation.

## Execution commands

### Swap (needs GMGN_PRIVATE_KEY)
```bash
gmgn-cli swap --chain sol --from <wallet> \
  --input-token So11111111111111111111111111111111111111112 \
  --output-token <token_mint> \
  --amount <raw_amount|--percent 50> \
  --slippage 30 [--anti-mev] [--priority-fee 0.0001] [--tip-fee 0.0001] \
  [--condition-orders '<json>'] [--raw]
```
- `--amount` is raw smallest-unit (SOL = lamports, 1 SOL = 1e9); or `--percent` (non-currency input only).
- SOL fees: `--priority-fee` / `--tip-fee`. EVM fees: `--gas-price` (gwei) or EIP-1559 `--max-fee-per-gas` / `--max-priority-fee-per-gas`.
- Attach TP/SL after the buy via `--condition-orders` (JSON): e.g. `[{"order_type":"profit_stop","side":"sell","price_scale":"100","sell_ratio":"100"},{"order_type":"loss_stop","side":"sell","price_scale":"50","sell_ratio":"100"}]`. Only `order_type/side/price_scale/sell_ratio` allowed per condition.
- Returns `order_id` + `hash` + `confirmation.state`. Poll with `order get`.

### Multi-wallet swap (needs GMGN_PRIVATE_KEY)
```bash
gmgn-cli multi-swap --chain sol --accounts <addr1>,<addr2> \
  --input-token <in> --output-token <out> \
  --input-amount '{"<addr1>":"1000000000","<addr2>":"500000000"}' --slippage 30 [--raw]
```
Up to 100 wallets (all bound to the API Key); each executes independently. Returns a per-wallet result array.

### Order status (needs GMGN_PRIVATE_KEY)
```bash
gmgn-cli order get --chain sol --order-id <id> [--raw]
gmgn-cli order quote --chain sol --from <wallet> --input-token <in> --output-token <out> --amount <raw> --slippage 30   # quote is API-key-only (or use relay dex_swap_quote)
```

### Limit / strategy orders (needs GMGN_PRIVATE_KEY)
```bash
gmgn-cli order strategy create --chain sol --from <wallet> \
  --base-token <token> --quote-token <quote> \
  --order-type limit_order --sub-order-type buy_low \
  --check-price <price> --amount-in <raw> --priority-fee 0.0001 --tip-fee 0.0001 [--raw]
gmgn-cli order strategy list   --chain sol [--type open|history] [--raw]
gmgn-cli order strategy cancel --chain sol --from <wallet> --order-id <id> [--raw]
```
Chain-specific required fees: SOL → `--priority-fee` + `--tip-fee`; BSC → `--gas-price`; ETH/BASE → none.

### Launch / create a token (needs GMGN_PRIVATE_KEY)
```bash
gmgn-cli cooking create --chain sol --dex pump --from <wallet> \
  --name "My Token" --symbol MYT --buy-amt 0.01 \
  --image-url <url> --auto-slippage [--twitter <url>] [--raw]
```
`--dex` per chain: `pump` / `bonk` / `bags` (sol), `fourmeme` / `flap` (bsc), `klik` / `clanker` (base). Asynchronous — poll `order get` with the returned `order_id` if `status = pending`.

### Signed portfolio/track reads (needs GMGN_PRIVATE_KEY — these read the API-Key-bound account)
```bash
gmgn-cli portfolio holdings --chain sol --wallet <wallet> [--raw]     # your bound wallet's holdings
gmgn-cli track follow-wallet --chain sol [--wallet <addr>] [--raw]     # trades from wallets you follow
```

## Notes

- Rate limits: leaky-bucket (rate=10, cap=10). `429` with `X-RateLimit-Reset`; the CLI auto-retries short read-only cooldowns. Don't hammer during a ban (extends it).
- Discover exact params for any command with `gmgn-cli <group> <action> --help`.
- For **analysis / screening**, prefer the Clawby `dex_*` relay interfaces (cheaper, no private key, already redacted) — reserve `gmgn-cli` for actually placing trades / launching tokens.
