# Polymarket — trade execution connector

Place / cancel orders on the **Polymarket CLOB** (prediction markets, on Polygon) via the official **unified SDK** — **TypeScript `@polymarket/client`** or **Python `polymarket-client`** — signing with the **user's own wallet private key**.

> Execution connector, NOT part of the Clawby data relay. This **places real orders / moves funds** with the user's own key; the key never goes to Clawby. For **read-only odds / events / order books**, use Clawby's `polymarket_*` interfaces (`api/clawby.yaml`) — don't sign anything just to read.

> **SDK status (checked 2026-10-25).** Use the unified SDK. Do **not** install `@polymarket/clob-client` / `py-clob-client`: the V1 clients are archived and can no longer trade — CLOB V2 went live 2026-04-28 and rejects V1-signed orders (collateral is now **pUSD**, new exchange contracts). `@polymarket/clob-client-v2`, `py-clob-client-v2` and `@polymarket/sdk` are superseded too. If `exec/index.yaml` still shows `npm install @polymarket/clob-client …`, follow this file instead. The unified SDKs are pre-1.0 (verified on 0.14.0): if a signature errors, check docs.polymarket.com/changelog/sdks.

## Prerequisite

```bash
# TypeScript — ESM package, Node >= 24
npm install @polymarket/client viem
# Python — 3.11+ (AsyncSecureClient shown below; sync SecureClient has the same methods without await)
pip install polymarket-client
```
No host/chain args: the SDK targets production (`clob.polymarket.com`, Polygon chainId `137`). Trading collateral is **pUSD** (see Advanced) — the wallet must be funded. ethers is optional and **v5 only** (`ethers-v5@npm:ethers@^5.8.0` + `@polymarket/client/ethers-v5`; there is no v6 adapter).

## Auth (two-level)

L1 = EIP-712 `ClobAuth` wallet signature → creates/derives the CLOB API creds (key / secret / passphrase). L2 = HMAC with those creds signs every trading request. `createSecureClient` / `SecureClient.create` does both — no `signatureType`, `funder` or `createOrDeriveApiKey` any more; it detects the wallet type itself (EOA 0 / Proxy 1 / Safe 2 / **Deposit Wallet 3**, the default for accounts created since 2026-05-04).

`wallet` = the address that holds the funds (polymarket.com profile menu). **Always pass it for an existing account**: omitting it targets (and may deploy) a fresh Deposit Wallet derived from the key, not a legacy Proxy/Safe account. Pass the signer's own address to trade as a plain EOA. Before trading, check the resolved `client.account.wallet` / `.walletType` (py `client.wallet`, `client.wallet_type`) is the account the user means.

**Option A — env var:**

```typescript
import { createSecureClient, OrderSide, OrderType } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";

const client = await createSecureClient({
  wallet: process.env.WALLET_ADDRESS,            // account wallet (not secret)
  signer: privateKey(process.env.PRIVATE_KEY),   // user's key — env only; must be 0x-prefixed 32-byte hex
});
```
```python
import os
from polymarket import AsyncSecureClient

client = await AsyncSecureClient.create(
    private_key=os.environ["PRIVATE_KEY"],       # user's key — env only
    wallet=os.environ["WALLET_ADDRESS"],
)
```

