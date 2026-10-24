# BlockPI RPC (BYOK)

RPC access to 70+ networks (EVM JSON-RPC, plus REST/gRPC on some non-EVM chains) using the user's **own BlockPI key**, fetched from the Clawby Key Vault. Direct to BlockPI — not via Clawby relay, no Clawby credits. A BlockPI key is created **per chain endpoint** (it is not global): pick the chain first, then the key that was made for it.

## 1 · Get the key (keep in memory, never write to disk)

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/blockpi -H "X-API-Key: $CLAWBY_API_KEY")
BLOCKPI_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
- If the user set a **trusted-IP whitelist** on their Clawby account, this machine's public IP must be on it, and their **vault retrieval switch must be ON** — otherwise the fetch is refused (403 `ip_not_allowed` / `vault_disabled`; 404 = no BlockPI key stored). Full error + response shapes: `rpc/index.yaml`.
- A vault holds up to 3 keys (slots) and each BlockPI key serves one chain, so use the slot whose `label` names the chain (ask the user if no label says which chain):

```bash
printf '%s' "$RESP" | python3 -c 'import sys,json;[print(k["slot"],k["label"]) for k in json.load(sys.stdin)["keys"]]'
# then read ["keys"][N]["fields"]["apiKey"] for the slot you picked
```
- The key is the last path segment (a 40-character string) of the endpoint URL shown in the BlockPI dashboard. If the stored value is a whole URL, trim it (its hostname also tells you the chain slug):

```bash
BLOCKPI_KEY=${BLOCKPI_KEY%/}; BLOCKPI_KEY=${BLOCKPI_KEY##*/}
```

## 2 · Endpoint

```text
https://{slug}.blockpi.network/v1/rpc/{BLOCKPI_KEY}    # JSON-RPC over HTTPS: POST, Content-Type: application/json
wss://{slug}.blockpi.network/v1/ws/{BLOCKPI_KEY}       # WebSocket (eth_subscribe); keyed endpoints only
```
`{slug}` is BlockPI's chain subdomain (section 3). The key is in the URL path, so **the whole URL is a secret** — never echo, log or commit it (no `curl -v`, no `set -x`). JSON-RPC conventions (POST body, batch, errors, hex): `rpc/index.yaml`.

**Key scope: per chain endpoint, NOT global** (BlockPI docs: "Generate An API Key" + `blockpi_ruBalance`)
- You choose a network + a key name; the dashboard creates one endpoint (URL) for that network. Docs example: an account with 4 endpoints (2x `polygon-zkevm`, `arbitrum-nova`, `klaytn`) holds 4 different keys.
- Per endpoint/key: the chain, Archive mode, MEV protection / Global Cast, IP whitelist (up to 10 IPs/domains), rate limit. Max 50 endpoints per account.
- Account-wide: the RU balance and RU packages — any key of the account reports the same balance.
- Using a key on another chain's host is not documented to work. An unrecognised key returns HTTP 503 `{"jsonrpc":"2.0","error":{"code":100021,"message":"Apikey not found"}}` (observed).
- Sibling networks are separate endpoints = separate keys: `ethereum` vs `ethereum-beacon`, `zetachain` vs `zetachain-evm`, `sui` vs `sui-archive`.

**Public (keyless) endpoints exist for only a few chains** (public.blockpi.io), and the form is NOT uniform:

