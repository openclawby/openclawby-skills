# Sui RPC (BYOK, non-EVM)

Sui reads and writes using the user's **own node key** (Ankr / Alchemy / BlockPI), fetched from the Clawby Key Vault. Direct to the provider — not via Clawby relay, no Clawby credits. Sui is **not** EVM: methods are `sui_*` / `suix_*`, data is object-based, there is no `eth_*`.

## 0 · STATUS: Sui JSON-RPC is being retired — read first

Sui replaced JSON-RPC with **gRPC** and **GraphQL**. Timeline (docs.sui.io JSON-RPC Migration Guide; the testnet date is from Ankr's notice): Foundation mainnet full nodes stopped serving JSON-RPC the week of 2026-07-27 (testnet week of 2026-07-06) · end of Aug 2026 snapshots stop · end of Sep 2026 no archive fallback · **mid-Oct 2026 JSON-RPC code is removed from node software.**

Keyless probes run 2026-10-24 (read-only, one call each):

| Endpoint | Result |
|---|---|
| `fullnode.mainnet.sui.io` (Sui Foundation) | `-32601 "Method not found. JSON-RPC on public fullnodes has been deprecated. Please migrate to gRPC or GraphQL"` |
| `sui-rpc.publicnode.com` | `-32000 "Sui JSON-RPC endpoint has been deprecated"` |
| `sui-mainnet-endpoint.blockvision.org` | `-32601 "Sui JSON-RPC has been deprecated"` |
| BlockPI docs | "If your application still points to a SUI JSON-RPC endpoint, it will no longer return data" |
| Alchemy docs | "Support for Sui JSON-RPC will end on September 25, 2026" |
| Ankr docs | page titled "Sui JSON-RPC (deprecated)"; endpoints "run only until the mid-October removal" |

**UNVERIFIED:** no keyed call was made (no user key available), so it is unknown whether a user's Ankr/Alchemy/BlockPI JSON-RPC endpoint still answers today. Expect it not to.

**Decision rule for agents:** make ONE cheap probe (`sui_getLatestCheckpointSequenceNumber`, §4). If the reply is `-32601`, a message containing `deprecated`, an HTML/404 body, or no data → stop retrying JSON-RPC and use **GraphQL** (plain HTTPS POST, curl-friendly) or gRPC — §6. §4 below is kept as the legacy reference (self-hosted/older nodes, and to map old method names to new ones).

## 1 · Get the key (memory only, never write to disk)

Fetch from the vault exactly as in `rpc/ankr.md` / `rpc/alchemy.md` / `rpc/blockpi.md` §1 (rules, errors, response shape: `rpc/index.yaml`). **The key sits in the endpoint URL (or gRPC token) → the whole URL is a secret; never log, echo, or commit it.**

## 2 · Endpoints per provider

`{KEY}` = the user's key. JSON-RPC is POST with `Content-Type: application/json`.

| Provider | JSON-RPC (legacy, likely dead) | GraphQL (replacement, HTTPS POST) | gRPC (replacement) |
|---|---|---|---|
| Ankr | `https://rpc.ankr.com/sui/{KEY}` | `https://rpc.ankr.com/premium-http/sui_graphql/{KEY}` (Premium only; mainnet) | `sui.grpc.ankr.com:443` · testnet `sui-testnet.grpc.ankr.com:443` · archive `archive.sui.grpc.ankr.com:443` · header `x-token: {KEY}` |
| Alchemy | `https://sui-mainnet.g.alchemy.com/v2/{KEY}` (testnet `sui-testnet`) | not documented — see Alchemy's Sui docs | `sui-mainnet.g.alchemy.com:443` · header `Authorization: Bearer {KEY}` |
| BlockPI | `https://sui.blockpi.network/v1/rpc/{KEY}` (generic BlockPI template form; BlockPI's Sui docs list only gRPC/GraphQL and say JSON-RPC no longer returns data) | `https://sui.blockpi.network/v1/graphql/{KEY}` (latest 90 days) | `sui.blockpi.network` + token · archive `sui-archive.blockpi.network` · testnet `sui-testnet.blockpi.network` |
| Keyless reference (not BYOK) | — | `https://graphql.mainnet.sui.io/graphql` (verified live 2026-10-24) | — |

Provider facts above come from each provider's own docs; the keyed URLs were not exercised with a real key. gRPC needs the `sui.rpc.v2` protos (reflection is supported on Ankr) and a gRPC client such as `grpcurl`.

## 3 · Envelope and data model

**Envelope** — standard JSON-RPC 2.0, **positional** `params` array in the order listed per method (optional params may be omitted from the right; use `null` to skip a middle one):

```json
{"jsonrpc":"2.0","id":1,"method":"<method>","params":[]}
```
Success `{"jsonrpc":"2.0","id":1,"result":<...>}`; failure `{"jsonrpc":"2.0","id":1,"error":{"code":<int>,"message":"<str>"}}`.

**Data model** — everything on Sui is an **object** with a 32-byte hex **object ID** (`0x…`), a `version` and a `digest`. A wallet "balance" is the sum of `Coin<T>` objects it owns. Reads take object IDs / addresses / tx digests (base58). SUI coin type is `0x2::sui::SUI` (long form `0x000…0002::sui::SUI` is the same coin; normalize before comparing).

**Units** — **MIST**: 1 SUI = 1,000,000,000 MIST (1e9). All balances (`totalBalance`, `balance`) are MIST. u64/u128 values are returned as **decimal strings**.

**Options object — what to include in the response.** Defaults are all `false`; without options you get minimal data (digest/ID only). Two different option sets:

| Used by | Flag | Returns |
|---|---|---|
| objects (`ObjectDataOptions`) — `sui_getObject`, `sui_multiGetObjects`, `suix_getOwnedObjects` (inside `query.options`) | `showType` | Move type, e.g. `0x2::coin::Coin<0x2::sui::SUI>` |
| | `showOwner` | `owner`: `{"AddressOwner":…}` / `{"ObjectOwner":…}` / `{"Shared":{…}}` / `"Immutable"` / `{"ConsensusAddressOwner":…}` |
| | `showContent` | parsed Move fields (`content.fields`) or package modules |
| | `showPreviousTransaction` | digest of the last tx that touched it |
| | `showStorageRebate` | storage rebate (MIST string) |
| | `showDisplay` | Display metadata for rendering (NFTs) |
| | `showBcs` | BCS-encoded content |
| transaction blocks (`TransactionBlockResponseOptions`) — `sui_getTransactionBlock`, `sui_multiGetTransactionBlocks`, `suix_queryTransactionBlocks`, `sui_executeTransactionBlock` | `showInput` | decoded tx data (sender, gas data, PTB inputs/commands) |
| | `showRawInput` | BCS tx bytes (base64) |
| | `showEffects` | status (`success`/`failure`), gas used, mutated/created/deleted objects |
| | `showEvents` | events emitted |
| | `showObjectChanges` | per-object change list (`created`/`mutated`/`transferred`/`published`/…) |
| | `showBalanceChanges` | per-owner, per-coin-type balance deltas (negative = spent) |
| | `showRawEffects` | BCS effects |

`showBalanceChanges` is a **transaction** flag (not an object flag): use it on tx calls to see who paid/received what.

## 4 · Method catalog (legacy JSON-RPC)

Source: Mysten OpenRPC spec (`crates/sui-open-rpc/spec/openrpc.json` at tag `testnet-v1.75.1`, the last tag found that still ships it) — examples are the spec's own, trimmed. Paging: `limit` defaults to and is capped at **50** on stock nodes (operator-configurable; checkpoints 100), larger values are silently clamped; paged results are `{data, nextCursor, hasNextPage}` — pass `nextCursor` back as `cursor`.

### Objects

#### sui_getObject
One object by ID. Params `[object_id, options?]`. Missing/deleted objects come back as `{"error":{"code":"notExists"|"deleted"|"dynamicFieldNotFound"|"unknown"|"displayError",…}}` in `result`, not as a JSON-RPC error.
```json
{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0x53e4567ccafa5f36ce84c80aa8bc9be64e0d5ae796884274aef3005ae6733809",{"showType":true,"showOwner":true,"showPreviousTransaction":true,"showContent":true,"showStorageRebate":true}]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"data":{"objectId":"0x53e4567ccafa5f36ce84c80aa8bc9be64e0d5ae796884274aef3005ae6733809","version":"1","digest":"33K5ZXJ3RyubvYaHuEnQ1QXmmbhgtrFwp199dnEbL4n7","type":"0x2::coin::Coin<0x2::sui::SUI>","owner":{"AddressOwner":"0xc8ec1d5b84dd6289e193b9f88de4a994358c9f856135236c3e75a925e1c77ac3"},"previousTransaction":"5PLgmQye6rraDYqpV3npV6H1cUXoJZgJh1dPCyRa3WCv","storageRebate":"100","content":{"dataType":"moveObject","type":"0x2::coin::Coin<0x2::sui::SUI>","hasPublicTransfer":true,"fields":{"balance":"100000000","id":{"id":"0x53e4567ccafa5f36ce84c80aa8bc9be64e0d5ae796884274aef3005ae6733809"}}}}}}
```

#### sui_multiGetObjects
Many objects in one call (order preserved). Params `[object_ids[], options?]`. Errors if the list is longer than the page cap (50).
```json
{"jsonrpc":"2.0","id":1,"method":"sui_multiGetObjects","params":[["0x77b3482580ee8d5bdc5b824808df54bfec4fc817622e5add0e48f749f01def98","0x9060d87664c26a3f9a509228c21b16dc6797cf787c839a07edc03e6338421091"],{"showType":true,"showOwner":true}]}
```
```json
{"jsonrpc":"2.0","id":1,"result":[{"data":{"objectId":"0x77b3482580ee8d5bdc5b824808df54bfec4fc817622e5add0e48f749f01def98","version":"1","digest":"2QwXW3qzMEZPAyyP9VHtXbC2tp7iomypQc5XnkyPsu5d","type":"0x2::coin::Coin<0x2::sui::SUI>","owner":{"AddressOwner":"0x504d411325e3c7f89d412044fe99007efb0f94f1e64d2e8090c619a39299d87e"}}},{"data":{"objectId":"0x9060d87664c26a3f9a509228c21b16dc6797cf787c839a07edc03e6338421091","version":"1","digest":"5itvhMFvtJcV6fY2VY4x7F9Ex18q2N4Rr5WU4FXTJsFU","type":"0x2::coin::Coin<0x2::sui::SUI>","owner":{"AddressOwner":"0x23618df6438d21a48040e6bb568cafc13246bd847c60448160e0358cac4a1134"}}}]}
```

#### suix_getOwnedObjects
Objects owned by an address, with optional filter. Params `[address, query?, cursor?, limit?]`; `query = {"filter":<ObjectFilter>,"options":<ObjectDataOptions>}` (filters: §5). Pagination is not snapshot-consistent if the owner has more than one page of objects.
```json
{"jsonrpc":"2.0","id":1,"method":"suix_getOwnedObjects","params":["0xdbc9abc01a87906b033a75750e741edb2df5ea5d55c96a611371d22799d26827",{"filter":{"StructType":"0x2::coin::Coin<0x2::sui::SUI>"},"options":{"showType":true,"showOwner":true}},null,3]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"data":[{"data":{"objectId":"0x0b37a91692359a98496738a58c17a9334aeacc435c70ab9635e47a277d8f8dd9","version":"13488","digest":"FZzfCnKCSRW2jN9AwkiarjYQapViUQAh799aiRMZ4YC2","type":"0x2::coin::Coin<0x2::sui::SUI>","owner":{"AddressOwner":"0xdbc9abc01a87906b033a75750e741edb2df5ea5d55c96a611371d22799d26827"}}}],"nextCursor":"0x0b37a91692359a98496738a58c17a9334aeacc435c70ab9635e47a277d8f8dd9","hasNextPage":true}}
```

### Balances and coins

#### suix_getBalance
Total of one coin type for an owner. Params `[owner, coin_type?]` (default `0x2::sui::SUI`).
```json
{"jsonrpc":"2.0","id":1,"method":"suix_getBalance","params":["0xa6f5a7953a75dc632e696cabe60560522a017bf2fb0bd930d1ec22c06f1ee4e4","0x2::sui::SUI"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"coinType":"0x2::sui::SUI","coinObjectCount":15,"totalBalance":"3000000000","lockedBalance":{},"fundsInAddressBalance":"42"}}
```
`totalBalance` is MIST (3000000000 = 3 SUI). `fundsInAddressBalance` appears in the v1.75 spec example (funds held as an address balance rather than as coin objects); older nodes omit it.

#### suix_getAllBalances
Totals for every coin type an owner holds. Params `[owner]`; result is an array of the same objects as above.
```json
{"jsonrpc":"2.0","id":1,"method":"suix_getAllBalances","params":["0x94f1a597b4e8f709a396f7f6b1482bdcd65a673d111e49286c527fab7c2d0961"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":[{"coinType":"0x2::sui::SUI","coinObjectCount":15,"totalBalance":"3000000000","lockedBalance":{},"fundsInAddressBalance":"42"}]}
```

#### suix_getCoins
`Coin<coin_type>` objects of one type (default SUI), paged. Params `[owner, coin_type?, cursor?, limit?]`.
```json
{"jsonrpc":"2.0","id":1,"method":"suix_getCoins","params":["0x6d907beaa3a49db57bdfdb3557e6d405cbf01c293a53e01457d65e92b5d8dd68","0x2::sui::SUI",null,3]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"data":[{"coinType":"0x2::sui::SUI","coinObjectId":"0xd62ca040aba24f862a763851c54908cd2a0ee7d709c11b93d4a2083747b76856","version":"103626","digest":"C9fdokK19BpDCgUgWsJv3cfd4LDyk7WGYBeGhFHbEL2Z","balance":"200000000","previousTransaction":"tw5DzJTfdxTn4f3rekFrhN7dQTUezBgsEhycDobTBLb"}],"nextCursor":"abcd","hasNextPage":true}}
```

#### suix_getAllCoins
Coin objects of every type, paged. Params `[owner, cursor?, limit?]`; same result shape as `suix_getCoins`.
```json
{"jsonrpc":"2.0","id":1,"method":"suix_getAllCoins","params":["0x41f5975e3c6bd5c95f041a8493ad7e9934be26e69152d2c2e86d8a9bdbd242b3",null,3]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"data":[{"coinType":"0x2::sui::SUI","coinObjectId":"0x861c5e055605b2bb1199faf653a8771e448930bc95a0369fad43a9870a2e5878","version":"103626","digest":"Ao1QyN9UTmYzb2ead3D5xhSBk7TvACRvmnJW8gRbwP99","balance":"200000000","previousTransaction":"7dp5WtTmtGp83EXYYFMzjBJRFeSgR67AzqMETLrfgeFx"}],"nextCursor":"abcd","hasNextPage":true}}
```

### Transactions

#### sui_getTransactionBlock
One transaction by digest. Params `[digest, options?]` (tx options: §3). Without options only `digest` is returned.
```json
{"jsonrpc":"2.0","id":1,"method":"sui_getTransactionBlock","params":["Hay2tj3GcDYcE3AMHrej5WDsHGPVAYsegcubixLUvXUF",{"showInput":true,"showEffects":true,"showEvents":true,"showBalanceChanges":true}]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"digest":"Hay2tj3GcDYcE3AMHrej5WDsHGPVAYsegcubixLUvXUF","transaction":{"data":{"messageVersion":"v1","transaction":{"kind":"ProgrammableTransaction","inputs":[{"type":"pure","valueType":"address","value":"0x8196d048b7a6d04c8edc89579d86fd3fc90c52f9a14c6b812b94fe613c5bcebb"}],"transactions":[{"TransferObjects":[[{"Input":1}],{"Input":0}]}]},"sender":"0x82179c57d5895babfb655cd62e8e886a53334b5e7be9be658eb759cc35e3fc66","gasData":{"price":"10","budget":"100000"}},"txSignatures":["<base64 signature>"]},"effects":{"messageVersion":"v1","status":{"status":"success"},"executedEpoch":"0","gasUsed":{"computationCost":"100","storageCost":"100","storageRebate":"10","nonRefundableStorageFee":"0"},"transactionDigest":"6AyFnAuKAKCqm1cD94EyGzBqJCDDJ716ojjmsKF2rqoi"},"events":[],"balanceChanges":[{"owner":{"AddressOwner":"0x82179c57d5895babfb655cd62e8e886a53334b5e7be9be658eb759cc35e3fc66"},"coinType":"0x2::sui::SUI","amount":"-190"}],"timestampMs":"1676911928000","checkpoint":"1000"}}
```
(`balanceChanges`, `timestampMs`, `checkpoint` are in the response schema; their values here are illustrative. Failed txs have `effects.status = {"status":"failure","error":"<reason>"}`. Total gas = computationCost + storageCost − storageRebate, in MIST.)

#### sui_multiGetTransactionBlocks
Many transactions, order preserved. Params `[digests[], options?]`. No duplicates; max 50 digests.
```json
{"jsonrpc":"2.0","id":1,"method":"sui_multiGetTransactionBlocks","params":[["EMqJqkQip6UaTkdff493ewAQNHGQFJwXDDn6m9CTgZzo","Hn3B25vTQNTFAdThFkWvfkiAAUZxzwTaj4uEengu1ACX"],{"showEffects":true}]}
```
```json
{"jsonrpc":"2.0","id":1,"result":[{"digest":"EMqJqkQip6UaTkdff493ewAQNHGQFJwXDDn6m9CTgZzo","effects":{"status":{"status":"success"},"gasUsed":{"computationCost":"100","storageCost":"100","storageRebate":"10","nonRefundableStorageFee":"0"}}},{"digest":"Hn3B25vTQNTFAdThFkWvfkiAAUZxzwTaj4uEengu1ACX","effects":{"status":{"status":"success"},"gasUsed":{"computationCost":"100","storageCost":"100","storageRebate":"10","nonRefundableStorageFee":"0"}}}]}
```

#### suix_queryTransactionBlocks
Find transactions by filter, paged. Params `[query, cursor?, limit?, descending_order?]`; `query = {"filter":<TxFilter>,"options":<tx options>}` (filters: §5). Default order is **oldest first** — pass `descending_order:true` for latest. With no `options` you only get digests.
```json
{"jsonrpc":"2.0","id":1,"method":"suix_queryTransactionBlocks","params":[{"filter":{"FromAddress":"0x82179c57d5895babfb655cd62e8e886a53334b5e7be9be658eb759cc35e3fc66"},"options":{"showEffects":true}},null,10,true]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"data":[{"digest":"GUPcK4cmRmgsTFr52ab9f6fnzNVg3Lz6hF2aXFcsRzaD","effects":{"status":{"status":"success"}}},{"digest":"B2iV1SVbBjgTKfbJKPQrvTT6F3kNdekFuBwY9tQcAxV2","effects":{"status":{"status":"success"}}}],"nextCursor":"B2iV1SVbBjgTKfbJKPQrvTT6F3kNdekFuBwY9tQcAxV2","hasNextPage":false}}
```
Cursor is a transaction digest.

### Checkpoints and gas

#### sui_getCheckpoint
A checkpoint by sequence number (string) or digest. Params `[id]`.
```json
{"jsonrpc":"2.0","id":1,"method":"sui_getCheckpoint","params":["1000"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"epoch":"5000","sequenceNumber":"1000","digest":"G6Dtzr1ZSfHFhotGsTE3cLENa7L1ooe1BBvknAUsARbV","networkTotalTransactions":"792385","previousDigest":"6tBy8RXZKrdrB4XkMQn7J3MNG4fQCo9XcRduFFvYrL5Z","epochRollingGasCostSummary":{"computationCost":"0","storageCost":"0","storageRebate":"0","nonRefundableStorageFee":"0"},"timestampMs":"1676911928","transactions":["mN8YNBgVR3wB7vfXmjVgDRF4oqxVRRjzmJ6U4mzbq77"],"checkpointCommitments":[],"validatorSignature":"<base64>"}}
```

#### sui_getLatestCheckpointSequenceNumber
Height of the latest executed checkpoint (use as the liveness probe). Params `[]`. Result is a decimal string.
```json
{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}
```
```json
{"jsonrpc":"2.0","id":1,"result":"507021"}
```

#### suix_getReferenceGasPrice
Network reference gas price in MIST per gas unit. Params `[]`. Schema type is a u64 string (the spec's own example shows a bare number — parse both).
```json
{"jsonrpc":"2.0","id":1,"method":"suix_getReferenceGasPrice","params":[]}
```
```json
{"jsonrpc":"2.0","id":1,"result":"1000"}
```

### Events

#### sui_getEvents
All events emitted by one transaction. Params `[transaction_digest]`. Result is an **array** of events (the spec's rendered example wraps it in a page object; the declared type is `Vec<SuiEvent>`).
```json
{"jsonrpc":"2.0","id":1,"method":"sui_getEvents","params":["11a72GCQ5hGNpWGh2QhQkkusTEGS6EDqifJqxr7nSYX"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":[{"id":{"txDigest":"11a72GCQ5hGNpWGh2QhQkkusTEGS6EDqifJqxr7nSYX","eventSeq":"0"},"packageId":"0xc54ab30a3d9adc07c1429c4d6bbecaf9457c9af77a91f631760853934d383634","transactionModule":"test_module","sender":"0xbcf7c32655009a61f1de0eae420a2e4ae1bb772ab2dd5d5a7dfa949c0ef06908","type":"0x0000000000000000000000000000000000000000000000000000000000000009::test::TestEvent","parsedJson":{"test":"example value"},"bcsEncoding":"base64","bcs":""}]}
```

#### suix_queryEvents
Events by filter, paged. Params `[query, cursor?, limit?, descending_order?]`; `query` **is** the EventFilter itself (no `filter`/`options` wrapper); cursor is `{"txDigest","eventSeq"}`. Default oldest first.
```json
{"jsonrpc":"2.0","id":1,"method":"suix_queryEvents","params":[{"MoveModule":{"package":"0xa395759ca37c6e1ffc179184e98a6f9a2da5d78f6e34b0e5044ed52a6bc0a1bc","module":"test"}},null,100,false]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"data":[{"id":{"txDigest":"FFwCMgC7FHBLEwfL9JeSeR2EhMAZMykUPVW1kE3HgTMe","eventSeq":"1"},"packageId":"0xb2fd632992b01aa25900867288b63d6255ff8223c12b0fd985c49d5777a0d65a","transactionModule":"test","sender":"0xcceee09f44d558691334ec0aff47af033f57162a2f33056e2585e2c46863ac02","type":"0x3::test::Test<0x3::test::Test>","parsedJson":"some_value","bcsEncoding":"base64","bcs":""}],"nextCursor":{"txDigest":"FFwCMgC7FHBLEwfL9JeSeR2EhMAZMykUPVW1kE3HgTMe","eventSeq":"1"},"hasNextPage":false}}
```

### Write path

You never send private keys. Build the transaction bytes **client-side** (Sui SDK, programmable transaction block → BCS), sign locally, then submit. Do not use the node-side `unsafe_*` builders: the node chooses the bytes you sign.

#### sui_dryRunTransactionBlock
Execute without committing; returns effects and gas estimate. Params `[tx_bytes]` (base64 BCS `TransactionData`, unsigned). Response has `effects`, `events`, `objectChanges`, `balanceChanges`, `input` (required) and optionally `suggestedGasPrice` / `executionErrorSource` — **no `digest`** (the spec's example reuses the execute shape).
```json
{"jsonrpc":"2.0","id":1,"method":"sui_dryRunTransactionBlock","params":["<base64 tx_bytes>"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"effects":{"messageVersion":"v1","status":{"status":"success"},"executedEpoch":"0","gasUsed":{"computationCost":"100","storageCost":"100","storageRebate":"10","nonRefundableStorageFee":"0"},"transactionDigest":"8UExPV121BEfWkbymSPDYhh23rVNh3MSWtC5juJ9JGMJ"},"events":[],"objectChanges":[{"type":"transferred","sender":"0x61fbb5b4f342a40bdbf87fe4a946b9e38d18cf8ffc7b0000b975175c7b6a9576","recipient":{"AddressOwner":"0x7ba91ddc7e717cf708c937060f04048736ec33fb1746d999a5e58cd5c677ed80"},"objectType":"0x2::example::Object","objectId":"0x4f82f1c8587b98d64c00bfb46c3843bd8bf6ccfa7c65a86138698cd1fdcac3dc","version":"2","digest":"B3xLC8EbyvTxy5pgiwTNUzHLa6kS7uwD6sZdErKB8F8f"}],"balanceChanges":[],"input":{"messageVersion":"v1","sender":"0x61fbb5b4f342a40bdbf87fe4a946b9e38d18cf8ffc7b0000b975175c7b6a9576","gasData":{"price":"10","budget":"100000"}}}}
```

#### sui_executeTransactionBlock
Submit a signed transaction. **This moves funds — only on explicit user instruction.** Params `[tx_bytes, signatures[], options?, request_type?]`; each signature is base64 of `flag || sig || pubkey`. `request_type`: `WaitForEffectsCert` (default unless options ask for effects/events; a finality proxy) or `WaitForLocalExecution` (this node has executed it before returning — use before follow-up reads; the response sets `confirmedLocalExecution:false` if it timed out).
```json
{"jsonrpc":"2.0","id":1,"method":"sui_executeTransactionBlock","params":["<base64 tx_bytes>",["<base64 flag||sig||pubkey>"],{"showEffects":true,"showBalanceChanges":true},"WaitForLocalExecution"]}
```
```json
{"jsonrpc":"2.0","id":1,"result":{"digest":"Gx7V6EteEAqSsptc1kbi1nUEMP7mhr4qV2cYS7JjzbBd","effects":{"messageVersion":"v1","status":{"status":"success"},"executedEpoch":"0","gasUsed":{"computationCost":"100","storageCost":"100","storageRebate":"10","nonRefundableStorageFee":"0"},"transactionDigest":"9agZ3azEMgMqxrDVG8P4GddELfWag2HhimEkpjixHhGE"},"balanceChanges":[],"confirmedLocalExecution":true}}
```
Always confirm `effects.status.status == "success"`; a returned digest alone does not mean it succeeded.

## 5 · Filters

**Object filter** (`suix_getOwnedObjects` → `query.filter`; combinable): `{"MatchAll":[f,…]}` · `{"MatchAny":[f,…]}` · `{"MatchNone":[f,…]}` · `{"Package":"0x…"}` · `{"MoveModule":{"package":"0x…","module":"name"}}` · `{"StructType":"0x2::coin::Coin<0x2::sui::SUI>"}` · `{"AddressOwner":"0x…"}` · `{"ObjectOwner":"0x…"}` · `{"ObjectId":"0x…"}` · `{"ObjectIds":["0x…"]}` · `{"Version":"123"}`.

**Transaction filter** (`suix_queryTransactionBlocks` → `query.filter`): `{"MoveFunction":{"package":"0x…","module":"m"?,"function":"f"?}}` · `{"InputObject":"0x…"}` · `{"ChangedObject":"0x…"}` (created/mutated/unwrapped) · `{"AffectedObject":"0x…"}` · `{"FromAddress":"0x…"}` · `{"ToAddress":"0x…"}` · `{"FromAndToAddress":{"from":"0x…","to":"0x…"}}` · `{"TransactionKind":"ProgrammableTransaction"}` · `{"TransactionKindIn":["…"]}`. **Not supported by the server:** `Checkpoint` and `FromOrToAddress` (marked "CURRENTLY NOT SUPPORTED" in the spec).

**Event filter** (`suix_queryEvents` `query`): `{"All":[]}` · `{"Sender":"0x…"}` · `{"Transaction":"<digest>"}` · `{"MoveModule":{"package":"0x…","module":"m"}}` (module that *emitted*) · `{"MoveEventType":"0xpkg::mod::Event"}` · `{"MoveEventModule":{"package":"0x…","module":"m"}}` (module that *defines* the event type) · `{"TimeRange":{"startTime":"<ms>","endTime":"<ms>"}}` (ms since epoch; start inclusive, end exclusive). `Any` exists but is subscription-only.

## 6 · Replacement: GraphQL and gRPC

Mapping from Sui's official migration guide (names are the new API's):

| JSON-RPC (this file) | gRPC (`sui.rpc.v2.*`) | GraphQL |
|---|---|---|
| `sui_getObject` | `LedgerService.GetObject` | `Query.object` |
| `sui_multiGetObjects` | `LedgerService.BatchGetObjects` | `Query.multiGetObjects` |
| `suix_getOwnedObjects` | `StateService.ListOwnedObjects` | `Address.objects` |
| `suix_getBalance` / `suix_getAllBalances` | `StateService.GetBalance` / `ListBalances` | `Address.balance` / `Address.balances` |
| `suix_getCoins` / `suix_getAllCoins` | `StateService.ListOwnedObjects` with type filter `0x2::coin::Coin<T>` (or bare `0x2::coin::Coin` for all) | `Address.objects` with `filter:{type:"0x2::coin::Coin<T>"}` |
| `sui_getTransactionBlock` | `LedgerService.GetTransaction` | `Query.transaction` |
| `sui_multiGetTransactionBlocks` | `LedgerService.BatchGetTransactions` | `Query.multiGetTransactions` |
| `suix_queryTransactionBlocks` | `LedgerService.ListTransactions` (+ `TransactionFilter`) | `Query.transactions` |
| `sui_getCheckpoint`, `sui_getLatestCheckpointSequenceNumber` | `LedgerService.GetCheckpoint` | `Query.checkpoint` |
| `suix_getReferenceGasPrice` | `LedgerService.GetEpoch` (`reference_gas_price`) | `Epoch.referenceGasPrice` |
| `sui_getEvents` / `suix_queryEvents` | `LedgerService.GetTransaction` with `events` in the field mask / `LedgerService.ListEvents` | `Query.events` (+ `EventFilter`) |
| `sui_executeTransactionBlock` | `TransactionExecutionService.ExecuteTransaction` | `Mutation.executeTransaction` |
| `sui_dryRunTransactionBlock` | `TransactionExecutionService.SimulateTransaction` | `Query.simulateTransaction` |

**GraphQL examples — verified live 2026-10-24** against `https://graphql.mainnet.sui.io/graphql` (swap in the provider GraphQL URL from §2 for BYOK). Body is `{"query": "...", "variables": {...}}`, POST, `Content-Type: application/json`:

```json
{"query":"{ checkpoint { sequenceNumber digest timestamp networkTotalTransactions } }"}
```
```json
{"data":{"checkpoint":{"sequenceNumber":337729853,"digest":"6Tyy1zYzMiEA7cX4CMKa4t44dV8uJ1GhDEWVUKLhYnnV","timestamp":"2026-10-24T21:38:34.526Z","networkTotalTransactions":6335926336}}}
```
```json
{"query":"{ epoch { epochId referenceGasPrice } }"}
```
```json
{"data":{"epoch":{"epochId":1290,"referenceGasPrice":"100"}}}
```
```json
{"query":"query($a: SuiAddress!) { address(address: $a) { balance(coinType: \"0x2::sui::SUI\") { totalBalance } } }","variables":{"a":"0x0000000000000000000000000000000000000000000000000000000000000005"}}
```
```json
{"data":{"address":{"balance":{"totalBalance":"31018584912"}}}}
```
```json
{"query":"query($a: SuiAddress!) { address(address: $a) { balances(first: 3) { nodes { coinType { repr } totalBalance } } objects(first: 2) { nodes { address version } } } }","variables":{"a":"0x0000000000000000000000000000000000000000000000000000000000000005"}}
```
```json
{"data":{"address":{"balances":{"nodes":[{"coinType":{"repr":"0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"},"totalBalance":"31018584912"},{"coinType":{"repr":"0x1c1c1214dfae7b32e90ca59ec6e29cf8e60f41401a126d982d7e79e26c879616::coin::COIN"},"totalBalance":"1000000000"}]},"objects":{"nodes":[{"address":"0x00d1b1fec2184694db096570e90668f0c4abfb1ff341b5917fe7dbc069b13f36","version":317307782}]}}}}
```
```json
{"query":"{ object(address: \"0x0000000000000000000000000000000000000000000000000000000000000006\") { address version digest } }"}
```
```json
{"data":{"object":{"address":"0x0000000000000000000000000000000000000000000000000000000000000006","version":1004272894,"digest":"EreiZsW4kJC1x4nYHynxm76Z8jQtU7g9zQMa2XtxJyWA"}}}
```
(Object `0x6` is the Clock — its version/digest change every checkpoint. The two-field query above returns `balances` and `objects` in one request; both lists were cut to fit.)
```json
{"query":"{ transaction(digest: \"HKt3ecfMErihwFXWn5EnDKijVfK4pfG85aByQWxNJMjY\") { digest effects { status epoch { epochId } } } }"}
```
```json
{"data":{"transaction":{"digest":"HKt3ecfMErihwFXWn5EnDKijVfK4pfG85aByQWxNJMjY","effects":{"status":"SUCCESS","epoch":{"epochId":1290}}}}}
```
GraphQL differences (seen in the replies above): coin types come back in long form; balances (`totalBalance`) stay decimal strings, but `sequenceNumber`, object `version` and `epochId` are JSON **numbers** (JSON-RPC returns them as strings); lists are Relay-style `{nodes, pageInfo}` with `first/after` cursors (default page 50, multi-get up to 200 per Ankr); `Query.transactions` / `Query.events` take filters — check the schema before use (a quick `transactions(filter:{sentAddress:…})` test returned an empty list, so do not assume the filter field names). Writes are `Mutation.executeTransaction`.

**gRPC example** (from Ankr's docs, not run here): `grpcurl -H "x-token: $KEY" -d '{"sequence_number":"214225619"}' sui.grpc.ankr.com:443 sui.rpc.v2.LedgerService.GetCheckpoint`. gRPC retention follows each node's pruning window; deep history needs the archive host (§2). gRPC streaming (`SubscriptionService`) replaces the old WebSocket subscriptions.

## 7 · Gotchas

- **JSON-RPC may simply be gone** (§0). Probe once, then switch; never loop on `-32601`.
- Wrong chain slug/host or invalid key → provider returns 401/404/HTML, not JSON (Ankr: bare nginx 404 for a bad key).
- **Strings, not numbers:** u64 values (`version`, `epoch`, `totalBalance`, `timestampMs`, `sequenceNumber`) are decimal strings; a few legacy fields (e.g. `coinObjectCount`, `gasData.payment[].version`) are JSON numbers. Parse both; use big ints.
- **MIST ≠ SUI:** divide by 1e9. Gas = computationCost + storageCost − storageRebate.
- Default ordering of `query*` is **oldest first**; for "latest N" set `descending_order:true`.
- `limit` > 50 is silently clamped on stock nodes; `sui_multiGet*` with >50 ids errors, and `sui_multiGetTransactionBlocks` also rejects duplicate digests.
- Data is pruned on full nodes; old objects/transactions may be absent (use archive endpoints on gRPC/GraphQL).
- Object responses report absence inside `result.error`, not as a JSON-RPC error.
- Coin type strings differ in form between APIs (`0x2::sui::SUI` vs `0x000…02::sui::SUI`); normalize.
- Sui is object-based: there is no account balance method that returns "everything" — use `suix_getAllBalances` for fungible coins and `suix_getOwnedObjects` for the rest.
- Never place private keys or seed phrases in any request; signing is always local.

Sources: docs.sui.io (`/sui-api-ref` deprecation banner, `/develop/accessing-data/json-rpc-migration`, `/concepts/grpc-overview`); Mysten OpenRPC spec at tag `testnet-v1.75.1`; `crates/sui-json-rpc-api/src/lib.rs` (page limits); Ankr / Alchemy / BlockPI Sui docs; live probes on 2026-10-24.
