# Alchemy RPC (BYOK)

EVM JSON-RPC, Alchemy-only **Enhanced APIs** (tokens, transfers, NFTs, prices, trace/debug, subscriptions) and non-EVM chains, using the user's **own Alchemy key** fetched from the Clawby Key Vault. Direct to Alchemy — not via Clawby relay, no Clawby credits.

Network list, limits and examples were checked against Alchemy's official docs and live probes on **2026-10-25** (sources: §7). Alchemy adds and retires networks often: treat §3 as a snapshot and trust a live 401/403 over this file.

## 1 · Get the key (keep in memory, never write to disk)

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/alchemy -H "X-API-Key: $CLAWBY_API_KEY")
ALCHEMY_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
If the user set a trusted-IP whitelist, **this machine's public IP must be on it**, and their **vault retrieval switch must be ON**, otherwise the fetch is refused (`403 ip_not_allowed` / `403 vault_disabled`; `404 not_found` = no Alchemy key stored). Full error shapes + response format: `rpc/index.yaml`. A user may store up to 3 keys (`keys[]` slots) — pick by `label`.

**One key works on many networks — it is per Alchemy *app*, not per network.** An app owns one API key plus a **network allowlist**; the same key string works on every network enabled for that app and only the subdomain changes (Alchemy's Admin API returns one `apiKey` and a `chainNetworks[]` list whose `rpcUrl`s all embed that same key). A network that is not enabled for the app is refused:
```text
HTTP 403  {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"OPT_MAINNET is not enabled for this app. Visit this page to enable the network: https://dashboard.alchemy.com/apps/<appId>/networks"}}
```
Vault slots are normally different apps/keys — if one slot says "not enabled" or 401, try the next slot before giving up. The user's app may also carry **Alchemy-side** IP / origin / contract-address allowlists (separate from Clawby's whitelist), see §6 error table.

Zero-cost smoke test (`eth_chainId` = 0 CU) — 200 + `"result":"0x1"` means key + network are good:
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

## 2 · Endpoint

```
https://{network}.g.alchemy.com/v2/{ALCHEMY_KEY}     # JSON-RPC, HTTPS POST  (all request/response calls)
wss://{network}.g.alchemy.com/v2/{ALCHEMY_KEY}       # WebSocket             (eth_subscribe streams only, §5.7)
```
`{network}` = the slug from §3 — **not** the chain's common name. **The key is in the URL path, so the whole URL is a secret**: never echo, log, commit, or paste it into other tools. JSON-RPC conventions (POST body, batch, hex, errors): `rpc/index.yaml`. HTTP 200 can still carry an `error` object — check both.

Other Alchemy products live on different bases (same key):

| API | Base |
|---|---|
| NFT API (REST) | `https://{network}.g.alchemy.com/nft/v3/{ALCHEMY_KEY}/{endpoint}?...` |
| Prices API (REST) | `https://api.g.alchemy.com/prices/v1/{ALCHEMY_KEY}/tokens/...` |
| Portfolio / Data API (REST) | `https://api.g.alchemy.com/data/v1/{ALCHEMY_KEY}/...` |

**Header form (keeps the key out of URLs and logs)** — officially documented for JSON-RPC, NFT API and Prices API; WebSocket stays path-based:
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2" -H "Authorization: Bearer $ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# NFT API:  https://eth-mainnet.g.alchemy.com/nft/v3/getNFTsForOwner?owner=...   Prices: https://api.g.alchemy.com/prices/v1/tokens/by-symbol?symbols=ETH   (same Bearer header)
```
Keyless fallback (no user key, shared/rate-limited, not for production): `https://{slug}.g.alchemy.com/public` works only for `arb-mainnet`, `base-mainnet`, `bnb-mainnet`, `eth-mainnet`, `gensyn-testnet`, `settlus-mainnet`, `settlus-septestnet`, `shape-mainnet`, `shape-sepolia`, `worldchain-mainnet`, `worldchain-sepolia` (verified live; every other slug answers 403 "not enabled for this app").

## 3 · Networks (snapshot 2026-10-25)

Source: Alchemy's public network directory (`alchemy.com/rpc/<network>`, 154 pages crawled) + the docs' "List of HTTP URLs by supported network" (158 rows). §3.1-3.4 list **181 slugs** (65 EVM mainnets + 62 EVM testnets + 26 non-EVM + 28 docs-table-only); retired ones are in §3.5.

**Slug rules.** The slug is the subdomain. It is **not** the common name: `arb-mainnet` = Arbitrum One, `opt-mainnet` = OP Mainnet, `bnb-mainnet` = BNB Smart Chain, `avax-mainnet` = Avalanche C-Chain, `story-mainnet` = DATA Network, `worldchain-mainnet` (no hyphen), `polygon-mainnet` = Polygon PoS. A wrong slug returns no JSON (TLS/DNS failure). **Data APIs (Portfolio, Prices) take `network` values in the request body; in Alchemy's examples/enums they equal the slug except Polygon = `matic-mainnet` / `matic-amoy`** (full enum list is only in the Dashboard "Chains" page — unverified for other chains).

Most used: `eth-mainnet` Ethereum · `polygon-mainnet` Polygon · `arb-mainnet` Arbitrum One · `opt-mainnet` OP · `base-mainnet` Base · `bnb-mainnet` BNB Chain · `avax-mainnet` Avalanche C · `zksync-mainnet` ZKsync · `linea-mainnet` · `scroll-mainnet` · `blast-mainnet` · `mantle-mainnet` · `gnosis-mainnet` · `celo-mainnet` · `unichain-mainnet` · `worldchain-mainnet` · `solana-mainnet` (non-EVM, §3.3).

**`enhanced` column** = which Alchemy-only APIs the network supports (from its directory page; the live Dashboard → Chains page is authoritative): `T` Token API (`alchemy_getTokenBalances/Metadata/Allowance`) · `X` Transfers (`alchemy_getAssetTransfers`) · `N` NFT API · `D` Debug · `R` Trace · `P` Prices · `B` `alchemy_getTransactionReceipts` · `W` WebSocket subscriptions · `G` gRPC · `—` none listed. All EVM rows support standard `eth_*` JSON-RPC.

### 3.1 EVM mainnets (65)

