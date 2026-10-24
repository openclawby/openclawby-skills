# Aptos RPC (BYOK, non-EVM — REST fullnode API)

Aptos reads, simulations and submissions using the user's **own node key** (Ankr / Alchemy / BlockPI), fetched from the Clawby Key Vault. Direct to the provider — not via Clawby relay, no Clawby credits. Aptos is **not EVM and not JSON-RPC**: it is a **REST/HTTP API** (the "Fullnode REST API", OpenAPI 3.0 "Aptos Node API" v1.2.0): resources are URL paths, reads are `GET`, calls/submits are `POST` with a JSON body, and there is no `{"jsonrpc":…}` envelope.

## 1 · Get the key (memory only, never write to disk)

Fetch from the vault as in `rpc/ankr.md` / `rpc/alchemy.md` / `rpc/blockpi.md` §1 (rules, errors, response shape: `rpc/index.yaml`). **The key sits in the endpoint URL → the whole URL is a secret; never log, echo, or commit it.**

## 2 · Endpoints per provider

Every provider exposes the same REST tree under a `/v1` segment. In this file `$BASE` = the provider URL **up to and including `/v1`**, and every path below is appended to it (`$BASE/accounts/0x1`).

| Provider | `$BASE` (mainnet) | Notes |
|---|---|---|
| Ankr | `https://rpc.ankr.com/premium-http/aptos/{KEY}/v1` | Ankr's REST/non-JSON-RPC form (`premium-http/<slug>/{KEY}/…`), **not** the usual `/{slug}/{KEY}`. Per Ankr docs; Freemium plan listed. `/v1/spec` and `/v1/-/healthy` are not supported. Not exercised with a real key (a wrong key returns a bare nginx 404). |
| Alchemy | `https://aptos-mainnet.g.alchemy.com/v2/{KEY}/v1` | Testnet: `aptos-testnet`. From Alchemy's Aptos quickstart. Alchemy also offers an Aptos gRPC transaction stream (separate). |
| BlockPI | `https://aptos.blockpi.network/aptos/v1/{KEY}/v1` | **Differs from the usual BlockPI `/v1/rpc/{KEY}` form** — this is the shape in BlockPI's own Aptos docs. Live check: the gateway recognises it and answers `Apikey not found` for a dummy key. A trailing slash on the bare root (`…/v1/`) returns a 301 to the slashless URL — use `curl -L` or omit it. |
| Aptos Labs public (reference, not BYOK) | `https://api.mainnet.aptoslabs.com/v1` | Alias `fullnode.mainnet.aptoslabs.com`. Anonymous = per-IP throttled; a Geomi key sent as `Authorization: Bearer <key>` raises limits. All examples below were captured here on 2026-10-24. |

Testnet / devnet: `api.testnet.aptoslabs.com`, `api.devnet.aptoslabs.com`; provider testnet slugs vary — see that provider's file.

## 3 · Protocol style (REST — different from JSON-RPC)

- `GET` for reads (path params + query params); `POST` with `Content-Type: application/json` for `/view`, `/transactions`, `/transactions/simulate`, `/tables/…`. Binary alternatives exist: send `Content-Type: application/x.aptos.signed_transaction+bcs` / `application/x.aptos.view_function+bcs`, and ask for BCS output with `Accept: application/x-bcs`. JSON is the default.
- Success = HTTP 200 (`202 Accepted` for submit). Errors use real HTTP status plus a JSON body: `{"message":"…","error_code":"<code>","vm_error_code":null}`. Codes include `account_not_found`, `resource_not_found`, `module_not_found`, `transaction_not_found`, `block_not_found`, `version_not_found`, `version_pruned`, `block_pruned`, `invalid_input`, `sequence_number_too_old`, `vm_error`, `mempool_is_full`, `rate_limited`, `web_framework_error`, `api_disabled`.
- **Successful responses carry ledger headers:** `X-Aptos-Chain-Id`, `X-Aptos-Ledger-Version`, `X-Aptos-Ledger-Oldest-Version`, `X-Aptos-Ledger-TimestampUsec`, `X-Aptos-Epoch`, `X-Aptos-Block-Height`, `X-Aptos-Oldest-Block-Height`; paged endpoints add **`X-Aptos-Cursor`**.
- **All u64/u128 are decimal STRINGS** in JSON (`"sequence_number":"31189"`, `"gas_used":"316"`); a few small fields (`chain_id`, gas estimates) are numbers. Addresses are `0x…` hex; leading zeros optional (`0x1` = `0x000…001`).
- **Units — Octas:** 1 APT = 100,000,000 Octas (1e8). Gas prices and balances are in Octas. APT's asset/metadata address is `0xa`; its legacy coin type is `0x1::aptos_coin::AptosCoin`.
- **Pagination — three different styles:**
  - `GET /transactions`: `start` = **ledger version**, `limit`.
  - `GET /accounts/{addr}/transactions`: `start` = account **sequence number**, `limit`.
  - `GET /accounts/{addr}/resources` and `/modules`: `start` = an **opaque cursor** that cannot be built client-side — call once without `start`, read the **`X-Aptos-Cursor`** response header, send it back as `start`. No header = last page.
  - When `start` is omitted, the two transaction endpoints return the *latest* entries.