```text
https://ethereum.public.blockpi.network/v1/rpc/public      # Ethereum   (note the ".public." host)
https://base.public.blockpi.network/v1/rpc/public          # Base        (".public." host)
https://conflux-espace.blockpi.network/v1/rpc/public       # Conflux eSpace
https://merlin.blockpi.network/v1/rpc/public               # Merlin      (+ merlin-testnet)
https://zetachain-evm.blockpi.network/v1/rpc/public        # ZetaChain EVM (+ zetachain-athens-evm)
https://zetachain.blockpi.network/rpc/v1/public            # ZetaChain Tendermint RPC; LCD /lcd/v1/public; WS wss://zetachain.blockpi.network/rpc/v1/public/websocket (+ zetachain-athens)
https://movement.blockpi.network/rpc/v1/public/v1          # Movement (REST)
https://sui.blockpi.network/v1/rpc/public                  # listed, but SUI JSON-RPC is being retired (404 in testing)
```
- `https://{slug}.blockpi.network/v1/rpc/public` is NOT a universal keyless form. On keyed hosts it returns `Apikey not found` (tested: ethereum, base, bsc), and `bsc.public.blockpi.network` returns `unknown host`. Every chain not listed above needs a key.
- Public limits (docs): 10 req/s (200 RU/s), no WS (except ZetaChain), no `debug_*`/`trace_*`, 3 MB max response, `eth_getLogs` range 1024, batch 10. Observed on `ethereum.public`: batch cap 5 (`Max messages exceeded (Limit: 5)`), `eth_getLogs` 5000 blocks with `address` and 1024 without. Sanity checks only — not for production.

## 3 · Chains (exact slugs)

Source: BlockPI "Supported Networks and Advanced Features" = **77 rows: 61 EVM (42 mainnet + 19 testnet) + 16 non-EVM**. Slugs come from docs.blockpi.io (MetaMask page + API-reference examples) and blockpi.io chain pages (Oct 2026); a subset was also probed against BlockPI's gateway and every candidate hostname was DNS-checked for decommissioning. The slug is the subdomain — it is not the chain's common name.

- **Tier**: `Free` = works on the free monthly package; `Elementary` / `Premium` = the account must hold that RU package or a higher one.
- **Feat** (per BlockPI table, `-` = not offered): `A` archive mode available · `T` `trace_*` · `D` `debug_*` · `M` MEV protection · `G` Global Cast.
- **Chain ID**: as printed on BlockPI's MetaMask page (`-` = not listed there; confirm with `eth_chainId`).
- **Src**: `D` hostname appears in docs.blockpi.io · `S` shown on blockpi.io / public.blockpi.io · `L` in no official page, but the host exists on BlockPI's gateway (row mapping inferred) · `!` hostname resolves to 0.0.0.0 (sinkholed; treat as decommissioned) · `?` unverified.

### EVM mainnets (42) — `https://{slug}.blockpi.network/v1/rpc/{KEY}`