| slug | network | chain ID | enhanced |
|---|---|---|---|
| `abstract-mainnet` | Abstract | 2741 | TXNDW |
| `adi-mainnet` | ADI | 36900 | DW |
| `anime-mainnet` | Anime | 69000 | XNDW |
| `apechain-mainnet` | ApeChain | 33139 | TXNDPW |
| `arb-mainnet` | Arbitrum One | 42161 | TXNDRPBW |
| `arc-mainnet` | Arc | 5042 | TXNDRPW |
| `astar-mainnet` | Astar | 592 | DW |
| `avax-mainnet` | Avalanche C-Chain | 43114 | TXNDPW |
| `base-mainnet` | Base | 8453 | TXNDPBW |
| `berachain-mainnet` | Berachain | 80094 | TXNDW |
| `blast-mainnet` | Blast | 81457 | TXNDPW |
| `bnb-mainnet` | BNB Smart Chain | 56 | TXDRPW |
| `bob-mainnet` | BOB | 60808 | DW |
| `boba-mainnet` | Boba | 288 | DW |
| `celo-mainnet` | Celo | 42220 | TXNDW |
| `citrea-mainnet` | Citrea | 4114 | DW |
| `cronos-mainnet` | Cronos | 25 | DW |
| `crossfi-mainnet` | CrossFi | 4158 | DW |
| `eth-mainnet` | Ethereum | 1 | TXNDRPBW |
| `flow-mainnet` | Flow EVM | 747 | DW |
| `frax-mainnet` | Frax | 252 | DW |
| `gensyn-mainnet` | Gensyn | 685689 | DW |
| `gnosis-mainnet` | Gnosis | 100 | TXPW |
| `humanity-mainnet` | Humanity | 6985385 | DR |
| `hyperliquid-mainnet` | Hyperliquid (HyperEVM) | 999 | TXDW |
| `injective-mainnet` | Injective | 1776 | W |
| `ink-mainnet` | Ink | 57073 | TXDW |
| `jovay-mainnet` | Jovay | 5734951 | W |
| `kaia-mainnet` | Kaia | 8217 | W |
| `katana-mainnet` | Katana | 747474 | W |
| `lens-mainnet` | Lens | 232 | DW |
| `linea-mainnet` | Linea | 59144 | TXNDPW |
| `mantle-mainnet` | Mantle | 5000 | DW |
| `megaeth-mainnet` | MegaETH | 4326 | DW |
| `metis-mainnet` | Metis | 1088 | DPW |
| `mode-mainnet` | Mode | 34443 | DW |
| `monad-mainnet` | Monad | 143 | TXNDPW |
| `moonbeam-mainnet` | Moonbeam | 1284 | D |
| `mythos-mainnet` | Mythos | 42018 | TXNDW |
| `opbnb-mainnet` | opBNB | 204 | DPW |
| `opt-mainnet` | OP Mainnet | 10 | TXNDRPBW |
| `pharos-mainnet` | Pharos | 1672 | W |
| `plasma-mainnet` | Plasma | 9745 | DRW |
| `polygon-mainnet` | Polygon PoS (Data APIs: `matic-mainnet`) | 137 | TXNDPBW |
| `rise-mainnet` | Rise | 4153 | W |
| `robinhood-mainnet` | Robinhood Chain | 4663 | TXNPW |
| `ronin-mainnet` | Ronin | 2020 | TXDW |
| `rootstock-mainnet` | Rootstock | 30 | TXNDRW |
| `scroll-mainnet` | Scroll | 534352 | TXNDPW |
| `sei-mainnet` | Sei | 1329 | DW |
| `settlus-mainnet` | Settlus | 5371 | TXNDW |
| `shape-mainnet` | Shape | 360 | TXNDW |
| `soneium-mainnet` | Soneium | 1868 | TXNW |
| `sonic-mainnet` | Sonic | 146 | DRW |
| `stable-mainnet` | Stable | 988 | DW |
| `story-mainnet` | DATA Network (formerly Story) | 1514 | TXNDW |
| `superseed-mainnet` | Superseed | 5330 | DW |
| `tempo-mainnet` | Tempo | 4217 | DW |
| `unichain-mainnet` | Unichain | 130 | TXNDW |
| `worldchain-mainnet` | World Chain | 480 | TXNPW |
| `worldmobilechain-mainnet` | World Mobile Chain | 869 | DW |
| `xlayer-mainnet` | X Layer | 196 | DW |
| `zetachain-mainnet` | ZetaChain | 7000 | DPW |
| `zksync-mainnet` | ZKsync Era | 324 | TXNDPW |
| `zora-mainnet` | Zora | 7777777 | TXNDW |

### 3.2 EVM testnets (62)