## 4 · Endpoint catalog

Examples are live responses, trimmed. `$BASE` as above; add `-H "Authorization: Bearer $KEY"` only for Aptos Labs endpoints (the provider URLs carry the key in the path).

### GET /v1 — ledger info
Chain state and the node's data window. Request: `curl -sL "$BASE"`.
```json
{"chain_id":1,"epoch":"17748","ledger_version":"7753441398","oldest_ledger_version":"7603641410","ledger_timestamp":"1792877286668371","node_role":"full_node","oldest_block_height":"1111210677","block_height":"1136406660","git_hash":"433c185c8e9c41205a83dfe289ac1072b7f00d1a"}
```
`chain_id` 1 = mainnet. `ledger_timestamp` is microseconds. **`oldest_ledger_version` > 0 means the node is pruned** — data older than that returns 410. Newer nodes also return an `encryption_key` field (ignore it). Liveness: `GET /-/healthy` → `{"message":"aptos-node:ok"}`.

### GET /v1/accounts/{address}
Sequence number + authentication key. Query: `ledger_version` (historical state, within the retention window).
```bash
curl -s "$BASE/accounts/0x1"
```
```json
{"sequence_number":"0","authentication_key":"0x0000000000000000000000000000000000000000000000000000000000000001"}
```
`sequence_number` is the next sequence number to use when signing (for sequence-number transactions). **An address that never existed does not 404 on the live mainnet API** — it returns 200 with `"sequence_number":"0"` and `authentication_key` = the address. Test existence via resources/balance, not by status code.

### GET /v1/accounts/{address}/resources
All Move resources stored on the account. Query: `ledger_version`, `start` (cursor from `X-Aptos-Cursor`), `limit`.
```bash
curl -s "$BASE/accounts/0x25a1c27838e49fd118924e4a8caec7490aec7b5862bda389d7bdbe3494d3c96b/resources?limit=3"
```
```json
[{"type":"0x1::account::Account","data":{"authentication_key":"0x25a1c27838e49fd118924e4a8caec7490aec7b5862bda389d7bdbe3494d3c96b","coin_register_events":{"counter":"0","guid":{"id":{"addr":"0x25a1c27838e49fd118924e4a8caec7490aec7b5862bda389d7bdbe3494d3c96b","creation_num":"0"}}},"guid_creation_num":"2","sequence_number":"255158"}}]
```
(`data` trimmed.) Each item is `{"type":"<struct tag>","data":{…}}`. **Do not read APT balances from a `0x1::coin::CoinStore<…>` resource** — on current mainnet APT lives in a fungible-asset store (that resource returns 404 `resource_not_found`; and the resources list above shows no coin resource). Use `GET /accounts/{addr}/balance/0xa` or `POST /view` (below). A nonexistent account returns `[]`. Accounts with big state can return huge pages (the default page for `0x1` measured ~1.6 MB) — always set `limit`.