| Network | Slug | Chain ID | Tier | Feat | Src |
|---|---|---|---|---|---|
| Ethereum Mainnet | `ethereum` | 1 | Free | ATDMG | DS |
| Arbitrum One | `arbitrum` | - | Free | A-D-- | DS |
| Arbitrum Nova | `arbitrum-nova` | - | Free | A-D-- | DS |
| OP Mainnet | `optimism` | 10 | Free | A-D-- | DS |
| Polygon Mainnet | `polygon` | 137 | Free | A-DMG | DS |
| BSC Mainnet | `bsc` | 56 | Free | ATDMG | DS |
| Kaia Mainnet | `kaia` | 8217 | Free | A-D-- | DS |
| zkSync Era Mainnet | `zksync-era` | 324 | Free | ----- | D |
| Scroll Mainnet | `scroll` | 534352 | Free | --D-- | DS |
| Zetachain Mainnet-EVM | `zetachain-evm` | 7000 | Free | A-D-- | DS |
| Base Mainnet | `base` | 8453 | Free | A-DMG | DS |
| Linea Mainnet | `linea` | 59144 | Free | --D-- | DS |
| Gnosis Mainnet | `gnosis` | 100 | Free | A---- | DS |
| Avalanche Standard EVM | `avalanche` | 43114 | Free | A-D-- | DS |
| Fantom Opera | `fantom` | 250 | Free | ATD-- | DS |
| Cronos Mainnet | `cronos` | 25 | Free | A-D-- | DS |
| Meter Mainnet | `meter` | 82 | Free | --D-- | DS |
| Viction Mainnet | `viction` | 88 | Free | --D-- | DS |
| Taiko Mainnet | `taiko` | 167000 | Free | A-D-- | DS |
| Blast Mainnet | `blast` | 81457 | Free | A-D-- | DS |
| Conflux eSpace | `conflux-espace` | 1030 | Free | A---- | DS |
| Merlin Mainnet | `merlin` | 4200 | Free | ----- | DS |
| Mantle Mainnet | `mantle` | 5000 | Free | --D-- | DS |
| Celo Mainnet | `celo` | 42220 | Free | --D-- | DS |
| Unichain Mainnet | `unichain` | 130 | Elementary | --D-- | DS |
| Metis Mainnet | `metis` | 1088 | Free | --D-- | DS |
| Story Mainnet | `story` | 1514 | Free | --D-- | DS |
| Sonic Mainnet | `sonic` | - | Free | ----- | S |
| Ink Mainnet | `ink` | - | Free | ----- | S |
| Abstract Mainnet | `abstract` | 2741 | Elementary | ----- | DS |
| Berachain Mainnet | `berachain` | 80094 | Free | ----- | DS |
| Monad Mainnet | `monad` | 143 | Elementary | --D-- | DS |
| t3rn Mainnet | `t3rn` | 819 | Free | ----- | D! |
| Sei Mainnet EVM | `sei-evm` | 1329 | Elementary | --D-- | DS |
| X Layer Mainnet | `xlayer` | 196 | Elementary | --D-- | DS |
| Hyperliquid Mainnet (HyperEVM) | `hyperliquid` | 999 | Elementary | A---- | DS |
| Etherlink Mainnet | `etherlink` | 42793 | Elementary | ----- | DS |
| Hemi Mainnet | `hemi` | 43111 | Elementary | ----- | DS |
| Stable Mainnet | `stable` | 988 | Elementary | A---- | DS |
| Plasma Mainnet | `plasma` | 9745 | Free | ----- | DS |
| Arc Mainnet | `arc` | 5042 | Elementary | -TD-- | DS |
| Robinhood Chain | `robinhood` | 4663 | Elementary | --D-- | DS |

### EVM testnets (19) — same URL shape

| Network | Slug | Chain ID | Tier | Feat | Src |
|---|---|---|---|---|---|
| Ethereum Sepolia | `ethereum-sepolia` | 11155111 | Elementary | -TD-- | D |
| Ethereum Hoodi | `ethereum-hoodi` | 560048 | Free | -TD-- | D |
| Arbitrum Sepolia | `arbitrum-sepolia` | - | Free | A-D-- | L |
| OP Sepolia | `optimism-sepolia` | 11155420 | Free | A---- | D |
| Polygon Amoy | `polygon-amoy` | 80002 | Free | --D-- | D |
| BSC Testnet | `bsc-testnet` | - | Free | ATD-- | S |
| Kaia Kairos | `kaia-kairos` | 1001 | Free | A-D-- | D |
| zkSync Era Sepolia | `zksync-era-sepolia` | 300 | Free | ----- | DS |
| Scroll Sepolia | `scroll-sepolia` | 534351 | Free | --D-- | D |
| Zetachain Athens-EVM | `zetachain-athens-evm` | 7001 | Free | --D-- | DS |
| Base Sepolia | `base-sepolia` | 84532 | Free | --D-- | DS |
| Linea Sepolia | `linea-sepolia` | 59141 | Free | --D-- | D |
| Avalanche Testnet | `avalanche-fuji` | - | Free | --D-- | L |
| Merlin Testnet | `merlin-testnet` | 686868 | Free | ----- | DS |
| Celo Sepolia | `celo-sepolia` | 11142220 | Free | --D-- | D |
| Unichain Sepolia | `unichain-sepolia` | 1301 | Free | --D-- | D |
| Monad Testnet | `monad-testnet` | 10143 | Elementary | --D-- | D |
| Sei Testnet EVM | `sei-testnet-evm` | 1328 | Elementary | --D-- | D |
| Arc Testnet | `arc-testnet` | 5042002 | Free | -TD-- | D |