| slug | network | chain ID | enhanced |
|---|---|---|---|
| `abstract-testnet` | Abstract Testnet | 11124 | TXNDW |
| `adi-testnet` | ADI Testnet AB | 99999 | DW |
| `alpen-testnet` | Alpen Testnet | 20310 | DRW |
| `anime-sepolia` | Anime Sepolia | 6900 | TXDW |
| `apechain-curtis` | ApeChain Curtis | 33111 | TXNDW |
| `arb-sepolia` | Arbitrum Sepolia | 421614 | TXNDBW |
| `arc-testnet` | Arc Testnet | 5042002 | TXNDRPW |
| `avax-fuji` | Avalanche C-Chain Fuji | 43113 | TXNDW |
| `base-sepolia` | Base Sepolia | 84532 | TXNDBW |
| `berachain-bepolia` | Berachain Bepolia | 80069 | DW |
| `blast-sepolia` | Blast Sepolia | 168587773 | TXNDW |
| `bnb-testnet` | BNB Smart Chain Testnet | 97 | TXW |
| `bob-sepolia` | BOB Sepolia | 808813 | DW |
| `boba-sepolia` | Boba Sepolia | 28882 | DW |
| `celo-sepolia` | Celo Sepolia | 11142220 | TXDW |
| `citrea-testnet` | Citrea Testnet | 5115 | DW |
| `cronos-testnet` | Cronos Testnet | 338 | DW |
| `crossfi-testnet` | CrossFi Testnet | 4157 | DW |
| `elysium-testnet` | Elysium Testnet | 99801 | W |
| `eth-hoodi` | Ethereum Hoodi | 560048 | DRW |
| `eth-sepolia` | Ethereum Sepolia | 11155111 | TXNDRBW |
| `flow-testnet` | Flow EVM Testnet | 545 | W |
| `gensyn-testnet` | Gensyn Testnet | 685685 | TXDW |
| `giwa-sepolia` | Giwa Sepolia | 91342 | W |
| `gnosis-chiado` | Gnosis Chiado | 10200 | TXW |
| `hyperliquid-testnet` | Hyperliquid HyperEVM Testnet | 998 | W |
| `injective-testnet` | Injective Testnet | 1439 | W |
| `ink-sepolia` | Ink Sepolia | 763373 | TXDW |
| `jovay-testnet` | Jovay Testnet | 2019775 | W |
| `kaia-testnet` | Kaia Kairos Testnet | 1001 | W |
| `katana-bokuto` | Katana Bokuto | 737373 | W |
| `lens-sepolia` | Lens Sepolia | 37111 | TXNDW |
| `linea-sepolia` | Linea Sepolia | 59141 | TXNDW |
| `mantle-sepolia` | Mantle Sepolia | 5003 | DW |
| `megaeth-testnet` | MegaETH Testnet | 6343 | DW |
| `mode-sepolia` | Mode Sepolia | 919 | DW |
| `monad-testnet` | Monad Testnet | 10143 | DW |
| `opbnb-testnet` | opBNB Testnet | 5611 | DW |
| `opt-sepolia` | OP Sepolia | 11155420 | TXNDRBW |
| `pharos-atlantic` | Pharos Atlantic | 688689 | W |
| `plasma-testnet` | Plasma Testnet | 9746 | DRW |
| `polygon-amoy` | Polygon PoS Amoy (Data APIs: `matic-amoy`) | 80002 | TXNDBW |
| `rise-testnet` | Rise Testnet | 11155931 | DW |
| `robinhood-testnet` | Robinhood Chain Testnet | 46630 | TXNPW |
| `ronin-saigon` | Ronin Saigon | 202601 | TXDW |
| `rootstock-testnet` | Rootstock Testnet | 31 | TXND |
| `sei-testnet` | Sei Testnet | 1328 | DW |
| `settlus-septestnet` | Settlus Sepolia | 5373 | TXNDW |
| `shape-sepolia` | Shape Sepolia | 11011 | TXNDW |
| `soneium-minato` | Soneium Minato | 1946 | TXNDW |
| `sonic-testnet` | Sonic Testnet | 14601 | DRW |
| `stable-testnet` | Stable Testnet | 2201 | DW |
| `story-aeneid` | DATA Network Aeneid | 1315 | XNDW |
| `superseed-sepolia` | Superseed Sepolia | 53302 | DW |
| `tempo-moderato` | Tempo Moderato | 42431 | DW |
| `unichain-sepolia` | Unichain Sepolia | 1301 | TXNDW |
| `worldchain-sepolia` | World Chain Sepolia | 4801 | TXNW |
| `xlayer-testnet` | X Layer Testnet | 1952 | DW |
| `xmtp-ropsten` | XMTP Ropsten | 351243127 | DW |
| `zetachain-testnet` | ZetaChain Testnet | 7001 | DW |
| `zksync-sepolia` | ZKsync Sepolia | 300 | TXNDW |
| `zora-sepolia` | Zora Sepolia | 999999999 | TXNDW |

### 3.3 Non-EVM (26 slugs, 13 chains)

Standard `eth_*` methods do **not** apply. Each chain has its own method set — read its guide.

| slug(s) | chain | protocol / URL shape | guide |
|---|---|---|---|
| `solana-mainnet`, `solana-devnet` | Solana | Solana JSON-RPC + DAS (`getAssetsByOwner`, ...) at `/v2/{KEY}`; native `*Subscribe` WebSocket; Yellowstone gRPC | `rpc/non-evm/solana.md` |
| `bitcoin-mainnet`, `bitcoin-testnet`, `bitcoin-testnet4`, `bitcoin-signet` | Bitcoin | Bitcoin JSON-RPC at `/v2/{KEY}` + UTXO REST API | — |
| `bitcoincash-mainnet`, `bitcoincash-testnet` | Bitcoin Cash | JSON-RPC + UTXO REST | — |
| `litecoin-mainnet`, `litecoin-testnet` | Litecoin | JSON-RPC + UTXO REST | — |
| `dogecoin-mainnet` | Dogecoin | JSON-RPC + UTXO REST | — |
| `aptos-mainnet`, `aptos-testnet` | Aptos | REST at `/v2/{KEY}/v1/...` (+ gRPC transaction stream) | `rpc/non-evm/aptos.md` |
| `sui-mainnet`, `sui-testnet` | Sui | **gRPC only**: `{slug}.g.alchemy.com:443`, header `Authorization: Bearer {KEY}`. Alchemy's Sui JSON-RPC was scheduled to end 2026-09-25 (past); the directory lists gRPC only | `rpc/non-evm/sui.md` |
| `starknet-mainnet`, `starknet-sepolia` | Starknet | `starknet_*` JSON-RPC at `/v2/{KEY}` (quickstart) or versioned `/starknet/version/rpc/v0_10/{KEY}` (docs URL table) | — |
| `stellar-mainnet`, `stellar-testnet` | Stellar | Stellar RPC (JSON-RPC 2.0) at `/v2/{KEY}` | — |
| `tron-mainnet`, `tron-testnet` | Tron | HTTP JSON API at `/v2/{KEY}/wallet/...` (+ gRPC); not JSON-RPC | `rpc/non-evm/tron.md` |
| `avax-mainnet`, `avax-fuji` + path `/ext/bc/P` | Avalanche P-Chain | `platform.*` JSON-RPC at `/v2/{KEY}/ext/bc/P` (the C-Chain EVM is the plain `/v2/{KEY}`) | — |
| `celestiabridge-mainnet`, `celestiabridge-mocha` | Celestia bridge node | DA bridge-node API at `/v2/{KEY}` | — |
| `eth-mainnetbeacon`, `eth-sepoliabeacon`, `eth-hoodibeacon` | Ethereum Beacon (consensus layer) | Beacon REST API (`/eth/v1/...`); exact path form not documented — unverified | — |

Hyperliquid **HyperCore** (trading-engine data, `hl_*` methods) is private preview with unpublished endpoints; only HyperEVM (`hyperliquid-mainnet`, §3.1) is generally available.

> Rows with **—** in *guide* have no dedicated file in this skill — use the *protocol / URL shape* column plus Alchemy's per-chain page `alchemy.com/rpc/<slug>`. Dedicated guides: `solana`, `tron`, `sui`, `aptos` (shared set also has `ton`, `xrp`, `near`).