### GET /v1/accounts/{address}/modules
Deployed Move modules (bytecode + ABI). Query: `ledger_version`, `start` (cursor), `limit`.
```bash
curl -s "$BASE/accounts/0x1/modules?limit=1"
```
```json
[{"bytecode":"0xa11ceb0b0a00000a<hex truncated>","abi":{"address":"0x1","name":"acl","friends":[],"exposed_functions":[{"name":"contains","visibility":"public","is_entry":false,"is_view":false,"generic_type_params":[],"params":["&0x1::acl::ACL","address"],"return":["bool"]}],"structs":[{"name":"ACL","is_native":false,"is_event":false,"is_enum":false,"abilities":["copy","drop","store"],"generic_type_params":[],"fields":[{"name":"list","type":"vector<address>"}],"variants":[]}]}}]
```
The ABI is what an agent needs to call `/view` or build entry-function payloads: `is_view:true` functions can be called through `POST /view`; `is_entry:true` can be submitted in a transaction. One module: `GET /accounts/{address}/module/{module_name}`.

### GET /v1/accounts/{address}/resource/{resource_type}
One resource by struct tag. **URL-encode generics**: `<` → `%3C`, `>` → `%3E`.
```bash
curl -s "$BASE/accounts/0x1/resource/0x1::coin::CoinInfo%3C0x1::aptos_coin::AptosCoin%3E"
```
```json
{"type":"0x1::coin::CoinInfo<0x1::aptos_coin::AptosCoin>","data":{"decimals":8,"name":"Aptos Coin","supply":{"vec":[{"aggregator":{"vec":[{"handle":"0x1b854694ae746cdbd8d44186ca4929b2b337df21d1c74633be19b2710552fdca","key":"0x619dc29a0aac8fa146714058e8dd6d2d0f3bdf5f6331907bf91f3acd81e6935","limit":"340282366920938463463374607431768211455"}]},"integer":{"vec":[]}}]},"symbol":"APT"}}
```
Missing → HTTP 404 `{"message":"Resource not found by Address(0x1), Struct tag(…) and Ledger version(…)","error_code":"resource_not_found","vm_error_code":null}`. Move `Option<T>` appears as `{"vec":[]}` (none) or `{"vec":[value]}` (some).

### GET /v1/transactions
Committed transactions in version order. Query: `start` (ledger version), `limit`.
```bash
curl -s "$BASE/transactions?start=7753444818&limit=1"
```
```json
[{"version":"7753444818","hash":"0x3a5b08b37da4463e65c7297cb815365dd630a614d250045ae6b908947cad3745","gas_used":"316","success":true,"vm_status":"Executed successfully","sender":"0xd503b95164384a5ebbccbb5c4bdc8b4a5893d9651e9953abda8e1c22fcc1181d","sequence_number":"0","max_gas_amount":"100000","gas_unit_price":"150","expiration_timestamp_secs":"1792877333","payload":{"function":"0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06::dex_accounts_entry::place_bulk_orders_to_subaccount_with_repricing","type_arguments":[],"arguments":["<trimmed>"],"type":"entry_function_payload"},"signature":{"public_key":"0x8d2a6dc60eaeacf89cba9e53db787d77165c63be218175c24009252eaf57c513","signature":"0xec03ce2dbd5823d369293b8c4b9e67612a39dc5c414fb0ee3c5b0dad48798fbbec48e263324fe828f4f29f5c5db68d91eed082be10f1184070e5081b7ec9390f","type":"ed25519_signature"},"replay_protection_nonce":"1791349153422070649","events":[{"guid":{"creation_number":"0","account_address":"0x0"},"sequence_number":"0","type":"0x1::transaction_fee::FeeStatement","data":{"execution_gas_units":"245","io_gas_units":"72","storage_fee_octas":"0","storage_fee_refund_octas":"0","total_charge_gas_units":"316"}}],"timestamp":"1792877313881977","type":"user_transaction"}]
```
(Also present, trimmed: `changes[]` write-set, `state_change_hash`, `event_root_hash`, `accumulator_root_hash`.) The array is heterogeneous by `type`: `user_transaction`, `block_metadata_transaction`, `block_epilogue_transaction`, `state_checkpoint_transaction`, `validator_transaction`, `genesis_transaction`, and `pending_transaction` (mempool, only via by_hash). **Always check `success` and `vm_status`** — a committed transaction can have `success:false` (e.g. `Move abort …`). Fee paid = `gas_used × gas_unit_price` Octas. `signature.type` can also be `multi_ed25519_signature`, `single_sender`, `fee_payer_signature`, `multi_agent_signature`. `timestamp` is microseconds. Without `start` it returns the newest transactions.

