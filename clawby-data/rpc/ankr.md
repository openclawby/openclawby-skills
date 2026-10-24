# Ankr RPC (BYOK)

Ankr node APIs (70+ networks, EVM and non-EVM) plus Ankr's Advanced multichain API, called with the user's **own Ankr key** fetched from the Clawby Key Vault. **One key works on every chain.** Direct to Ankr — not via Clawby relay, no Clawby credits (usage counts against the user's Ankr plan).

## 1 · Get the key (keep in memory, never write to disk)

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/ankr -H "X-API-Key: $CLAWBY_API_KEY")
ANKR_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
If the user set a trusted-IP whitelist, this machine's public IP must be on it, and their vault retrieval switch must be ON. Response shape and error bodies (`ip_not_allowed`, `vault_disabled`, `not_found`, 401, 429): see `rpc/index.yaml`.

**The key sits in the URL path, so the WHOLE endpoint URL is a secret.** Never echo, log, commit or paste it into a report (`curl -v` and stack traces print it).

## 2 · Endpoint templates

```
Node API (JSON-RPC, POST)       https://rpc.ankr.com/{chain}/{ANKR_KEY}
REST-style chains (GET/POST)    https://rpc.ankr.com/premium-http/{chain}/{ANKR_KEY}/{path}
Advanced API (EVM only, POST)   https://rpc.ankr.com/multichain/{ANKR_KEY}
WebSocket (Premium plan only)   wss://rpc.ankr.com/{chain}/ws/{ANKR_KEY}
```
- `{chain}` is an **Ankr slug** from section 3, NOT the chain's common name. Send `Content-Type: application/json`; there is no auth header, the key is the path segment.
- REST example (Aptos ledger info, from Ankr docs): `curl -s https://rpc.ankr.com/premium-http/aptos/$ANKR_KEY/v1/`
- The `wss://` form is documented on Ankr's Robinhood Chain page; `eth_subscribe` needs a Premium plan.
- **Keyless "public" URLs** (`https://rpc.ankr.com/{chain}`, `.../http/{chain}/...`) still appear in Ankr's examples, but when tested on 2026-10-25 the major chains (eth, bsc, polygon, base, arbitrum, optimism, avalanche, fantom, gnosis) answered `-32000 Unauthorized: You must authenticate your request with an API key`; only ~20 smaller chains (celo, core, chiliz, xdc, flare, taiko, story_mainnet, ...) still answered keyless. Do not rely on it, always use the keyed form.
- JSON-RPC conventions (POST body, batch, hex values, error object): see `rpc/index.yaml`.

## 3 · Chain slugs (complete list)

How to read: a slug listed as **confirmed** appears in Ankr's docs examples, or was live-checked on 2026-10-25 (the gateway answered with a result, `Unauthorized`, or `Method not found`, which proves it knows the slug). **Unconfirmed** slugs come only from Ankr's own dashboard chain map (the gateway gave an ambiguous 403 when probed without a key): make one test call before relying on them. For JSON-RPC slugs append `/{ANKR_KEY}`; REST-style entries show their full template.

### EVM mainnets (confirmed)

Majors: `eth` (Ethereum) · `bsc` (BNB Smart Chain) · `polygon` (Polygon PoS) · `arbitrum` (Arbitrum One) · `optimism` (OP Mainnet) · `base` · `avalanche` (C-Chain) · `linea` · `scroll` · `mantle` · `blast` · `zksync_era` (zkSync Era) · `gnosis` · `celo` · `fantom` · `metis` · `taiko` · `xlayer` (X Layer) · `sonic_mainnet` (Sonic) · `monad_mainnet` (Monad)

More (A-Z): `0g_mainnet_evm` (0G) · `abchain_mainnet` (AB Chain) · `arbitrumnova` (Arbitrum Nova) · `b2` (B2 Network) · `bitlayer` · `chiliz` · `core` (Core DAO) · `electroneum` · `etherlink_mainnet` (Etherlink) · `flare` · `goat_mainnet` (GOAT) · `gravity` (Gravity Alpha) · `iota_evm` (IOTA EVM) · `iotex` · `kaia` · `kava_evm` (Kava EVM) · `kite_mainnet` (Kite AI) · `matchain_mainnet` · `redbelly_mainnet` · `robinhood_mainnet` (Robinhood Chain) · `sei_evm` (Sei EVM) · `somnia_mainnet` (Somnia) · `story_mainnet` (Story) · `tac` (TAC) · `telos` (Telos EVM) · `vflow_mainnet` (zkVerify vFlow) · `xdc` (XDC Network) · `xphere_mainnet`