### 3.4 Only in Alchemy's docs URL table (28) — partner / internal / unverified

Not in the public directory (chain IDs, products and availability unverified; may need enablement by Alchemy): `alterscope-mainnet`, `earnm-mainnet`, `earnm-sepolia`, `edge-mainnet`, `edge-testnet`, `frax-hoodi`, `galactica-mainnet`, `galactica-cassiopeia`, `humanity-testnet`, `openloot-sepolia`, `polynomial-mainnet`, `polynomial-sepolia`, `race-mainnet`, `race-sepolia`, `standard-mainnet`, `unite-mainnet`, `unite-testnet`, `worldl3-devnet`, `worldmobile-devnet`, `worldmobile-testnet`, `xmtp-mainnet`, `xprotocol-mainnet`, `alchemy-sepolia`, `alchemy-internal`, `alchemyarb-fam`, `alchemyarb-sepolia`. Also `eth-holesky` and `eth-holeskybeacon` (Holešky: dropped from the directory, retired upstream — use `eth-hoodi` / `eth-sepolia`). The docs table also lists "V Devnet" on a non-standard host `https://rpc.devnet.alchemy.com/{KEY}` (internal). `frax-sepolia` appears in the directory with no Alchemy products enabled.

### 3.5 Retired — do not use

| slug / chain | status |
|---|---|
| `polygonzkevm-mainnet`, `polygonzkevm-cardona` | ended 2026-07-01 (Polygon zkEVM shut down) |
| `botanix-mainnet`, `botanix-testnet` | ended 2026-08-01 |
| `degen-mainnet`, `degen-sepolia` | ended 2026-08-31 |
| `sonic-blaze` | ended 2026-06-12 — use `sonic-testnet` |
| Fantom (`fantom-mainnet`, slug from older docs) | ended 2025-10-07 — migrate to `sonic-mainnet` |
| Arbitrum Nova (`arbnova-mainnet`, slug from older docs), Geist, Lumia, Clankermon, Tea (`tea-sepolia`) | discontinued ("spun down") — notices only, no migration path |
| `berachain-bartio` | superseded by `berachain-bepolia` (stale in an old quickstart) |
| Sui JSON-RPC (`/v2/{KEY}`) | scheduled end 2026-09-25 (past) — gRPC only (§3.3) |
| Polygon `erigon_*`, `trace_filter`, `trace_get`, `trace_rawTransaction` | removed on `polygon-mainnet`/`polygon-amoy` since 2026-08-01 (Erigon to Bor); use `debug_trace*` |
| hosts `*.alchemy.io`, `*.alchemyapi.io` | no longer resolve — always `*.g.alchemy.com` |

Machine-readable list: `GET https://admin-api.alchemy.com/v1/chains` returns every network with `availability` (public/prerelease/deprecated), but needs an Alchemy **Access Key**, not the app key in the vault.

## 4 · Standard EVM methods

Full method list, param shapes, hex/block-tag rules: **`rpc/evm-methods.md`**. Alchemy serves the standard `eth_*`, `net_*`, `web3_*` set plus extras (`eth_getBlockReceipts`, `eth_callMany`, `eth_simulateV1`, ...); each chain's exact list: `https://www.alchemy.com/docs/{chain}/{chain}-api-overview.md` (e.g. `ethereum`, `base`, `solana`). Common CU costs: `eth_chainId` 0 · `eth_blockNumber` 10 · `eth_getBalance` 20 · `eth_call` 26 · `eth_sendRawTransaction` 40 · `eth_getLogs` 60.

Latest block (Ethereum):
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```
Native balance (Base) — result is wei in hex:
```bash
curl -s -X POST "https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","latest"],"id":1}'
```
Read a contract — USDC `balanceOf(0xd8dA...6045)` via `eth_call` (selector `70a08231` + address left-padded to 32 bytes):
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","data":"0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"},"latest"],"id":1}'
```
USDC `Transfer` logs in a **10-block window** (the widest range the Free plan accepts, see §6):
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getLogs","params":[{"fromBlock":"0x137d3c2","toBlock":"0x137d3cb","address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}],"id":1}'
```
Batch = JSON array body, responses may come back **in any order** (match on `id`). Alchemy discourages large batches (see §6):
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},{"jsonrpc":"2.0","id":2,"method":"eth_gasPrice","params":[]}]'
```

## 5 · Enhanced APIs (Alchemy-specific)

> These are **not standard JSON-RPC and not portable** to other providers (`alchemy_*`, `trace_*`/`debug_*` extras, and REST products). They work only on networks whose `enhanced` flag (§3) says so; elsewhere expect `-32601 Unsupported method` or a 4xx. Same endpoint and key as §2 unless a REST base is shown.

| Need | Use | Section |
|---|---|---|
| ERC-20 balances of a wallet (one chain) | `alchemy_getTokenBalances` + `alchemy_getTokenMetadata` | 5.1 |
| Wallet transfer/tx history (one chain) | `alchemy_getAssetTransfers` | 5.2 |
| Tokens + prices / NFTs / transfers across several chains in one call | Portfolio API | 5.3 |
| Token price now or historical | Prices API | 5.4 |
| NFTs, owners, metadata, floor price, spam | NFT API (REST) | 5.5 |
| Why a tx failed, internal calls, state diffs | `debug_traceTransaction` / `trace_transaction` | 5.6 |
| Live blocks / logs / pending txs | `eth_subscribe` over WebSocket | 5.7 |
| All receipts of a block in one call | `alchemy_getTransactionReceipts` | 5.8 |

### 5.1 Token API (JSON-RPC) — flag `T`

`alchemy_getTokenBalances [address, tokenSpec?, options?]` (20 CU). `tokenSpec`: `"erc20"` (default; every ERC-20 the address has held) · `"NATIVE_TOKEN"` · array of contract addresses. `options`: `{"pageKey": "<from previous response>", "maxCount": 100}` (max 100 per page).
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":42,"method":"alchemy_getTokenBalances","params":["0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be",["0x607f4c5bb672230e8672085532f7e901544a7375"]]}'
```
```json
{"jsonrpc":"2.0","id":42,"result":{"address":"0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be","tokenBalances":[
  {"contractAddress":"0x607f4c5bb672230e8672085532f7e901544a7375","tokenBalance":"0x00000000000000000000000000000000000000000000000000003c005f81ab00","error":null}]}}
