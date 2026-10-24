# TRON RPC (BYOK)

TRON via the user's **own Ankr or Alchemy key** from the Clawby Key Vault (fetch steps, IP whitelist, vault errors: `rpc/index.yaml` and `rpc/<provider>.md`). Direct to the provider — not via Clawby relay, no Clawby credits. **BlockPI lists no TRON endpoint** (§1) — if the user only has a BlockPI key, TRON is not available through BYOK.

TRON is **not Ethereum**. A node exposes **two different interfaces** and you must pick the right one:

1. **HTTP REST API** (native, complete): `POST <base>/wallet/<method>` (FullNode, latest head) and `POST <base>/walletsolidity/<method>` (SolidityNode, *solidified* = final state, read-only), JSON in / JSON out. Almost everything — accounts, blocks, tx receipts, contract reads, building and broadcasting transactions, resources — lives here.
2. **JSON-RPC** (`eth_*` / `net_*` / `web3_*` + `buildTransaction`): an Ethereum-flavoured *partial* compatibility layer for reads. It cannot broadcast (no `eth_sendRawTransaction`), takes **hex addresses only**, and most state reads support only the `latest` tag.

> The key sits in the endpoint URL, so **the whole URL is a secret**. Never log, echo or commit it.

## 1 · Endpoints (mainnet)

| Provider | REST (append `/wallet/<m>` or `/walletsolidity/<m>`) | JSON-RPC URL | Notes |
|---|---|---|---|
| Ankr | `https://rpc.ankr.com/premium-http/tron/{KEY}` | `https://rpc.ankr.com/tron_jsonrpc/{KEY}` | **Premium plan only** (a Freemium key should expect `-32052`, per `ankr.md`). Does *not* follow the generic `rpc.ankr.com/{slug}/{KEY}` template — a bare `rpc.ankr.com/tron/{KEY}` is wrong; the two paths shown are the ones Ankr documents. Many `/wallet/*` paths are blocked, see below. JSON-RPC lists 26 methods. |
| Alchemy | `https://tron-mainnet.g.alchemy.com/v2/{KEY}` | per Alchemy's Tron `eth_*` doc pages: `POST` to the same base URL `https://tron-mainnet.g.alchemy.com/v2/{KEY}` — **unverified, see note** | Chain id 728126428 (`0x2b6653dc`). Testnet slug `tron-testnet`. Product surface: RPC + gRPC only (no WebSockets / Token / NFT / Transfers APIs). Docs index: 75 FullNode + 27 Solidity HTTP pages + 37 JSON-RPC pages. |
| BlockPI | — | — | Not listed in BlockPI's network table or docs (`blockpi.io/chain/tron` is 404). |

Reference only (not a BYOK provider): TronGrid `https://api.trongrid.io` serves `/wallet/*`, `/walletsolidity/*`, `/jsonrpc` and the extra `/v1/...` indexed API (TRC-20 history, events, token holders). The `/v1/...` API is **not** offered through Ankr or Alchemy (absent from both providers' docs) — use `eth_getLogs` / per-block scans instead.

**Ankr blocks (Premium)**: `/wallet/easytransfer*`, `gettransactionsign`, `createaddress`, `generateaddress`, `listnodes`, `getnodeinfo`, `addtransactionsign`, and all shielded-note helpers (`getakfromask`, `getnkfromnsk`, `getspendingkey`, `getexpandedspendingkey`, `getdiversifier`, `getincomingviewingkey`, `createspendauthsig`, `getnewshieldedaddress`, `createshieldedtransaction`, `createshieldedcontractparameters*`, `scanshieldedtrc20notesby{ivk,ovk}`, `isshieldedtrc20contractnotespent`). Ankr's REST list also predates newer endpoints (`estimateenergy`, `getcontractinfo`, `getblock`, `getenergyprices`, Stake 2.0 `*v2`) — absent from its docs ≠ proven unsupported; test before relying.

**Alchemy**: its docs index lists `gettransactioninfobyid` / `gettransactioninfobyblocknum` only under `/walletsolidity/`; use that (final-state). `/wallet/` availability of those two is unverified on Alchemy.

**Alchemy JSON-RPC caveat (unresolved).** Alchemy's Tron docs have 37 `eth_*` / `net_*` / `web3_*` pages whose examples POST to the base `/v2/{KEY}` URL, but its Tron FAQ calls the API "a custom HTTP JSON RPC-style API, rather than the standard Ethereum-style JSON-RPC", and `rpc/alchemy.md` records it as "HTTP JSON API … not JSON-RPC". I could not test it (Alchemy's `docs-demo` key is origin-locked, 403). **On Alchemy use the REST interface (§3); treat §4 as Ankr/TronGrid-verified and try `eth_*` on Alchemy only as a fallback.**

```bash
# REST helper  (Alchemy shown; Ankr: TRON_REST="https://rpc.ankr.com/premium-http/tron/$ANKR_KEY")
TRON_REST="https://tron-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY"
tron() { local b="${2:-}"; [ -n "$b" ] || b='{}'; curl -s -X POST "$TRON_REST/$1" -H 'Content-Type: application/json' -d "$b"; }
tron wallet/getaccount '{"address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","visible":true}'

# JSON-RPC helper (Alchemy: same base URL; Ankr: https://rpc.ankr.com/tron_jsonrpc/$ANKR_KEY)
TRON_JSONRPC="https://tron-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY"
trpc() { curl -s -X POST "$TRON_JSONRPC" -H 'Content-Type: application/json' -d "$1"; }
trpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

## 2 · Conventions (read this before calling anything)

**Addresses.** Three forms of the same address:
- Base58Check `T…` (34 chars) — human form, used with REST `"visible":true`.
- Hex with `41` prefix, 21 bytes (`41a614f803b6fd780986a42c78ec9c7f77e6ded13c`) — REST default (`visible` omitted/false).
- 20-byte hex = the 21-byte form without `41` (`0xa614f8…ded13c`) — JSON-RPC, log `address`, ABI-encoded args.

JSON-RPC takes **hex only** (20-byte, or 21-byte with `41`; with or without `0x`); a `T…` address fails with `-32602 exception decoding Hex string` (verified).

```python
import hashlib
A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58_to_hex(addr):                       # 'T…' -> '41…' (21 bytes)
    n=0
    for c in addr: n=n*58+A.index(c)
    raw=n.to_bytes(25,"big"); assert hashlib.sha256(hashlib.sha256(raw[:-4]).digest()).digest()[:4]==raw[-4:]
    return raw[:-4].hex()