Slug notes:
- `taiko`: the docs' MetaMask page prints `https://taiko.network/...` (typo); the real host is `taiko.blockpi.network` (API-reference pages + blockpi.io).
- `avalanche-fuji`: in no official page. The host exists on BlockPI's gateway while `avalanche-testnet` returns `unknown host`; assumed to be the "Avalanche Testnet" row — confirm in the dashboard.
- `arbitrum-sepolia`: also gateway-only (`L`). `sonic`, `ink`, `bsc-testnet`: only on blockpi.io chain pages (`S`).
- `t3rn`: still listed in the docs table, but `t3rn.blockpi.network` resolves to 0.0.0.0 — treat as retired.
- `hyperliquid` is HyperEVM (chain 999). Hyperliquid L1 `info`/`exchange` APIs use the same slug (below).

### Non-EVM (16 rows)

Method sets: `rpc/non-evm/<chain>.md` (e.g. `solana.md`, `sui.md`, `aptos.md`, `near.md`, `ton.md`). BlockPI differs only in URL shape and auth — shown here (replace `{KEY}`).

| Network | Slug | Tier | BlockPI URL shape |
|---|---|---|---|
| Solana Mainnet | `solana` | Premium | `https://solana.blockpi.network/v1/rpc/{KEY}` (Solana JSON-RPC; Yellowstone gRPC also offered) |
| Eclipse Mainnet | `eclipse` | Elementary | `https://eclipse.blockpi.network/v1/rpc/{KEY}` (SVM; billed on the Solana/Eclipse RU table) |
| SUI Mainnet | `sui` | Free | gRPC `sui.blockpi.network:443` with metadata `x-token: {KEY}`; GraphQL `https://sui.blockpi.network/v1/graphql/{KEY}` (latest 90 days); testnet gRPC `sui-testnet.blockpi.network`. SUI JSON-RPC is being phased out (docs: it "will no longer return data"). |
| SUI Mainnet Archive | `sui-archive` | Elementary | gRPC only, `sui-archive.blockpi.network:443`; needs its own endpoint/key created as "SUI Mainnet Archive" |
| Aptos Mainnet | `aptos` | Free | REST `https://aptos.blockpi.network/aptos/v1/{KEY}/v1/<aptos-api-path>` |
| Movement Mainnet | `movement` | Free | REST `https://movement.blockpi.network/rpc/v1/{KEY}/v1/<aptos-api-path>` |
| Near Mainnet | `near` | Free | JSON-RPC `https://near.blockpi.network/v1/rpc/{KEY}` (e.g. method `block`, params `{"finality":"final"}`) |
| Ton Mainnet | `ton` | Elementary | REST GET `https://ton.blockpi.network/v1/rpc/{KEY}/<method>?...` (e.g. `getAddressBalance?address=`), v3: `https://ton.blockpi.network/v1/api/{KEY}/api/v3/<path>` |
| Starknet Mainnet | `starknet` | Free | JSON-RPC `https://starknet.blockpi.network/v1/rpc/{KEY}` (`starknet_*` methods) |
| Bitcoin Mainnet | `bitcoin` | Free | Bitcoin Core JSON-RPC `https://bitcoin.blockpi.network/v1/rpc/{KEY}` (body uses `"jsonrpc":"1.0"`, e.g. `getblockcount`) |
| Cosmos Mainnet | `cosmos` | Free | Tendermint RPC `https://cosmos.blockpi.network/rpc/v1/{KEY}/<path>` (e.g. `abci_info`); LCD REST `https://cosmos.blockpi.network/lcd/v1/{KEY}/<path>` |
| Zetachain Mainnet (Cosmos side) | `zetachain` | Free | same two shapes: `/rpc/v1/{KEY}/<path>`, `/lcd/v1/{KEY}/<path>` (+ `/zeta-chain/...` modules); EVM side is `zetachain-evm` |
| Zetachain Athens (Cosmos side) | `zetachain-athens` | Free | same shapes as `zetachain`; EVM side is `zetachain-athens-evm` |
| Ethereum Beacon Chain | `ethereum-beacon` | Free | Beacon REST `https://ethereum-beacon.blockpi.network/rpc/v1/{KEY}/eth/v1/<path>` |
| Sepolia Beacon Chain | `ethereum-sepolia-beacon` | Elementary | host exists, undocumented; path shape assumed same as `ethereum-beacon` |
| Hoodi Beacon Chain | `ethereum-hoodi-beacon` | Free | host exists, undocumented; path shape assumed same as `ethereum-beacon` |