```
`tokenBalance` is a 32-byte hex string: `int(tokenBalance,16) / 10**decimals` (decimals from `alchemy_getTokenMetadata`). Exactly one of `tokenBalance` / `error` is non-null. If more results remain, pass the returned `pageKey` back in `options`.

`alchemy_getTokenMetadata [contract]` (10 CU):
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getTokenMetadata","params":["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":{"name":"USD Coin","symbol":"USDC","decimals":6,"logo":"https://static.alchemyapi.io/images/assets/3408.png"}}
```
`alchemy_getTokenAllowance [{contract, owner, spender}]` (20 CU) — result is a decimal string:
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getTokenAllowance","params":[{"contract":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","owner":"0xOWNER","spender":"0xSPENDER"}]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":"0"}
```

### 5.2 Transfers API — `alchemy_getAssetTransfers` (flag `X`, 120 CU)

Indexed transfer history for an address; no block-range juggling. `category` is **required**: `external` (native), `internal` (contract-initiated native; only **eth-mainnet, polygon-mainnet, base-mainnet, arc-mainnet, arc-testnet**), `erc20`, `erc721`, `erc1155`, `specialnft` (CryptoPunks/CryptoKitties). Other params: `fromBlock` (hex, default `0x0`), `toBlock` (hex or `latest`/`indexed`, default `latest`), `fromAddress`, `toAddress` (both set = transfers from A to B; for both directions of a wallet make two calls and merge on `uniqueId`, or use Portfolio Transfers By Wallet), `contractAddresses`, `excludeZeroValue` (default true), `order` (`asc` default / `desc`), `withMetadata` (adds `metadata.blockTimestamp`; only eth, base, polygon, arbitrum, optimism), `maxCount` (**hex string**, default `0x3e8` = 1000), `pageKey`.
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{
        "fromBlock":"0x0","toBlock":"latest",
        "toAddress":"0x5c43B1eD97e52d009611D89b74fA829FE4ac56b1",
        "category":["external","erc20","erc721","erc1155"],
        "excludeZeroValue":true,"withMetadata":true,"order":"desc","maxCount":"0x3e8"}]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":{"transfers":[
  {"blockNum":"0xb0eadc","uniqueId":"0x3847245c...f5ff:external","hash":"0x3847245c...f5ff",
   "from":"0xef4396d9ff8107086d215a1c9f8866c54795d7c7","to":"0x5c43b1ed97e52d009611d89b74fa829fe4ac56b1",
   "value":0.5,"asset":"ETH","category":"external","erc721TokenId":null,"erc1155Metadata":null,"tokenId":null,
   "rawContract":{"value":"0x6f05b59d3b20000","address":null,"decimal":"0x12"},
   "metadata":{"blockTimestamp":"<ISO-8601>"}}],
  "pageKey":""}}
```
Trimmed (`...`). `value` is already decimal-adjusted (`null` for ERC-721 / unknown decimals); `rawContract.address` is `null` for external/internal. **Pagination:** a non-empty `pageKey` means more results (a page holds up to `maxCount`, default 1000) — send it back as `pageKey` with the **same** other params; it expires after **10 minutes**; stop when it is empty/absent.
```python
import os, json, urllib.request
url = f"https://eth-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_KEY']}"
params = {"fromBlock":"0x0","toAddress":"0xADDRESS","category":["external","erc20"],"withMetadata":True,"order":"desc"}
out, page = [], None
while True:
    if page: params["pageKey"] = page
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[params]}).encode()
    res = json.load(urllib.request.urlopen(urllib.request.Request(url, body, {"Content-Type":"application/json"})))["result"]
    out += res["transfers"]; page = res.get("pageKey")
    if not page: break
```

### 5.3 Portfolio / Data API (REST, multi-chain)

Several wallets/chains in one call. Base `https://api.g.alchemy.com/data/v1/{ALCHEMY_KEY}`, all `POST` JSON. `network` values are the Data-API ids (Polygon = `matic-mainnet`, see §3). CU are charged **per network requested** (3 networks on Transfers = 1,440 CU).

| endpoint | what | request limits | CU per network |
|---|---|---|---|
| `/assets/tokens/by-address` | native + ERC-20/SPL tokens with balances, metadata, prices (Tokens By Wallet) | 2 addresses, 5 networks each | 360 |
| `/assets/tokens/balances/by-address` | balances only (lighter) | 3 address/network pairs, 20 networks | 200 |
| `/assets/nfts/by-address` | NFTs across chains | 2 pairs, 15 networks each | 1000 |
| `/assets/nfts/contracts/by-address` | NFT collections held | 2 pairs, 15 networks each | 600 |
| `/transfers/by-address` | transfer history for **one** address; `direction` to/from/both, `category` required, `fromTimestamp`/`toTimestamp`, `order` (**beta**) | 5 networks from: eth, matic, arb, opt, base, bnb, celo, ronin, monad (+testnet), robinhood (+testnet), arc (+testnet) | 480 |

```bash
curl -s -X POST "https://api.g.alchemy.com/data/v1/$ALCHEMY_KEY/assets/tokens/by-address" -H "Content-Type: application/json" \
  -d '{"addresses":[{"address":"0x1E6E8695FAb3Eb382534915eA8d7Cc1D1994B152","networks":["eth-mainnet","base-mainnet","matic-mainnet"]}],
       "withMetadata":true,"withPrices":true,"includeNativeTokens":true,"includeErc20Tokens":true}'
```
```json
{"data":{"tokens":[{"address":"0x1E6E...B152","network":"eth-mainnet","tokenAddress":null,
   "tokenBalance":"<string: 0x-hex or decimal>","tokenMetadata":{"decimals":18,"logo":"...","name":"Ethereum","symbol":"ETH"},
   "tokenPrices":[{"currency":"usd","value":"4608.2208671202","lastUpdatedAt":"2025-08-26T20:17:27Z"}],"error":null}],
  "pageKey":"..."},
 "error":{"message":"Failed to fetch tokens on certain networks","partialErrors":[{"network":"base-mainnet","message":"..."}]}}
```
`tokenAddress:null` = the chain's native token. **Partial failure:** a network can fail while the call still returns **HTTP 200** — the top-level `error.partialErrors` lists failed networks (key absent when all succeed); keep the good `data`, retry only the listed networks with a fixed attempt limit. Per-network timeout 5 s (paged) / 10 s (fetch-all).

### 5.4 Prices API (REST)