Unconfirmed mainnets: `unichain_mainnet` (Unichain) · `hyperevm` (HyperEVM) · `atleta_mainnet` (Atleta)

### EVM testnets

Naming has no fixed rule: `<chain>_sepolia`, `<chain>_testnet`, `<chain>_testnet_<name>` or a testnet's own name. Confirmed:

`eth_sepolia` · `eth_hoodi` · `polygon_amoy` · `arbitrum_sepolia` · `optimism_sepolia` · `base_sepolia` · `avalanche_fuji` · `bsc_testnet_chapel` · `blast_testnet_sepolia` · `celo_sepolia` · `fantom_testnet` · `zksync_era_sepolia` · `iotex_testnet` · `monad_testnet` · `somnia_testnet` · `story_aeneid_testnet` · `electroneum_testnet` · `xdc_testnet` · `whitechain_testnet` (Whitechain, testnet only) · `goat_testnet` · `atleta_olympia` · `taiko_hekla` · `tac_turin` · `tac_spb` · `xphere_testnet` · `abchain_testnet` · `dogeos_testnet` (DogeOS, testnet only) · `etherlink_shadownet_testnet` · `flare_coston` · `flare_coston2` · `flare_songbird` (Songbird canary net)

Unconfirmed: `gnosis_testnet` · `kaia_testnet` · `scroll_sepolia_testnet` · `xlayer_testnet` · `bitlayer_testnet` · `taiko_hoodi_testnet` · `iota_evm_testnet` · `neura_testnet` (Neura, EVM assumed) · `sonic_blaze_testnet` · `vflow_volta_testnet` · `eth_holesky` (legacy: Ankr docs still mention Holesky but its current chain page lists `eth_hoodi` instead)

### Non-EVM chains

Different request format and a **different RPC method set** from `eth_*`. Same key, same `https://rpc.ankr.com/...` host. Per-chain guides below; use the chain's own methods.

