# LI.FI — discovery & reference (read-only)

Resolve chains, token addresses, and tool keys before quoting. **Cache `/chains`, `/tokens`,
`/tools`** — they're static and keyless-cheap but still count against the rate limit.
`"${H[@]}"` is the optional `x-lifi-api-key` header.

---

## GET /chains — supported chains

`?chainTypes=EVM,SVM,UTXO,MVM,TVM,STL` (comma list; **pass it explicitly** — omitting it may
return only EVM). Response `{ chains: [...] }`, ~65 EVM live.

```bash
curl -s "${H[@]}" "https://li.quest/v1/chains?chainTypes=EVM" \
 | python3 -c 'import sys,json;[print(c["id"],c["key"],c["name"],c.get("coin")) for c in json.load(sys.stdin)["chains"]]'
```

Each chain: `id` (numeric, e.g. `137`), `key` (`eth`/`arb`/…), `name`, `chainType`, `coin`,
`mainnet`, `logoURI`, `nativeToken` (`{address:0x000…0, symbol, decimals, priceUSD, …}`),
`metamask` (`{chainId:'0x89' hex, chainName, nativeCurrency, rpcUrls[], blockExplorerUrls[]}`).
Note `id` is decimal but `metamask.chainId` is hex. Common IDs: `1` eth · `10` optimism ·
`56` bsc · `137` polygon · `8453` base · `42161` arbitrum · `4663` robinhood · plus Solana.

## GET /tokens — all tokens, grouped by chain

`?chains=ETH,ARB` (comma list — accepts keys or numeric ids) · `?chainTypes=…` ·
`?tags=stablecoin` (only tag today) · `?minPriceUSD=` (default 0.0001).

**Response is keyed by chain-id STRING**, not a `tokens` wrapper:

```jsonc
{ "42161": [ {"address":"0xaf88…5831","symbol":"USDC","decimals":6,"chainId":42161,
              "name":"USD Coin","coinKey":"USDC","priceUSD":"1.0004","logoURI":"…"} , … ] }
```

```bash
# Arbitrum stablecoins
curl -s "${H[@]}" "https://li.quest/v1/tokens?chains=ARB&tags=stablecoin"
```

Each token carries its own `chainId`. Combining `chains` + `tags` returns the intersection.
**Resolve symbols to addresses here before quoting** anything real.

## GET /token — resolve ONE token (+ price)

`?chain=<id|key>&token=<address|symbol>` (both required). Returns a token object (the spec says
array; live returns a single object — handle both) with `address`, `symbol`, `decimals`,
`chainId`, `coinKey`, `priceUSD` (string — parse before math), `logoURI`. Great for a quick
price or to turn a symbol into an address.

```bash
curl -s "${H[@]}" "https://li.quest/v1/token?chain=42161&token=USDC" \
 | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d[0] if isinstance(d,list) else d;print(d["address"],d["priceUSD"])'
```

## GET /tools — bridge & exchange keys

`?chains=1&chains=137` (optional; repeated or comma). Response `{ bridges:[...], exchanges:[...] }`;
each tool has `key`, `name`, `logoURI`, `supportedChains`. The **`key`** is what feeds
`allowBridges`/`denyBridges`/`allowExchanges`/`preferBridges` on `/quote`, `options.bridges`/
`options.exchanges` on `/advanced/routes`, and the `bridge` param on `/status`.

Live keys (snapshot — fetch fresh): **bridges** `across` `stargateV2` `stargateV2Bus` `mayan`
`mayanMCTP` `relay` `squid` `symbiosis` `allbridge` `celercircle` `gnosis` `polygon` `arbitrum` …
(37); **exchanges** `1inch` `paraswap` `openocean` `kyberswap` `sushiswap` `bebop` `dodo`
`enso` `gluex` `jupiter` (Solana) `okx` `bitget` `lifidexaggregator` … (40).

## GET /connections — what routes between two chains

Required `fromChain` + `toChain`; optional `fromToken`, `toToken`, `chainTypes`,
`allow/deny/preferBridges`, `allow/deny/preferExchanges`, `allowSwitchChain`,
`allowDestinationCall`. **Use numeric IDs** (upper-case aliases silently return 0 connections).
Response `{ connections: [ {fromChainId, toChainId, fromTokens[], toTokens[]} ] }` — tokens are
`{address, chainId}`. `toChain` is a single value, so loop over destinations for a full map.

```bash
# can I bridge from Arbitrum(42161) to Base(8453), and in what tokens?
curl -s "${H[@]}" "https://li.quest/v1/connections?fromChain=42161&toChain=8453" \
 | python3 -c 'import sys,json;c=json.load(sys.stdin)["connections"][0];print("from",len(c["fromTokens"]),"to",len(c["toTokens"]),"tokens")'
```

## GET /gas/prices · /gas/suggestion — gas

`/gas/prices` → object keyed by chain id: `{ "1": {standard, fast, fastest, lastUpdated}, … }`
(values in wei). `/gas/suggestion?fromChain=<id>` → suggested values for one chain. Useful for a
quick fee sanity-check, but when sending use the `gasLimit`/`gasPrice` inside the quote's
`transactionRequest` as-returned.