def hex_to_b58(h):                          # '41…' | '0x…' | 20-byte -> 'T…'
    b=bytes.fromhex(h[2:] if h.startswith("0x") else h); b=b if len(b)==21 else b"\x41"+b
    raw=b+hashlib.sha256(hashlib.sha256(b).digest()).digest()[:4]; n=int.from_bytes(raw,"big"); s=""
    while n: n,r=divmod(n,58); s=A[r]+s
    return s
```

**`visible`** (REST bodies): `true` → addresses in the request **and** response are Base58; omitted/`false` → hex. The request address must match the mode. For `getnowblock` it is a **query** parameter (`?visible=true`) — a `visible` in the POST body is ignored (verified). `gettransactioninfobyid` also honours `visible` (converts `contract_address` / log `address`).

**Units.** 1 TRX = **1,000,000 sun**. Balances, `amount`, `call_value`, `fee_limit`, fees are in sun; timestamps and `expiration` are **milliseconds**; block time = 3 s. `getaccount.balance` and `eth_getBalance` are the same number (decimal vs hex sun).

**Resources.** Every tx burns Bandwidth (bytes; 600 free per activated account per day) and contract calls burn Energy; shortfalls are paid in TRX. Live chain parameters: Energy 100 sun/unit (`getEnergyFee`), Bandwidth 1,000 sun/byte (`getTransactionFee`), `getCreateAccountFee` = 100,000 sun and `getCreateNewAccountFeeInSystemContract` = 1,000,000 sun (account-activation costs), `getMaxFeeLimit` = 15,000,000,000 sun.

**proto3 JSON.** Default values are **omitted**: a missing number is 0, missing bool is false, a missing `type` in `frozenV2` means `BANDWIDTH`, and a successful `gettransactioninfobyid` has **no top-level `result`** (only failures carry `"result":"FAILED"`).

**Errors / not-found (REST).** HTTP status is almost always 200. Failure = body `{"Error":"…"}`; not found / inactive account = **`{}`** (verified for `getaccount`, `gettransactionbyid`, `gettransactioninfobyid`, `getblockbynum`). Always check for `Error` and for `{}`. Rate-limit/oversize can give 4xx/413 (`TRON-PRO-API-KEY` applies to TronGrid only).

## 3 · REST methods

Every request below is `POST <TRON_REST>/<path>` with the JSON shown (`tron <path> '<json>'`). Solidity twins use `/walletsolidity/<same name>` and the same body. Samples are trimmed; some values illustrative.

### Accounts

#### `/wallet/getaccount`
Account state: TRX balance, staking, votes, permissions, TRC-10. Params `address` (required), `visible`.
```json
{"address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","visible":true}
```
```jsonc
{"address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","balance":1750447480,"create_time":1619598471000,"latest_opration_time":1776410580000,
 "frozenV2":[{"amount":44907000000},{"type":"ENERGY","amount":5000000},{"type":"TRON_POWER"}],
 "delegated_frozenV2_balance_for_bandwidth":93000000,
 "net_window_size":28800000,"net_window_optimized":true,
 "account_resource":{"acquired_delegated_frozenV2_balance_for_energy":145000000,"energy_window_size":28800000},
 "assetV2":[{"key":"1000745","value":99900}],
 "owner_permission":{"permission_name":"owner","threshold":1,"keys":[{"address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","weight":1}]},
 "active_permission":[{"type":"Active","id":2,"permission_name":"active","threshold":2,"operations":"7fff1fc0…","keys":[/* … */]}]}
```
- `balance` in sun (above: 1,750.44748 TRX). **Never-activated address → `{}`.** Field `latest_opration_time` is spelled that way in the protocol. TRC-10 in `assetV2` (`key` = token id); **TRC-20 balances are not here** — call the token contract (§3 "Smart contracts"). Time fields are ms.

#### `/wallet/getaccountresource`
Bandwidth / Energy / TRON Power limits and usage. Params `address`, `visible`.
```json
{"address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","visible":true}
```
```json
{"freeNetUsed":120,"freeNetLimit":600,"NetUsed":320,"NetLimit":1500,"TotalNetLimit":43200000000,"TotalNetWeight":1000000000,"EnergyUsed":5000,"EnergyLimit":100000,"TotalEnergyLimit":180000000000,"TotalEnergyWeight":2000000000}
```
- Available = limit − used (zero fields are omitted → treat missing as 0): free bandwidth `freeNetLimit−freeNetUsed`, staked `NetLimit−NetUsed`, energy `EnergyLimit−EnergyUsed`. `assetNetUsed` / `assetNetLimit` are `[{key,value}]` lists (TRC-10). Mixed key casing (`freeNetLimit` vs `NetLimit`) — match exactly.

#### `/wallet/getaccountnet`
Bandwidth only (subset of the above). Params `address`, `visible`. Returns `freeNetUsed`, `freeNetLimit`, `NetUsed`, `NetLimit`, `TotalNetLimit`, `TotalNetWeight`, `assetNetUsed`, `assetNetLimit`.
```json
{"address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","visible":true}
```

#### `/wallet/getaccountbalance`
TRX balance **at a given block** (needs node balance-history; may silently return 0 if the node doesn't keep it). Params `account_identifier.address`, `block_identifier.{hash,number}` (both required, must match), `visible`.
```json
{"account_identifier":{"address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM"},"block_identifier":{"hash":"0000000000010c4a732d1e215e87466271e425c86945783c3d3f122bfa5affd9","number":68682},"visible":true}
```
```json
{"balance":64086449348265042,"block_identifier":{"hash":"0000000000010c4a732d1e215e87466271e425c86945783c3d3f122bfa5affd9","number":68682}}
```
- Whether Ankr / Alchemy keep balance history is **unverified** — treat a `0` for an old block with suspicion.

### Blocks

#### `/wallet/getnowblock`
Newest block of this node (may not be solidified). `POST` or `GET`; no body. `visible` goes in the **query**.
```json
{}
```
```jsonc
{"blockID":"000000000535a67093ec6901849f9600504029886491fa282df22194e8bafcac",
 "block_header":{"raw_data":{"number":87402096,"txTrieRoot":"a916d46d…","witness_address":"TGyrSc9ZmTdbYziuk1SKEmdtCdETafewJ9","parentHash":"000000000535a66fae043a16…","version":39,"timestamp":1792879488000},"witness_signature":"4139853c…"},
 "transactions":[{"ret":[{"contractRet":"SUCCESS"}],"txID":"d0807adb…","raw_data":{"contract":[{"type":"TransferContract","parameter":{"value":{"amount":1,"owner_address":"…","to_address":"…"},"type_url":"type.googleapis.com/protocol.TransferContract"}}],"ref_block_bytes":"…","ref_block_hash":"…","expiration":1792879548000,"timestamp":1792879488000}}]}
