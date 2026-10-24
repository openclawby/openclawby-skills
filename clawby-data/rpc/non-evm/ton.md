# TON RPC (BYOK)

TON via the user's **own Ankr or BlockPI key** from the Clawby Key Vault (fetch steps, IP whitelist, vault errors: `rpc/index.yaml` and `rpc/<provider>.md`). Direct to the provider — not via Clawby relay, no Clawby credits. **Alchemy lists no TON endpoint** (absent from its `alchemy.com/rpc` chain directory; `alchemy.com/rpc/ton` is 404) — a user with only an Alchemy key cannot use TON via BYOK.

TON is **neither EVM nor Solana-like**. Accounts are smart contracts (actors) that exchange **asynchronous messages**; a "transaction" is one account processing one inbound message, and one user action can spawn a chain of transactions across accounts. The chain is a set of workchains split dynamically into shardchains. The node-facing API is the **TON Center "HTTP API v2"** (tonlib over liteservers), in two equivalent flavours:

- **REST**: `GET <base>/<method>?<query>`; a few methods are `POST` with a JSON body (`runGetMethod`, `sendBoc`, `sendBocReturnHash`, `estimateFee`).
- **JSON-RPC wrapper**: `POST <json-endpoint>` with `{"jsonrpc":"2.0","id":"1","method":"<name>","params":{…named object…}}`.

Responses are always `{"ok":true,"result":…}` or `{"ok":false,"error":"…","code":NNN}` — not the Ethereum/Solana `result`/`error` envelope.

> The key sits in the endpoint URL, so **the whole URL is a secret**. Never log, echo or commit it.

## 1 · Endpoints (mainnet)