Base `https://api.g.alchemy.com/prices/v1/{ALCHEMY_KEY}/tokens`. By Symbol = CEX+DEX blend for the top 1000+ symbols; By Address = DEX only, 10K+ tokens. **Separate request cap: Free 300 requests/hour, PAYG 10K/hour.** 40 CU per call.
```bash
# current price by symbol (max 25 symbols; repeat the param)
curl -s "https://api.g.alchemy.com/prices/v1/$ALCHEMY_KEY/tokens/by-symbol?symbols=ETH&symbols=BTC"
# current price by contract (max 25 addresses, max 3 networks)
curl -s -X POST "https://api.g.alchemy.com/prices/v1/$ALCHEMY_KEY/tokens/by-address" -H "Content-Type: application/json" \
  -d '{"addresses":[{"network":"eth-mainnet","address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}]}'
# history: symbol OR (network+address); interval 5m (max 7d range), 1h (max 30d), 1d (max 1y); startTime/endTime ISO-8601 or epoch seconds
curl -s -X POST "https://api.g.alchemy.com/prices/v1/$ALCHEMY_KEY/tokens/historical" -H "Content-Type: application/json" \
  -d '{"symbol":"ETH","startTime":"2024-01-01T00:00:00Z","endTime":"2024-01-31T23:59:59Z","interval":"1d","withMarketData":true}'
```
```json
{"data":[{"symbol":"ETH","prices":[{"currency":"USD","value":"3000.00","lastUpdatedAt":"2024-04-27T12:34:56Z"}],"error":null}]}
```
Missing tokens come back inside a 200 with a per-item `error`.

### 5.5 NFT API (REST) — flag `N`

Different base from JSON-RPC: `GET https://{network}.g.alchemy.com/nft/v3/{ALCHEMY_KEY}/{endpoint}?query` (batch/refresh endpoints are POST).
```bash
# NFTs owned by a wallet (ENS ok on eth-mainnet). pageSize max 100; pass the returned pageKey for the next page.
curl -s "https://eth-mainnet.g.alchemy.com/nft/v3/$ALCHEMY_KEY/getNFTsForOwner?owner=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&withMetadata=false&pageSize=2"
# one NFT's metadata (tokenType=ERC721/ERC1155 speeds it up)
curl -s "https://eth-mainnet.g.alchemy.com/nft/v3/$ALCHEMY_KEY/getNFTMetadata?contractAddress=0xe785E82358879F061BC3dcAC6f0444462D4b5330&tokenId=44&tokenType=ERC721"
```
```json
{"ownedNfts":[{"contract":{"address":"0x000386E3...Dc3","name":"Bored Ape Nike Club","symbol":"BANC","tokenType":"ERC721","isSpam":true},
  "tokenId":"1","tokenType":"ERC721","name":null,"tokenUri":"http://api.nikeapenft.xyz/ipfs/1","image":{"cachedUrl":null,"originalUrl":null},
  "balance":"26","timeLastUpdated":"2023-11-06T04:34:38.880Z"}],
 "totalCount":26620,"validAt":{"blockNumber":18513471},"pageKey":"MHgwMDAz..."}
```
Endpoints — GET: `getNFTsForOwner`, `getContractsForOwner`, `getNFTsForContract` (`startToken`, `limit`), `getNFTsForCollection`, `getNFTMetadata`, `getContractMetadata`, `getOwnersForNFT`, `getOwnersForContract` (`pageKey` for >50k owners, `withTokenBalances`), `getFloorPrice` (`contractAddress` or `collectionSlug`), `isSpamContract`, `reportSpam`. POST: `getNFTMetadataBatch`, `getContractMetadataBatch`, `refreshNftMetadata`. `getNFTsForOwner` extras: `contractAddresses[]` (max 45), `orderBy=transferTime`, `excludeFilters[]=SPAM|AIRDROPS` (**SPAM filter is paid-tier only**), `spamConfidenceLevel`. CU per call 80-600 (e.g. `getNFTMetadata` 80, `getNFTsForOwner` 480, `getNFTsForContract` 600).

### 5.6 Trace + Debug (JSON-RPC) — flags `R`, `D`

**Plan:** both require a **Pay-As-You-Go or Enterprise** plan; the Free plan cannot use them. Trace (`R`) is limited to: `alpen-testnet`, `arb-mainnet`, `arc-mainnet`, `arc-testnet`, `bnb-mainnet`, `eth-hoodi`, `eth-mainnet`, `eth-sepolia`, `humanity-mainnet`, `opt-mainnet`, `opt-sepolia`, `plasma-mainnet`, `plasma-testnet`, `rootstock-mainnet`, `sonic-mainnet`, `sonic-testnet`; Debug (`D`) is on 104 of the EVM networks in §3.1-3.2 (see the flags). Batch requests are **not** supported for either.

Trace (OpenEthereum style, 20-80 CU): `trace_transaction [txHash]`, `trace_block [blockHexOrTag]`, `trace_call [callObj, ["trace"|"stateDiff"], block?]`, `trace_filter [{fromBlock,toBlock,fromAddress[],toAddress[],after,count}]`, `trace_get`, `trace_rawTransaction`, `trace_replayTransaction`, `trace_replayBlockTransactions`, `trace_callMany`. Trace types: `trace` and `stateDiff` on eth-mainnet/eth-sepolia only; `vmTrace` unsupported. Arbitrum also has `arbtrace_*` equivalents.
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"trace_transaction","params":["0x8fc90a6c3ee3001cdcbbb685b4fbe67b1fa2bec575b15b0395fea5540d0901ae"]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":[{"action":{"callType":"call","from":"0xbc9f...c067","gas":"0x97478","input":"0xfebefd61...","to":"0x6090...78ef","value":"0x2386f26fc10000"},
  "blockHash":"0x6d00...bed6","blockNumber":4000036,"result":{"gasUsed":"0x7ad71","output":"0x"},
  "subtraces":4,"traceAddress":[],"transactionHash":"0x552b...bacc","transactionPosition":71,"type":"call"}]}