```
- Block height = `block_header.raw_data.number`. `transactions` is **absent** for an empty block. Sample above: `?visible=true` made `witness_address` Base58. For final state use `/walletsolidity/getnowblock` (lags head by ≈ 1 min; ~21 blocks observed).

#### `/wallet/getblock`
Block by number **or** hash, header-only or full. Params `id_or_num` (string; omit = newest), `detail` (bool, default false = header only).
```json
{"id_or_num":"87400000","detail":false}
```
```json
{"blockID":"0000000005359e404d8cf2765d6f4f35bc771711652f0dbc520bcbcc510c379c","block_header":{"raw_data":{"number":87400000,"timestamp":1792873200000,"txTrieRoot":"…","parentHash":"…","witness_address":"…","version":39},"witness_signature":"…"}}
```
- With `"detail":true` the response also holds `transactions[]`. Send `id_or_num` as a **string**.

#### `/wallet/getblockbynum`
Full block (with all transactions) by height. Param `num` (int).
```json
{"num":87400000}
```
- Same shape as `getnowblock`. Heavy (hundreds of txs). A height beyond the head → **`{}`**.

#### `/wallet/getblockbyid`
Full block by block hash. Param `value` (block hash / `blockID`).
```json
{"value":"0000000005359e404d8cf2765d6f4f35bc771711652f0dbc520bcbcc510c379c"}
```

#### `/wallet/getblockbylatestnum`
Newest N blocks (ascending), each with transactions. Param `num`.
```json
{"num":2}
```
```jsonc
{"block":[{"blockID":"…","block_header":{"raw_data":{"number":87402292,/* … */}},"transactions":[/* … */]},{"blockID":"…","block_header":{"raw_data":{"number":87402293,/* … */}}}]}
```
- Results may be unsolidified. Max `num` isn't documented — keep it small.

#### `/wallet/getblockbylimitnext`
Blocks in a height range, `startNum` inclusive, `endNum` **exclusive** (docs' own sample contradicts this — verify boundaries). Max span undocumented.
```json
{"startNum":87400000,"endNum":87400003}
```
```jsonc
{"block":[{"blockID":"…","block_header":{/* … */},"transactions":[/* … */]} /* , … */]}
```

### Transactions

#### `/wallet/gettransactionbyid`
Transaction **body** + signatures (no execution receipt). Param `value` = txID (64 hex).
```json
{"value":"d5ec749ecc2a615399d8a6c864ea4c74ff9f523c2be0e341ac9be5d47d7c2d62"}
```
```jsonc
{"ret":[{"contractRet":"SUCCESS"}],"signature":["ffbf691a…"],"txID":"d0807adb3c5412aa150787b944c96ee898c997debdc27e2f6a643c771edb5933",
 "raw_data":{"contract":[{"parameter":{"value":{"amount":16,"asset_name":"54726f6e696373","owner_address":"414a5fe0179f2dd9c900194e63d661863cd0ade7b0","to_address":"41718de6b323652d1257437ace160c4f4198aae4e1"},"type_url":"type.googleapis.com/protocol.TransferAssetContract"},"type":"TransferAssetContract"}],
 "ref_block_bytes":"6bdd","ref_block_hash":"1616edaf3a57fe19","expiration":1546455678000,"timestamp":1546455620175},"raw_data_hex":"…"}
```
- Unknown / not-yet-seen txID → **`{}`**. `ret[0].contractRet` = execution outcome (`SUCCESS` for success; failures show another value); `raw_data.contract[0].type` = `TransferContract` (TRX), `TransferAssetContract` (TRC-10), `TriggerSmartContract` (contract call incl. TRC-20 `transfer`), … `raw_data.fee_limit` (sun) present for contract calls. `/walletsolidity/gettransactionbyid` returns the body only once solidified → use it to confirm finality.

#### `/wallet/gettransactioninfobyid`
Execution **receipt**: fees, Energy/Bandwidth used, result, event logs, internal txs. Param `value`; `visible` honoured.
```json
{"value":"b71e71a171404949d67d0eb1562ff99d802994a5e91cf683c4f1f8b62db5d726","visible":true}
```
```jsonc
{"id":"b71e71a171404949d67d0eb1562ff99d802994a5e91cf683c4f1f8b62db5d726","blockNumber":87402333,"blockTimeStamp":1792880199000,
 "contractResult":["0000000000000000000000000000000000000000000000000000000000000000"],
 "contract_address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
 "receipt":{"energy_usage":64284,"origin_energy_usage":1,"energy_usage_total":64285,"net_usage":345,"result":"SUCCESS","energy_penalty_total":49635},
 "log":[{"address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","topics":["ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0000000000000000000000001516470dcee35a95afffcc4b0f07674e1dd893f8","000000000000000000000000124820a1ee400ae5d330d315f7b01c03954bb83e"],"data":"0000000000000000000000000000000000000000000000000000000001036640"}]}
