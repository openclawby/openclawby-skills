# LI.FI — getting a signable transaction (swap / bridge)

All four endpoints return the data you need to move tokens; only `/quote` and the zap return a
`transactionRequest` directly. Sign & broadcast it with the user's wallet — see `execute.md`.
`"${H[@]}"` below is the optional `x-lifi-api-key` header (see `overview.md`).

---

## 1 · GET /quote — the primary path (one route, tx included)

One recommended route from `fromToken` → `toToken`, same-chain or cross-chain, **with**
`transactionRequest`. Six query params are **required**: `fromChain`, `toChain`, `fromToken`,
`toToken`, `fromAddress`, `fromAmount`.

| Param | Req | Meaning |
|---|---|---|
| `fromChain` / `toChain` | ✓ | NUMERIC chain IDs (same value both = same-chain swap). |
| `fromToken` / `toToken` | ✓ | Token address (preferred) or symbol. Native = `0x0000…0000`. |
| `fromAddress` | ✓ | The sending wallet — use the user's real `baw wallet address` so the tx is theirs. |
| `fromAmount` | ✓ | Smallest-unit string (1 USDC = `1000000`). |
| `toAddress` | | Recipient; defaults to `fromAddress`. |
| `order` | | `CHEAPEST` or `FASTEST` (route preference). |
| `slippage` | | Fraction, e.g. `0.005` = 0.5%. |
| `allowBridges`/`denyBridges`/`preferBridges` | | Bridge keys from `/tools` (e.g. `across,stargateV2`). `all`/`none`/`default` keywords work. |
| `allowExchanges`/`denyExchanges`/`preferExchanges` | | Exchange keys from `/tools`. |
| `maxPriceImpact` | | Drop routes above this (default 0.10 = 10%). |
| `allowDestinationCall` | | Default `true`; `false` forbids a dest-chain call inside the bridge tx. |
| `fromAmountForGas` | | Portion of the sent token converted to destination gas. |
| `integrator` / `referrer` / `fee` | | Your tracking label / referrer / integrator fee fraction (<1). |
| `skipSimulation` | | `true` = faster, but gas limit may be off. |

```bash
# 1 USDC on Arbitrum(42161) → USDC on Base(8453), 0.5% slippage
curl -s "${H[@]}" "https://li.quest/v1/quote\
?fromChain=42161&toChain=8453\
&fromToken=0xaf88d065e77c8cC2239327C5EDb3A432268e5831\
&toToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\
&fromAmount=1000000&fromAddress=$WALLET&slippage=0.005"
```

### Response: a `Step`

```jsonc
{
  "type": "lifi",            // swap | cross | lifi (composite) | protocol
  "tool": "across",          // the bridge/exchange chosen
  "toolDetails": { "key": "across", "name": "Across", "logoURI": "…" },
  "action":   { "fromChainId": 42161, "toChainId": 8453,
                "fromToken": {…}, "toToken": {…}, "fromAmount": "1000000",
                "slippage": 0.005, "fromAddress": "0x…", "toAddress": "0x…" },
  "estimate": {
    "fromAmount": "1000000",
    "toAmount":    "993442",   // expected out (smallest units)
    "toAmountMin": "993442",   // GUARANTEED minimum after slippage — the number to show/trust
    "approvalAddress": "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",  // ERC-20 spender to approve
    "executionDuration": 2,    // seconds (approx)
    "feeCosts": [ { "name","percentage":"0.0025","token":{…},"amount","amountUSD","included":true } ],
    "gasCosts": [ { "type":"SEND","price","estimate","limit","amount","amountUSD","token":{…} } ]
  },
  "includedSteps": [ … ],      // sub-steps of a composite route
  "transactionRequest": {      // ← sign & broadcast this (execute.md)
    "from": "0x…", "to": "0x1231DEB6…4EaE", "chainId": 42161,
    "data": "0x1794958f…", "value": "0x0",          // native fromToken → value = amount (hex wei)
    "gasLimit": "0x2ae8dd", "gasPrice": "0x1319290"
  }
}
```

**Read it right:**
- Trust **`toAmountMin`**, not `toAmount`, when telling the user what they'll get (it's post-slippage).
- Check **`feeCosts[].included`**: `true` = already in the quoted amounts; `false` = user pays on top. On a `lifi` step the top-level `feeCosts`/`gasCosts` already roll up `includedSteps` — don't add them twice.
- **ERC-20 `fromToken`** → `transactionRequest.value` is `0x0` and you must approve `approvalAddress` for `fromAmount` first. **Native `fromToken`** → no approval, and `value` equals `fromAmount` in hex wei.
- Quotes can go stale — re-quote if it sat around before you execute.

