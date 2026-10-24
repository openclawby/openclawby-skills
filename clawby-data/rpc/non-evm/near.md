# NEAR RPC (BYOK, non-EVM)

NEAR reads and submissions using the user's **own node key**, fetched from the Clawby Key Vault. Direct to the provider — not via Clawby relay, no Clawby credits. NEAR is **not** EVM: it uses JSON-RPC 2.0, but with NEAR's own methods (mostly one multiplexed `query` method with a `request_type`), named-object params, and a different data model (accounts with human names, access keys, contracts, shards).

## 1 · Get the key (memory only, never write to disk)

Fetch from the vault as in `rpc/ankr.md` / `rpc/blockpi.md` §1 (rules, errors, response shape: `rpc/index.yaml`). **The key sits in the endpoint URL → the whole URL is a secret; never log, echo, or commit it.**

## 2 · Endpoints per provider

POST to the URL as-is (root path), `Content-Type: application/json`.

| Provider | Mainnet endpoint | Notes |
|---|---|---|
| Ankr | `https://rpc.ankr.com/near/{KEY}` | Slug `near`. **Premium plans only** (per Ankr docs). **Unsupported methods: `status`, `network_info`, `sandbox_patch_state`** — use `block` / `gas_price` for liveness instead. Not archival. Not exercised with a real key (bad key → bare nginx 404). |
| Alchemy | not offered | NEAR is absent from Alchemy's official chain list; `near-mainnet.g.alchemy.com` does not resolve. |
| BlockPI | `https://near.blockpi.network/v1/rpc/{KEY}` | Form shown in BlockPI's own NEAR docs (`…/v1/rpc/your-rpc-key`); the gateway recognises it. NEAR's docs list a keyless `…/v1/rpc/public` (20 req/s), but a probe on 2026-10-24 returned `{"error":{"code":100021,"message":"Apikey not found"}}` — use the user's key. BlockPI documents `status` and `network_info` as available. |

**Public reference nodes** (not BYOK; free, rate-limited; verified answering 2026-10-24): `https://rpc.mainnet.near.org`, `https://free.rpc.fastnear.com`, `https://near.drpc.org`, `https://rpc.intea.rs`; archival `https://archival-rpc.mainnet.near.org` (severely rate-limited); testnet `https://test.rpc.fastnear.com`. (`https://1rpc.io/near` answered `gas_price` with "method does not exist".) All examples below were captured on mainnet (nearcore 2.13.4, protocol 86) unless marked.

## 3 · Envelope and conventions

```json
{"jsonrpc":"2.0","id":"dontcare","method":"<method>","params":{}}
```
- JSON-RPC 2.0, one request object per HTTP POST. **Batching is not supported:** an array body returns HTTP 400 `-32700 Parse error "JSON RPC Request format was expected"` and none of the calls run.
- `params` is a **named object** for almost everything (`query`, `block`, `chunk`, `tx`, `send_tx`, …). Exceptions that take a **positional array**: `status` / `network_info` / `health` → `[]`; `gas_price` → `[null]` (latest) or `[<height or hash>]`; `validators` → `[null]` (current epoch) or `[<block hash>]`; `broadcast_tx_async` / `broadcast_tx_commit` → `["<base64 signed tx>"]`. Legacy positional forms of `tx` still work (verified: `["<hash>","<sender>"]`).
- Success `{"jsonrpc":"2.0","result":<...>,"id":…}`; failure `{"jsonrpc":"2.0","error":{"name":"…","cause":{"name":"…","info":{…}},"code":<int>,"message":"…","data":"…"},"id":…}`. Check the `error` field — HTTP status varies (observed 200 for `UNKNOWN_ACCOUNT`, 400 for parse/validation errors, 422 for `UNKNOWN_BLOCK`). **Extra channel for `query`:** view failures (bad key, contract panic, missing method, no contract) arrive as `result.error` (a string) with HTTP 200 — see `call_function` / `view_access_key`.