```
- Unknown / pending → `{}`. **Success detection** (TRON's own rule): top-level `result` is **not** `"FAILED"` **and** `receipt.result == "SUCCESS"` (a plain TRX transfer has only `receipt.net_usage`; use `gettransactionbyid.ret[0].contractRet` for those). `fee` (sun) is omitted when 0 — e.g. when staked Energy/Bandwidth covered the cost. Log `topics` / `data` here have **no `0x`**; event `Transfer(address,address,uint256)` topic0 = `ddf252ad…`; the value above is `0x01036640` = 17,000,000 raw units (17 USDT).
- Failures: `receipt.result` other than `SUCCESS` (e.g. `REVERT`, `OUT_OF_ENERGY`) and/or `resMessage`.

#### `/wallet/gettransactioninfobyblocknum`
All receipts of a block. Param `num`. Returns an **array** of the object above (verified: 456 items for one mainnet block). Plain TRX transfers carry only `{"id","blockNumber","blockTimeStamp","contractResult":[""],"receipt":{"net_usage":265}}`.
```json
{"num":87400000}
```

### Smart contracts and TRC-20

#### `/wallet/triggerconstantcontract`
Read-only contract call (`view`/`pure`) — the way to read TRC-20/721 state. Nothing is broadcast and no resources are spent. Params `owner_address`, `contract_address`, `function_selector` (e.g. `balanceOf(address)`) + `parameter` (ABI-encoded args, hex, **no `0x`**, no selector) **or** `data` (selector+args), optional `call_value`, `visible`.
```json
{"owner_address":"TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9","contract_address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","function_selector":"balanceOf(address)","parameter":"00000000000000000000000082dd6b9966724ae2fdc79b416c7588da67ff1b35","visible":true}
```
```jsonc
{"result":{"result":true},"energy_used":4062,"energy_penalty":3127,
 "constant_result":["00000000000000000000000000000000000000000000000000000000002f4d60"],
 "transaction":{"ret":[{}],"txID":"…","raw_data":{/* unsigned, never sent */},"raw_data_hex":"…"}}