Hyperliquid L1 (same slug as HyperEVM; the docs show the same key placeholder for all three paths): `POST https://hyperliquid.blockpi.network/v1/info/{KEY}` (read-only market/state queries) and `POST https://hyperliquid.blockpi.network/v1/exchange/{KEY}` (trading actions).

### Not in the current table
- `plume` — EVM, only on blockpi.io/chain/plume (`https://plume.blockpi.network/v1/rpc/{KEY}`); no docs row.
- Docs API-reference sections with no current row (status unknown): `0g-galileo`, `artela-testnet`, `oasys`, `zkfair`.
- Sinkholed (hostname resolves to 0.0.0.0 — treat as decommissioned): `ethereum-holesky`, `polygon-zkevm`, `flow-evm`, `berachain-bartio`, `taiko-hekla`, `story-odyssey-evm`, `klaytn`.

The list grows over time. Authoritative: the endpoint URL in the user's BlockPI dashboard, and https://docs.blockpi.io/build/supported-networks-and-advanced-features (append `.md` for raw markdown).

## 4 · Standard EVM methods

All standard `eth_*` / `net_*` / `web3_*` methods, params and hex conventions: `rpc/evm-methods.md`. BlockPI-ready examples (replace the slug; `eth_chainId` first is a cheap check that key and chain match the Chain ID column):

```bash
# bp <slug> <method> [params-json]  — keyed call; the key stays in $BLOCKPI_KEY
bp() { curl -s -X POST "https://$1.blockpi.network/v1/rpc/$BLOCKPI_KEY" -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"$2\",\"params\":${3:-[]},\"id\":1}"; }
bp ethereum eth_chainId        # {"jsonrpc":"2.0","id":1,"result":"0x1"}
```
Latest block (BlockPI docs example):
```bash
curl -s -X POST "https://ethereum.blockpi.network/v1/rpc/$BLOCKPI_KEY" -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# {"jsonrpc":"2.0","id":1,"result":"0xf2f8c7"}
```
Native balance, wei as hex (BlockPI docs example):
```bash
curl -s -X POST "https://ethereum.blockpi.network/v1/rpc/$BLOCKPI_KEY" -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x407d73d8a49eeb85d32cf465507dd71d507100c1","latest"],"id":1}'
# {"jsonrpc":"2.0","id":1,"result":"0x0"}
```
Batch — one HTTPS request, answers come back in request order, each inner request is billed (cap 1000 on keyed HTTPS):
```bash
curl -s -X POST "https://bsc.blockpi.network/v1/rpc/$BLOCKPI_KEY" -H "Content-Type: application/json" \
  --data '[{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1},
           {"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":2},
           {"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":3}]'
# [{"jsonrpc":"2.0","id":1,"result":"0x38"},{"jsonrpc":"2.0","id":2,"result":"0x..."},{"jsonrpc":"2.0","id":3,"result":"0x..."}]
```
`eth_sendRawTransaction` is a write — broadcast only on the user's explicit instruction.

## 5 · RU (Request Unit) metering

