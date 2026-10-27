# LI.FI — cross-chain bridge & DEX aggregator (BYOK optional)

LI.FI finds the best route to **swap or bridge any token to any token across 65+ EVM chains
and Solana**, aggregating 37 bridges and 40 DEX/exchanges. You ask for a quote; LI.FI returns
the expected output, costs, and a ready-to-sign **`transactionRequest`**. Signing and
broadcasting happen with the **user's own wallet** (`exec/baw`) — LI.FI never holds funds, and
nothing here is routed through Clawby or billed as Clawby credits.

It also exposes a **DeFi Earn API** (`earn.li.fi`): searchable yield vaults (APY/TVL across
Aave, Morpho, etc.) and a wallet's live DeFi positions.

## Two hosts, one key

| Host | What |
|---|---|
| `https://li.quest/v1` | quotes, routes, transfer status, chain/token/tool discovery, gas |
| `https://earn.li.fi/v1` | DeFi yield vaults, protocols, wallet positions |

**Key is OPTIONAL.** Every endpoint answers with no key at a lower rate limit
(`/quote` 75 / 2h keyless vs 100 RPM with a key). If the user stored a LI.FI key in their
Clawby Key Vault under slug **`lifi`**, fetch it once and send it as the header
`x-lifi-api-key: <key>`; a `404 not_found` from the vault just means "no key" — fall back to
keyless, don't abort. Verify a key with `GET /v1/keys/test`. Full auth + limits: `_index.yaml`.

```bash
# fetch the optional key (once per session; keep in a shell var, never write to disk)
LIFI_KEY="$(curl -s https://api.openclawby.com/api/vault/lifi -H "X-API-Key: $CLAWBY_API_KEY" \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("keys") or [{}])[0].get("fields",{}).get("apiKey",""))' 2>/dev/null)"
H=(); [ -n "$LIFI_KEY" ] && H=(-H "x-lifi-api-key: $LIFI_KEY")   # add "${H[@]}" to every curl
```

## The end-to-end flow (swap / bridge)

1. **Resolve** chain IDs and token addresses (`discovery.md`): numeric chain IDs always, token
   address via `/tokens` or `/token`. Use the user's real wallet address (`baw wallet address`)
   as `fromAddress` so the returned tx is theirs to sign.
2. **Quote** (`swap-bridge.md`): `GET /quote` → one route with `estimate` (toAmount, toAmountMin,
   approvalAddress, fees, gas) and `transactionRequest`. Need options/comparison? `POST
   /advanced/routes` → pick one → `POST /advanced/stepTransaction` per step for its tx data.
3. **Execute** (`execute.md`): ERC-20 `fromToken` → approve `estimate.approvalAddress` for
   `fromAmount` first (native `fromToken` skips this); then sign+broadcast `transactionRequest`
   with `exec/baw`. **risk: high → restate the route and get the user's `CONFIRM`.**
4. **Track** (`status.md`): for a cross-chain transfer, poll `GET /status` until `DONE` — the
   source-chain receipt alone does not mean the funds arrived on the destination.

## Read vs execute (the safety line)

- **Read-only (free, no confirmation):** quotes, routes, status, all discovery, all Earn data.
  A quote returns an *unsigned* payload — producing it moves nothing.
- **Execute (risk: high, confirm every time):** signing and broadcasting a `transactionRequest`
  (or an approval tx). This is done by the user's wallet in `exec/baw`, per the standard
  `risk: high` rule in SKILL.md — restate venue · chains · tokens (full addresses) · amounts ·
  bridge/tool · `toAmountMin`, show the exact command, require a typed `CONFIRM`.

## Conventions (don't skip — confirmed live)

- **Chain params = numeric chain IDs** (1/42161/8453/56/137/10/4663/…). `/quote` and `/status`
  reject upper-case aliases (`ARB`, `BASE`) with error 1011; `/connections` silently returns 0.
- **Native coin** = `0x0000000000000000000000000000000000000000` (⚠️ baw's native sentinel is
  the *other* one, `0xEeee…EEeE` — see `execute.md`).
- **Amounts** are smallest-unit integer strings (1 USDC = `"1000000"`). `transactionRequest`
  `value`/`gasPrice`/`gasLimit` are **hex** wei; `estimate.gasCosts[].amount` is a decimal string.
- **EVM router/spender** (approvalAddress and `transactionRequest.to`) is the LI.FI Diamond
  `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`, the same on every EVM chain.
- **Smallest-unit math uses BigInt** — `1e18` overflows JS safe integers; keep amounts as strings.

## Where each thing lives

`swap-bridge.md` quotes & routes · `discovery.md` chains/tokens/tools/connections/gas ·
`status.md` transfer tracking · `earn.md` DeFi yield · `execute.md` sign & broadcast via baw.
Base URLs, auth, rate limits, endpoint index: `_index.yaml`.