| Provider | JSON-RPC (POST) | REST | Notes |
|---|---|---|---|
| Ankr | `https://rpc.ankr.com/ton_api_v2/{KEY}` | `GET https://rpc.ankr.com/premium-http/ton_api_v2/{KEY}/<method>?<query>` · `POST …/runGetMethod`, `…/estimateFee` | Freemium + Premium, nothing blocked. **Not** the generic `rpc.ankr.com/{slug}/{KEY}` shape (slug is `ton_api_v2`; mainnet only, see `ankr.md`). v2 only. Ankr documents 27 distinct methods and **no `sendBoc` / `sendBocReturnHash`** (its only "Send" method is `estimateFee`) — whether broadcasting works on Ankr is **unverified**. |
| BlockPI | `https://ton.blockpi.network/v1/rpc/{KEY}/jsonRPC` | `GET https://ton.blockpi.network/v1/rpc/{KEY}/<method>?<query>` · `POST …/sendBoc`, `…/runGetMethod`, `…/estimateFee` | Needs BlockPI's **Elementary** RU package or higher (per its network table). Docs list 29 endpoints incl. `sendBoc`, `sendBocReturnHash`, `sendQuery`, `estimateFee`, `jsonRPC`; legacy names (`/shards`). BlockPI's `runGetMethod` doc example shows the wrong path (`/getConfigAll`) — the path is `/runGetMethod`. The bare `…/v1/rpc/{KEY}` root (shown on blockpi.io/chain/ton) is unverified for calls. `rpc/blockpi.md` additionally records an **API v3** path, `https://ton.blockpi.network/v1/api/{KEY}/api/v3/<path>` (not in BlockPI's API-reference index; unverified here). A keyless call to the public endpoint returns `Apikey not found` — a key is required. |
| Alchemy | — | — | Not listed. |

Reference only (not a BYOK provider): TON Center `https://toncenter.com/api/v2` — key via header `X-API-Key` or query `api_key`; keyless = **1 req/s**; Free plan 10 rps, Plus 25, Advanced 100 (per network). It also hosts **API v3** (`/api/v3`, an *indexed* API: `accountStates`, `walletStates`, `transactions`, `jettonWallets`, traces, NFTs, …) — **not exposed by Ankr**; BlockPI reportedly has a v3 route (see its row above, unverified).

```bash
# JSON-RPC helper (Ankr shown; BlockPI: TON_RPC="https://ton.blockpi.network/v1/rpc/$BLOCKPI_KEY/jsonRPC")
TON_RPC="https://rpc.ankr.com/ton_api_v2/$ANKR_KEY"
ton() { local p="${2:-}"; [ -n "$p" ] || p='{}'; curl -s -X POST "$TON_RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"$1\",\"params\":$p}"; }
ton getAddressBalance '{"address":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W"}'
# REST equivalent (Ankr):
curl -s "https://rpc.ankr.com/premium-http/ton_api_v2/$ANKR_KEY/getAddressBalance?address=EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W"
```

Below, each "Request" is the **JSON-RPC body** (the REST form is `GET <base>/<method>?<same params>`; POST-only methods take the same fields as a JSON body at `<base>/<method>`).

## 2 · Envelope and conventions

```jsonc
// Request — "params" is a NAMED OBJECT (not an array), "id" is a STRING
{"jsonrpc":"2.0","id":"1","method":"getAddressBalance","params":{"address":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W"}}
// Success (TON Center sampled live: no "jsonrpc"/"id" echo; some providers add them, e.g. Ankr's docs)
{"ok":true,"result":"6091084","@extra":"1792879597:17:11.614"}
// Error — HTTP status is also non-200
{"ok":false,"error":"failed to parse get request: Failed to parse ton_addr: 'notanaddress'","code":422,"@extra":"…"}
```
Always test `ok` (the request-level `id` may not be echoed). `@extra` is a timing/debug string; `@type` fields are tonlib type names (informational).

| `code` | Meaning |
|---|---|
| 404 | not found / `method is not supported` (unknown method, verified) |
| 409 | resource has the wrong type (e.g. `getTokenData` on a non-token: *Smart contract is not a Jetton or NFT*) |
| 422 | parameter validation (bad address, missing field — `Field is missing`) |
| 429 | rate limit (`Ratelimit exceeded`) — back off; keyless TON Center = 1 rps |
| 500 | internal / invalid BoC (`INVALID_BAG_OF_CELLS`, verified) |
| 504 | liteserver timeout — retry |
| 542 | liteserver error / unsupported TVM stack type |

### Addresses, units, identifiers
- **Raw**: `workchain:64-hex` — `0:f976e9c96a1d5446ae877dfbbb484a4248e7793e7bb3c62aa0a111ef91237eab`. **User-friendly**: 48-char base64 / base64url (`-`,`_`) of flags + workchain + account id + CRC16: `EQ…` bounceable, `UQ…` non-bounceable (mainnet), `kQ…` / `0Q…` testnet-only variants. **All endpoints accept any form** and responses mix them (e.g. `account` raw uppercase, `account_address` friendly).
- Wallets should be funded via **non-bounceable** (`UQ…`) addresses; contracts via bounceable (`EQ…`). A bounceable transfer to an uninitialized address bounces the funds back. Helpers: `detectAddress` (all forms), `packAddress` (raw → friendly), `unpackAddress` (friendly → raw).
- **Amounts** are decimal **strings in nanoton**: 1 TON = 1,000,000,000 nanoton. Jetton amounts are raw integers in the token's own decimals.
- **Transaction id** = (`lt`, `hash`): `lt` is a 64-bit *logical time* **string**, `hash` is base64 or 64-hex. Hashes accept hex (64) or base64 (44). A **BoC** is a base64 serialized cell tree (bodies, code, data, messages).
- **Workchains/shards**: `-1` = masterchain (validators, config), `0` = basechain (user accounts). Shard id `-9223372036854775808` is the whole masterchain (and an unsplit basechain); basechain shards split/merge dynamically — enumerate them with `getShards`. A block is identified by (`workchain`, `shard`, `seqno`) + `root_hash` + `file_hash`.
- **Account state**: `uninitialized` (no contract deployed) | `active` | `frozen`. An address can hold a balance while still `uninitialized` (e.g. a new wallet that has only received its first deposit); it becomes `active` once its contract is deployed.
- **`seqno`** has two meanings: a *wallet's* replay-protection counter (`getWalletInformation.seqno`, `runGetMethod seqno`) vs a *block's* sequence number.

## 3 · Method reference

The 10 core methods first (full request/response), then every other documented method in compact form (§4). Samples are trimmed (`…`); values sampled live on mainnet unless noted.

### Accounts

#### getAddressInformation
Balance, code, data, state and last tx of any account. Params `address` (required), `seqno?` (read state at a past masterchain block — in TON Center's current spec; unverified on providers).
```json
{"jsonrpc":"2.0","id":"1","method":"getAddressInformation","params":{"address":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W"}}
```
```jsonc
{"ok":true,"result":{"@type":"raw.fullAccountState","balance":"6091084","extra_currencies":[],
  "code":"te6cckEBAQEAIwAIQgKPRS16Tf10BmtoI2UXclntBXNENb52tf1L1divK3w9aCBrv3Y=","data":"te6cckEBAQEARgAA…",
  "last_transaction_id":{"@type":"internal.transactionId","lt":"50916968000001","hash":"pWoKuywed76xCy/1ncCPXwaRnDQU7VS9HO8vM8sxCoE="},
  "block_id":{"@type":"ton.blockIdExt","workchain":-1,"shard":"-9223372036854775808","seqno":101145270,"root_hash":"XP8DLjS4MtcCLBAxxuTvdMZVITWEPg4uqrF1OXnm4Pg=","file_hash":"slVW66g+oNNa5llw7sqN0bU1y5U7vtF/HGZBcxwuTwA="},
  "frozen_hash":"","sync_utime":1792879588,"state":"active","suspended":false}}
```
- `balance` is nanoton (6,091,084 = 0.006091084 TON). `code`/`data` are BoC (base64) — empty for uninitialized accounts. `sync_utime` = unix seconds of the block read. `last_transaction_id` is the cursor for `getTransactions`.

#### getAddressBalance
Only the balance. Params `address`, `seqno?`.
```json
{"jsonrpc":"2.0","id":"1","method":"getAddressBalance","params":{"address":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W"}}
```
```json
{"ok":true,"result":"6091084"}
```
- A never-used address returns `"0"` (not an error). Result is a **string**.

#### getAddressState
`"uninitialized"` | `"active"` | `"frozen"` (verified: a random unused raw address → `"uninitialized"`). Params `address`, `seqno?`.
```json
{"jsonrpc":"2.0","id":"1","method":"getAddressState","params":{"address":"0:6d1fc1e1a2c2f6a9d0e5a0b5c0a8b8f3a1b2c3d4e5f60718293a4b5c6d7e8f90"}}
```
```json
{"ok":true,"result":"uninitialized"}
```

#### getWalletInformation
Wallet-aware view: wallet type, `seqno` (needed to send), subwallet id. **Check `wallet:true` first.** Params `address`, `seqno?`.
```json
{"jsonrpc":"2.0","id":"1","method":"getWalletInformation","params":{"address":"EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N"}}
```
```json
{"ok":true,"result":{"@type":"ext.accounts.walletInformation","wallet":true,"balance":"1592542221079555","account_state":"active","wallet_type":"wallet v3 r2","seqno":343,"wallet_id":698983191,"last_transaction_id":{"@type":"internal.transactionId","lt":"109633787000015","hash":"10beCuKo9PUZEz6P/6NcvPePRnh8BPumR+7KzQOZyPU="}}}
```
- For a non-wallet contract the response is `{"wallet":false,"balance":…,"account_state":…,"last_transaction_id":…}` with **no** `wallet_type` / `seqno`. Known types per the docs include `wallet v3 r2`, `wallet v4 r2`, `wallet v5 r1`, `tg-wallet`; v5 also returns `is_signature_allowed`.

#### getTransactions
Account history, **newest first**. Params `address`, `limit?` (default 10, max 100 per Ankr), `lt?` + `hash?` (start point, send together), `to_lt?` (stop), `archival?` (true = only full-history liteservers).
```json
{"jsonrpc":"2.0","id":"1","method":"getTransactions","params":{"address":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W","limit":2}}
```
```jsonc
{"ok":true,"result":[{
  "@type":"ext.transaction","account":"0:F976E9C96A1D5446AE877DFBBB484A4248E7793E7BB3C62AA0A111EF91237EAB",
  "address":{"@type":"accountAddress","account_address":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W"},
  "utime":1731670761,"data":"te6cckECDwEAAywAA7V/l26c…",
  "transaction_id":{"@type":"internal.transactionId","lt":"50916968000001","hash":"pWoKuywed76xCy/1ncCPXwaRnDQU7VS9HO8vM8sxCoE="},
  "fee":"1637729","storage_fee":"3329","other_fee":"1634400",
  "in_msg":{"@type":"ext.message","hash":"3jx5RrwwWIowm2IRuVrMGqrhUpm1aQNxn1u2VprmOIA=","source":"EQAAOIgLfMTTvAjkATrYCQrow4DFN10rYXX0XtWl0PvSX5uk","destination":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W","value":"50000000","fwd_fee":"526938","ihr_fee":"0","created_lt":"50916965000002","body_hash":"Y15DtyjbzMrE23EtehlgWUMCwxbUuYdqgVHwElGObWs=","msg_data":{"@type":"msg.dataRaw","body":"te6cckEBAgEAZg…"},"message":"D4p+pe/kbVTh…"},
  "out_msgs":[{"@type":"ext.message","source":"EQD5dunJah1URq6Hffu7SEpCSOd5PnuzxiqgoRHvkSN-q19W","destination":"EQCM7pu2eD2mJQU3hbyqOpnUSVUsWgWY2FnTXGVdU8uU4Ddb","value":"48365600","fwd_fee":"822940","ihr_fee":"0","created_lt":"50916968000002" /* , hash, body_hash, msg_data, message */}]
} /* , … */]}
```
- Pagination: pass the **`lt` and `hash` of the oldest returned tx**; the next page **starts with (includes) that same tx** (verified) — drop the duplicate. Stop when a page returns ≤ 1 item.
- `utime` = unix seconds; fees are nanoton strings. `in_msg.source` empty = external message (typical for wallet sends); `message` holds the decoded **text comment** only when the body is a plain comment. `out_msgs` are messages this tx *created* — their own processing is a separate tx on the destination (find it with `tryLocateResultTx`). Older history needs `archival:true`. Variant `getTransactionsStd` returns a standardized shape with a `previous_transaction_id` cursor.

### Blocks and chain

#### getMasterchainInfo
Latest masterchain block (the reference for "now"). No params.
```json
{"jsonrpc":"2.0","id":"1","method":"getMasterchainInfo","params":{}}
```
```json
{"ok":true,"result":{"@type":"blocks.masterchainInfo","last":{"@type":"ton.blockIdExt","workchain":-1,"shard":"-9223372036854775808","seqno":101142643,"root_hash":"HzNuMHG+FyaU0+2DJCGwVsXELoMRNLvCQKALr3Rs/qg=","file_hash":"kgfeejr+vzQSXvjgA/xKh5FYhKdMLEh7YCmh6T2RHtM="},"state_root_hash":"66/3umJWO+LGgSFSRto3dBa24d/5qZ7lAgK3v5Dulxw=","init":{"@type":"ton.blockIdExt","workchain":-1,"shard":"0","seqno":0,"root_hash":"F6OpKZKqvqeFp6CQmFomXNMfMj2EnaUSOXN+Mh+wVWk=","file_hash":"XplPz01CXAps5qeSWUtxcyBfdAo5zVb1N979KLSKD24="}}}
```
- `last.seqno` = current masterchain height. Pass it (minus a few) to block methods that need a recent `seqno`.

#### lookupBlock
Block id by position or time. Params `workchain` (required), `shard` (required, **string**), and **exactly one** of `seqno` | `lt` | `unixtime`.
```json
{"jsonrpc":"2.0","id":"1","method":"lookupBlock","params":{"workchain":-1,"shard":"-9223372036854775808","seqno":101142744}}
```
```json
{"ok":true,"result":{"@type":"ton.blockIdExt","workchain":-1,"shard":"-9223372036854775808","seqno":101142744,"root_hash":"42MG73DD7E6t/qJ6SChs9dD31cSKTde+IsLeRS4u4Hw=","file_hash":"vI7n8CH6EIJWuDgfG1ceNAW9MIWZnaZi9xhSxp9ZeL4="}}
```
- Use `unixtime` to find the block at a wall-clock time. Providers only keep recent blocks for some block methods (Ankr's docs: roughly the last two days for `lookupBlock`, `getBlockHeader`, `getBlockTransactions*`, `shards`, signatures/proof).

### Smart-contract calls

#### runGetMethod
Execute a read-only **get method** on a contract (the TON equivalent of `eth_call`). **POST.** Params `address`, `method` (name **or** numeric id), `stack` (array of `[type, value]` input args, `[]` for none), `seqno?`.
```json
{"jsonrpc":"2.0","id":"1","method":"runGetMethod","params":{"address":"EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N","method":"seqno","stack":[]}}
```
```jsonc
{"ok":true,"result":{"@type":"smc.runResult","gas_used":549,"exit_code":0,"stack":[["num","0x157"]],
  "block_id":{"@type":"ton.blockIdExt","workchain":-1,"shard":"-9223372036854775808","seqno":101144890,"root_hash":"…","file_hash":"…"},
  "last_transaction_id":{"@type":"internal.transactionId","lt":"109633787000015","hash":"10beCuKo…"}}}
```
- **Success = `exit_code` 0 or 1.** A missing method / failing code still returns HTTP 200 with `ok:true` and a non-zero `exit_code` (verified: an unknown method gave `"exit_code":11`) — always check it.
- Stack entries are `[type, value]`: output `["num","0x157"]` (hex string, negatives like `"-0x1"`), `["cell",{"bytes":"<base64 BoC>"}]` (+ parsed `object`), `["slice",…]`, tuples/lists. Input types per the current spec: `["num","<decimal string>"]`, `["cell","<base64 BoC>"]`, `["slice","<base64 BoC>"]`; Ankr's docs example uses the older tag `["tvm.Slice","<base64 BoC>"]`. Addresses must be passed as a slice BoC (needs a TON library to build).
- `runGetMethodStd` (TON Center spec) is the typed variant: stack entries are objects `{"@type":"tvm.stackEntryNumber","number":{"@type":"tvm.numberDecimal","number":"343"}}`, `tvm.stackEntryCell` / `…Slice` / `…Tuple` / `…List`.
- Example on a jetton master — `get_jetton_data` (`stack:[]`) returned `[["num","0x5148e3baabcb0"] (total supply), ["num","-0x1"] (mintable), ["cell",…] (admin), ["cell",…] (content), ["cell",…] (wallet code)]`.

### Sending

#### sendBoc
Broadcast a fully-built, **signed external message** (BoC, base64). **POST** body `{"boc":"<base64>"}`.
```json
{"jsonrpc":"2.0","id":"1","method":"sendBoc","params":{"boc":"<BASE64_SIGNED_EXTERNAL_MESSAGE>"}}
```
```json
{"ok":true,"result":{"@type":"ok"}}
```
- Returns as soon as the message is **accepted** for propagation — not executed. Confirm via `getTransactions` / `tryLocateResultTx`. A malformed BoC → `{"ok":false,"error":"INVALID_BAG_OF_CELLS: …","code":500}` (verified with a junk BoC). `sendBocReturnHash` has the same input and returns `{"@type":"ext.messageInfo","hash":"<base64>","hash_norm":"<base64>"}` — **prefer it**: you get the message hash to track.
- Availability: on TON Center and BlockPI docs; **absent from Ankr's documented list**. Building and signing the message (wallet-version-specific cell layout, `seqno`, `valid_until`, Ed25519 signature) is done locally with a TON library — never send a private key to an RPC.

#### estimateFee
Fee breakdown for a message without sending it. **POST.** Params `address` (destination), `body` (base64 BoC of the message body), `init_code?`, `init_data?` (for deployments), `ignore_chksig?` (skip signature check — set **`true`** when you have no real signature yet; TON Center's spec defaults it to `true`, Ankr's docs say `false`, so always send it explicitly).
```json
{"jsonrpc":"2.0","id":"1","method":"estimateFee","params":{"address":"EQBVbC7Hu-g3htYXzst8L5ucV76NMzeBK3URJKebN2Y1k55Q","body":"te6ccgEBBAEAwwABRYgAqthdj3fQ…","ignore_chksig":true}}
```
```json
{"ok":true,"result":{"@type":"query.fees","source_fees":{"@type":"fees","in_fwd_fee":996800,"storage_fee":0,"gas_fee":40000,"fwd_fee":0},"destination_fees":[]}}
```
- Fees are **integers in nanoton** (unlike most amounts, which are strings): total ≈ `in_fwd_fee + storage_fee + gas_fee + fwd_fee`. It is an estimate — actual fees depend on contract/chain state at execution time, so keep a margin.

## 4 · Remaining methods (compact)

Same envelope and `ok`/`code` handling. `?` = optional. Names are the TON Center v2 spec's; providers' docs use the legacy aliases shown in brackets (TON Center accepts both — verified for `shards` and `config_id`; with Ankr/BlockPI use the names from their docs).

| Method | Params | Returns |
|---|---|---|
| `getExtendedAddressInformation` | `address`, `seqno?` | `fullAccountState` with parsed contract state for known contract types (use `getWalletInformation` to detect wallets) |
| `getTokenData` | `address` | Jetton master (`total_supply`, `mintable`, `admin_address`, `jetton_content`, `jetton_wallet_code`), Jetton wallet (`balance`, `owner`, `jetton`), NFT item or collection — auto-detected via `contract_type`; non-token → 409 |
| `detectAddress` | `address` | `raw_form`, `bounceable{b64,b64url}`, `non_bounceable{…}`, `given_type`, `test_only` |
| `packAddress` / `unpackAddress` | `address` | friendly ⇄ raw string |
| `detectHash` | `hash` | the hash in hex and base64 forms (TON Center spec; not in the providers' docs) |
| `getShards` [`shards`] | `seqno` (masterchain block) | `{shards:[blockIdExt…]}` active shard blocks |
| `getBlockHeader` | `workchain`, `shard`, `seqno`, `root_hash?`, `file_hash?` | block metadata (`global_id`, `version`, `flags`, `after_merge`, `start_lt`, `end_lt`, `gen_utime`, prev blocks, …) |
| `getBlockTransactions` | `workchain`, `shard`, `seqno`, `root_hash?`, `file_hash?`, `after_lt?`, `after_hash?`, `count?` (default 40) | `{incomplete, req_count, transactions:[{account,lt,hash,mode}]}` — page with `after_lt` + `after_hash` while `incomplete:true` |
| `getBlockTransactionsExt` | same | the same list with full transaction objects |
| `getMasterchainBlockSignatures` | `seqno` | validator signatures of a masterchain block |
| `getShardBlockProof` | `workchain`, `shard`, `seqno`, `from_seqno?` | Merkle proof linking a shard block to a masterchain block |
| `getConsensusBlock` | — | `{consensus_block, timestamp}` |
| `getOutMsgQueueSize` [`getOutMsgQueueSizes`] | — | outbound message-queue size per shard (congestion signal) |
| `getBlock` | `workchain`, `shard`, `seqno`, `root_hash?`, `file_hash?`, `archival?` | raw block as base64 BoC (TON Center spec; not in providers' docs) |
| `tryLocateTx` / `tryLocateResultTx` | `source`, `destination`, `created_lt` | the transaction on the **destination** that processed that message |
| `tryLocateSourceTx` | `source`, `destination`, `created_lt` | the transaction on the **source** that emitted it |
| `getConfigParam` | `param` [`config_id` in Ankr/BlockPI docs], `seqno?` | `configInfo` with the parameter as a BoC cell (e.g. 20 / 21 = gas prices) |
| `getConfigAll` | `seqno?` | full blockchain config as a BoC |
| `getLibraries` | `libraries` (hashes) | library code cells (TON Center spec; not in providers' docs) |
| `dnsResolve` | `domain`, `resolver_address?`, `seqno?` | `.ton` / `.t.me` DNS records (TON Center spec; not in providers' docs) |
| `getShardAccountCell` | `address`, `seqno?` | raw shard-account cell (TON Center spec) |
| `runGetMethodStd` | as `runGetMethod`, typed stack | typed stack result (TON Center spec) |
| `sendBocReturnHash` | `boc` | message `hash` + `hash_norm` (see `sendBoc`) |
| `sendQuery` | legacy | listed only in BlockPI's docs; absent from the current TON Center spec — avoid |

TON Center v2 spec: **36 methods + `jsonRPC`** (`POST /api/v2/jsonRPC`). Ankr documents 27 of them; BlockPI lists 29 endpoints (incl. `sendQuery` and `jsonRPC`).

## 5 · Recipes

- **TON balance**: `getAddressBalance` (nanoton string ÷ 1e9) — `"0"` for unseen addresses; `getAddressState` tells you if it's `uninitialized`.
- **Jetton (e.g. USDT) balance for a holder**: you need the holder's *jetton wallet* address. Either (a) you already have it → `getTokenData` on it (`balance` raw, `owner`, `jetton` master); or (b) derive it: `runGetMethod` on the **jetton master** with method `get_wallet_address` and stack `[["slice","<holder address as slice BoC>"]]` → decode the returned slice to an address → then (a). Divide by the token's decimals (master's `jetton_content.data.decimals`; USDT-TON master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` = 6 decimals, verified).
- **Recent activity**: `getTransactions(limit)` → follow `lt`/`hash` for older pages (dedupe the boundary tx).
- **Send TON**: `getWalletInformation` (seqno, wallet_type) → build + sign the external message locally for that wallet version → optional `estimateFee` (`ignore_chksig:true`) → `sendBocReturnHash` → poll `getTransactions` for the wallet (or `tryLocateResultTx`) until a new transaction carrying your message appears; then follow its `out_msgs` to the recipient's transaction. If the wallet `seqno` hasn't advanced and the message's `valid_until` has passed, rebuild and resend.
- **What happened to my message?** `tryLocateTx` (destination tx), `tryLocateSourceTx` (who sent it), using `source` / `destination` / `created_lt` from the message object.

## 6 · Gotchas

- **Named-object params and string ids** in the JSON-RPC wrapper (`"params":{…}`, `"id":"1"`) — positional arrays or numeric ids from EVM/Solana habits get a 422 or are ignored.
- **`ok:false` carries the error** — the HTTP status is non-200 too, but check the body. `runGetMethod` is the exception: failures come back `ok:true` with a non-zero `exit_code`.
- **Amounts are strings** (up to 2^64 and beyond): parse as BigInt/decimal. `estimateFee` fee fields are plain integers.
- **Address forms are interchangeable but not identical text** — normalise with `detectAddress`/`unpackAddress` before comparing. Use non-bounceable addresses for wallets.
- **Async execution**: a successful `sendBoc` is only "accepted". The wallet tx, then the recipient's tx, appear later; fees are split across them.
- **`getTransactions` pagination is inclusive** of the (`lt`,`hash`) you pass; history older than the liteserver window needs `archival:true`.
- **Block methods only serve recent blocks** on Ankr (≈ last two days per its docs); `seqno`-parametrised historical reads (`getAddressInformation?seqno=`) are unverified on providers.
- **Provider surface differs**: Ankr = v2 REST + JSON-RPC (no documented `sendBoc`); BlockPI = v2 REST + `/jsonRPC` (plan-gated), possibly a v3 route; no Alchemy; no v3 on Ankr. For indexed queries (jetton transfer history, traces, NFT sales) there is no verified BYOK path — scan `getTransactions`/blocks yourself, or test BlockPI's v3 route.
- **Naming drift**: legacy vs new names (`shards`/`getShards`, `getOutMsgQueueSizes`/`getOutMsgQueueSize`, `config_id`/`param`) and stack tags (`tvm.Slice` vs `slice`) — use the spelling in the provider's own docs.
- **Rate limits**: keyless TON Center is 1 rps; providers apply plan limits — on 429 back off and retry.
- The key is part of the URL — keep it out of logs and transcripts.

*Sources checked*: docs.ton.org (TON Center API v2/v3 overview, authentication, error codes, rate limits, address formats, sharding) and TON Center's OpenAPI 3.1 spec `toncenter.com/api/v2/openapi.json` (v2.1.17, 36 methods + `jsonRPC`); Ankr `chains-list/s-t-p3`, `chains-api/ton` (+ 4 methods pages); BlockPI `blockpi.io/chain/ton`, docs TON index + `/jsonRPC`, supported-networks table; Alchemy chain directory (no TON). Behaviours marked "verified" or "sampled" were read from TON Center's public keyless mainnet API; Ankr's and BlockPI's docs reproduce the same v2 methods and response shapes, but provider-specific behaviour was not tested (no keys).
