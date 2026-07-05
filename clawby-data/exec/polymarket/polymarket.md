# Polymarket — trade execution connector

Place / cancel orders on the **Polymarket CLOB** (prediction markets, on Polygon) via the official SDK — **TypeScript `@polymarket/clob-client`** or **Python `py-clob-client`** — signing with the **user's own wallet private key**.

> Execution connector, NOT part of the Clawby data relay. This **places real orders / moves funds** with the user's own key; the key never goes to Clawby. For **read-only odds / events / order books**, use Clawby's `polymarket_*` interfaces (`api/clawby.yaml`) — don't sign anything just to read.

## Prerequisite

```bash
# TypeScript
npm install @polymarket/clob-client ethers@5.8.0
# Python
pip install py-clob-client
```
Host `https://clob.polymarket.com`, chainId `137` (Polygon).

## Auth (two-level)

L1 = EIP-712 wallet signature (derive API creds) → L2 = HMAC API key (sign trade requests). The SDK handles both.

```typescript
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";                 // v5
const signer = new Wallet(process.env.PRIVATE_KEY);   // user's key — env only
// L1: derive credentials
const creds = await new ClobClient("https://clob.polymarket.com", 137, signer).createOrDeriveApiKey();
// L2: trading client
const client = new ClobClient(
  "https://clob.polymarket.com", 137, signer, creds,
  2,                  // signatureType: 0=EOA, 1=POLY_PROXY (email/Magic), 2=GNOSIS_SAFE (most common)
  "FUNDER_ADDRESS",   // proxy/funder wallet from polymarket.com/settings
);
```
Python mirrors this (`ClobClient(host, key=pk, chain_id=137, creds=..., signature_type=2, funder=...)`).

**Secrets:** `PRIVATE_KEY` (and any creds) live in **env vars only** — never echo/log/commit them.

## ⚠️ Safety — confirm before any real money moves

Before placing, cancelling, or any on-chain action (split/merge/redeem, bridge): show the user the exact market, side, size, price and ask them to confirm. Read-only queries don't need confirmation. Verify `tickSize` and `negRisk` per market before ordering.

**One-time approvals (prerequisite to trading):** the funder must approve the Exchange — **USDC.e** allowance to BUY, **conditional-token** allowance to SELL.

## Place orders

Get per-market `tickSize` (`client.getTickSize(tokenID)`) and `negRisk` first. Price 0–1 = implied probability.

```typescript
// Limit (GTC)
await client.createAndPostOrder(
  { tokenID, price: 0.50, size: 10, side: Side.BUY },
  { tickSize: "0.01", negRisk: false }, OrderType.GTC);

// Market (FOK): BUY amount = $ to spend, SELL amount = shares; price = worst-price (slippage) limit
await client.createAndPostMarketOrder(
  { tokenID, side: Side.BUY, amount: 100, price: 0.50 },
  { tickSize: "0.01", negRisk: false }, OrderType.FOK);

// GTD (expiring): expiration = now + 60 + N seconds
// Post-only (maker, GTC/GTD only): client.postOrder(signed, OrderType.GTC, true)
// Batch: up to 15 via client.postOrders([...])
```

| Type | Behavior |
|------|----------|
| GTC | rest until filled/cancelled (default limit) |
| GTD | expire at UTC-seconds timestamp (`now+60+N`) |
| FOK | fill entirely now or cancel |
| FAK | fill what's available, cancel rest |

## Cancel (L2 auth required)

```typescript
await client.cancelOrder("0xID");              // single
await client.cancelOrders(["0xID1","0xID2"]);  // many
await client.cancelAll();                       // all
await client.cancelMarketOrders({ market: "0xCONDITION_ID", asset_id: "TOKEN_ID" });
```

## Heartbeat (if used)

If a valid heartbeat isn't received within ~10s, **all open orders are cancelled**. Post one every ~5s (first call: empty `heartbeat_id`, reuse the returned id).

## Order lifecycle & common errors

Insert status: `matched | live | delayed | unmatched`. Trade: `MATCHED → MINED → CONFIRMED` (or `RETRYING/FAILED`).
Common rejects: `INVALID_ORDER_MIN_TICK_SIZE` (price ≠ tick), `INVALID_ORDER_MIN_SIZE`, `INVALID_ORDER_NOT_ENOUGH_BALANCE` (allowance/balance), `INVALID_ORDER_EXPIRATION`, `INVALID_POST_ONLY_ORDER` (would cross).

## Advanced (on-chain, Polygon chainId 137)

Beyond CLOB orders, the repo's reference docs cover (confirm with user — these move funds on-chain):
- **CTF operations** — split / merge / redeem positions, negative-risk (multi-outcome) conversion. Contracts: CTF `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`, CTF Exchange `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`, Neg-Risk Exchange `0xC5d563A36AE78145C45a50134d48A1215220f80a`, USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`.
- **Gasless** — relayer (`relayer-v2.polymarket.com`) submits transactions without the user paying gas (builder headers).
- **Bridge** — deposits / withdrawals across chains (`bridge.polymarket.com`).

Sports markets: outstanding limit orders auto-cancel at game start; marketable orders get a 3s delay.