Every request is billed in **RU**; heavier methods cost more. Official per-method price lists:
- EVM (+ zkEVM `zkevm_*`, zkSync `zks_*`, Beacon REST): https://docs.blockpi.io/pricing/request-unit-ru/evm-ru-table
- Solana/Eclipse: `.../solana-eclipse-ru-table` · SUI: `.../sui-ru-table` · Aptos/Movement: `.../aptos-movement-ru-table` · Bitcoin: `.../aptos-movement-ru-table-1` · Cosmos/Zetachain: `.../cosmos-zetachain-ru-table` · Near: `.../near-ru-table` · TON: `.../ton-ru-table` · Starknet: `.../starknet-ru-table` (all under https://docs.blockpi.io/pricing/request-unit-ru/)
- Surcharge rules: https://docs.blockpi.io/pricing/request-unit-ru · plans + rate limits: https://docs.blockpi.io/pricing/pricing-and-rate-limit · calculator: https://blockpi.io/pricing/

EVM price groups (RU per call, from the official table):

| RU | Methods |
|---|---|
| 5 | `eth_chainId`, `eth_syncing`, `net_version`, `net_listening`, `net_peerCount` |
| 10 | `eth_blockNumber`, `eth_uninstallFilter`, `txpool_status`, `txpool_inspect` |
| 15 | `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_gasPrice`, `eth_hashrate`, `eth_getTransactionReceipt`, `eth_getBlockTransactionCountByHash/Number`, `eth_getUncleCountByBlockHash/Number`, `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`, `web3_clientVersion`, `web3_sha3`, `trace_get`, `debug_getRawTransaction`, `debug_getRawHeader` |
| 20 | `eth_call`, `eth_estimateGas`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getFilterChanges`, `trace_block`, `trace_transaction` |
| 30 | `eth_getTransactionByBlockHashAndIndex`, `eth_getTransactionByBlockNumberAndIndex`, `eth_getUncleByBlockHashAndIndex`, `eth_getUncleByBlockNumberAndIndex` |
| 35 | `eth_getTransactionByHash` |
| 40 | `debug_getRawBlock` |
| 50 | `eth_getLogs` |
| 60 | `trace_call`, `trace_rawTransaction`, `trace_filter` |
| 150 | `debug_traceCall`, `debug_traceTransaction`, `debug_traceBlockByHash`, `debug_traceBlockByNumber`, `eth_getBlockReceipts` |
| 200 | `eth_sendRawTransaction` |
| 400 | `debug_getRawReceipts` |
| 2900 | `trace_replayTransaction` |

Other families: Solana/Eclipse default 65 (`getLargestAccounts`, `getSupply` 260; gRPC 50) · Bitcoin 30 (`getblock` 500, `getrawmempool` 2000) · Aptos/Movement 20-120 · Near 20-1000 · TON 150-500 · Starknet 0-80 · SUI JSON 20-2000 (gRPC 50) · Cosmos LCD 5-5000, Tendermint RPC 5-4000.

Extra RU on top of the table:
- Methods not in the table (e.g. `eth_subscribe`): 5 RU per 250 bytes of data.
- Response over 1 MB: +100% per additional 1 MB. `eth_getLogs` over 200 KB: +100% per additional 200 KB.
- **Archive Mode on the key: +30% RU on every request of that key.**
- Batch: billed per inner request.
- Polygon with MEV protection enabled: each `eth_sendRawTransaction` costs 250,000 RU.
- SUI Archive gRPC: base 50 RU per method, +100% per additional 100 KB over 100 KB.

Plans (official; RU limits are per endpoint, and the most advanced package in the account sets the limit):

| Plan | Price | RU | Valid | Rate limit |
|---|---|---|---|---|
| Public (keyless) | free | - | - | 10 req/s, 200 RU/s |
| Free | $0 | 50M, re-gifted on the 1st of each month | 32 days | 20 req/s, 400 RU/s |
| Elementary | $49 | 500M | 60 days | 1,000 req/s, 40,000 RU/s |
| Premium | $299 | 4,000M | 90 days | 2,500 req/s, 100,000 RU/s |
| Pay As You Go | $0.01 per 50,000 RU | wallet-funded, kicks in when RU hit 0 and wallet > $0.01 | - | 20 req/s, 1,000 RU/s |
| Enterprise | contact BlockPI | custom | - | custom |

- Either limit (requests/s or RU/s) exceeded => rate-limit error. Packages are consumed first-expiring-first. At 0 RU the key **freezes** unless the user set Auto-Renew or Pay As You Go.
- Budget feel (Free, 50M RU): about 5M `eth_blockNumber`, 2.5M `eth_call`, 1M `eth_getLogs`, 333k `debug_trace*`. Free 400 RU/s allows about 8 `eth_getLogs`/s or 20 `eth_call`/s.
- Check the balance with any key of the account (per docs, not live-tested — needs a real key):

```bash
curl -s https://api.blockpi.io/openapi/v1/rpc -X POST -H "Content-Type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"blockpi_ruBalance\",\"params\":[{\"apiKey\":\"$BLOCKPI_KEY\"}],\"id\":1}"
# {"jsonrpc":"2.0","id":1,"result":{"balance":<RU left>}}
```
Same endpoint: `blockpi_ruConsumed` (params `{"apiKey":...,"days":"1"}`; days = "1", "3" or "7"; returns `cost`), `blockpi_packageExpiration` (returns `details[]` with `ruTotalAmount`, `ruLeftAmount`, `skuName`, `expireTime`), `blockpi_walletBalance` (USD).

**Archive / trace / debug per plan**
- Archive data, `debug_*` and `trace_*` are listed for every registered plan (Free, Elementary, Premium, Pay As You Go, Enterprise); the keyless public endpoints have none of them. They only work on chains flagged `A` / `D` / `T` in section 3.
- Archive is a **per-key switch the user flips in the dashboard** (effective after a few minutes; the agent cannot change it). It routes all requests of that key to archive nodes (+30% RU, slower). Users often keep a second key with archive ON just for historical queries.
- `debug_*` only supports `callTracer` and `prestateTracer` (no custom tracers).
- Chains with Tier `Elementary` / `Premium` are unusable on a Free-only account.

## 6 · Gotchas

- **Slug is not the common name**: `optimism` (not `op`), `arbitrum` = Arbitrum One, `bsc` (not `bnb`), `sei-evm`, `zksync-era`, `conflux-espace`, `xlayer`, `ethereum-beacon` = consensus layer, `hyperliquid` = HyperEVM. A wrong subdomain returns `{"error":{"code":-32000,"message":"unknown host"}}` (HTTP 404). Use the table; do not guess.
- **Key is per chain**: use the vault slot made for that chain. Wrong/unknown key => HTTP 503 `Apikey not found` (100021). Never brute-force slugs or keys: a short burst of bad-key requests (a handful in a few seconds) got plain-text HTTP 402 `Payment Required` for minutes (observed).
- **Secret URL**: key in path => never echo/log/commit it; scrub it from error output; use `curl -s`, avoid `curl -v` and `set -x`.
- **User-Agent**: Python's default `urllib` UA gets `403 error code: 1010` from BlockPI's edge. `curl`, `requests`, or any custom `User-Agent` header works.
- **Where errors show up**: node/method errors come as HTTP 200 + JSON-RPC `error` (`-32602` range/params, `-32000` disabled method or limit, `-32601` unsupported over HTTP); gateway errors come as HTTP 503 with an `error` object (`100021` Apikey not found, `Max messages exceeded (Limit: N)`, "exceeded the level limit"). Always parse the body, not just the status.
- **RU exhausted**: BlockPI errors `ErrUserBalanceIsNotEnough` ("Insufficient RU balance") / `ErrApikeyIsExpired` / `ErrApikeyNotFound`. Do not retry — stop and tell the user (buy a package, set Auto-Renew/Pay As You Go, or check the key in the dashboard).
- **Rate limit** (`ErrorRateLimitExceed` / `ErrorTicketRateLimitExceed`, HTTP 429, or "you have exceeded the level limit"): limits are per endpoint and double-gated (req/s AND RU/s — heavy methods hit RU/s first). Back off 1s, 2s, 4s, 8s with jitter (max ~5 tries), lower concurrency, batch cheap calls.
- **Public endpoints are heavily limited vs keyed**: 10 req/s and 200 RU/s (a Free key gets 20 / 400, Elementary 1,000 / 40,000), no `debug_*`/`trace_*`/WS, smaller batch and response caps — and it is a shared pool: `merlin.blockpi.network/v1/rpc/public` answered `-32000 "...exceeded the level limit. Upgrade your plan at https://blockpi.io"` (HTTP 503) on the first call in testing. Use a keyed endpoint for anything real.
- **`eth_getLogs` range**: 1024 blocks without `address`/`topics`; 5000 with `address` or `topics` on keyed endpoints (docs say 1024 on public; ethereum.public showed 5000 with `address`). Over the cap => `-32602` (`ErrMethodLogsArgvLimit1024/5000`). Page the range:

```python
# run after `export BLOCKPI_KEY` (the shell variable must be exported to be visible here)
import json, os, urllib.request
URL = f"https://ethereum.blockpi.network/v1/rpc/{os.environ['BLOCKPI_KEY']}"
def rpc(method, params):
    req = urllib.request.Request(URL, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 {"Content-Type": "application/json", "User-Agent": "clawby-agent/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=30))
def get_logs(start, end, address, step=5000):          # step 1000 if no address/topics
    out, lo = [], start
    while lo <= end:
        hi = min(lo + step - 1, end)
        r = rpc("eth_getLogs", [{"fromBlock": hex(lo), "toBlock": hex(hi), "address": address}])
        if "error" in r: raise RuntimeError(r["error"])
        out += r["result"]; lo = hi + 1
    return out
```
- **Batch caps**: keyed HTTPS 1000, public 10 (observed 5), WSS none. A huge batch in one HTTPS request can time out — chunk it. Over the cap => `ErrorMaxMessagesExceed`.
- **HTTPS-only limits**: no `eth_subscribe` (WSS only; BlockPI cuts WebSockets every 30 minutes — reconnect and resubscribe) and no filter methods (`eth_newFilter`, `eth_newBlockFilter`, `eth_getFilterChanges`; e.g. `eth_newBlockFilter` => `-32000 "method is disabled"`, observed). Poll `eth_blockNumber` / `eth_getLogs` ranges instead. Public endpoints also lack WS, `debug_*`, `trace_*`; max response 3 MB (`ErrMaxResponseMessageSizeExceed`).
- **Historical state needs Archive Mode on that key**: `missing trie node`, `required historical state unavailable`, `missing revert data in call exception` (and a 404 on pruned Beacon data) mean archive is off or the chain has no archive — ask the user to enable it.
- **IP whitelist**: the user may restrict an endpoint to up to 10 IPs/domains; requests from other IPs get an error — ask them to add this machine's IP.
- **Writes**: `eth_sendRawTransaction` only on explicit instruction. MEV protection / Global Cast are mutually exclusive per-key switches on Ethereum, Polygon, BSC and Base; Polygon MEV protection costs 250,000 RU per transaction.
- **Chain specifics**: SUI JSON-RPC is retired (use gRPC/GraphQL); Solana needs a Premium package; Taiko docs typo; `t3rn` host is sinkholed (table above).
- **SSLCertVerificationError** is the caller's local certificate setup, not BlockPI.

Official references: https://docs.blockpi.io/ (index: `/llms.txt`) · supported networks: `/build/supported-networks-and-advanced-features` · restrictions: `/basic-tutorials/best-practices` · errors: `/supports/rpc-error-reference` · status: https://status.blockpi.io