```
- `constant_result[0]` = the ABI-encoded return value (here uint256 `0x2f4d60` = 3,100,000 raw → **3.1 USDT**, 6 decimals — USDT TR7NHq… live). `parameter` = the holder's address as `24 zeros + 20-byte hex`: `"0"*24 + b58_to_hex(addr)[2:]` (the `[2:]` drops the `41`).
- `decimals()` → `function_selector:"decimals()"`, `"parameter":""` → `…0006`; `symbol()` → ABI string: 32-byte offset (`0x20`) + 32-byte length + padded bytes (`USDT`).
- **A revert still says `"result":{"result":true}`.** Check `transaction.ret[0].ret`: `"FAILED"` and `result.message` (`"REVERT opcode executed"`) mean the call reverted; `constant_result` is `[""]`. A non-contract address → `{"result":{"code":"CONTRACT_VALIDATE_ERROR","message":"Smart contract is not exist."}}`. Nodes with `vm.supportConstant=false` answer `this node does not support constant`.

#### `/wallet/triggersmartcontract`
Build an **unsigned** state-changing contract call (e.g. TRC-20 `transfer`). Params `owner_address`, `contract_address`, `fee_limit` (sun, **required**), `function_selector`, `parameter` or `data`, `call_value`, `call_token_value`, `token_id`, `visible`.
```json
{"owner_address":"<sender>","contract_address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","function_selector":"transfer(address,uint256)","parameter":"<20-byte-to 32B-padded><amount 32B>","fee_limit":50000000,"visible":true}
```
- Returns `{result:{result:true}, transaction:{txID, raw_data, raw_data_hex, …}}`. **You must sign and broadcast it yourself** (§5). `fee_limit` caps the TRX the call may burn for Energy (e.g. a real USDT transfer used 50,000,000 sun = 50 TRX).

#### `/wallet/estimateenergy`
Predict Energy for a contract call. Params as `triggerconstantcontract`.
```json
{"owner_address":"TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9","contract_address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","function_selector":"transfer(address,uint256)","parameter":"<args>","visible":true}
```
```json
{"result":{"result":true},"energy_required":130285}
```
- Disabled by default on nodes (needs `vm.estimateEnergy` **and** `vm.supportConstant`): TronGrid answered `CONTRACT_VALIDATE_ERROR "this node does not support estimate energy"` (verified). Fallbacks: `triggerconstantcontract.energy_used`, or JSON-RPC `eth_estimateGas`. Energy → TRX: × `getEnergyFee` (100 sun), plus margin.

#### `/wallet/getcontract` and `/wallet/getcontractinfo`
Contract metadata. Param `value` = contract address, `visible`.
```json
{"value":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","visible":true}
```
- `getcontract` → `origin_address`, `contract_address`, `name` (`TetherToken`), `abi.entrys[]` (46 entries for USDT), `bytecode`, `consume_user_resource_percent`, `origin_energy_limit`, `code_hash`. `getcontractinfo` → `{smart_contract, runtimecode, contract_state}`. Use `abi` to pick `function_selector`s.

### Build and broadcast

#### `/wallet/createtransaction`
Unsigned TRX transfer. Params `owner_address`, `to_address`, `amount` (sun, > 0), optional `Permission_id` (capital P), `extra_data` (hex memo), `visible`.
```json
{"owner_address":"TUoHaVjx7n5xz8LwPRDckgFrDWhMhuSuJM","to_address":"TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL","amount":1000000,"visible":true}
```
```jsonc
{"txID":"d0807adb…","raw_data":{"contract":[{"parameter":{"value":{"owner_address":"…","to_address":"…","amount":1000000},"type_url":"type.googleapis.com/protocol.TransferContract"},"type":"TransferContract"}],"ref_block_bytes":"00c8","ref_block_hash":"2a54a3bbdc956e1d","expiration":1700000060000,"timestamp":1700000000000},"raw_data_hex":"…"}
```
- Sending to a never-activated address **activates it and costs extra TRX** (chain parameters `getCreateAccountFee` and `getCreateNewAccountFeeInSystemContract`, §2). Expiry ≈ 60 s after construction.

#### `/wallet/broadcasttransaction`
Submit the **signed** tx (the unsigned object + `signature[]`).
```jsonc
{"txID":"d0807adb…","raw_data":{/* as built */},"raw_data_hex":"…","signature":["<65-byte secp256k1 sig, hex>"],"visible":true}
```
```json
{"result":true,"txid":"6db783c4142b3749a4b598db4644155455c9206e2eca4b31efbd48e46773d9d5"}
```
- `result:true` only means "accepted without error" — **not** included / executed / final (§5). Failure: `result` absent, `code` (see §6) + `message` (often **hex-encoded** text: decode it).
- `/wallet/broadcasthex` takes `{"transaction":"<signed tx protobuf hex>"}` and returns the same shape.

### Chain, fees, network

#### `/wallet/getchainparameters`
All governance parameters. `GET` or `POST`, no body.
```jsonc
{"chainParameter":[{"key":"getEnergyFee","value":100},{"key":"getTransactionFee","value":1000},{"key":"getCreateAccountFee","value":100000},{"key":"getCreateNewAccountFeeInSystemContract","value":1000000},{"key":"getMaxFeeLimit","value":15000000000},{"key":"getMemoFee","value":1000000},{"key":"getUnfreezeDelayDays","value":14} /* , … 81 total */]}
```
- Values are sun unless a name says otherwise; a key with value 0 may omit `value`.

#### `/wallet/getenergyprices`, `/wallet/getbandwidthprices`, `/wallet/getburntrx`
`GET`/`POST`, no body. Prices history as `"<ms-timestamp>:<sun>,…"` — the **last pair is current**.
```json
{"prices":"0:100,1542607200000:20,1544724000000:10,1606240800000:40,1613044800000:140,1635422400000:280,1670133600000:420,1726747200000:210,1756468800000:100"}
```
`getbandwidthprices` → `{"prices":"0:10,1606240800000:40,1613044800000:140,1627279200000:1000"}` (1,000 sun/byte now). `getburntrx` → `{"burnTrxAmount":16479235557515950}` (sun burned in fees since proposal 54).

### Solidity (final-state) twins

`POST <TRON_REST>/walletsolidity/<name>` with the same bodies, reading only **solidified** blocks (≈ 1 min behind head). Documented: `getnowblock`, `getblock`, `getblockbynum`, `getblockbyid`, `getblockbylatestnum`, `getblockbylimitnext`, `gettransactionbyid`, `gettransactioninfobyid`, `gettransactioninfobyblocknum`, `gettransactioncountbyblocknum`, `getaccount`, `getaccountbyid`, `triggerconstantcontract`, `estimateenergy`, `getdelegatedresource*`, `getcandelegatedmaxsize`, `getavailableunfreezecount`, `getcanwithdrawunfreezeamount`, `getnodeinfo`, `getburntrx`, `getenergyprices`, `getbandwidthprices`, TRC-10 reads (`getassetissuebyid|name`, `getassetissuelist`, `getassetissuelistbyname`, `getpaginatedassetissuelist`), `listwitnesses`, `getreward`, `getbrokerage`, `getpaginatednowwitnesslist`, `listexchanges`, `getexchangebyid`. Use for deposit crediting and any irreversible decision.

### More FullNode endpoints (compact — official `developers.tron.network/reference/<name>`)

| Group | Paths |
|---|---|
| Utility | `validateaddress` · `getsignweight` · `getapprovedlist` |
| Accounts | `createaccount` · `updateaccount` · `accountpermissionupdate` |
| Staking 2.0 | `freezebalancev2` · `unfreezebalancev2` · `cancelallunfreezev2` · `delegateresource` · `undelegateresource` · `withdrawexpireunfreeze` · `getavailableunfreezecount` · `getcanwithdrawunfreezeamount` · `getcandelegatedmaxsize` · `getdelegatedresourcev2` · `getdelegatedresourceaccountindexv2` |
| Staking 1.0 (legacy) | `unfreezebalance` · `getdelegatedresource` · `getdelegatedresourceaccountindex` |
| Chain | `listnodes` · `getnodeinfo` · `getblockbalance` · `gettransactionlistfrompending` · `gettransactionfrompending` · `getpendingsize` · `getnextmaintenancetime` |
| TRC-10 | `getassetissuebyaccount` · `getassetissuebyid` · `getassetissuebyname` · `getassetissuelist` · `getassetissuelistbyname` · `getpaginatedassetissuelist` · `transferasset` · `createassetissue` · `participateassetissue` · `unfreezeasset` · `updateasset` |
| Contracts | `deploycontract` · `updatesetting` · `updateenergylimit` · `clearabi` |
| Governance | `listwitnesses` · `createwitness` · `updatewitness` · `votewitnessaccount` · `getbrokerage` · `updatebrokerage` · `getreward` · `withdrawbalance` · `getpaginatednowwitnesslist` · `listproposals` · `getproposalbyid` · `proposalcreate` · `proposalapprove` · `proposaldelete` |

(Official FullNode HTTP index: **81 endpoint pages**; Solidity HTTP: 34.)

## 4 · JSON-RPC methods

Endpoint: Ankr `https://rpc.ankr.com/tron_jsonrpc/{KEY}` (documented, 26 methods) · Alchemy `https://tron-mainnet.g.alchemy.com/v2/{KEY}` (POST; unverified, see §1 caveat). Behaviour below was sampled on TronGrid's `/jsonrpc` (java-tron).

```jsonc
// Request (batch = JSON array of these → array of responses; verified)
{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}
// Success
{"jsonrpc":"2.0","id":1,"result":"0x535a679"}
// Error (HTTP 200)
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"QUANTITY not supported, just support TAG as latest","data":"{}"}}
```
Quantities are hex (`0x…`). Differences from Ethereum (verified live unless noted):
- **Addresses**: hex only (20 or 21 bytes). Base58 → `-32602`.
- **Block tags**: `eth_getBalance`, `eth_getStorageAt`, `eth_getCode`, `eth_call` accept **only `"latest"`** (a hex height → `-32602 QUANTITY not supported, just support TAG as latest`). Block-query methods accept hex height, `latest`, `earliest`, `finalized` (= solidified); `pending` / `safe` → `-32602 TAG pending not supported`.
- `nonce` is always `0x0`; `gas` = **Energy**; `gasPrice` = Energy price in sun (`0x64` = 100); `eth_getTransactionCount`, `eth_sendRawTransaction` **do not exist** (`-32601`). Alchemy's docs index lists Ethereum pages for some of these names — TRON's own method list below is authoritative.
- Unknown tx → `null`; revert → error `-32000 REVERT opcode executed`; non-contract `to` → `-32600 Smart contract is not exist.`

#### eth_chainId · net_version
No params. `"0x2b6653dc"` = 728126428 (mainnet). Shasta `0x94a9059e`, Nile `0xcd8690dc` (chain id = last 4 bytes of the genesis hash). `net_version` returns the same value.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}
```

#### eth_blockNumber
No params → latest height (hex). Above: `"0x535a679"` = 87,402,105.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}
```