### GET /v1/transactions/by_hash/{txn_hash}
One transaction by hash; also returns **pending** (mempool) ones as `{"type":"pending_transaction",…}`. Same object shape as above. Poll this (or `GET /transactions/wait_by_hash/{hash}`, which long-polls) after submitting.
```bash
curl -s "$BASE/transactions/by_hash/0x3a5b08b37da4463e65c7297cb815365dd630a614d250045ae6b908947cad3745"
```
Errors: `404 transaction_not_found`; malformed hash → `400 web_framework_error` ("unable to parse HashValue").

### GET /v1/transactions/by_version/{txn_version}
Same object by ledger version (the global monotonic transaction counter). Pruned → `410 version_pruned`.
```bash
curl -s "$BASE/transactions/by_version/7753444818"
```

### GET /v1/accounts/{address}/transactions
Transactions **sent by** an account, by its sequence number. Query: `start` (sequence number), `limit`. Returns sequence-number transactions only — **orderless transactions (below) are not listed.**
```bash
curl -s "$BASE/accounts/0x25a1c27838e49fd118924e4a8caec7490aec7b5862bda389d7bdbe3494d3c96b/transactions?limit=2"
```
Same array-of-transactions shape; `X-Aptos-Cursor` is not used here. To page backwards, subtract from the current `sequence_number` (from `GET /accounts/{addr}`). Incoming transfers are NOT here — use events or the Indexer.

### POST /v1/view
Call a Move `#[view]` function without a transaction (reads, e.g. balances, prices, pool state). Body: `function` (`address::module::name`), `type_arguments` (array of type tags), `arguments` (array, JSON-encoded per parameter type: addresses as `"0x…"`, u64/u128 as strings, vectors as arrays). Query: `ledger_version`.
```bash
curl -s -X POST "$BASE/view" -H 'Content-Type: application/json' -d '{"function":"0x1::coin::balance","type_arguments":["0x1::aptos_coin::AptosCoin"],"arguments":["0x1"]}'
```
```json
["11120868786"]
```
Response is an **array** of the function's return values (here one u64 as a string, in Octas = 111.2 APT). Other verified calls: `{"function":"0x1::timestamp::now_microseconds","type_arguments":[],"arguments":[]}` → `["1792877348959953"]`; `0x1::primary_fungible_store::balance` with `type_arguments:["0x1::fungible_asset::Metadata"]`, `arguments:["<owner>","0xa"]` → balance. Errors: `400 invalid_input` ("could not find view function by 0x1::coin::nope"), `410 version_pruned` for old `ledger_version`.

### POST /v1/transactions
Submit a **signed** transaction. **Moves funds / changes state — only on explicit user instruction.** Sign locally (Aptos SDK / CLI); never send a private key to any node. JSON body is a `SubmitTransactionRequest` (the same body `simulate` accepts, with a real signature):
```bash
curl -s -X POST "$BASE/transactions" -H 'Content-Type: application/json' -d @signed_txn.json
```
```json
{"sender":"0x25a1c27838e49fd118924e4a8caec7490aec7b5862bda389d7bdbe3494d3c96b","sequence_number":"255158","max_gas_amount":"200000","gas_unit_price":"100","expiration_timestamp_secs":"1792877965","payload":{"type":"entry_function_payload","function":"0x1::aptos_account::transfer","type_arguments":[],"arguments":["0x1","100"]},"signature":{"type":"ed25519_signature","public_key":"0x<32-byte public key hex>","signature":"0x<64-byte signature hex>"}}
```
`202 Accepted` response = a `PendingTransaction` (it is only in the mempool):
```json
{"hash":"0x<txn hash>","sender":"0x25a1c27838e49fd118924e4a8caec7490aec7b5862bda389d7bdbe3494d3c96b","sequence_number":"255158","max_gas_amount":"200000","gas_unit_price":"100","expiration_timestamp_secs":"1792877965","payload":{"type":"entry_function_payload","function":"0x1::aptos_account::transfer","type_arguments":[],"arguments":["0x1","100"]},"signature":{"type":"ed25519_signature","public_key":"0x<…>","signature":"0x<…>"}}
```
(Response shape from the OpenAPI schema; submit was not executed here. Request shape is the one the live simulate call accepted.) Then poll `by_hash` until `type != "pending_transaction"` and `success:true`. Optional orderless fields: `replay_protection_nonce`. Alternative body: raw BCS `SignedTransaction` with `Content-Type: application/x.aptos.signed_transaction+bcs`. `POST /transactions/batch` submits several. Documented HTTP statuses: `202`, `400`, `403`, `404`, `413` (too large), `500`, `503`, `507`. Verified live: a malformed JSON body → `400 web_framework_error`; undecodable BCS → `400 invalid_input`. The spec also defines `vm_error`, `sequence_number_too_old` (stale sequence number) and `mempool_is_full` codes (bad signature / expired / insufficient balance surface as VM or input errors) — exact status mapping not verified.