- **Solana** — `solana` · devnet `solana_devnet` — Solana JSON-RPC → `rpc/non-evm/solana.md`. Since 2026-09-15 `getBlock`/`getTransaction` must pass `"maxSupportedTransactionVersion": 1` (0 returns `-32015`).
- **Sui** — `sui` · testnet `sui_testnet` — Sui JSON-RPC ⚠️ **deprecated/removed by Ankr in late-2026** (a key may still answer — probe once, then use the gRPC/GraphQL below). Also GraphQL `premium-http/sui_graphql/{ANKR_KEY}` (mainnet) and gRPC host `sui.grpc.ankr.com:443` with header `x-token: <key>` (testnet and archive gRPC hosts: see Ankr's Sui page) → `rpc/non-evm/sui.md`
- **Aptos** — REST only: `premium-http/aptos/{ANKR_KEY}/v1/...` (testnet slug unconfirmed: `aptos_testnet`) → `rpc/non-evm/aptos.md`
- **NEAR** — `near` (Premium plan only) → `rpc/non-evm/near.md`
- **TRON** — JSON-RPC `tron_jsonrpc` (an `eth_*` subset) and REST `premium-http/tron/{ANKR_KEY}/wallet/...` + `/walletsolidity/...` (Premium plan only) → `rpc/non-evm/tron.md`
- **XRP Ledger** — `xrp_mainnet` · testnet `xrp_testnet` (docs tag: Premium plan) → `rpc/non-evm/xrp.md`
- **TON** — JSON-RPC `ton_api_v2` and REST `premium-http/ton_api_v2/{ANKR_KEY}/{method}` (mainnet only) → `rpc/non-evm/ton.md`
- **Bitcoin** — `btc` · signet `btc_signet` (Bitcoin Core JSON-RPC); Blockbook REST `premium-http/btc_blockbook/{ANKR_KEY}/api/v2/...` (signet Blockbook `btc_blockbook_signet`, unconfirmed)
- **Stellar** — Horizon REST `premium-http/stellar_horizon/{ANKR_KEY}/...`; Soroban RPC `stellar_soroban`; testnet Soroban `stellar_testnet_soroban`, testnet Horizon `stellar_testnet_horizon` (unconfirmed)
- **Polkadot** — `polkadot` (Premium plan only); Asset Hub `polkadot_mainnet_asset_hub` (unconfirmed)
- **Filecoin** — `filecoin` · testnet `filecoin_testnet` (Lotus API; `eth_*` also answers)
- **Nervos CKB** — `nervos_ckb`
- **IOTA (Move)** — `iota_mainnet` · `iota_testnet`
- **Midnight** — `midnight_testnet` · `midnight_mainnet` (known to the gateway, not yet in Ankr docs)
- **Avail** — `avail_turing_testnet`
- **Movement** — REST `premium-http/movement_mainnet/{ANKR_KEY}/v1/...` (testnet `movement_bardock`, unconfirmed)
- **zkVerify** — `zkverify_mainnet` · `zkverify_volta_testnet`

Consensus / Cosmos / sub-chain endpoints of EVM chains (not `eth_*`):
- Ethereum Beacon REST `premium-http/eth_beacon/{ANKR_KEY}/eth/v1/...`; Gnosis Beacon `premium-http/gnosis_beacon/{ANKR_KEY}/eth/v1/...`; 0G Beaconkit `premium-http/0g_mainnet_beaconkit/{ANKR_KEY}/...` (all Premium plan). Testnet beacons `eth_sepolia_beacon`, `eth_hoodi_beacon` are unconfirmed.
- Avalanche non-EVM VMs: `avalanche-p` (`platform.*`), `avalanche-x` (`avm.*`), `avalanche-c` (`avax.*`). Flare: `flare-p`, `flare-x`, `flare-c`. Their Fuji / Coston variants (`avalanche_fuji-p`, `flare_coston-p`, ...) exist on Ankr's chain page but are unconfirmed.
- Cosmos-SDK sides: Kava `kava_rpc` (Tendermint JSON-RPC) and `kava_api` (Cosmos REST); Sei `sei` (Tendermint) and `sei_cosmos` (Cosmos REST, `premium-http/sei_cosmos/{ANKR_KEY}/...`); TAC `tac_tendermint` (Tendermint) and `tac_cosmos` (unconfirmed). For the REST ones the keyed `premium-http/{slug}/{ANKR_KEY}/...` form is assumed from the pattern above.
- Method lists per chain: `https://www.ankr.com/docs/rpc-service/chains/chains-api/<chain>/`

### Plan gating, wrong names, retired slugs

- **Docs tag as Premium plan only** (a free Freemium key should expect `-32052`): `fantom` `linea` `metis` `robinhood_mainnet` `near` `polkadot` `tron_jsonrpc` (and TRON REST) `xrp_mainnet` `xrp_testnet` `eth_beacon` `gnosis_beacon`. Every other chain Ankr documents is tagged "Freemium and Premium" or untagged (no plan restriction stated).
- **Wrong, do not use**: `ethereum`, `bnb`, `matic`, `avax`, `arbitrum_nova` (real: `arbitrumnova`), `zksync` (real: `zksync_era`), and the bare page names `sonic` `story` `etherlink` `kite` `matchain` `redbelly` `robinhood` `xphere` `somnia` `monad` `xrp` `tron` `unichain` (use the `_mainnet` / `_jsonrpc` forms above).
- **Not on Ankr's current list or docs** (older drafts had them): `polygon_zkevm`, `harmony`, `swell`, `bahamut`, `berachain` got the same 403 as a made-up slug when probed; `moonbeam`, `rollux`, `syscoin` are still recognized by the gateway but undocumented, so treat all of these as retired and test before use.
- `multichain` is not a chain: it is the Advanced API endpoint (section 5).
- Ankr adds chains often. If a requested chain is missing, check `https://www.ankr.com/rpc/` (new chains show up there first) and probe the slug. Authoritative docs: `https://www.ankr.com/docs/rpc-service/chains/chains-list/`

## 4 · EVM methods and examples

The full standard EVM JSON-RPC catalog (`eth_*`, `net_*`, `web3_*`, `trace_*`, `debug_*`) is in `rpc/evm-methods.md`. Ankr-specific support (Ankr docs, typical EVM chains; a few chains add more exclusions):
- **Not supported over HTTPS**: filter API (`eth_newFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`, `eth_uninstallFilter`) → poll with `eth_getLogs` / `eth_blockNumber` instead; `eth_coinbase`, `eth_hashrate`, `eth_mining`, `eth_getWork`, `eth_submitWork`, `eth_submitHashrate`, `net_peerCount`; namespaces `personal_*`, `admin_*`, `miner_*`, `clique_*`, `les_*`, `engine_*`, `parity_*`; `debug_*` except `debug_traceBlockByHash`, `debug_traceBlockByNumber`, `debug_traceBlock`, `debug_traceTransaction`, `debug_traceCall`. Over WSS `txpool_*` is also unsupported.
- `trace_*` and `debug_*` work only on a Premium plan and only on chains whose Ankr page lists them.

Latest block on Ethereum (result is hex; decode with `printf '%d\n' 0x...`):
```bash
curl -s -X POST "https://rpc.ankr.com/eth/$ANKR_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```
Native balance on BSC (hex wei; divide by 1e18):
```bash
curl -s -X POST "https://rpc.ankr.com/bsc/$ANKR_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xADDRESS","latest"],"id":1}'
```
ERC-20 `balanceOf` through `eth_call` (USDC on Ethereum, 6 decimals; selector `0x70a08231` + address left-padded to 32 bytes):
```bash
TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
HOLDER=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
DATA=0x70a08231$(printf '%064s' "${HOLDER#0x}" | tr ' ' 0)
curl -s -X POST "https://rpc.ankr.com/eth/$ANKR_KEY" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$TOKEN\",\"data\":\"$DATA\"},\"latest\"],\"id\":1}"
# result = 32-byte hex; python3 -c 'print(int("<result>",16)/1e6)'
```
Batch (array in, array out in the same order; max 100 calls on Freemium, 1000 on Premium):
```bash
curl -s -X POST "https://rpc.ankr.com/eth/$ANKR_KEY" -H "Content-Type: application/json" \
  -d '[{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1},
       {"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":2}]'
```
Logs over a bounded window (stay inside the plan's block-range cap, section 6):
```bash
LATEST=$(curl -s -X POST "https://rpc.ankr.com/eth/$ANKR_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))')
FROM=$(printf '0x%x' $((LATEST-1000))); TO=$(printf '0x%x' "$LATEST")
curl -s -X POST "https://rpc.ankr.com/eth/$ANKR_KEY" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"$FROM\",\"toBlock\":\"$TO\",\"address\":\"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\",\"topics\":[\"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef\"]}],\"id\":1}"
```

## 5 · Ankr Advanced API (multichain)

Indexed answers instead of raw chain reads: wallet balances with USD value, NFTs, token prices and holders, transfers, transaction history, logs. One endpoint, many chains, JSON-RPC 2.0 `POST`:

```
https://rpc.ankr.com/multichain/{ANKR_KEY}
```
- **Only on the `multichain` endpoint**, never on `https://rpc.ankr.com/{chain}/...`. These `ankr_*` methods are NOT standard EVM methods.
- **EVM chains only**, `blockchain` values (use exactly these): mainnets `arbitrum` `avalanche` `base` `bsc` `eth` `fantom` `flare` `gnosis` `linea` `optimism` `polygon` `scroll` `somnia_mainnet` `story_mainnet` `taiko` `telos` `xlayer`; testnets `avalanche_fuji` `base_sepolia` `eth_sepolia` `optimism_sepolia` `polygon_amoy` `story_aeneid_testnet`. Any other chain name → `-32602 ... is not allowed`. (Stellar has its own `stellar_*` methods, below.)
- Needs a Freemium or Premium key (not available keyless). Cost 700 credits (about $0.00007) per call. Rate: Freemium 50 req/min (max 500 per 10 min), Premium 1k+ req/min; batch max 25.
- **`params` is a JSON object (named), not an array.** `blockchain` is an **array** on multi-chain methods and a single **string** on single-chain methods (marked `str` below); the wrong type gives `-32602 Invalid params`.
- Paginated methods return `nextPageToken`; pass it back as `pageToken` until it is empty. JSON-RPC errors can arrive with HTTP 200, always check for an `error` object.
- ENS names (e.g. `vitalik.eth`) are accepted for wallet addresses on Ethereum.

Helper used in the examples (POST a body to the multichain URL):
```bash
ankr_adv() { curl -s -X POST "https://rpc.ankr.com/multichain/$ANKR_KEY" -H 'Content-Type: application/json' -d "$1"; }
```

### The 16 methods

**Query API**
- `ankr_getBlocks` — `blockchain` (str), `fromBlock`, `toBlock` (max 30 blocks per call); opt `includeTxs`, `includeLogs` (needs `includeTxs`), `decodeTxData`, `decodeLogs`, `descOrder`
- `ankr_getLogs` — scope with `blockchain`[], `address`[], `topics` (like `eth_getLogs`), a block range or `fromTimestamp`/`toTimestamp`; opt `decodeLogs`, `descOrder`, `pageSize` (default 1000, max 10000)
- `ankr_getTransactionsByAddress` — `address` (one per call); opt `blockchain`[], block or time range, `includeLogs`, `descOrder`, `pageSize` (default 100, max 10000)
- `ankr_getTransactionsByHash` — `transactionHash`; opt `blockchain`[] (searches all chains if omitted), `includeLogs`, `decodeTxData`, `decodeLogs`
- `ankr_getInteractions` — `address` → `{"blockchains":[...]}`, the chains where that address has activity (no `blockchain` param)
- `ankr_getBlockchainStats` — opt `blockchain`[] (omit = all) → latest block, block time, tx/event totals, native-coin USD price

**Token API**
- `ankr_getAccountBalance` — `walletAddress`; opt `blockchain`[], `onlyWhitelisted` (default true = CoinGecko-listed tokens only), `nativeFirst`, `pageSize`
- `ankr_getTokenPrice` — `blockchain` (str); opt `contractAddress` (omit = native coin price)
- `ankr_getTokenHolders` — `blockchain` (str), `contractAddress`; `pageSize` (default and max 10000), ranked by balance
- `ankr_getTokenHoldersCount` — `blockchain` (str), `contractAddress` → day-by-day holder-count history
- `ankr_getTokenTransfers` — opt `address`[], `blockchain`[], block or time range, `descOrder`, `pageSize` (default 100, max 10000)
- `ankr_getCurrencies` — `blockchain` (str) → native + indexed ERC-20 catalog (symbol, decimals, address)

**NFT API** (ERC-721, ERC-1155, ENS, POAP)
- `ankr_getNFTsByOwner` — `walletAddress`; opt `blockchain`[], `filter` (`[{"<contract>":[tokenIds]}]`, empty array = whole collection), `pageSize` (default 10, max 50)
- `ankr_getNFTMetadata` — `blockchain` (str), `contractAddress`, `tokenId`; opt `forceFetch` (read on-chain instead of Ankr's cache)
- `ankr_getNFTHolders` — `blockchain` (str), `contractAddress`; `pageSize` (default 1000, max 10000)
- `ankr_getNftTransfers` — opt `address`[], `blockchain`[], block or time range, `descOrder`, `pageSize` (default 100, max 10000)

Also: `ankr_getTokenPriceHistory` appears in Ankr's docs (not in the OpenAPI spec): `blockchain` (str), opt `contractAddress`, `fromTimestamp`, `toTimestamp`, `interval`, `limit` → `quotes: [{timestamp, blockHeight, usdPrice}]`. And three Stellar methods on the same endpoint with `"blockchain":"stellar_soroban"`: `stellar_getTokenPrice`, `stellar_getAccountBalance` (`walletAddress` is a `G...` Strkey), `stellar_getEvents` (`startLedger`, opt `endLedger`, `limit`, `cursor`, `filters`).

Always scope calls (set `blockchain`, an address or contract, a range, and a small `pageSize`): omitting `blockchain` fans out to every supported chain.

### `ankr_getAccountBalance` — all token balances of a wallet, with USD value
```bash
ankr_adv '{"jsonrpc":"2.0","id":1,"method":"ankr_getAccountBalance","params":{"walletAddress":"0x18b2a687610328590bc8f2e5fedde3b582a49cda","blockchain":["eth","bsc","polygon"]}}'
```
Response (trimmed; native assets have no `contractAddress`):
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "totalBalanceUsd": "398857.927815440716633863",
    "totalCount": 3,
    "assets": [
      {
        "blockchain": "bsc",
        "tokenName": "Binance Smart Chain",
        "tokenSymbol": "BNB",
        "tokenDecimals": 18,
        "tokenType": "NATIVE",
        "holderAddress": "0x18b2a687610328590bc8f2e5fedde3b582a49cda",
        "balance": "1608.434310817656690616",
        "balanceRawInteger": "1608434310817656690616",
        "balanceUsd": "394175.866488091069305026",
        "tokenPrice": "245.068053968402063819",
        "thumbnail": "https://www.ankr.com/protocol/static/media/bsc.e1bfba92.svg"
      },
      {
        "blockchain": "polygon",
        "tokenName": "Minereum Polygon",
        "tokenSymbol": "MNEP",
        "tokenDecimals": 8,
        "tokenType": "ERC20",
        "holderAddress": "0x18b2a687610328590bc8f2e5fedde3b582a49cda",
        "contractAddress": "0x0b91b07beb67333225a5ba0259d55aee10e3a578",
        "balance": "300000",
        "balanceRawInteger": "30000000000000",
        "balanceUsd": "1244.852927117672699968",
        "tokenPrice": "0.004149509757058909",
        "thumbnail": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x426CA1eA2406c07d75Db9585F22781c096e3d0E0/logo.png"
      }
    ]
  }
}
```

### `ankr_getTokenPrice` — USD price of a token or native coin
```bash
ankr_adv '{"jsonrpc":"2.0","id":1,"method":"ankr_getTokenPrice","params":{"blockchain":"eth","contractAddress":"0xdac17f958d2ee523a2206206994597c13d831ec7"}}'
```
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "blockchain": "eth",
    "contractAddress": "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "usdPrice": "1"
  }
}
```
Native coin: send only `{"blockchain":"polygon"}` as `params`.

### `ankr_getTokenHolders` — holders of an ERC-20, ranked by balance
```bash
ankr_adv '{"jsonrpc":"2.0","id":1,"method":"ankr_getTokenHolders","params":{"blockchain":"eth","contractAddress":"0x40eb746dee876ac1e78697b7ca85142d178a1fc8","pageSize":2}}'
```
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "blockchain": "eth",
    "contractAddress": "0x40eb746dee876ac1e78697b7ca85142d178a1fc8",
    "holders": [
      {
        "balance": "15217676.432428",
        "balanceRawInteger": "15217676432428000000000000",
        "holderAddress": "0x000000000000000000000000000000000000dead"
      },
      {
        "balance": "0.000000000000000001",
        "balanceRawInteger": "1",
        "holderAddress": "0x000000000000084e91743124a982076c59f10084"
      }
    ],
    "holdersCount": 1843,
    "nextPageToken": "HUAjC8b1LGxx7soyEPoojoahpqtPaAhk6jTx35dALF6jLH85QD4oHWRA8E1Wf9MqjffsuHfg6pg5ac6Eocb",
    "tokenDecimals": 18
  }
}
```
Next page: repeat with `"pageToken":"<nextPageToken>"`.

### `ankr_getLogs` — indexed logs with optional event decoding
Request body (decoded `Transfer` events of WETH between two addresses over a bounded range):
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "method": "ankr_getLogs",
  "params": {
    "blockchain": ["eth"],
    "address": ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
    "decodeLogs": true,
    "fromBlock": "0xdaf6b1",
    "toBlock": 14350010,
    "topics": [
      ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
      ["0x000000000000000000000000def1c0ded9bec7f1a1670819833240f027b25eff"],
      ["0x0000000000000000000000003dd49f67e9d5bc4c5e6634b3f70bfd9dc1b6bd74"]
    ]
  }
}
```
Response:
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "logs": [
      {
        "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "blockHash": "0x76fe73c4d2a66bb0cba343482521c8cd44f0ef824e97493f3c4f3e5140422ea5",
        "blockNumber": "0xdaf6b4",
        "blockchain": "eth",
        "data": "0x00000000000000000000000000000000000000000000000000787f498b5b22b7",
        "event": {
          "anonymous": false,
          "id": "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "name": "Transfer",
          "signature": "Transfer(address,address,uint256)",
          "string": "event Transfer(address indexed _from, address indexed _to, uint256 _value)",
          "verified": false
        },
        "logIndex": "0x49",
        "removed": false,
        "topics": [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x000000000000000000000000def1c0ded9bec7f1a1670819833240f027b25eff",
          "0x0000000000000000000000003dd49f67e9d5bc4c5e6634b3f70bfd9dc1b6bd74"
        ],
        "transactionHash": "0x6f11297b0964a0fb0630e6667093a6c9cee4b383495c94e99becc6b88aed8f14",
        "transactionIndex": "0x3f"
      }
    ]
  }
}
```
`fromBlock`/`toBlock` take an integer, a hex string, `earliest` or `latest`; use `fromTimestamp`/`toTimestamp` (UNIX seconds) for time windows. The result may also carry `nextPageToken`.

### `ankr_getNFTsByOwner` — NFTs held by a wallet
Request body (ENS name, all chains, default page of 10):
```json
{ "id": 1, "jsonrpc": "2.0", "method": "ankr_getNFTsByOwner", "params": { "walletAddress": "vitalik.eth" } }
```
Response (trimmed to one asset):
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "owner": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    "nextPageToken": "2hMDmwWDCKfaN8VPERnkckY4JWbRyDurn8LyreDRZbyprWUErKSC6AoGbKerumFnyG1SAkWHxs",
    "assets": [
      {
        "blockchain": "eth",
        "collectionName": "Cool Oliens",
        "contractAddress": "0x03a1e037df88001bf867e3bcffa7e48bab0cf5a6",
        "contractType": "ERC721",
        "imageUrl": "https://ipfs.io/ipfs/QmTzuLQSn78keGt3n36b3tNNs7B3WMjo2SNJUF9rRshPjA/116.png",
        "name": "Cool Oliens #117",
        "symbol": "COOLIEN",
        "tokenId": "116",
        "tokenUrl": "https://ipfs.io/ipfs/QmdT4pLoe5w93rCnESnaEXBU7PaAiSSWuDDXurLhmzVvAz/116",
        "traits": [
          { "trait_type": "NFT ID", "value": "117" },
          { "trait_type": "Rank", "value": "199" }
        ]
      }
    ]
  }
}
```
Scope to a collection with `"blockchain":["eth"],"filter":[{"0x700b4b9f39bb1faf5d0d16a20488f2733550bff4":[]}]`.