#### eth_getBalance
`[address, "latest"]` → TRX balance in **sun**, hex.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x82dd6b9966724ae2fdc79b416c7588da67ff1b35","latest"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":"0x2198397"}
```
(`0x2198397` = 35,226,519 sun = 35.226519 TRX.)

#### eth_call
`[{from?, to, data|input, value?}, "latest"]` → return data (hex). `gas` / `gasPrice` accepted but **ignored**; `value` supported; if both `data` and `input` are sent, `input` wins (`input` must be `0x`-prefixed, even length). Equivalent of `triggerconstantcontract`.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"from":"0x82dd6b9966724ae2fdc79b416c7588da67ff1b35","to":"0xa614f803b6fd780986a42c78ec9c7f77e6ded13c","data":"0x70a0823100000000000000000000000082dd6b9966724ae2fdc79b416c7588da67ff1b35"},"latest"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":"0x00000000000000000000000000000000000000000000000000000000002f4d60"}
```
(TRC-20 `balanceOf` via the ERC-20 selector `0x70a08231`; `to` = USDT contract in 20-byte hex.)

#### eth_estimateGas
`[{from,to,data,value}]` → estimated **Energy** (hex). A plain TRX transfer returns `0x0`; a USDT `transfer` call returned `0xfb1d` = 64,285 (matches a real tx's `energy_usage_total`).
```json
{"jsonrpc":"2.0","id":1,"method":"eth_estimateGas","params":[{"from":"0x82dd6b9966724ae2fdc79b416c7588da67ff1b35","to":"0xa614f803b6fd780986a42c78ec9c7f77e6ded13c","data":"0xa9059cbb000000000000000000000000<to-20-byte><amount-32-byte>"}]}
```

#### eth_gasPrice
No params → current **Energy price in sun** (hex): `"0x64"` = 100.

#### eth_getBlockByNumber · eth_getBlockByHash
`[numberHexOrTag, fullTxBool]` / `[blockHash, fullTxBool]`. Result keys (sampled): `baseFeePerGas, difficulty, extraData, gasLimit, gasUsed, hash, logsBloom, miner, mixHash, nonce, number, parentHash, receiptsRoot, sha3Uncles, size, stateRoot, timestamp, totalDifficulty, transactions, transactionsRoot, uncles`.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}
```
```jsonc
{"jsonrpc":"2.0","id":1,"result":{"number":"0x535a689","hash":"0x000000000535a68976ae794b76c6764fb80be3a3b11c83d0fcd3333c5df837a1","parentHash":"0x000000000535a688…","timestamp":"0x6add2bcb","miner":"0x3ce9a6b8ad08e5bb13b57a9d3782946a5efdb36d","gasUsed":"0x482727","transactions":["0x…" /* hashes when fullTx=false */] /* , … */}}
```
- `timestamp` is **seconds** here (REST uses ms). `finalized` returns the latest solidified block (~17 behind head observed). Unknown block → `null`.

#### eth_getTransactionByHash
`[txHash]` (32 bytes, `0x` optional) → Ethereum-style tx; unknown → `null`. Keys: `blockHash, blockNumber, from, gas, gasPrice, hash, input, nonce, r, s, to, transactionIndex, type, v, value`.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["0xd339062c2d7e37877414e66f6d744cf3b3670067d82550c1fde519117f8716b7"]}
```
```jsonc
{"jsonrpc":"2.0","id":1,"result":{"blockNumber":"0x535a684","from":"0x478af6ea7e0c97eacd228cea072df68104d07b23","to":"0xa614f803b6fd780986a42c78ec9c7f77e6ded13c","gas":"0xfb1d","gasPrice":"0x64","nonce":"0x0","input":"0xa9059cbb00000000…","value":"0x0","type":"0x0","transactionIndex":"0x0" /* , blockHash, hash, v, r, s */}}
```