```
(trimmed; one object per call/create/suicide, nested via `traceAddress`.)

Debug (Geth style, 40 CU): `debug_traceTransaction`, `debug_traceCall`, `debug_traceBlockByNumber`, `debug_traceBlockByHash`, `debug_traceCallMany`, `debug_getRawBlock`, `debug_getRawHeader`, `debug_getRawReceipts`. Tracers: `callTracer` (call tree) or `prestateTracer` (state diff); `tracerConfig.onlyTopCall`; `timeout` string; `debug_traceCall` takes `stateOverrides`.
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction","params":["0x8fc90a6c3ee3001cdcbbb685b4fbe67b1fa2bec575b15b0395fea5540d0901ae",{"tracer":"callTracer","tracerConfig":{"onlyTopCall":false}}]}'
# debug_traceCall:        params = [ {from,to,data,...}, "latest", {"tracer":"callTracer"} ]
# debug_traceBlockByNumber: params = [ "0xccde12", {"tracer":"callTracer"} ]
```
```json
{"jsonrpc":"2.0","id":1,"result":{"type":"CALL","from":"0xe088...979e","to":"0x7052...85a1","value":"0x0","gas":"0x7fffffffffffadf7","gasUsed":"0x0","input":"0x","output":"0x","calls":[]}}
```
`error` / `revertReason` fields appear on failed calls. **Polygon:** `erigon_*`, `trace_filter`, `trace_get`, `trace_rawTransaction` were removed on 2026-08-01 (§3.5), and the directory no longer lists Trace for `polygon-mainnet`; use `debug_traceBlockByNumber` with `callTracer`.

### 5.7 Subscriptions (WebSocket) — flag `W`

Open `wss://{network}.g.alchemy.com/v2/{ALCHEMY_KEY}`, then send `eth_subscribe`; events arrive as `eth_subscription` notifications until `eth_unsubscribe`. Use WebSocket **only** for subscriptions (plain RPC over HTTPS: faster, retryable, has status codes). Types: `newHeads` (new blocks, incl. re-orgs), `logs` (`{address, topics[]}`; re-orged logs re-emitted with `removed:true`), `newPendingTransactions` (hashes), **`alchemy_pendingTransactions`** (`{fromAddress, toAddress, hashesOnly}`, max 1000 addresses, pending pool of Alchemy's mempool), **`alchemy_minedTransactions`** (`{addresses:[{from,to}], includeRemoved, hashesOnly}`, max 1000 addresses). The two `alchemy_*` types are Alchemy-only: pending is documented for eth-mainnet, eth-sepolia, polygon-mainnet; Alchemy's overview page lists Ethereum, Arbitrum, Polygon, Optimism for the pair (docs disagree — handle an error). Prefer `hashesOnly:true` and narrow filters: events are billed by bytes (~0.04 CU/byte).
```bash
npx wscat -c "wss://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY"
> {"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}
< {"jsonrpc":"2.0","id":1,"result":"0xcd0c3e8af590364c09d0fa6a1210faf5"}
< {"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0xcd0c3e8af590364c09d0fa6a1210faf5","result":{"number":"0x...","hash":"0x...","parentHash":"0x...","timestamp":"0x...","gasUsed":"0x...","gasLimit":"0x..."}}}
> {"jsonrpc":"2.0","id":2,"method":"eth_unsubscribe","params":["0xcd0c3e8af590364c09d0fa6a1210faf5"]}
< {"jsonrpc":"2.0","id":2,"result":true}
```
Other `params` for `eth_subscribe`:
```
["logs", {"address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}]
["newPendingTransactions"]
["alchemy_pendingTransactions", {"toAddress":["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","0xdAC17F958D2ee523a2206206994597C13D831ec7"],"hashesOnly":true}]
["alchemy_minedTransactions", {"addresses":[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"}],"includeRemoved":false,"hashesOnly":true}]
```
Time-boxed listener for an agent (stop after N events):
```python
import asyncio, json, os, websockets   # pip install websockets
async def main():
    url = f"wss://eth-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_KEY']}"
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}))
        print(await ws.recv())                      # subscription id
        for _ in range(5): print(await ws.recv())   # first 5 notifications
asyncio.run(main())
```
Limits: 100 WebSocket connections on Free (2,000 on paid), 1,000 subscriptions per connection, 200 concurrent requests per connection. Solana uses native `accountSubscribe`/`logsSubscribe`/... (see `rpc/non-evm/solana.md`), not `eth_subscribe`.

### 5.8 Utility + other

`alchemy_getTransactionReceipts [{"blockNumber":"0xF1D1C6"}]` (or `{"blockHash":"0x..."}`; flag `B`: eth, arb, opt, base, polygon + their testnets; 250 CU) returns every receipt of a block in one call — cheaper than one `eth_getTransactionReceipt` per tx:
```bash
curl -s -X POST "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getTransactionReceipts","params":[{"blockNumber":"0xF1D1C6"}]}'
```
```json
{"jsonrpc":"2.0","id":1,"result":{"receipts":[{"blockHash":"0x1876...eaabe","blockNumber":"0xF1D1C6","transactionIndex":"0x0","transactionHash":"0x4c32...cfb2","from":"0x0049...1886","to":"0x66c4...c9b1","cumulativeGasUsed":"0x5208","gasUsed":"0x5208","contractAddress":null,"logs":[],"status":1,"effectiveGasPrice":"0x1e8480","type":"0x2"}]}}
```
Not covered here (need extra setup, little use for a CLI agent): Webhooks (push to a public HTTPS URL), Bundler / Gas Manager (account abstraction), `alchemy_simulateAssetChanges` / `alchemy_simulateExecution` (2500 CU; listed in the CU table but no current reference page found — unverified).

## 6 · Gotchas

- **Slug ≠ common name** (§3). Wrong slug = no JSON (TLS/DNS error). Data APIs use `matic-mainnet` for Polygon. Never use `*.alchemy.io` / `*.alchemyapi.io`.
- **Key in the URL path = secret.** Prefer the `Authorization: Bearer` form where possible (§2); WebSocket needs the path form. Never log, echo, commit, or cache the URL/key.
- **Error decoder** (check HTTP status *and* `error`; HTTP 200 may still carry one):

| HTTP / code | message | meaning / action |
|---|---|---|
| 401 / -32600 | `Must be authenticated!` | invalid/revoked key — try another vault slot |
| 403 / -32600 | `<NETWORK> is not enabled for this app...` | network not in the app's allowlist — try another slot or ask the user to enable it |
| 403 / -32600 | `IP Address not on whitelist`, `Unspecified origin not on whitelist`, `Origin not on whitelist` | the user's **Alchemy-side** IP/origin allowlist excludes this machine (not Clawby's whitelist) |
| 403 | `Monthly capacity limit exceeded.` / `App is inactive.` | plan CU cap hit / app disabled |
| 429 | `Your app has exceeded its compute units per second capacity.` | back off (below) |
| 413 | Payload Too Large | request body above 2,600,000 bytes |
| 400 or -32601 | `Unsupported method` | method not available on this chain/plan — check the `enhanced` flags |
| 200 + `error` (code 3 etc.) | `execution reverted`, `filter not found`... | on-chain/simulation error, not a transport problem |