### `ankr_getTransactionsByAddress` — transactions sent or received by a wallet
Request body (newest 10 on Ethereum):
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "method": "ankr_getTransactionsByAddress",
  "params": {
    "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    "blockchain": ["eth"],
    "pageSize": 10,
    "descOrder": true
  }
}
```
Response (trimmed to one transaction):
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "transactions": [
      {
        "blockHash": "0x8ffa5d490184c95c830bb4fb47b76e1fd69eb35d100f93d36d7db131837c938f",
        "blockNumber": "0xf823ad",
        "blockchain": "eth",
        "cumulativeGasUsed": "0x68f589",
        "from": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        "gas": "0xbe98",
        "gasPrice": "0x2babee650",
        "gasUsed": "0xbd8d",
        "hash": "0x9a70ccd1f8e0d5ddf8e78f68b477d4d5c15ddd17c66f05f820b4c67f5eb6f85a",
        "input": "0xa9059cbb000000000000000000000000fe97e32a873aa2f926fbfc560abeef01f753c1280000000000000000000000000000000000000000000000000000002e90edd000",
        "nonce": "0x3c4",
        "status": "0x1",
        "timestamp": "0x63a85033",
        "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "transactionIndex": "0x3c",
        "type": "0x2",
        "value": "0x0"
      }
    ]
  }
}
```
The full object also has `r`, `s`, `v`. Add `"includeLogs": true` to embed each transaction's logs, and `nextPageToken` pages further.