### POST /v1/transactions/simulate
Dry-run a transaction with a **zeroed signature** (no signing key needed; changes nothing). Body = same `SubmitTransactionRequest`, but `signature.signature` is 64 zero bytes (`"0x"` + 128 zeros) with the sender's real `public_key`. Optional boolean query flags: `estimate_max_gas_amount` (ignore the body's max gas, use the maximum possible), `estimate_gas_unit_price` (ignore the body's price, use the node's estimate), `estimate_prioritized_gas_unit_price` (use a higher price than that estimate).
```bash
curl -s -X POST "$BASE/transactions/simulate" -H 'Content-Type: application/json' -d @sim_body.json
```
```json
[{"version":"7753450908","hash":"0xc364110ca54de210f724657f3f8c5cee77aa56f7e8bed75dcecf30c815d0dc08","gas_used":"0","success":false,"vm_status":"INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE","sender":"0x25a1c27838e49fd118924e4a8caec7490aec7b5862bda389d7bdbe3494d3c96b","sequence_number":"255158","max_gas_amount":"200000","gas_unit_price":"100","expiration_timestamp_secs":"1792877965","payload":{"function":"0x1::aptos_account::transfer","type_arguments":[],"arguments":["0x1","100"],"type":"entry_function_payload"},"signature":{"public_key":"0x96843255d7af39f37db56f9e1f6080e5f53e6de697304dd3b1c75e1afeed197e","signature":"0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000","type":"ed25519_signature"},"events":[],"changes":[],"timestamp":"1792877365677409"}]
```
Result is an **array** with one transaction object whose state hashes are zeroed. In this live example the sender had no APT, so `success:false` — an agent must read `success` + `vm_status`; use `gas_used` × `gas_unit_price` to estimate cost when `success:true`; `changes` / `events` show what would happen.

### GET /v1/estimate_gas_price
Recommended gas unit price (Octas per gas unit) in three tiers.
```bash
curl -s "$BASE/estimate_gas_price"
```
```json
{"deprioritized_gas_estimate":100,"gas_estimate":100,"prioritized_gas_estimate":150}
```
Plain numbers (not strings). Per the spec the estimate equals the minimum gas unit price (100 here) unless recent blocks were full, and the three tiers get progressively more aggressive. Use one as `gas_unit_price` when building a transaction.