#### eth_getTransactionReceipt
`[txHash]` → keys `blockHash, blockNumber, contractAddress, cumulativeGasUsed, effectiveGasPrice, from, gasUsed, logs, logsBloom, status, to, transactionHash, transactionIndex, type`. `status` `0x1` ok / `0x0` failed; `gasUsed` = Energy; each log also carries `blockTimestamp` (hex seconds). Unknown/pending → `null`. **No fee in sun** here → use REST `gettransactioninfobyid` for fees / Bandwidth.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xd339062c2d7e37877414e66f6d744cf3b3670067d82550c1fde519117f8716b7"]}
```
```jsonc
{"jsonrpc":"2.0","id":1,"result":{"status":"0x1","gasUsed":"0xfb1d","cumulativeGasUsed":"0xfb1d","effectiveGasPrice":"0x64","contractAddress":null,"from":"0x478af6ea…","to":"0xa614f803…","type":"0x0","logs":[{"address":"0xa614f803…","topics":["0xddf252ad…","0x000…","0x000…"],"data":"0x…","blockTimestamp":"0x6add2bbc","logIndex":"0x0","removed":false}] /* , blockHash, blockNumber, logsBloom, transactionHash, transactionIndex */}}
```

#### eth_getLogs
Filter `{fromBlock?, toBlock?, address? (20-byte hex or array), topics?, blockHash?}`. Limits: block span **≤ 5000** by default (`-32602 exceed max block range: 5000`, verified; hosted gateways may differ), ≤ 1000 addresses, ≤ 4 topic positions, ≤ 1000 OR-values per position; `blockHash` cannot be combined with `fromBlock`/`toBlock`. `pending`/`safe` unsupported.
```json
{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":"0xa614f803b6fd780986a42c78ec9c7f77e6ded13c","fromBlock":"0x535a729","toBlock":"0x535a73d","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}]}
```
```jsonc
{"jsonrpc":"2.0","id":1,"result":[{"address":"0xa614f803b6fd780986a42c78ec9c7f77e6ded13c","blockNumber":"0x535a729","blockTimestamp":"0x6add2dab","logIndex":"0x0","removed":false,
  "topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000082dd8b99b3422d7a37fe449e4010bf28b483bae0","0x000000000000000000000000cac6ba948f356cc0ed6dc10416a9ad1988be7399"],
  "data":"0x000000000000000000000000000000000000000000000000000000001680223d","transactionHash":"0xfd81d808…","transactionIndex":"0x2","blockHash":"0x000000000535a729…"} /* … 643 logs in 20 blocks */]}