## 6 · Gotchas and limits

- **Slug, not name**: `eth` (not `ethereum`/`mainnet`), `bsc` (not `bnb`), `avalanche` (not `avax`), `polygon` (not `matic`), `arbitrumnova` (no underscore), and newer chains need the suffix (`sonic_mainnet`, `story_mainnet`, `xrp_mainnet`, ...). A wrong slug fails with a short error body, not an HTML 404: tested without a key it was HTTP 403 `API key is not allowed to access blockchain` (`-32052`); Ankr's error table also defines `-32093` `Blockchain not supported`.
- **`-32052` on a valid slug** = the chain is not enabled for this key/project (Ankr dashboard → project) or the plan excludes it (see "Premium plan only" above). Tell the user; do not retry.
- **The URL is the secret**: the key is in the path, so any logged request URL leaks it.
- **Plan and quota are the user's Ankr plan** (verified in Ankr docs, 2026-10):

  | | Freemium (free key) | Premium |
  |---|---|---|
  | Credits | 200M free per month | pay-as-you-go ($0.10 = 1M credits) or monthly Deal |
  | Node API rate | about 1,800 req/min | up to about 1.5k req/s per endpoint (Solana about 4k/s) |
  | Advanced API rate | 50 req/min (500 per 10 min) | 1k+ req/min |
  | Batch size (Node / Advanced) | 100 / 25 | 1000 / 25 |
  | `eth_getLogs` max block range | 3,000 | 10,000 |
  | `trace_*` / `debug_*`, WebSocket | no | yes |

  Cost per call: EVM and other non-EVM 200 credits, Solana 500, Beacon chains 700, Advanced API 700. Failed or unsupported-method calls are still charged; a `429` and a malformed JSON-RPC body are not. Free credits cover roughly 1M EVM calls or 285k Advanced calls a month, so do not loop blindly.