### GET /v1/blocks/by_height/{block_height}
Block metadata and its version range. Query: `with_transactions` (bool, default false; a block's txns can be large and may be truncated — fetch the rest via `/transactions?start=`).
```bash
curl -s "$BASE/blocks/by_height/1136406660?with_transactions=false"
```
```json
{"block_height":"1136406660","block_hash":"0x9745cf8c34a516a7d7e0a23408aa71b1f333efbd29eef5fe545357c9833bf5d6","block_timestamp":"1792877286668371","first_version":"7753441397","last_version":"7753441398","transactions":null}
```
`first_version`…`last_version` is the inclusive transaction-version range of the block; `block_timestamp` is microseconds. Pruned → `410 block_pruned`. By version: `GET /blocks/by_version/{version}`.

## 5 · Other endpoints (not exampled)

`GET /accounts/{address}/balance/{asset_type}` — balance of a coin type or fungible-asset metadata address (e.g. `0xa` for APT); returns a **bare JSON number** in base units (verified: `11120868786`). `GET /accounts/{address}/events/{creation_number}` and `/events/{event_handle}/{field_name}` (paged with `start`/`limit`), `POST /tables/{table_handle}/item` (and `/raw_item`), `GET /transactions/wait_by_hash/{hash}`, `POST /transactions/batch`, `POST /transactions/encode_submission` (node builds the signing message — only against a node you trust), `GET /transactions/auxiliary_info`, `GET /accounts/{address}/transaction_summaries`, `GET /info`, `GET /-/healthy`, `GET /spec` (OpenAPI; not supported on Ankr).

## 6 · Indexer GraphQL (mention only)

For rich/historical queries (token balances, NFT holdings, incoming transfers, activity, aggregates) the fullnode REST API is the wrong tool; Aptos Labs runs an **Indexer GraphQL API** at `https://api.mainnet.aptoslabs.com/v1/graphql` (testnet/devnet analogous; Geomi key for higher limits). Verified live: `POST` `{"query":"query { ledger_infos { chain_id } }"}` → `{"data":{"ledger_infos":[{"chain_id":1}]}}`; balances are in the `current_fungible_asset_balances` table (`where:{owner_address:{_eq:"0x…"}}`, fields `asset_type`, `amount`). Not documented further here. Whether Ankr/Alchemy/BlockPI proxy it is unconfirmed (their Aptos pages do not mention it) — assume you need an Aptos Labs / Geomi key. Node pruning (§7) is another reason to use the Indexer for old history.

## 7 · Gotchas

- **REST, not JSON-RPC.** No `method`/`params`/`id`; status codes carry meaning; errors are `{message,error_code,vm_error_code}`.
- **Provider URL shapes differ** (§2): Ankr `premium-http/aptos/{KEY}/v1`, Alchemy `…/v2/{KEY}/v1`, BlockPI `aptos/v1/{KEY}/v1`. Wrong key/slug → 404/401/`Apikey not found`/HTML.
- **Strings for big numbers** (u64/u128); Octas (1e8 per APT). Don't parse with 53-bit floats.
- **Pruned history:** nodes keep only a window (`oldest_ledger_version` in `GET /v1`; ~150M versions retained by default). Older versions/blocks/state return **`410`** `version_pruned` / `block_pruned`; Aptos Labs' reply includes `"archival_endpoint":"https://archive.mainnet.aptoslabs.com/v1"`. Provider archival tiers vary. `ledger_version=` queries are limited to the same window.
- **Orderless transactions:** many modern transactions have `sequence_number:"18446744073709551615"` (u64 max) plus a `replay_protection_nonce`; `GET /accounts/{addr}/transactions` skips them (the spec says so explicitly), and by design they do not use the account's sequence number.
- **Non-existent accounts return 200** (`sequence_number:"0"`), not 404; resources `[]`.
- **APT balance** ≠ `CoinStore` resource any more → `/accounts/{addr}/balance/0xa` or `/view`.
- **Check `success`/`vm_status`** on every transaction and simulation. A `202` from submit means "in mempool", not "done".
- **Gas:** fee = `gas_used × gas_unit_price`; `max_gas_amount × gas_unit_price` must be ≤ the account balance or simulation/submit fails (`INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE`). Transactions expire at `expiration_timestamp_secs`.
- **Type tags in URLs** must be percent-encoded; function IDs are `address::module::function`, case-sensitive.
- **Never send private keys or seed phrases;** sign locally. `encode_submission` returns the bytes you then sign — only use a node you trust.
- Rate limits are per provider plan (Aptos Labs public: per IP / Geomi key); back off on `429`/`rate_limited`.

Sources: aptos.dev (`/en/build/apis/fullnode-rest-api`, `/en/build/indexer/indexer-api`); the OpenAPI spec served at `fullnode.mainnet.aptoslabs.com/v1/spec.json` (Aptos Node API 1.2.0); Ankr Aptos chain page, Alchemy Aptos quickstart, BlockPI Aptos reference; live calls on `api.mainnet.aptoslabs.com` 2026-10-24 (all GET/view/simulate/error shapes; submit not executed).