**Option B — fetch the wallet key from the Clawby Key Vault:**
```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/polymarket -H "X-API-Key: $CLAWBY_API_KEY")
export PRIVATE_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["privateKey"])')
```
Field name is whatever the user stored in the vault. Trusted-IP whitelist + vault switch rules + error shapes: see `rpc/index.yaml`. Keep the key in the environment only, never on disk — and note it is a **WALLET private key (can move funds)**, so extra care:
- Fetch it only when about to sign (after the user's confirmation); never echo `$RESP` (it holds the whole vault entry); `unset RESP PRIVATE_KEY` when done.
- Safer to vault a dedicated low-balance trading wallet, or a Deposit-Wallet **Session Key** (beta; scoped, cannot withdraw; same `createSecureClient` call with `wallet` = the deposit wallet — docs.polymarket.com/trading/session-keys).
- TS needs a `0x`-prefixed 32-byte hex key — add the prefix if the stored value lacks it.

**Secrets:** `PRIVATE_KEY` (and any CLOB creds) live in **env vars only** — never echo/log/commit them. Optional Relayer API key (`apiKey: relayerApiKey({ key, address })`, py `api_key=RelayerApiKey(...)`; create at polymarket.com → Settings → API Keys → Relayer) enables **gasless** wallet actions (approvals, split/merge/redeem); not needed just to place orders once approvals are in place.

## ⚠️ Safety — confirm before any real money moves

Before placing, cancelling, or any on-chain action (approvals, split/merge/redeem, transfer, bridge): show the user the exact **market, outcome, side, size, price (or $ amount), order type and wallet** and ask them to confirm. Read-only queries don't need confirmation.
- Market BUY `amount` = $ **before** fees; taker fees are charged on top (most categories; geopolitics is free) — cap the all-in cost with `maxSpend` / `max_spend`. Market orders default to **FAK** (partial fill OK); pass FOK for all-or-nothing.
- Pre-flight: market `state.acceptingOrders`; `price` on the market's tick grid and `size` ≥ min order size (`market.trading.minimumTickSize` / `minimumOrderSize`, or Clawby `polymarket_markets`: `orderPriceMinTickSize` / `orderMinSize`). The SDK resolves tick size, neg-risk and fees itself. Orders from geoblocked regions are rejected (`GET https://polymarket.com/api/geoblock` → `blocked`) — don't work around it.
- **One-time approvals (prerequisite to trading):** the account wallet must approve the exchange contracts — **pUSD** allowance to BUY, **conditional-token** allowance to SELL. `await client.setupTradingApprovals()` (py `setup_trading_approvals()`) grants whatever is missing (idempotent; an EOA pays POL gas, Deposit/Proxy/Safe wallets need the Relayer/Builder key); order placement also auto-recovers a missing exchange allowance. **CTF neg-risk markets** additionally need Neg Risk Adapter approvals that are NOT automatic (see Advanced).

## Place orders

`assetId` = the outcome's trading id: its **`positionId` on a Protocol V2 market, else the CTF `tokenId`** (= Clawby `polymarket_markets` `clobTokenIds[i]`, a JSON string — parse it). Resolve it with the SDK:

```typescript
const market = await client.fetchMarket({ slug });          // or { url } / { id }
const { yes } = market.outcomes;                            // .no for the other side
const assetId = market.version === "v2" ? yes.positionId : yes.tokenId;
```
```python
market = await client.get_market(slug=slug)
yes = market.outcomes.yes
asset_id = yes.position_id if market.version == "v2" else yes.token_id
```

Price 0–1 = implied probability (pass decimal strings).

```typescript
// Limit — GTC; add `expiration` (unix s) for GTD, `postOnly: true` for maker-only
const r = await client.placeLimitOrder({ assetId, side: OrderSide.BUY, price: "0.52", size: "10" });

// Market — BUY: amount = $ to spend + maxPrice; SELL: shares + minPrice (slippage bounds)
const m = await client.placeMarketOrder({
  assetId, side: OrderSide.BUY, amount: "10", maxPrice: "0.55", orderType: OrderType.FOK });
if (!m.ok) throw new Error(`${m.code}: ${m.message}`);     // always check ok
const hashes = await client.waitForOrderFillSettlement(m);   // optional — settlement is async
```
```python
r = await client.place_limit_order(asset_id=asset_id, side="BUY", price="0.52", size="10")   # + expiration=, post_only=True
m = await client.place_market_order(
    asset_id=asset_id, side="BUY", amount="10", max_price="0.55", order_type="FOK")          # SELL: shares=, min_price=
if not m.ok:
    raise RuntimeError(f"{m.code}: {m.message}")
hashes = await client.wait_for_order_fill_settlement(m)
```

Batch (1–15, each result has its own `ok`): sign first, post together — `client.postOrders([await client.createLimitOrder({...}), ...])` (py `create_limit_order` → `post_orders`).

| Type | How | Behavior |
|------|-----|----------|
| GTC | `placeLimitOrder` | rest until filled/cancelled (default limit) |
| GTD | `placeLimitOrder` + `expiration` | expire at a UTC-seconds timestamp ≥ now+3 min; the order lapses 60 s *before* it, so lifetime N s = `now + 60 + N` (N ≥ ~120) |
| FOK | `placeMarketOrder`, `orderType: FOK` | fill entirely now or cancel |
| FAK | `placeMarketOrder` (default) | fill what's available, cancel the rest |
| Post-only | `postOnly: true` on GTC/GTD | rejected if it would cross the book (maker only) |

## Cancel (L2 auth required)

L2 creds come with the client. A result lists `canceled` and `notCanceled` (id → reason; py `not_canceled`) — reconcile before retrying.

```typescript
await client.cancelOrder({ orderId: "0xID" });                  // single
await client.cancelOrders({ orderIds: ["0xID1", "0xID2"] });    // many (≤ 3000)
await client.cancelMarketOrders({ market: "0xCONDITION_ID" });  // whole market; or { assetId } for one outcome
await client.cancelAll();                                       // every open order on this API key
```
```python
await client.cancel_order(order_id="0xID")
await client.cancel_orders(order_ids=["0xID1", "0xID2"])
await client.cancel_market_orders(market="0xCONDITION_ID")      # or asset_id=
await client.cancel_all()
```
Cancelling a partial fill removes only the unfilled remainder. Cancels still work in cancel-only mode, but not while a marketable order sits in its delay window. Verify afterwards: `fetchOrder({ orderId })`, `listOpenOrders({ market?, assetId? })` (paginator), `listAccountTrades()` (py `get_order`, `list_open_orders`).

## Heartbeat (if used)

⚠️ The **first accepted heartbeat arms cancel-all for ALL open orders on that API key** (every market and process), and there is **no disarm**: if sends stop for 10 s — loop ends, process dies, client closed — the orders are cancelled (best effort). Don't send even a "test" heartbeat unless you will keep a loop running every ~5 s (one sender per key, await each send, keep the returned id).

```typescript
let id = "";                                                       // first send: empty id
const hb = await client.sendOrderHeartbeat({ heartbeatId: id });  id = hb.heartbeatId;
// OrderHeartbeatMismatchError → retry once with error.heartbeatId
```
```python
hb = await client.send_order_heartbeat(heartbeat_id=hid)           # hid starts ""; keep hb.heartbeat_id
# OrderHeartbeatMismatchError → retry once with error.heartbeat_id
```
To stop cleanly: stop placing orders, cancel what you want gone, verify, then end the loop.

## Order lifecycle & common errors

Insert status: `live | matched | delayed | unmatched`. `delayed` = accepted but not matched yet (markets with `trading.secondsDelay`, e.g. sports; some crypto up/down markets have a short taker delay) — pending and not cancellable; follow it on the `user` stream. Trade: `MATCHED → MINED → CONFIRMED` (or `RETRYING/FAILED`).

Rejects come back as `ok: false` with `code` / `message`:
- `not enough balance / allowance` — pUSD / outcome-token balance or approval; names the missing spender (Neg Risk Adapter → Advanced).
- `… breaks minimum tick size rule` (price ≠ tick) · `… lower than the minimum` (size) · `invalid expiration` · `invalid post-only order: order crosses book`.
- FOK: `order couldn't be fully filled…` · FAK: `no orders found to match…`.
- `address … in closed only mode` — only position-reducing orders (`fetchClosedOnlyMode()` / py `get_closed_only_mode()`).
- Request-level rejects **throw** `RequestRejectedError` (`.restriction`, `.retryAfter`; py `.retry_after`): HTTP 425 / `"restarting"` = matching-engine restart → wait `retryAfter` (else back off 1 s → 30 s), then for ~2 min only post-only orders are accepted (`"post_only"`, 503 `post_only_mode`); 503 cancel-only / trading disabled → pause new orders; 429 → exponential backoff; 500 `order timed out` → safe to resubmit.

## Advanced (on-chain, Polygon chainId 137)

Beyond CLOB orders (confirm with user — these move funds on-chain):
- **Positions** — `splitPosition({ conditionId, amount })`, `mergePositions({ conditionId, amount: "max" })`, `redeemPositions({ conditionId })` (py `split_position` / `merge_positions` / `redeem_positions`; each returns a handle → `.wait()`; `amount` in 6-decimal base units, `1_000_000n` = 1 pUSD). V2 neg-risk: `horizontalSplit` / `horizontalMerge` / `convert`. Gasless wallets go through the relayer (`relayer-v2.polymarket.com`, Relayer or Builder API key); an EOA pays POL gas.
- **Collateral = pUSD** `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (6 decimals, USDC-backed). Wrap USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` → pUSD with CollateralOnramp `0x93070a847efEf7F70739046A929D47a521F5B8ee` `wrap(asset, to, amount)` — approve the *Onramp*, not pUSD. Bridge deposits auto-wrap.
- **CTF neg-risk approvals** (not done by `setupTradingApprovals`): `approveErc20` (pUSD) + `approveErc1155ForAll` (Conditional Tokens) to the Neg Risk Adapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`.
- **Contracts** (docs.polymarket.com/resources/contracts): Conditional Tokens `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` · CTF Exchange `0xE111180000d2663C0091e4f400237545B87B996B` · Neg Risk CTF Exchange `0xe2222d279d744050d28e00520010520000310F59` · ExchangeV3 (Protocol V2) `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` · PositionManager `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF` · Router `0x12121212006e4CD160D18e3f00711DA5c3372600`. The old V1 exchange addresses (`0x4bFb…`, `0xC5d5…`) and USDC.e collateral are superseded — don't approve them.
- **Bridge** — deposits / withdrawals across chains (`bridge.polymarket.com`; deposits arrive as pUSD).

Sports markets: resting limit orders are auto-cancelled at the official game start (start times can shift — watch your orders); marketable orders may be held for the market's `trading.secondsDelay`.