- **`eth_getLogs` caps**: block range per the table above, but Polygon is 1,000 on both plans, BSC 1,000 on Freemium, Monad 100 on Freemium / 1,000 on Premium. At most 200,000 logs per response, otherwise it errors (no partial result). Too wide a range returns `-32062` "Block range is too large": split into windows (start near 2,000 blocks) or filter by `address` and `topics`. For wallet history prefer `ankr_getLogs` / `ankr_getTransactionsByAddress`.
- **Archive and traces**: archive data is available on every plan, but `trace_*` / `debug_*` are Premium only. Old-state reads (`eth_call` / `eth_getBalance` at a past block) can return `-32000 missing trie node` or `header not found` from a pruned full node, and `-32061` when no archive node is free (retry). A future block number also gives `-32000`.
- **Non-EVM chains** speak their own methods; do not send `eth_*` to `solana`, `sui`, `near`, `xrp_mainnet`, `ton_api_v2` and so on. Use `rpc/non-evm/<chain>.md`. Exceptions: `tron_jsonrpc` and `filecoin` answer an `eth_*` subset.
- **Advanced API**: `params` is an object, `blockchain` is array vs string per method, and it exists only on `.../multichain/{ANKR_KEY}`. Calling `ankr_*` on a per-chain URL fails (method not available there).
- **Errors worth handling** (gateway codes; `error.data.trace_id` identifies the request for Ankr support):

  | Code (HTTP) | Meaning | Do |
  |---|---|---|
  | -32049 / -32050 (401) | key missing / not found | re-fetch the key from the vault, check for typos |
  | -32051 / -32060 (403) | key disabled / expired | tell the user |
  | -32052 (403) | chain not enabled for key or plan, or unknown slug | check the slug and plan, tell the user |
  | -32053 / -32054 / -32079 / -32080 (403) | method / IP / origin / contract blocked by the key's own allowlists in Ankr | the user's Ankr key restricts this machine; tell the user |
  | -32090 (429) | rate limit | exponential backoff with jitter (200 ms base, 10 s cap, at most 5 tries), honor `Retry-After`, batch |
  | -32062 (413) | request, block range or batch too large | split it up |
  | -32055 / -32056 / -32057 / -32059 / -32061 / -32063 / -32064 / -32071 / -32076 (5xx) | transient node/gateway trouble | retry with backoff |
  | -32601 / -32602 (4xx) | method missing / bad params (on the Advanced API also an unsupported `blockchain` value) | fix the request |

  Codes not in this table (node-level `-32000` such as `header not found`, `3` "execution reverted", Solana `-32015`) come from the chain node, not Ankr's gateway. The one gateway message that reuses `-32000` is the keyless `Unauthorized: You must authenticate your request with an API key`.
- **Never swap in a shared or demo key** from Ankr's docs or sample code: use only the user's key from the vault.

Sources: Ankr docs `https://www.ankr.com/docs/rpc-service/chains/chains-list/`, `https://www.ankr.com/docs/rpc-service/service-plans/`, `https://www.ankr.com/docs/rpc-service/errors/overview/`, `https://www.ankr.com/docs/advanced-api/overview/`; Advanced API OpenAPI spec `https://www.ankr.com/docs/openapi/ankr-advanced-api.yaml`; chain page `https://www.ankr.com/rpc/`.
