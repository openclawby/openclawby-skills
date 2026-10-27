# LI.FI Earn — DeFi yield vaults & wallet positions

The Earn Data API finds **yield vaults** (Aave, Morpho, …) by chain / asset / protocol with APY
and TVL, and reads a **wallet's live DeFi positions**. Read-only data. Different host:
**`https://earn.li.fi/v1`** (not `li.quest`). A LI.FI key is recommended here (keyless is
rate-limited to ~50/min); send it the same way (`x-lifi-api-key`, shown as `"${H[@]}"`).

> This is **discovery/analytics**. To actually *deposit* into a vault, either use `exec/baw`'s
> `defi` commands (stake/LP/lend), or bridge-and-deposit via the cross-chain zap
> (`POST /quote/contractCalls`, see `swap-bridge.md`) and sign with the wallet (`execute.md`).

## GET /v1/vaults — search vaults

| Param | Meaning |
|---|---|
| `chainId` | Numeric EVM chain id (`1` eth, `8453` base, …). **Named `chainId`, not `chain`.** |
| `asset` | Underlying token symbol, e.g. `USDC` (matches `underlyingTokens[].symbol`). |
| `protocol` | Protocol filter, e.g. `morpho`, `aave-v3` (examples use slugs). |
| `minTvlUsd` | Exclude vaults below this USD TVL. |
| `isTransactional` | `true` = vaults Composer can deposit to / withdraw from programmatically. |
| `isRedeemable` | `true` = currently accepts withdrawals. |
| `isComposerSupported` | `true` = full Composer support for cross-chain deposits. |
| `sortBy` | `apy` or `tvl` (descending). |
| `limit` | 1–100 (default 50). |
| `cursor` | `nextCursor` from the previous page. |

```bash
# highest-TVL USDC vaults on Base
curl -s "${H[@]}" "https://earn.li.fi/v1/vaults?chainId=8453&asset=USDC&sortBy=tvl&limit=10"
```

**Response** `{ data: [vault], nextCursor, total }`. Each vault:

```jsonc
{
  "address": "0x7bfa7c4f…cbf34a",
  "chainId": 8453,
  "name": "SPARKUSDC",
  "protocol": { "name": "morpho", "logoUri": "…", "url": "…" },
  "underlyingTokens": [ { "address":"0x8335…2913", "symbol":"USDC", "decimals":6, "weight":1 } ],
  "analytics": {
    "apy": { "total": 4.34, "base": …, "reward": …, "apy1d": …, "apy7d": …, "apy30d": … },  // percent
    "tvl": { "usd": "481134516", "native": "…" }
  }
}
```

`apy.total` is a **percent** (`4.34` = 4.34%). `tvl.usd` is a string. Paginate by passing
`nextCursor` back as `cursor` until it comes back empty.

## GET /v1/vaults/{chainId}/{address} — one vault

Path params `chainId` (int) + `address` (`0x` + 40 hex). Same object shape as a list item.
`400` malformed id/address · `404` no such vault.

```bash
curl -s "${H[@]}" "https://earn.li.fi/v1/vaults/8453/0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a"
```

## GET /v1/portfolio/{address}/positions — a wallet's DeFi positions

Path param `address` (`0x` + 40 hex). Response `{ positions: [...] }`; each position:
`chainId`, `address` (vault/pool), `protocolName`, `asset {address,name,symbol,decimals}`,
`balanceUsd`, `balanceNative` (strings). Empty `positions` = the wallet holds none that the API
covers. `400` = invalid address.

```bash
curl -s "${H[@]}" "https://earn.li.fi/v1/portfolio/$WALLET/positions"
```

## GET /v1/chains · /v1/protocols — coverage

- `/v1/chains` → `[ { chainId, name, networkCaip } ]` — chains that have Earn vaults (≈17 live).
  **Earn-only**; for swap/bridge chains use `li.quest`'s `/chains` (`discovery.md`).
- `/v1/protocols` → `[ { name, logoUri, url } ]` — protocols that currently have vaults.

```bash
curl -s "${H[@]}" "https://earn.li.fi/v1/protocols"
```

**Errors** (Earn): `400` bad params · `404` not found · `429` rate limit · `500`. Body
`{ statusCode, message }`.