- **Compute units + throughput.** Billing and limits are in Compute Units (CU): Free = **30M CU/month** and **300 CU/s**; Pay-As-You-Go = $0.525 per million CU and **10,000 CU/s**. Throughput is **account-level**: your calls share the budget with every app the user runs on that Alchemy account, so keep concurrency modest. It is a 10-second token bucket (Free can burst 3,000 CU in 10 s). On **429** (HTTP; over WebSocket a JSON-RPC error code 429) honour the `Retry-After` header (whole seconds), else exponential backoff with jitter (1 s, 2 s, 4 s ... capped at 32-64 s) and a max retry count. 429/403 and unknown methods cost 0 CU; other 4xx/5xx cost the method's CU. CU examples: `eth_chainId` 0, `eth_blockNumber` 10, `eth_getBalance` 20, `eth_call` 26, `eth_getLogs` 60, `alchemy_getTokenBalances` 20, `alchemy_getAssetTransfers` 120, `alchemy_getTransactionReceipts` 250, `trace_*` 20-80, `debug_*` 40, NFT 80-600, Prices 40, Portfolio 200-1000 per network. Also the Prices API cap: Free 300 requests/hour.
- **`eth_getLogs` block range depends on the user's plan.** **Free: max 10 blocks per query.** Pay-As-You-Go: unlimited on Ethereum, Base, Optimism, Arbitrum, Polygon, World Chain, BNB, Robinhood, HyperEVM, Monad, Tempo and Sei (Alchemy's table names these chains; Monad Testnet is separate at 1,000); Berachain 1,000; "all other chains" 10,000 (wider is possible but unreliable). Responses are capped at 150 MB. On a range error, split the window and re-query. **For wallet history use `alchemy_getAssetTransfers` + `pageKey`** (no range cap, 120 CU) instead of scanning logs.
- **Pagination keys differ:** `alchemy_getAssetTransfers` `pageKey` (valid 10 min, default 1000 rows) · `alchemy_getTokenBalances` `options.pageKey/maxCount<=100` · NFT API `pageKey/pageSize<=100` · `getOwnersForContract` `pageKey` · Portfolio `pageKey`. Always loop until no key is returned.
- **Archive data is on every plan** (Free, PAYG, Enterprise per Alchemy's pricing page) — historical `eth_call` / `eth_getBalance` at old blocks work without an archive upgrade. Debug/Trace still need PAYG+.
- **Sizes + batching:** requests up to 2,600,000 bytes, responses up to 150 MB, but stay under ~100 KB / ~10 MB. HTTP batch limit is 1000, Alchemy recommends under 50 and discourages batching — send concurrent single calls instead. Batch is **unsupported** for Transfers, Token, Transaction Receipts, Transact, Trace, Debug and most subscription APIs. Send `Accept-Encoding: gzip` (`curl --compressed`) for large responses.
- **Enhanced methods are Alchemy-only** — no equivalent on Ankr/BlockPI; do not assume them on other providers.
- **WebSocket is for streams only** and is billed per byte delivered; an unfiltered pending/mined stream is expensive. Agents: prefer polling over HTTP, or time-box a listener (§5.7).
- **Deprecated/changed networks** are listed in §3.5 (Sui is gRPC-only now, Polygon zkEVM/Fantom/Degen/Botanix ended, Polygon lost its Erigon trace methods). Older Alchemy guides and earlier versions of this file still show some of them.

## 7 · Sources (Alchemy official, fetched 2026-10-25)

- Networks: `https://www.alchemy.com/docs/reference/node-supported-chains` (HTTPS URL table), `https://www.alchemy.com/rpc` + 154 pages `https://www.alchemy.com/rpc/{name}.md` (slugs, chain IDs, product support), `https://www.alchemy.com/docs/chains.md`, per-chain `.../docs/reference/{chain}-api-quickstart.md` and `.../{chain}-deprecation-notice.md` (Fantom, Polygon zkEVM, Arbitrum Nova, Botanix, Degen, Geist, Lumia, Tea, Clankermon, Sonic Blaze, Polygon Erigon), `.../reference/sui-api-quickstart` + `sui-grpc-quickstart`.
- Key model: `.../docs/create-an-api-key`, `.../reference/admin-api/overview`, `.../admin-api/apps/update-app-network-allowlist`, `.../admin-api/chains/list-chains`, `.../how-to-add-allowlists-to-your-apps-for-enhanced-security`, `.../how-to-use-api-keys-in-http-headers`, `.../best-practices-for-key-security-and-management`.
- Limits: `.../reference/throughput`, `compute-units`, `compute-unit-costs`, `pricing-plans`, `error-reference`, `batch-requests`, `best-practices-when-using-alchemy`, `pay-as-you-go-pricing-faq`.
- Enhanced APIs: `.../reference/token-api-overview` + `data/token-api/token-api-endpoints/alchemy-get-token-{balances,metadata,allowance}`; `.../reference/transfers-api-quickstart` + `data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers`; `.../reference/portfolio-apis` + `data/portfolio-apis/...`; `.../reference/prices-api-quickstart` + `prices-api-faq`; `.../reference/nft-api-overview` + `nft-api-quickstart` + `nft-api-endpoints/...`; `.../reference/trace-api-quickstart`, `debug-api-quickstart` + `chains/trace-api/...`, `chains/debug-api/...`; `.../reference/subscription-api`, `subscription-api-endpoints`, `alchemy-minedtransactions`, `alchemy-pendingtransactions`, `newheads`, `logs`; `.../reference/utility-api-overview`; `.../chains/ethereum/ethereum-api-endpoints/eth-get-logs`.
- Live probes (no real key): invalid key -> `401 Must be authenticated!`; `/public` keyless on `eth-mainnet` works; `/public` on a non-listed network -> `403 ... is not enabled for this app`; wrong slug -> TLS error.
- Unverified: exact HTTP path form of the Beacon API; Data-API network ids other than the ones shown in Alchemy's examples; availability/products of the §3.4 partner networks; slugs of Fantom/Arbitrum Nova (older docs); whether `alchemy_simulate*` are still current.