```
- Here: USDT `Transfer(from,to,value)`; `topics[1]`/`[2]` = 32-byte-padded 20-byte addresses, `data` = uint256. Filter by sender/recipient by padding their 20-byte hex to 32 bytes in topic position 1 / 2. Page large scans in ≤ 5000-block windows.

#### eth_getCode · eth_getStorageAt
`[address, "latest"]` / `[address, slotHex, "latest"]` → hex. `latest` only. (USDT's `eth_getCode` is ~29.9k hex characters.)

#### buildTransaction (TRON-specific)
Builds an unsigned tx via JSON-RPC (sign + broadcast still via REST `broadcasttransaction`). Params object by type: TransferContract `{from,to,value}`; TransferAssetContract `{from,to,tokenId,tokenValue}`; TriggerSmartContract `{from,to,data|input,gas,value?,tokenId?,tokenValue?}`; CreateSmartContract `{from,name,gas,abi,data|input,consumeUserResourcePercent,originEnergyLimit,value?,…}`. `gas` = Energy (converted to `fee_limit` at the current price). **Not in Ankr's or Alchemy's documented method lists — availability unverified; use REST builders.**
```json
{"jsonrpc":"2.0","id":1,"method":"buildTransaction","params":[{"from":"0x<sender-20-byte>","to":"0x<recipient-20-byte>","value":"0x3e8"}]}
```
```jsonc
{"jsonrpc":"2.0","id":1,"result":{"transaction":{"txID":"…","raw_data":{/* … */},"raw_data_hex":"…"}}}
```

#### Remaining JSON-RPC methods (TRON-official list = 40 total)
| Method | Note |
|---|---|
| `eth_accounts` · `eth_coinbase` · `eth_mining` · `eth_hashrate` · `eth_getWork` | node-local / compatibility stubs (`eth_accounts` → `[]`, `eth_hashrate` → `0x0`) |
| `eth_syncing` | `false` or `{startingBlock,currentBlock,highestBlock}` |
| `eth_protocolVersion` | e.g. `0x26` |
| `eth_getBlockTransactionCountByHash` · `eth_getBlockTransactionCountByNumber` | tx count (hex) |
| `eth_getTransactionByBlockHashAndIndex` · `eth_getTransactionByBlockNumberAndIndex` | one tx by position |
| `eth_getBlockReceipts` | all receipts of a block (159 for a sampled block) |
| `eth_newFilter` · `eth_newBlockFilter` · `eth_getFilterChanges` · `eth_getFilterLogs` · `eth_uninstallFilter` | stateful filters (idle filters time out; uninstall them) |
| `eth_getUncleByBlockHashAndIndex` · `eth_getUncleByBlockNumberAndIndex` · `eth_getUncleCountByBlockHash` · `eth_getUncleCountByBlockNumber` | no uncles on TRON: `null` / `0x0` |
| `net_listening` · `net_peerCount` | connectivity (`0x1e` peers sampled) |
| `web3_clientVersion` · `web3_sha3` | `TRON/v4.8.2.4/…`; Keccak-256 of the input (not SHA3-256) |

## 5 · Recipes

- **TRX balance**: REST `getaccount.balance` (÷ 1,000,000) or `eth_getBalance` (hex sun). `{}` ⇒ address never activated ⇒ 0.
- **TRC-20 balance** (e.g. USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, 6 decimals): `triggerconstantcontract` `balanceOf(address)` (param = 24 zeros + 20-byte hex of the holder) → `int(constant_result[0],16) / 10**decimals`. Read `decimals()` per token; never assume 6.
- **TRC-20 transfers in/out of an address**: `eth_getLogs` on the token contract, topic0 `ddf252ad…`, topic1 = padded sender and/or topic2 = padded recipient, ≤ 5000-block windows (no `/v1` history API through these providers).
- **Did my tx succeed?** `broadcasttransaction` `result:true` → poll `/walletsolidity/gettransactionbyid` until non-empty (final inclusion) → for contract calls also `/walletsolidity/gettransactioninfobyid`: top-level `result` ≠ `FAILED` **and** `receipt.result == "SUCCESS"`. Keep polling on `{}`; don't rebuild a replacement until the original's `expiration` has passed on the solidified chain.
- **Send TRX / TRC-20**: build (`createtransaction` | `triggersmartcontract` with `fee_limit`) → verify the returned `txID` = `SHA-256(raw_data_hex bytes)` and the decoded fields are what you intended → sign `txID` locally with secp256k1 (65-byte signature appended to `signature[]`) → `broadcasttransaction`. Do all of it within ~50 s (default expiry ≈ 60 s). **Never send a private key to any endpoint.**

## 6 · Errors

| Where | Value | Meaning |
|---|---|---|
| REST body | `{"Error":"class org.tron.core.services.http.JsonFormat$ParseException : 1:13: invalid address for field: protocol.Account.address"}` | malformed request (bad address etc.), HTTP 200 |
| REST body | `{}` | not found / inactive account |
| `triggerconstantcontract` | `result.code:"CONTRACT_VALIDATE_ERROR"`, `message:"Smart contract is not exist."` | address isn't a contract |
| `estimateenergy` | `CONTRACT_VALIDATE_ERROR "this node does not support estimate energy"` | feature off on this node |
| broadcast `code` | `SIGERROR` bad signature · `BANDWITH_ERROR` (sic) not enough Bandwidth/TRX for bandwidth, new account, multisig or memo fees (**not** Energy) · `DUP_TRANSACTION_ERROR` already known (rebroadcast the exact same tx is safe) · `TAPOS_ERROR` stale ref block · `TRANSACTION_EXPIRATION_ERROR` expired · `TOO_BIG_TRANSACTION_ERROR` · `CONTRACT_VALIDATE_ERROR` · `CONTRACT_EXE_ERROR` · `SERVER_BUSY` · `NOT_ENOUGH_EFFECTIVE_CONNECTION` · `NO_CONNECTION` · `BLOCK_UNSOLIDIFIED` · `OTHER_ERROR` | `message` is usually hex-encoded text (decode it). Also seen as plain text: `account does not exist` (activate the address first), `No contract or not a valid smart contract`. |
| JSON-RPC | `-32602` invalid params (bad tag/hex, `exceed max block range: 5000`, `TAG pending not supported`) · `-32601` method does not exist · `-32600` `Smart contract is not exist.` · `-32000` `REVERT opcode executed` | HTTP 200 with `error` object |
| HTTP | `413` oversize body · `429`/`403` rate limit or plan | back off |

## 7 · Gotchas

- **Two interfaces, two address formats, two timestamp units** (REST: ms; JSON-RPC: hex seconds). Decide per call.
- **`{}` is the "not found" answer** — not an error, not a zero. An unactivated address has no balance record at all.
- **Check `Error`, not HTTP status**; HTTP 200 carries errors on both interfaces.
- **FullNode ≠ final.** `/wallet/*` and `latest` reads can be reorged; deposits, accounting and "paid?" decisions must read `/walletsolidity/*` (or `finalized`).
- **Success flags are subtle**: `broadcasttransaction.result:true` ≠ executed; `triggerconstantcontract` says `result:true` even on revert; `gettransactioninfobyid` has no `result` on success (proto3 omission).
- **JSON-RPC cannot broadcast** and cannot read old state (`latest` only) — use REST for broadcasting, `getaccountbalance` history, and anything historical.
- **`fee_limit` is required** for contract calls and capped by the node (`getMaxFeeLimit` 15,000 TRX); too low ⇒ out-of-energy failure after burning the fee. Energy shortfall and Bandwidth shortfall burn TRX differently (`BANDWITH_ERROR` is Bandwidth, not Energy).
- **Sending to a fresh address costs an activation fee** (see `getCreateAccountFee` + `getCreateNewAccountFeeInSystemContract` in `getchainparameters`).
- **Ankr TRON is Premium-only**, path forms differ from other Ankr chains (`tron_jsonrpc/`, `premium-http/tron/`), and some `/wallet/*` paths are blocked; **Alchemy** exposes REST under `/v2/{KEY}/wallet/…` (its `eth_*` support is unverified, §1); **BlockPI lists no TRON**.
- **TRC-20 amounts are raw integers** — apply the token's `decimals`; USDT/USDC on TRON = 6, but verify.
- **Block ranges**: `eth_getLogs` ≤ 5000 blocks; `getblockbylimitnext` boundaries are inconsistent in the docs; big `getblockbynum` responses are heavy.
- The key is part of the URL — keep it out of logs and transcripts.

*Sources checked*: developers.tron.network (`docs/api`, FullNode HTTP / Solidity HTTP / JSON-RPC / TronGrid v1 indexes and ~30 endpoint pages, `api-signature-and-broadcast-flow`, `broadcast-and-rpc-errors`, `tron-vs-ethereum`); Ankr `chains-list/s-t-p4`, `chains-api/tron` (+ methods pages); Alchemy `rpc/tron`, Tron API quickstart / FAQ / docs index; BlockPI docs index + network table. Items marked "verified" or "sampled" were read from TronGrid's public mainnet node (java-tron); Ankr's and Alchemy's docs describe the same endpoints and shapes, but provider-specific behaviour was not tested (no keys).