**Errors:** `400` bad request; `404` no route — the body's `errors` object lists filtered-out /
failed routes with reasons (`NO_POSSIBLE_ROUTE`, `AMOUNT_TOO_LOW`). Widen `slippage`/bridges or
raise `fromAmount` and re-quote.

---

## 2 · POST /advanced/routes — compare several routes

Returns many candidate `routes` (no tx data). Use it when the user wants options
(cheapest vs fastest, which bridge). Then pick a route and call `stepTransaction` per step.

**Body** (required: `fromChainId`, `fromAmount`, `fromTokenAddress`, `toChainId`, `toTokenAddress`):

```jsonc
{
  "fromChainId": 42161, "fromAmount": "1000000",
  "fromTokenAddress": "0xaf88…5831",
  "toChainId": 8453, "toTokenAddress": "0x8335…2913",
  "fromAddress": "0x…", "toAddress": "0x…",
  "options": {
    "order": "CHEAPEST",            // or FASTEST
    "slippage": 0.005,
    "maxPriceImpact": 0.1,
    "allowSwitchChain": true,
    "bridges":   { "allow": ["across","stargateV2"], "deny": [], "prefer": [] },
    "exchanges": { "allow": ["all"] },
    "integrator": "clawby"
  }
}
```

> Note the shape: it's `options.bridges = {allow,deny,prefer}` and `options.exchanges = {…}` —
> **not** the flat `allowBridges` query params that `/quote` uses.

**Response** `{ routes: [Route], unavailableRoutes?, … }`. Each `Route`: `id`, `fromChainId`,
`toChainId`, `fromAmount`, `toAmount`, `toAmountMin`, `fromAmountUSD`, `toAmountUSD`,
`gasCostUSD`, and `steps[]` (same `Step` shape as `/quote`, but **without** `transactionRequest`).

### POST /advanced/stepTransaction — fill a step with tx data

Send the **whole chosen `Step` object** (from the route's `steps[]`) as the JSON body; the
response is that same step now carrying `transactionRequest`. Call once per step that needs a tx.

```bash
curl -s "${H[@]}" -X POST "https://li.quest/v1/advanced/stepTransaction" \
  -H "Content-Type: application/json" -d "$CHOSEN_STEP_JSON"
```

- If the route was requested with `options.pools.deny`, **re-send those same entries** as repeated
  `denyPools` query params on every `stepTransaction` call (the step doesn't carry them).
- `estimate.approvalAddress` is still the spender to approve; `estimate.skipApproval:true` = none needed.
- When to use which: **`/quote`** for "just do this swap" (one call, tx included);
  **`/advanced/routes` + `stepTransaction`** for "show me options / let me choose".

---

## 3 · POST /quote/contractCalls — cross-chain zap (BETA)

Bridge (and optionally swap) from the source chain, then run **your own contract call(s)** on the
destination chain in the same flow — e.g. bridge USDC → deposit into a vault. Beta: "rough edges."

**Body** (required: `fromChain`, `fromToken`, `fromAddress`, `toChain`, `toToken`, `toAmount`,
`contractCalls`):

```jsonc
{
  "fromChain": 42161, "fromToken": "0xaf88…5831", "fromAddress": "0x…",
  "toChain": 8453, "toToken": "0x8335…2913",
  "toAmount": "1000000",                 // min toToken the destination call needs
  "contractCalls": [{
    "fromAmount": "1000000",
    "fromTokenAddress": "0x8335…2913",
    "toContractAddress": "0xVault…",
    "toContractCallData": "0x…",         // ABI-encoded call for the destination contract
    "toContractGasLimit": "200000"       // too low → the call fails
  }],
  "slippage": 0.005, "integrator": "clawby",
  "toFallbackAddress": "0x…",            // gets the bridged funds if a call reverts (default: sender)
  "contractOutputsToken": "0x…"          // a receipt token the call mints back to the user, if any
}
```

Response is a `Step` with `transactionRequest`, like `/quote` (treat it the same). You build
`toContractCallData` yourself (ABI-encode the destination call); verify it before signing.