**Which block to read — `finality` or `block_id`** (give exactly one; most read methods accept them):
| Parameter | Values | Meaning |
|---|---|---|
| `finality` | `"final"` | irreversible (BFT-final), roughly 3 s behind head. **Use for anything that matters.** |
| | `"near-final"` | endorsed and effectively settled, roughly 2 s behind head; could only be undone if a block producer were slashed |
| | `"optimistic"` | newest block the node has, roughly 1 s behind head; small chance it is skipped/orphaned |
| `block_id` | integer height or base58 block hash string | an exact block (older ones need an archival node) |
| `sync_checkpoint` | `"genesis"` / `"earliest_available"` | in `block`/`query` only |

**Units.** Balances are **yoctoNEAR**, strings: **1 NEAR = 10^24 yoctoNEAR** (`"34903125087308986035125720461069"` = 34,903,125.087 NEAR). Gas is in gas units (1 Tgas = 10^12); `gas_price` is yoctoNEAR **per gas unit** (100,000,000 → 1 Tgas costs 0.0001 NEAR). `storage_usage` is bytes. Heights and nonces are JSON numbers (u64; today's values, e.g. nonce ≈ 1.1×10^14, still fit a double, but parse them as 64-bit integers).

## 4 · Method catalog

### Accounts, keys and contracts — all via method `query`

`query` takes `request_type` + a block reference (`finality` or `block_id`) + type-specific args, and returns a `result` that always includes `block_height` and `block_hash`.

#### query: view_account
Balance, code hash and storage of an account. Args: `account_id`.
```json
{"jsonrpc":"2.0","id":"dontcare","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"wrap.near"}}
```
```json
{"jsonrpc":"2.0","result":{"amount":"34903125087308986035125720461069","block_hash":"BTk8FTXYztrjnGLAJwQoFqo6zcfds7JkSAcooH1cGAUh","block_height":221445259,"code_hash":"DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1","locked":"0","storage_paid_at":0,"storage_usage":167232987},"id":"dontcare"}
```
`amount` is the liquid balance (yoctoNEAR); `locked` is staked; `code_hash` of `11111111111111111111111111111111` = no contract deployed. Spendable ≈ `amount` − storage cost (`storage_usage` bytes × 10^19 yoctoNEAR/byte). Unknown account → `error.cause.name` `UNKNOWN_ACCOUNT`:
```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"block_hash":"4E1g98FYZ6mUuJi82ZMqCbebiCWpvYh5Jh9mz7zFMVr8","block_height":221445266,"requested_account_id":"this-account-does-not-exist-xyz123.near"},"name":"UNKNOWN_ACCOUNT"},"code":-32000,"message":"Server error","data":"account this-account-does-not-exist-xyz123.near does not exist while viewing"},"id":"dontcare"}
```

#### query: view_access_key
Nonce and permission of one key. Args: `account_id`, `public_key` (`ed25519:…` / `secp256k1:…`). Use this to get the next transaction nonce (`nonce + 1`).
```json
{"jsonrpc":"2.0","id":"dontcare","method":"query","params":{"request_type":"view_access_key","finality":"final","account_id":"blessmysoul0.tg","public_key":"ed25519:DhQh7grCS9acLjMhBymVj6j4wbr5HhcGq6o6b9mcmDRs"}}
```
```json
{"jsonrpc":"2.0","result":{"block_hash":"EkbsUMmAEiSKkDuNzpsoufst2Yy5NPkvHzpt8kVMwhks","block_height":221445400,"nonce":112094236005931,"permission":"FullAccess"},"id":"dontcare"}
```
`permission` is `"FullAccess"` or an object: `{"FunctionCall":{"allowance":"250000000000000000000000","receiver_id":"contract.example.near","method_names":["get_greeting"]}}` (gas-key variants `GasKeyFullAccess` / `GasKeyFunctionCall` exist on new nodes). **Unknown key is NOT a JSON-RPC error** — verified live: HTTP 200 with the failure inside `result`: `{"result":{"block_hash":"6oiStcCYDEHjv58jBN4CnqgxpWaoBeUgFnab4xcb9Ktc","block_height":221447541,"error":"access key ed25519:DCkbTMS8s4kqV4nGvz5kRBdNbY9YwjjvNGNXKpAg2eFa does not exist while viewing","logs":[]}}`. Always test `result.error` before reading `nonce` / `permission`.

#### query: view_access_key_list
All access keys of an account. Args: `account_id`.
```json
{"jsonrpc":"2.0","id":"dontcare","method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"blessmysoul0.tg"}}
```
```json
{"jsonrpc":"2.0","result":{"block_hash":"FCfg6eiT4QPvY2pEyJrSsSNgnrKwyHrEffdVUnSDF2xh","block_height":221445376,"keys":[{"access_key":{"nonce":112094236005931,"permission":"FullAccess"},"public_key":"ed25519:DhQh7grCS9acLjMhBymVj6j4wbr5HhcGq6o6b9mcmDRs"}]},"id":"dontcare"}
```
Locked contract accounts return `"keys":[]` (verified on `wrap.near`). Post-quantum keys show as `ml-dsa-65-hash:…`. Newer nodes also accept `limit` / `after_key` for paging (in nearcore's OpenAPI; not exercised live).

#### query: call_function
Run a **read-only** contract method (view call). Args: `account_id` (the contract), `method_name`, `args_base64` = **base64 of the JSON args** (empty string `""` when none). Does not cost gas or change state.
```bash
ARGS=$(printf '{"account_id":"near"}' | base64)   # eyJhY2NvdW50X2lkIjoibmVhciJ9
```
```json
{"jsonrpc":"2.0","id":"dontcare","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"wrap.near","method_name":"ft_balance_of","args_base64":"eyJhY2NvdW50X2lkIjoibmVhciJ9"}}
```
```json
{"jsonrpc":"2.0","result":{"block_hash":"73xQy7MXip9DrECmi114XukUcUqcT6krvvxHW8QLD1X9","block_height":221445297,"logs":[],"result":[34,50,49,51,50,55,49,50,49,54,54,51,52,57,51,51,53,56,51,55,57,53,57,53,53,54,50,34]},"id":"dontcare"}
```
`result.result` is the contract's return value as an **array of bytes (UTF-8)** — decode and parse: `json.loads(bytes(r["result"]["result"]))` → `"21327121663493358379595562"` (a JSON *string*; NEP-141 balances are yocto-units of the token, wNEAR has 24 decimals → 21.327 wNEAR). `logs` carries `env::log` output. **Contract failures are NOT JSON-RPC errors** — verified live, each is HTTP 200 with a string in `result.error` and no `result.result`: missing method → `"wasm execution failed with error: MethodResolveError(MethodNotFound)"`; account without a contract → `"wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: \"…\" })"`; bad args → `"wasm execution failed with error: HostError(GuestPanic { panic_msg: \"…missing field `account_id`…\" })"`. Test `result.error` first. (Unknown *account* is different: a real `HANDLER_ERROR` / `UNKNOWN_ACCOUNT`.) Another verified call: `ft_metadata` with `args_base64:""`. Shortcut method `EXPERIMENTAL_call_function` takes the same args without `request_type` (verified).

#### query: view_state
Raw key/value storage of a contract. Args: `account_id`, `prefix_base64` (base64 of a key prefix; `""` = everything).
```json
{"jsonrpc":"2.0","id":"dontcare","method":"query","params":{"request_type":"view_state","finality":"final","account_id":"contract.rpc-examples.testnet","prefix_base64":""}}
```
```json
{"jsonrpc":"2.0","result":{"block_hash":"9QaT46poXHWtKDkRt7vNUoMwyLQJYp7pLv2aKuAVfADc","block_height":274606876,"values":[{"key":"U1RBVEU=","value":"HQAAAEdyZWV0aW5ncyBmcm9tIE5FQVIgUHJvdG9jb2whAQAAAHI="},{"key":"cgAAAAAAAAAA","value":"CQAAAHNwYWNlcm9jaw=="}]},"id":"dontcare"}
```
(Testnet docs-example contract; `values` trimmed. Keys/values are base64 of borsh/raw bytes — you need the contract's layout to decode; prefer `call_function` view methods.) Nodes refuse large state: **default limit 50 kB**; live error on `wrap.near`:
```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"block_hash":"Byi6zo9vgXfBFRcp3kEPddAHdRMwCqQzgAGK2gfRFX2h","block_height":221445310,"contract_account_id":"wrap.near"},"name":"TOO_LARGE_CONTRACT_STATE"},"code":-32000,"message":"Server error","data":"State of contract wrap.near is too large to be viewed"},"id":"dontcare"}
```
A contract with no state returns `"values":[]`. Use narrower `prefix_base64`, or an archival/own node for big state. Newer nodes add `limit`, `after_key_base64`, `include_proof` (OpenAPI; not exercised live).

Other `request_type`s: `view_code` (base64 WASM), `view_global_contract_code`, `view_global_contract_code_by_account_id`, `view_gas_key_nonces`.

### Blocks and chunks

#### block
Block header + chunk summaries. Params: `finality` **or** `block_id` (or `sync_checkpoint`).
```json
{"jsonrpc":"2.0","id":"dontcare","method":"block","params":{"finality":"final"}}
```
```json
{"jsonrpc":"2.0","result":{"author":"meteor.poolv1.near","header":{"height":221445253,"hash":"HiPNeu4tsmBmkqm548V812YxXCCfLof56FpdXEecB5ZM","prev_hash":"3yvEWyHiw8K3JYbbEL5tuiv7YgScj7DNhdMzP2FgWrBG","timestamp":1792877555390726266,"timestamp_nanosec":"1792877555390726266","epoch_id":"AvuK6u4okXELk8yJvQY9zTVEHZogaLVWzxLaqjhv8rsJ","gas_price":"100000000","total_supply":"1309847699299913187236776248266843","latest_protocol_version":86,"chunks_included":10},"chunks":[{"chunk_hash":"AuWbwZXtAyR3S5gFJJE1GTLQ3S4UU9886DBaWon5LWLX","shard_id":10,"gas_limit":1000000000000000,"gas_used":0,"height_created":221445253,"height_included":221445253,"tx_root":"11111111111111111111111111111111"}]},"id":"dontcare"}
```
(10 chunks on mainnet, trimmed to one; the live reply is ~19 KB.) `timestamp` is **nanoseconds** since Unix epoch. A chunk with `tx_root` of all `1`s has no transactions. `header.hash` is the block hash you pass as `block_id`. `UNKNOWN_BLOCK` = never existed *or* garbage-collected from this node.

#### chunk
One shard's chunk with its transactions and receipts. Params: `chunk_id` (chunk hash from `block`) **or** `block_id` + `shard_id`.
```json
{"jsonrpc":"2.0","id":"dontcare","method":"chunk","params":{"chunk_id":"7tT4yHz2ZXG6GS8UUuMd31zxHgoXtwUWxN3DNdF6mndg"}}
```
```json
{"jsonrpc":"2.0","result":{"author":"macrodatarefinement.poolv1.near","header":{"chunk_hash":"7tT4yHz2ZXG6GS8UUuMd31zxHgoXtwUWxN3DNdF6mndg","shard_id":8,"gas_limit":1000000000000000,"gas_used":223182562500,"height_created":221445253,"height_included":221445253,"prev_block_hash":"3yvEWyHiw8K3JYbbEL5tuiv7YgScj7DNhdMzP2FgWrBG"},"transactions":[{"hash":"PrTxvvCCrKvACnP4dxu3a8EnFkTeRAZd7GpuVGcrT33","signer_id":"blessmysoul0.tg","receiver_id":"game.hot.tg","nonce":112094236005931,"public_key":"ed25519:DhQh7grCS9acLjMhBymVj6j4wbr5HhcGq6o6b9mcmDRs","actions":[{"FunctionCall":{"method_name":"l2_claim","args":"<base64 trimmed>","gas":20000000000000,"deposit":"0"}}]}],"receipts":[]},"id":"dontcare"}
```
`transactions[].hash` + `signer_id` are what `tx` needs. Errors: `UNKNOWN_CHUNK`, `INVALID_SHARD_ID`.

### Transactions

Write path: build a `SignedTransaction` **client-side** (nonce = key nonce + 1; `block_hash` of a recent final block; actions), borsh-serialize, sign with the key, base64-encode. Never send a private key to a node. Prefer `send_tx`; `broadcast_tx_async` and `broadcast_tx_commit` are marked deprecated in nearcore's OpenAPI and kept for compatibility.

#### tx
Status + outcome of a transaction. Params: `tx_hash` + `sender_account_id` (the signer), **or** `signed_tx_base64`; optional `wait_until` (below).
```json
{"jsonrpc":"2.0","id":"dontcare","method":"tx","params":{"tx_hash":"PrTxvvCCrKvACnP4dxu3a8EnFkTeRAZd7GpuVGcrT33","sender_account_id":"blessmysoul0.tg","wait_until":"FINAL"}}
```
```json
{"jsonrpc":"2.0","result":{"final_execution_status":"FINAL","status":{"SuccessValue":""},"transaction":{"signer_id":"blessmysoul0.tg","public_key":"ed25519:DhQh7grCS9acLjMhBymVj6j4wbr5HhcGq6o6b9mcmDRs","nonce":112094236005931,"receiver_id":"game.hot.tg","hash":"PrTxvvCCrKvACnP4dxu3a8EnFkTeRAZd7GpuVGcrT33","actions":[{"FunctionCall":{"method_name":"l2_claim","args":"<base64 trimmed>","gas":20000000000000,"deposit":"0"}}]},"transaction_outcome":{"id":"PrTxvvCCrKvACnP4dxu3a8EnFkTeRAZd7GpuVGcrT33","block_hash":"HiPNeu4tsmBmkqm548V812YxXCCfLof56FpdXEecB5ZM","outcome":{"executor_id":"blessmysoul0.tg","gas_burnt":315879629260,"tokens_burnt":"31587962926000000000","receipt_ids":["6t9TmVfoAAqGASawCEJajrae3NygCscU6bRnYgGtVnQ7"],"status":{"SuccessReceiptId":"6t9TmVfoAAqGASawCEJajrae3NygCscU6bRnYgGtVnQ7"},"logs":[]}},"receipts_outcome":[{"id":"6t9TmVfoAAqGASawCEJajrae3NygCscU6bRnYgGtVnQ7","block_hash":"BAntC4DFEeSFoE6WYPT1DXJGseBfBDV7GiJGjpT5MKQr","outcome":{"executor_id":"game.hot.tg","gas_burnt":2907224571935,"status":{"SuccessValue":""},"logs":["<trimmed>"]}},{"id":"CvoJbvBGoP6P4nEWgUWjRSpTsdKAhiYEvFLhrosbnHSC","block_hash":"Fq539L7hLKn1hxjaNwirwYDuBCqrmKMYfzzbNooZwYr","outcome":{"executor_id":"blessmysoul0.tg","gas_burnt":223182562500,"status":{"SuccessValue":""},"logs":[]}}]},"id":"dontcare"}
```
**NEAR transactions execute as a chain of asynchronous receipts.** `status` is the overall result: `{"SuccessValue":"<base64>"}` (decode the return value; `""` = none) or `{"Failure":{…}}`. For cross-contract calls also read `receipts_outcome[].outcome.status` and `.logs` to see which step did what (each receipt has its own `SuccessValue` / `Failure` / `SuccessReceiptId`). `final_execution_status` says how far execution has progressed. `wait_until` (optional, default `EXECUTED_OPTIMISTIC`): `NONE` | `INCLUDED` | `EXECUTED_OPTIMISTIC` | `INCLUDED_FINAL` | `EXECUTED` | `FINAL` — each waits for a stricter milestone; higher levels can take several seconds and may `TIMEOUT_ERROR`. Errors: `UNKNOWN_TRANSACTION`, `INVALID_TRANSACTION`, `TIMEOUT_ERROR`. Result `block_hash` fields refer to where each step executed.

#### EXPERIMENTAL_tx_status
Same as `tx` plus the full **receipts** (`receipts[]`: predecessor, receiver, actions, gas price). In current NEAR docs it is a **deprecated alias of `tx_status`** (identical request/response; use `tx_status` in new code, but both work — verified live).
```json
{"jsonrpc":"2.0","id":"dontcare","method":"EXPERIMENTAL_tx_status","params":{"tx_hash":"PrTxvvCCrKvACnP4dxu3a8EnFkTeRAZd7GpuVGcrT33","sender_account_id":"blessmysoul0.tg","wait_until":"FINAL"}}
```
Response = the `tx` result above with one extra top-level key `receipts` (verified keys: `final_execution_status`, `receipts`, `receipts_outcome`, `status`, `transaction`, `transaction_outcome`). Each receipt looks like `{"predecessor_id":"blessmysoul0.tg","receiver_id":"game.hot.tg","receipt_id":"6t9TmVfoAAqGASawCEJajrae3NygCscU6bRnYgGtVnQ7","receipt":{"Action":{"signer_id":"…","gas_price":"1000000000","actions":[…]}},"priority":0}`.

#### broadcast_tx_async
Fire-and-forget: submit a signed transaction and return its hash immediately (**does not tell you if it succeeds**). Params: **positional array** `["<base64 SignedTransaction>"]`. Deprecated — equivalent to `send_tx` with `wait_until:"NONE"`.
```json
{"jsonrpc":"2.0","id":"dontcare","method":"broadcast_tx_async","params":["<base64 signed tx>"]}
```
Success `result` is the transaction hash as a base58 string (response schema: CryptoHash); then poll `tx`. Live-tested with a malformed payload (HTTP 400):
```json
{"jsonrpc":"2.0","error":{"name":"REQUEST_VALIDATION_ERROR","cause":{"name":"PARSE_ERROR","info":{"error_message":"Failed to decode transaction: Unexpected length of input"}},"code":-32700,"message":"Parse error","data":"Failed to decode transaction: Unexpected length of input"},"id":"dontcare"}
```
**Submitting moves funds / changes state — only on explicit user instruction.**

#### broadcast_tx_commit
Submit and **wait** for the transaction to complete (10-second node-side timeout; deprecated — prefer `send_tx`). Params: `["<base64 signed tx>"]`. Success `result` has the same shape as `tx` (`status`, `transaction`, `transaction_outcome`, `receipts_outcome`, …). On timeout you get `TIMEOUT_ERROR` — the transaction may still land: query `tx` before retrying (a re-signed copy with a used nonce is rejected as `INVALID_TRANSACTION`).
```json
{"jsonrpc":"2.0","id":"dontcare","method":"broadcast_tx_commit","params":["<base64 signed tx>"]}
```
Preferred: `{"method":"send_tx","params":{"signed_tx_base64":"<base64 signed tx>","wait_until":"EXECUTED_OPTIMISTIC"}}` (same `wait_until` values as `tx`). Errors: `INVALID_TRANSACTION` (re-sign with right nonce/block hash/key), `EXPIRED_TRANSACTION` (reference block too old — refresh `block_hash`), `INVALID_SIGNATURE`.

### Network and fees

#### status
Node status: chain, versions, sync window. Params `[]`. **Not available on Ankr.**
```json
{"jsonrpc":"2.0","id":"dontcare","method":"status","params":[]}
```
```json
{"jsonrpc":"2.0","result":{"chain_id":"mainnet","protocol_version":86,"latest_protocol_version":86,"genesis_hash":"EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H","rpc_addr":"0.0.0.0:3030","sync_info":{"earliest_block_height":221327533,"earliest_block_time":"2026-10-24T02:45:53.886729225Z","latest_block_hash":"8kuwNv2hAufsU1UC86eGYae7uhNq4P6YVHLHnd8fGJjZ","latest_block_height":221445249,"latest_block_time":"2026-10-24T21:32:33.098993332Z","epoch_id":"AvuK6u4okXELk8yJvQY9zTVEHZogaLVWzxLaqjhv8rsJ","epoch_start_height":221413934,"syncing":false},"uptime_sec":168780,"validator_account_id":null,"version":{"build":"2.13.4","commit":"44f7ae6cd7ef08bab604e20a473bf77e35d4c993","rustc_version":"1.93.0","version":"2.13.4"},"validators":[{"account_id":"astro-stakers.poolv1.near"},{"account_id":"figment.poolv1.near"}]},"id":"dontcare"}
```
`syncing:false` + a fresh `latest_block_time` = healthy. `earliest_block_height`…`latest_block_height` is the history this node still holds (this node: ~19 h). `validators` lists ~100 current block producers (trimmed).

#### network_info
P2P view of the node: peers and known block producers. Params `[]`. **Not available on Ankr.** Large (≈64 KB on mainnet).
```json
{"jsonrpc":"2.0","id":"dontcare","method":"network_info","params":[]}
```
```json
{"jsonrpc":"2.0","result":{"active_peers":[{"account_id":null,"addr":"64.31.39.10:24567","id":"ed25519:8CiUikJVopxahbPooXeSbyphU2FijZK5E3rvvxKHm7wK"}],"num_active_peers":35,"peer_max_count":40,"sent_bytes_per_sec":5212814,"received_bytes_per_sec":5386322,"known_producers":[{"account_id":"qbit.poolv1.near","addr":null,"peer_id":"ed25519:GAEaExXRu6pSQCnukDtaSwXspFLssxuqZgSQ3LKvwRia"}]},"id":"dontcare"}
```
(`active_peers` 35 and `known_producers` 524 entries in the live reply, trimmed to one each.) Describes *that node*, not chain activity.

#### gas_price
Gas price (yoctoNEAR per gas unit) at a block. Params: **array** — `[null]` = latest, `[<height>]` or `["<block hash>"]`.
```json
{"jsonrpc":"2.0","id":"dontcare","method":"gas_price","params":[null]}
```
```json
{"jsonrpc":"2.0","result":{"gas_price":"100000000"},"id":"dontcare"}
```
100000000 yoctoNEAR/gas = 0.0001 NEAR per Tgas. The price floats with congestion; trust this live value (the genesis-era `min_gas_price` in `EXPERIMENTAL_protocol_config` reads 10^9, higher than the live price, so do not hard-code a floor). Cost of an action ≈ gas × gas_price.

#### validators
Current-epoch validator set with stakes and performance. Params: `[null]` (current epoch), `[<block hash>]`, or `{"epoch_id":"…"}` / `{"block_id":<height|hash>}`.
```json
{"jsonrpc":"2.0","id":"dontcare","method":"validators","params":[null]}
```
```json
{"jsonrpc":"2.0","result":{"epoch_height":4898,"epoch_start_height":221413934,"current_validators":[{"account_id":"astro-stakers.poolv1.near","public_key":"ed25519:2nPSBCzjqikgwrqUMcuEVReJhmkC91eqJGPGqH9sZc28","stake":"33300010923084121979730365985168","is_slashed":false,"num_produced_blocks":1866,"num_expected_blocks":1866,"num_produced_chunks":9268,"num_expected_chunks":9268,"shards":[13]}],"next_validators":[{"account_id":"astro-stakers.poolv1.near","public_key":"ed25519:2nPSBCzjqikgwrqUMcuEVReJhmkC91eqJGPGqH9sZc28","shards":[13],"stake":"33282913455289863195889897306207"}],"current_fishermen":[],"next_fishermen":[],"current_proposals":[{"account_id":"00aboo203.pool.near","public_key":"ed25519:2dJjJWXgvSG6iMbLFnhjrZhttrznxS225Wfq8Ffqz3Up","stake":"40032561850774431070466653120","validator_stake_struct_version":"V1"}],"prev_epoch_kickout":[{"account_id":"centurion.poolv1.near","reason":{"NotEnoughChunkEndorsements":{"expected":43174,"produced":0}}}]},"id":"dontcare"}
```
**Huge:** the live mainnet reply was **~414 KB** (392 current validators, 390 next, 429 proposals, plus per-validator reward maps). Fetch it rarely, never inside loops; stakes are yoctoNEAR strings.

## 5 · Other methods (not exampled)

Same envelope. Official method list (docs.near.org + nearcore OpenAPI): `send_tx`, `tx_status`, `EXPERIMENTAL_receipt`, `EXPERIMENTAL_receipt_to_tx`; `changes` (`changes_type`: `account_changes`, `data_changes`, `contract_code_changes`, `all_access_key_changes`, `single_access_key_changes`), `EXPERIMENTAL_changes`, `EXPERIMENTAL_changes_in_block`, `block_effects`; shortcut forms that take no `request_type`: `EXPERIMENTAL_view_account` and `EXPERIMENTAL_call_function` (both verified live), `EXPERIMENTAL_view_access_key`, `EXPERIMENTAL_view_access_key_list`, `EXPERIMENTAL_view_code`, `EXPERIMENTAL_view_state`; `health`, `client_config`, `genesis_config`, `EXPERIMENTAL_genesis_config`, `EXPERIMENTAL_protocol_config`, `EXPERIMENTAL_congestion_level`, `EXPERIMENTAL_validators_ordered`, `EXPERIMENTAL_maintenance_windows`, `maintenance_windows`, `EXPERIMENTAL_split_storage_info`; light client: `light_client_proof`, `next_light_client_block`, `EXPERIMENTAL_light_client_proof`, `EXPERIMENTAL_light_client_block_proof`. `EXPERIMENTAL_*` names are explicitly unstable — prefer the `query` forms above.

## 6 · Gotchas

- **`call_function` args are base64 of JSON; the result is an array of bytes** — decode UTF-8 then JSON-parse. Empty args = `""`.
- **yoctoNEAR (10^24)**: always strings; use big integers. Don't confuse with gas units or `storage_usage` bytes.
- **No batching** — one request per HTTP call; an array body is rejected outright.
- **Finality:** use `final` for balances/decisions; `optimistic` can roll back. `near-final` is in between.
- **History is short on normal RPC nodes:** old blocks/chunks/state fail with `UNKNOWN_BLOCK` (seen live for block height 1) or `UNKNOWN_CHUNK` / `GARBAGE_COLLECTED_BLOCK` (per docs) once garbage-collected (the public node probed held ~19 h; `status.sync_info.earliest_block_height` shows the window). Use an archival endpoint (e.g. `archival-rpc.mainnet.near.org`, or a provider archival tier) for history.
- **View state limit:** 50 kB by default (`TOO_LARGE_CONTRACT_STATE`). Prefer view methods.
- **Provider gaps:** Ankr blocks `status` and `network_info` (and requires Premium); Alchemy has no NEAR; BlockPI public key may be refused.
- **Huge responses:** `validators` ≈ 414 KB, `network_info` ≈ 64 KB, `block` ≈ 19 KB — mind agent context budgets.
- **Async execution:** "included" ≠ "succeeded". Check `status` and, for cross-contract calls, each `receipts_outcome[].outcome.status`; use `wait_until:"FINAL"` when finality matters, or poll `tx`.
- **Two error channels — check both.** (1) A JSON-RPC `error` object: read `error.cause.name` (seen live: `UNKNOWN_ACCOUNT`, `UNKNOWN_BLOCK`, `UNKNOWN_TRANSACTION`, `TOO_LARGE_CONTRACT_STATE`, `PARSE_ERROR`; documented: `INVALID_TRANSACTION`, `EXPIRED_TRANSACTION`, `TIMEOUT_ERROR`, `UNKNOWN_CHUNK`, `INVALID_SHARD_ID`, `GARBAGE_COLLECTED_BLOCK`). (2) For `query` view calls an **error string inside `result.error`** with HTTP 200 (unknown access key, contract panics, missing method, no contract code). HTTP status alone is unreliable (200 / 400 / 422 all seen).
- **Account IDs** are human strings (`wrap.near`, `alice.testnet`), lowercase; implicit accounts are 64-hex. Public keys carry a curve prefix (`ed25519:`).
- **Never send private keys / seed phrases;** signing is always local. Transactions need a recent `block_hash` (valid for `transaction_validity_period` = 86,400 blocks, about a day) and `nonce = key nonce + 1`.

Sources: docs.near.org RPC pages (`/api/rpc/introduction`, `/contracts`, `/transactions`, `/block-chunk`, `/gas`, `/providers`); nearcore OpenAPI v1.3.37 (`chain/jsonrpc/openapi/openapi.json`); Ankr NEAR chain page, BlockPI NEAR reference, Alchemy chain list; live calls on `rpc.mainnet.near.org` (nearcore 2.13.4) and `test.rpc.fastnear.com` on 2026-10-24 (broadcast success responses and `send_tx` not executed).
