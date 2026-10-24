# EVM JSON-RPC — shared method reference

One reference for **every EVM chain on every BYOK provider** (Ankr · Alchemy · BlockPI). Request and response bodies are identical everywhere; only the endpoint URL — and which methods, block ranges and history depth your plan allows — differs.

- Endpoint, key, chain slugs: [ankr.md](ankr.md) · [alchemy.md](alchemy.md) · [blockpi.md](blockpi.md). Vault/auth + short primer: [index.yaml](index.yaml).
- Calls go straight to the provider with the user's own key (not Clawby relay; no Clawby credits) and count against **their** provider quota.
- Basis: Ethereum `execution-apis` spec (`src/eth`, `src/debug`, `src/error-groups`) + the ethereum.org "JSON-RPC API" docs, cross-checked and probed live against a public mainnet node on 2026-10-25. **[ext]** marks a client/provider extension outside the core spec.
- Examples are Ethereum mainnet (USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, holder `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`); live values change. If you built the URL from a chain slug, call `eth_chainId` first to confirm the chain.
- Long by design: read §1 once, then jump to the method you need (search `### <method>`); §13 has ready-made recipes and §14 the pitfalls.

## Index

| Group | Methods |
|---|---|
| §2 Chain / node | `eth_chainId` `net_version` `net_listening` `net_peerCount` `web3_clientVersion` `web3_sha3` `eth_syncing` `eth_protocolVersion` |
| §3 Blocks | `eth_blockNumber` `eth_getBlockByNumber` `eth_getBlockByHash` `eth_getBlockTransactionCountByNumber` `eth_getBlockTransactionCountByHash` `eth_getBlockReceipts` |
| §4 Accounts / state | `eth_getBalance` `eth_getCode` `eth_getStorageAt` `eth_getTransactionCount` `eth_getProof` |
| §5 Transactions | `eth_getTransactionByHash` `eth_getTransactionByBlockNumberAndIndex` `eth_getTransactionByBlockHashAndIndex` `eth_getTransactionReceipt` `eth_sendRawTransaction` (**write**) |
| §6 Call / estimate | `eth_call` `eth_estimateGas` `eth_createAccessList` |
| §7 Gas / fees | `eth_gasPrice` `eth_maxPriorityFeePerGas` `eth_feeHistory` `eth_blobBaseFee` |
| §8 Logs / filters | `eth_getLogs` `eth_newFilter` `eth_newBlockFilter` `eth_newPendingTransactionFilter` `eth_getFilterChanges` `eth_getFilterLogs` `eth_uninstallFilter` |
| §9 Subscriptions (WSS) | `eth_subscribe` `eth_unsubscribe` |
| §10 Newer spec methods | `eth_getHeaderByNumber` `eth_getHeaderByHash` `eth_simulateV1` `eth_getStorageValues` `eth_baseFee` `eth_config` `eth_capabilities` `eth_getBlockAccessList` `eth_fillTransaction` |
| §11 Legacy / node-local | `eth_accounts` `eth_coinbase` `eth_mining` `eth_hashrate` `eth_sign` `eth_signTransaction` `eth_sendTransaction` `eth_getUncleCountByBlockHash` `eth_getUncleCountByBlockNumber` `eth_getUncleByBlockHashAndIndex` `eth_getUncleByBlockNumberAndIndex` `txpool_status` `txpool_content` `txpool_contentFrom` |
| §12 debug / trace (non-standard) | `debug_traceTransaction` `debug_traceCall` `debug_traceBlockByNumber` `debug_traceBlockByHash` `trace_block` `trace_transaction` `trace_get` `trace_filter` `trace_call` `trace_replayTransaction` `trace_replayBlockTransactions` `trace_rawTransaction` |

Intent → method:

| I want… | Use |
|---|---|
| which chain am I on / is it alive | `eth_chainId`, `eth_blockNumber` |
| native-coin balance | `eth_getBalance` |
| token balance / any contract view function | `eth_call` (§13 P3) |
| is this address a contract / proxy target | `eth_getCode`, `eth_getStorageAt` (§13 P8) |
| did my tx land / succeed | `eth_getTransactionReceipt` (§13 P9) |
| events / transfers / swaps | `eth_getLogs` (§8, §13 P5) |
| what fee to pay | `eth_feeHistory` + `eth_maxPriorityFeePerGas` (§13 P7) |
| broadcast a signed tx | `eth_sendRawTransaction` (**write**, irreversible) |
| live new blocks / events | `eth_subscribe` over `wss://` (§9) |

---

## 1. Protocol basics

### 1.1 Envelope

POST the JSON body with header `Content-Type: application/json`.

```bash
curl -s -X POST "$RPC_URL" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```
`$RPC_URL` is the full provider endpoint from the provider guide. **It contains the key — treat it as a secret** (never print or log it).

| Field | Rule |
|---|---|
| `jsonrpc` | always `"2.0"` |
| `method` | method name, case-sensitive |
| `params` | **positional array** (`[]` when none). Named/object params are not supported |
| `id` | number or string, echoed back. A request without `id` is a notification and gets no response |

```jsonc
// success
{"jsonrpc":"2.0","id":1,"result":"0x190c67f"}
// error — HTTP status is normally still 200
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params","data":"odd number of digits at line 1 column 5"}}
```
- `result: null` is **not** an error — it means "no such tx / receipt / block".
- `error.data` is optional extra detail (for reverts it holds the raw revert bytes).

### 1.2 Batch

Send an array of requests, get an array of responses. Each element succeeds or fails independently.

```jsonc
// request
[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
 {"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]},
 {"jsonrpc":"2.0","id":3,"method":"eth_nope","params":[]}]
// response
[{"jsonrpc":"2.0","id":1,"result":"0x1"},
 {"jsonrpc":"2.0","id":2,"result":"0x190c683"},
 {"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}]
```
- Responses normally arrive in request order, but JSON-RPC does not guarantee it — **match by `id`** and keep ids unique.
- Batch size is capped per provider/plan (see §14) and each element is billed on its own. An oversized batch is rejected as a whole (e.g. `-32600`, HTTP 413/429) with a single error object instead of an array.
- Don't mix cheap calls with heavy ones (`eth_getLogs`, traces, hydrated blocks): the slowest element delays the whole response. WebSocket batch limits are usually lower than HTTP.

### 1.3 Errors

`{"code": <int>, "message": "<string>", "data": <optional>}`

| Code | Name | Typical cause → action |
|---|---|---|
| -32700 | Parse error | body is not valid JSON → fix payload |
| -32600 | Invalid request | missing/invalid `jsonrpc`/`method`/`id`; empty or oversized batch → fix / split |
| -32601 | Method not found | method not offered by this chain/provider/plan, or typo (geth words it `the method X does not exist/is not available`) → don't retry; use an alternative |
| -32602 | Invalid params | wrong arity/type, missing `0x`, odd-length hex, decimal where hex is required, bad block tag; some providers also use it for "block range too large" or "block range extends beyond current head block" |
| -32603 | Internal error | node/provider fault → retry with backoff |
| -32000 | Server error (generic) | catch-all node error. Read `message`: `execution reverted`, `nonce too low`, `insufficient funds for gas * price + value`, `already known`, `replacement transaction underpriced`, `header not found`, `missing trie node`, `filter not found`, `query timeout exceeded`, … |
| -32001 | Resource not found | EIP-1474 |
| -32002 | Resource unavailable | EIP-1474 |
| -32003 | Transaction rejected | EIP-1474 |
| -32004 | Method not supported | EIP-1474 |
| -32005 | Limit exceeded | rate limit, or too many results / too wide a range (`query returned more than 10000 results`) → shrink the request, back off |
| -32006 | JSON-RPC version not supported | EIP-1474 |
| 3 | Execution reverted | `eth_call` / `eth_estimateGas` on geth-family and reth; other clients use `-32000` with the same message. `data` = raw revert bytes |
| 4444 | Pruned history unavailable | EIP-4444: the node dropped old block/tx/receipt/log data (try another node or an archive plan) |

Revert data: `0x08c379a0` + ABI string = `Error(string)` (the readable reason); `0x4e487b71` + uint256 = `Panic(uint256)`.

HTTP layer: JSON-RPC errors come back as HTTP 200, but providers also return **401/403** (bad key, IP not allowed, network not enabled for the key), **404** (wrong slug/path), **413** (body too large), **429** (rate limit / quota), **5xx** (outage), often with a non-JSON body. Check the HTTP status before JSON-decoding.

Providers add their own codes in the implementation-defined range — e.g. Ankr `-32062` "Block range is too large" and `-32052` "API key is not allowed to access blockchain" (chain not enabled for the key); BlockPI reports gateway limits as HTTP 503 with an `error` object. Always read `message`.

Retry guidance: retry `-32603`, `-32005`, 429, 5xx with exponential backoff + jitter (honour a `Retry-After` header if present); never retry `-32600/-32601/-32602`, reverts, or auth errors.

### 1.4 Encoding

- **QUANTITY** (integers: wei, gas, nonces, block numbers, timestamps, chain IDs): `0x` + minimal lowercase hex, **no leading zeros**, zero is `0x0`. Valid: `0x0`, `0x41` (65), `0x400` (1024). Invalid: `0x`, `0x0400`, `ff`, decimal. Strict clients reject the invalid forms with `-32602`.
- **DATA** (addresses, hashes, calldata, bytecode, topics): `0x` + two hex digits per byte (even length); `0x` = empty. Address = 20 bytes (40 hex), hash/topic/storage word = 32 bytes (64 hex), function selector = 4 bytes. Input is case-insensitive (EIP-55 mixed case accepted); lowercase is always safe.
- Convert: Python `int(x, 16)` / `hex(n)`; JS `BigInt(x)` / `"0x" + n.toString(16)`. **Wei and token amounts exceed 2^53 — use big integers**, never floats.
- Useful constants: 1 gwei = `0x3b9aca00`, 1 ether = `0xde0b6b3a7640000`, plain transfer gas = `0x5208` (21000).
- Not hex: `net_version` (decimal string), `eth_feeHistory.gasUsedRatio` / `blobGasUsedRatio` (JSON floats), `rewardPercentiles` (JSON numbers), booleans, and several trace outputs (plain JSON integers for `pc`, `gas`, `blockNumber`).
- Types used below: `ADDRESS` = DATA(20), `HASH` = DATA(32), `BLOCK` = §1.5, `?` suffix = optional param.

### 1.5 Block parameter

State/call methods and many others take a `BLOCK` argument:

| Value | Meaning |
|---|---|
| `"latest"` | newest block the node has — can still be re-orged |
| `"safe"` | newest block safe from re-org under honest-majority assumptions |
| `"finalized"` | newest finalized block (cannot be re-orged absent a social-consensus event) |
| `"earliest"` | genesis / the oldest block the node serves |
| `"pending"` | the node's speculative next block (mempool txs applied); semantics differ per client. `eth_getTransactionCount(addr, "pending")` is the standard way to get the next nonce |
| `"0x<n>"` | exact height (QUANTITY) |
| `{"blockNumber":"0x<n>"}` or `{"blockHash":"0x…","requireCanonical":true}` | EIP-1898 forms, accepted by `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_getProof`, `eth_call`, `eth_estimateGas`, `eth_createAccessList`, `eth_getBlockReceipts`. Pin reads to an exact historical block. The spec also lets a bare 32-byte block hash string stand in; the object form is the portable one |

- `safe` and `finalized` deliberately trail the head: on Ethereum mainnet a live check (2026-10-25) gave `safe` ≈ head − 47 and `finalized` ≈ head − 79 blocks (≈ 9 and 16 minutes). They are not supported on every chain (some L2s/sidechains error, return `null`, or alias to `latest`), and neither is `pending`.
- Where the block argument is optional the default is `"latest"`. The spec marks it optional and current clients accept omission, but older geth versions and some providers answer `-32602 … missing value for required argument` — **always send it explicitly**.
- Unknown / future block → `null` (blocks) or an error (state methods, `eth_getLogs`).

### 1.6 Minimal client

```bash
rpc() { curl -s -X POST "$RPC_URL" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"; }
rpc eth_blockNumber
rpc eth_getBalance '["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","latest"]'
```

```python
import json, os, urllib.request

class RpcError(Exception):
    def __init__(self, e):
        super().__init__(e.get("message", "")); self.code = e.get("code"); self.data = e.get("data")

def rpc(method, params=None, url=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    req = urllib.request.Request(url or os.environ["RPC_URL"], body,
                                 {"Content-Type": "application/json", "User-Agent": "clawby-agent/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:     # HTTPError (401/403/429/5xx) raises here
        j = json.load(r)
    if "error" in j:
        raise RpcError(j["error"])
    return j["result"]

print(int(rpc("eth_blockNumber"), 16))
```
`urllib` exceptions don't echo the URL. Libraries such as `requests` put the request path (= your key) into connection-error text — don't print those verbatim. Always send a custom `User-Agent`: some edges (e.g. BlockPI's) answer Python's default `urllib` UA with `403 error code: 1010`.

---

## 2. Chain / node

### eth_chainId
EIP-155 chain ID of the endpoint — use it to confirm you are on the intended chain.
**Params:** none · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x1"}
```
Common IDs: Ethereum `0x1` · BSC `0x38` · Polygon `0x89` · Arbitrum One `0xa4b1` · OP Mainnet `0xa` · Base `0x2105` · Avalanche C `0xa86a` · Gnosis `0x64` · zkSync Era `0x144` · Linea `0xe708` · Scroll `0x82750` · Sepolia `0xaa36a7`.

### net_version
Legacy network ID as a **decimal string** (not hex). Usually equals the chain ID but may differ on legacy/special networks — prefer `eth_chainId`.
**Params:** none · **Returns:** string

```jsonc
// request
{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"1"}
```

### net_listening
Whether the node accepts inbound P2P connections. Mostly meaningless on hosted RPC.
**Params:** none · **Returns:** boolean

```jsonc
// request
{"jsonrpc":"2.0","method":"net_listening","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":true}
```

### net_peerCount
Number of P2P peers of the backing node. Not meaningful behind a load balancer.
**Params:** none · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x2c"}
```

### web3_clientVersion
Client name/version string of the backing node (some providers hide or normalise it).
**Params:** none · **Returns:** string

```jsonc
// request
{"jsonrpc":"2.0","method":"web3_clientVersion","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"reth/v2.8.0-05ba481/x86_64-unknown-linux-gnu"}   // geth style: "Geth/v1.12.1-stable/linux-amd64/go1.19.1"
```

### web3_sha3
Keccak-256 (not NIST SHA3-256) of the given bytes. Often disabled on hosted RPC — compute locally.
**Params:** `[data]` — DATA · **Returns:** HASH

```jsonc
// request
{"jsonrpc":"2.0","method":"web3_sha3","params":["0x68656c6c6f20776f726c64"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad"}
```

### eth_syncing
Sync status of the backing node: `false` when fully synced, otherwise a progress object. If it isn't `false`, data may be stale — try another endpoint.
**Params:** none · **Returns:** `false`, or `{startingBlock, currentBlock, highestBlock}` (QUANTITYs; clients may add fields)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_syncing","params":[],"id":1}
// response — synced
{"jsonrpc":"2.0","id":1,"result":false}
// response — still syncing
{"jsonrpc":"2.0","id":1,"result":{"startingBlock":"0x384","currentBlock":"0x386","highestBlock":"0x454"}}
```

### eth_protocolVersion
Legacy eth wire-protocol version. Removed/unsupported on many clients and encoded differently across them (docs show `"54"`, reth answered `"0x5"`) — don't parse it.
**Params:** none · **Returns:** string

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_protocolVersion","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x5"}
```

---

## 3. Blocks

### eth_blockNumber
Height of the newest block the node knows. Load-balanced providers can lag a block or two between calls (see §14).
**Params:** none · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x190c67f"}      // 26265215
```

### eth_getBlockByNumber
Block header fields + transactions, by height or tag.
**Params:** `[block, fullTx]` — `block`: QUANTITY or tag (`latest` `safe` `finalized` `earliest` `pending`; no EIP-1898 object here); `fullTx` boolean, **required**: `false` → tx hashes only, `true` → full transaction objects (§5; hundreds of KB for a busy block).
**Returns:** block object, or `null` if unknown/pruned.

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}
// response (trimmed; fork-dependent fields are present only on chains/blocks that have them)
{"jsonrpc":"2.0","id":1,"result":{
  "number":"0x190c67f",
  "hash":"0x01b9d2f0c2ef417ce1008b511c39ffc7f041d994aaee688f1c21efd20ce1f7bc",
  "parentHash":"0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32",
  "timestamp":"0x6add2393",                 // unix seconds (1792877459 = 2026-10-24T21:30:59Z)
  "miner":"0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97",   // fee recipient
  "gasLimit":"0x3938700", "gasUsed":"0x1598192",
  "baseFeePerGas":"0x2dd0773",              // London+
  "transactions":["0x709a374c0bfda6e266427291981c55fb18e85884a655a7cf0e493a9953f3271b","0xb7408f2d4101bfd068c0620765e5e3a82a30f5e2c9c9a9bebb1d3a0435af390d"],   // 215 hashes in the live block; objects when fullTx=true
  "transactionsRoot":"0x33a817582f8af52459e55184d3b44f044aa772be630ed484d76acadeba97e936",
  "stateRoot":"0x6e205694afdcb6d1123bdefd8e8e3694004bdd9953e7882934f2bc41b064ff19",
  "receiptsRoot":"0xdbbcb580022ac2a5eed216ad70d43e9a128ee65f0929922310a15a135a27ec2d",
  "logsBloom":"0x51b2f6eb…",                // 256 bytes
  "sha3Uncles":"0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", "uncles":[],
  "difficulty":"0x0", "nonce":"0x0000000000000000",       // both constant after the Merge
  "mixHash":"0x6a89afa2212871baba05ea8d3530a644854ab20d78f3d435e9ececdf3632df4b",   // = prevRandao after the Merge
  "extraData":"0x546974616e2028746974616e6275696c6465722e78797a29", "size":"0x209f9",
  "withdrawalsRoot":"0x70d56952f5be8367a2e9ea50d710b98a1b00645842f6855b25aa99c52fe4a99e",   // Shanghai+
  "withdrawals":[{"index":"0x8cd7adb","validatorIndex":"0x1d0c11","address":"0x8e609ac80f4324e499a6efd24f221a2caa868224","amount":"0xc72312"}],
  "blobGasUsed":"0x20000", "excessBlobGas":"0xa4d42cc",   // Cancun+
  "parentBeaconBlockRoot":"0x863c722c2b8d7e9d288dba0ae64263610ace73731b5d314d25283e2a5e7c8daf",   // Cancun+
  "requestsHash":"0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"   // Prague+
}}
```
L2s/sidechains add chain-specific fields (e.g. OP Stack deposit txs of type `0x7e`, L1 info) — ignore unknown fields. `"pending"` support and which fields are `null` vary by client.

### eth_getBlockByHash
Same as above, addressed by block hash (immune to re-orgs: you get that exact block or `null`).
**Params:** `[blockHash, fullTx]` — HASH, boolean (required) · **Returns:** block object or `null`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getBlockByHash","params":["0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32",false],"id":1}
// response — same object shape as eth_getBlockByNumber
{"jsonrpc":"2.0","id":1,"result":{"number":"0x190c67e","hash":"0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32", "…":"…"}}
```

### eth_getBlockTransactionCountByNumber
Number of transactions in a block, without fetching it.
**Params:** `[block]` — QUANTITY or tag · **Returns:** QUANTITY, or `null` if unknown

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getBlockTransactionCountByNumber","params":["0x190c67e"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x124"}      // 292
```

### eth_getBlockTransactionCountByHash
**Params:** `[blockHash]` — HASH · **Returns:** QUANTITY, or `null` if unknown

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getBlockTransactionCountByHash","params":["0x01b9d2f0c2ef417ce1008b511c39ffc7f041d994aaee688f1c21efd20ce1f7bc"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0xd7"}       // 215
```

### eth_getBlockReceipts
All receipts (and therefore all logs) of one block in one call — far cheaper than N × `eth_getTransactionReceipt`. Heavy: hundreds of KB to MBs on busy blocks; not supported by every older client/provider (`-32601`).
**Params:** `[block]` — QUANTITY, tag, block hash, or EIP-1898 object · **Returns:** array of receipt objects (§5), or `null`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getBlockReceipts","params":["0x190c67e"],"id":1}
// response (292 receipts in this block; first one trimmed)
{"jsonrpc":"2.0","id":1,"result":[
  {"transactionHash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa","transactionIndex":"0x0",
   "blockHash":"0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32","blockNumber":"0x190c67e",
   "type":"0x2","status":"0x1","cumulativeGasUsed":"0x3de66","gasUsed":"0x3de66","effectiveGasPrice":"0x2f52ab7",
   "from":"0x5875db54cd9ae2b2a875e09bb731772297ae9d92","to":"0x0000000aa232009084bd71a5797d089aa4edfad4","contractAddress":null,
   "logs":[{"…":"…"}], "logsBloom":"0x…"},
  {"…":"…"}
]}
```

---

## 4. Accounts / state

All state methods read state **after** the given block executed. Old blocks need archive/state history (§14).

### eth_getBalance
Native-coin balance of an address, in wei.
**Params:** `[address, block?]` — ADDRESS, BLOCK (default `"latest"`) · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","latest"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x501f9796d1954301"}     // 5773499921329373953 wei = 5.7735 ETH (divide by 1e18)
```

### eth_getCode
Deployed runtime bytecode at an address.
**Params:** `[address, block?]` — ADDRESS, BLOCK (default `"latest"`) · **Returns:** DATA

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getCode","params":["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","latest"],"id":1}
// response — a contract (USDC proxy; 2186 bytes, trimmed)
{"jsonrpc":"2.0","id":1,"result":"0x60806040526004361061006d576000357c0100…"}
// response — empty account / plain EOA
{"jsonrpc":"2.0","id":1,"result":"0x"}
// response — EOA that delegated via EIP-7702 (Pectra): 0xef0100 + 20-byte delegate address; still an EOA
{"jsonrpc":"2.0","id":1,"result":"0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d"}
```
So `code != "0x"` does **not** prove "is a contract" any more — check for the `0xef0100` prefix (§13 P8).

### eth_getStorageAt
One 32-byte storage word of a contract.
**Params:** `[address, slot, block?]` — ADDRESS, slot as DATA/QUANTITY (≤32 bytes; `0x0` or zero-padded 32-byte form both work), BLOCK (default `"latest"`) · **Returns:** DATA (32 bytes, left-padded)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getStorageAt","params":["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","0x0","latest"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x000000000000000000000000fcb19e6a322b27c06842a71e8c725399f049ae3a"}
```
Slot math: value types sit at their declaration slot; `mapping[key]` lives at `keccak256(pad32(key) ++ pad32(mappingSlot))`; dynamic arrays at `keccak256(pad32(slot)) + index`. Proxy slots: §13 P8.

### eth_getTransactionCount
Account nonce — the number of txs the account has sent (post-EIP-7702 this is no longer strictly "sent txs"). Use `"pending"` for the next nonce to sign with; `"latest"` for the confirmed one.
**Params:** `[address, block?]` — ADDRESS, BLOCK (default `"latest"`) · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getTransactionCount","params":["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","pending"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x1751"}      // 5969
```

### eth_getProof
Merkle proof (EIP-1186) of an account and optionally some of its storage slots, against the block's state root. Needs state history; may be disabled or limited on some providers/plans.
**Params:** `[address, storageKeys, block?]` — ADDRESS, array of DATA (≤32 bytes; `[]` for none), BLOCK (send it explicitly) · **Returns:** account-proof object

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getProof","params":["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",["0x0"],"latest"],"id":1}
// response (trimmed)
{"jsonrpc":"2.0","id":1,"result":{
  "address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "balance":"0x0", "nonce":"0x1",
  "codeHash":"0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505",
  "storageHash":"0xe694299d5cfe3ae67c8b823b602c034c4a11c2f2da8330879f46f009ae23a235",
  "accountProof":["0xf90211a0…", "…"],                       // RLP trie nodes, root → leaf
  "storageProof":[{"key":"0x0","value":"0xfcb19e6a322b27c06842a71e8c725399f049ae3a","proof":["0xf90211a0…", "…"]}]
}}
```

---

## 5. Transactions

### eth_getTransactionByHash
A transaction by hash — mined or pending. `null` if the node doesn't know it (never seen, dropped, or pruned).
**Params:** `[txHash]` — HASH · **Returns:** transaction object, or `null`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getTransactionByHash","params":["0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa"],"id":1}
// response (EIP-1559 tx, input trimmed)
{"jsonrpc":"2.0","id":1,"result":{
  "hash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa",
  "blockHash":"0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32",   // null while pending
  "blockNumber":"0x190c67e", "transactionIndex":"0x0",                                // null while pending
  "blockTimestamp":"0x6add2387",                                                      // newer clients only
  "from":"0x5875db54cd9ae2b2a875e09bb731772297ae9d92",
  "to":"0x0000000aa232009084bd71a5797d089aa4edfad4",                                  // null = contract creation
  "nonce":"0x2b0b2", "value":"0x0", "gas":"0x70f9b",
  "input":"0x09c5eabe0000…",                                                          // calldata (older clients may name it "data")
  "type":"0x2", "chainId":"0x1",
  "maxFeePerGas":"0x5cc9132", "maxPriorityFeePerGas":"0x0",
  "gasPrice":"0x2f52ab7",        // type-2: the effective price once mined; the receipt's effectiveGasPrice is canonical
  "accessList":[],
  "yParity":"0x1", "v":"0x1", "r":"0x9873a722…", "s":"0x2799d50b…"
}}
```
Type-specific fields: `0x0` legacy (`gasPrice`, `v/r/s`) · `0x1` (+`accessList`, `chainId`) · `0x2` (+`maxFeePerGas`, `maxPriorityFeePerGas`) · `0x3` blob (+`maxFeePerBlobGas`, `blobVersionedHashes`) · `0x4` EIP-7702 (+`authorizationList`).

### eth_getTransactionByBlockNumberAndIndex
**Params:** `[block, index]` — QUANTITY or tag, QUANTITY (0-based position in the block) · **Returns:** transaction object (as above) or `null`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getTransactionByBlockNumberAndIndex","params":["0x190c67e","0x0"],"id":1}
// response — same object as eth_getTransactionByHash
{"jsonrpc":"2.0","id":1,"result":{"hash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa","transactionIndex":"0x0","…":"…"}}
```

### eth_getTransactionByBlockHashAndIndex
**Params:** `[blockHash, index]` — HASH, QUANTITY · **Returns:** transaction object or `null`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getTransactionByBlockHashAndIndex","params":["0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32","0x0"],"id":1}
// response — same object as eth_getTransactionByHash
{"jsonrpc":"2.0","id":1,"result":{"hash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa","transactionIndex":"0x0","…":"…"}}
```

### eth_getTransactionReceipt
Outcome of a mined transaction: success flag, gas, logs. `null` while pending or unknown.
**Params:** `[txHash]` — HASH · **Returns:** receipt object, or `null`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa"],"id":1}
// response (trimmed; this tx emitted 11 logs, one shown)
{"jsonrpc":"2.0","id":1,"result":{
  "transactionHash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa", "transactionIndex":"0x0",
  "blockHash":"0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32", "blockNumber":"0x190c67e",
  "from":"0x5875db54cd9ae2b2a875e09bb731772297ae9d92", "to":"0x0000000aa232009084bd71a5797d089aa4edfad4",
  "contractAddress":null,                    // set for contract-creation txs
  "type":"0x2", "status":"0x1",              // 0x1 success, 0x0 reverted (post-Byzantium)
  "gasUsed":"0x3de66", "cumulativeGasUsed":"0x3de66", "effectiveGasPrice":"0x2f52ab7",   // fee paid = gasUsed × effectiveGasPrice (+ L1 data fee on L2s)
  "logs":[{
    "address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
              "0x000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90",
              "0x0000000000000000000000000000000aa232009084bd71a5797d089aa4edfad4"],
    "data":"0x00000000000000000000000000000000000000000000000000000000013240e5",
    "blockNumber":"0x190c67e", "blockHash":"0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32",
    "blockTimestamp":"0x6add2387", "transactionHash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa",
    "transactionIndex":"0x0", "logIndex":"0x0", "removed":false }],
  "logsBloom":"0x0000…",
  "blobGasUsed":"0x20000", "blobGasPrice":"0x3"        // blob (type 0x3) txs only
}}
```
A receipt means "mined", not "final": confirmations = `head − blockNumber + 1`; use `finalized` for settlement-grade checks.

### eth_sendRawTransaction
**WRITE — irreversible broadcast.** Submits an already **signed** transaction to the mempool. Sign locally (ethers/viem/web3.py/eth_account…); never send a private key to an RPC node. Hosted RPC has no unlocked accounts, so `eth_sendTransaction`/`eth_sign` (§11) do not work — this is the only way to send.
**Params:** `[signedTx]` — DATA (RLP; typed txs `0x01…`/`0x02…`/`0x03…`/`0x04…` EIP-2718 envelope; blob txs must be the network form with sidecar) · **Returns:** HASH (the tx hash)

```jsonc
// request  (placeholder — substitute a real signed tx hex; do not broadcast without an explicit user instruction)
{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0x02f8…SIGNED_TX_HEX…"],"id":1}
// response — accepted into the mempool (NOT yet mined)
{"jsonrpc":"2.0","id":1,"result":"0xc00e97af59c6f88de163306935f7682af1a34c67245e414537d02e422815efc3"}
```
The returned hash means "accepted", not "mined" — poll `eth_getTransactionReceipt` (§13 P7). Typical rejections (code `-32000` on most clients): `nonce too low`, `already known`, `replacement transaction underpriced` (a same-nonce replacement needs ≥ ~10% higher fees on both fee fields), `insufficient funds for gas * price + value`, `intrinsic gas too low`, `max fee per gas less than block base fee`, `invalid sender` / wrong chain ID (EIP-155). Resubmitting the same raw tx is safe (same hash; usually `already known`).

---

## 6. Call / estimate

All three take a **call object** and execute against state without creating a transaction.

Call object (all fields optional unless noted; hex QUANTITY/DATA):

| Field | Meaning |
|---|---|
| `from` | sender; set it whenever the call checks `msg.sender`, balances or allowances |
| `to` | target contract/account; **omit/`null` to simulate a contract creation** (put init code in `input`) |
| `gas` | gas cap for the simulation (providers apply their own cap) |
| `gasPrice` **or** `maxFeePerGas` + `maxPriorityFeePerGas` | fee fields — can be omitted for simulations |
| `value` | wei sent |
| `input` / `data` | calldata. Spec name is `input`; `data` is the legacy alias every client accepts — use **one**: both set and different → `-32602 both "data" and "input" are set and not equal` |
| `nonce`, `type`, `chainId`, `accessList`, `maxFeePerBlobGas`, `blobVersionedHashes`, `authorizationList` | rarely needed |

### eth_call
Executes a message call locally and returns the raw output — the way to read any contract view function. Changes nothing on chain.
**Params:** `[callObject, block?]` — call object, BLOCK (default `"latest"`) · **Returns:** DATA (ABI-encoded return value; `0x` if nothing is returned)
**[ext]** 3rd param `stateOverrides`, 4th `blockOverrides` — present in geth's `eth_call` signature and accepted by a live reth node (most other clients/providers support them too; probe first).

```jsonc
// request — USDC.balanceOf(0xd8dA…6045)  (selector 0x70a08231 + address left-padded to 32 bytes)
{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"},"latest"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x000000000000000000000000000000000000000000000000000000000246c3fc"}   // 38192124 / 10^6 = 38.192124 USDC
```
- `result: "0x"` usually means **no contract code at `to`** (wrong chain/address), or a function with no return value. Check `eth_getCode`.
- A revert is an **error**, not a result: `{"error":{"code":3,"message":"execution reverted: ERC20: transfer to the zero address","data":"0x08c379a0…"}}` (decode per §1.3). Non-geth clients may use code `-32000`.
- State override example **[ext]** — pretend an account holds 2 ETH:
```jsonc
{"jsonrpc":"2.0","method":"eth_call","params":[
  {"from":"0x000000000000000000000000000000000000dEaD","to":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","value":"0xde0b6b3a7640000"},
  "latest",
  {"0x000000000000000000000000000000000000dEaD":{"balance":"0x1bc16d674ec80000"}}     // per account: balance, nonce, code, state (replace ALL storage), stateDiff (patch slots)
],"id":1}
```
- Decimal numbers or wrong-length addresses → `-32602`. A historical `block` needs archive state. A missing `to` simulates a contract creation (the call returns the deployed runtime code).

### eth_estimateGas
Gas a transaction would need if sent now. Fails with the revert error if the call would revert.
**Params:** `[callObject, block?]` — call object (all fields optional), BLOCK (default `"latest"`) · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_estimateGas","params":[{"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","to":"0x000000000000000000000000000000000000dEaD","value":"0x1"}],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x5208"}      // 21000
```
Add headroom (≈ +10–25%) when sending: state can change between estimate and inclusion. On some L2s the figure includes L1 data gas. Always pass a realistic `from`.

### eth_createAccessList
Simulates the call and returns the EIP-2930 access list it touches (and gas used with it). Feed the list into a type-1/2 tx; it only saves gas when cold-access savings exceed the list cost.
**Params:** `[callObject, block?]` · **Returns:** `{accessList:[{address, storageKeys[]}], gasUsed, error?}`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_createAccessList","params":[{"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"},"latest"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":{
  "accessList":[
    {"address":"0x43506849d7c04f9138d1a2050bbf3a0c054402dd","storageKeys":[]},
    {"address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","storageKeys":["0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b","0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3","0xbf4954ae1137d99a74d9587692d0c99fcc87859496c91311c267c25a44a35f95"]}],
  "gasUsed":"0x81f7"
}}
```

---

## 7. Gas / fees

All fee values are wei per gas.

### eth_gasPrice
Node's suggested price per gas. On EIP-1559 chains ≈ recent base fee + suggested tip; on legacy-gas chains the legacy price. For EIP-1559 txs prefer `eth_feeHistory` + `eth_maxPriorityFeePerGas`.
**Params:** none · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x2f54235"}      // 49627701 wei ≈ 0.0496 gwei
```

### eth_maxPriorityFeePerGas
Suggested priority fee (tip) for an EIP-1559 tx. `-32601` on chains without EIP-1559 → fall back to `eth_gasPrice`.
**Params:** none · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_maxPriorityFeePerGas","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x177e"}
```

### eth_feeHistory
Base fees, gas-used ratios and sampled tips for a range of recent blocks — the building block for fee estimation.
**Params:** `[blockCount, newestBlock, rewardPercentiles]` — QUANTITY (hex string; many clients also accept a plain integer), QUANTITY or tag, array of floats 0–100 in increasing order (`[]` allowed → no `reward`) · **Returns:** object

```jsonc
// request — last 4 blocks, 25th and 75th percentile tips
{"jsonrpc":"2.0","method":"eth_feeHistory","params":["0x4","latest",[25,75]],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":{
  "oldestBlock":"0x190c67e",
  "baseFeePerGas":["0x2f52ab7","0x2dd0773","0x2c68f1a","0x2b8b2f3","0x2acd21b"],   // blockCount + 1 entries; the LAST is the NEXT block's base fee
  "gasUsedRatio":[0.3724837833333333,0.37738483333333334,0.42197708333333334,0.4318024],   // gasUsed / gasLimit per block
  "baseFeePerBlobGas":["0x27e5fc","0x287fe6","0x28a6bd","0x29bab8","0x2a333a"],             // Cancun+ (zeros before)
  "blobGasUsedRatio":[0.19047619047619047,0.047619047619047616,0.3333333333333333,0.14285714285714285],
  "reward":[["0x5c5c9","0x3b9aca00"],["0x1bc422","0x244f4861"],["0xf4240","0xada95e1"],["0xf4240","0xf4240"]]   // per block: tip at each requested percentile
}}
```
Clients cap `blockCount` (a public reth node clamped 2000 → 1024) and may return fewer blocks than asked — use `len(baseFeePerGas) - 1`. Fee recipe: §13 P7.

### eth_blobBaseFee
Current base fee per blob gas (EIP-4844, Cancun+ chains). `-32601` where unsupported.
**Params:** none · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_blobBaseFee","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x287fe6"}
```

---

## 8. Logs / filters

### eth_getLogs
Event logs matching a filter over a block range (or one block). The workhorse for on-chain event analysis — and the method providers cap hardest.
**Params:** `[filter]` — filter object:

| Field | Type | Notes |
|---|---|---|
| `fromBlock?` / `toBlock?` | QUANTITY, or `earliest` `latest` `safe` `finalized` | inclusive bounds, default `latest`. `pending` is not valid for ranges in the current spec |
| `address?` | ADDRESS, or array of ADDRESS, or `null` | emitting contract(s); omit = any contract (expensive, often rejected on wide ranges) |
| `topics?` | array, ≤ 4 positions | position-matched; see below |
| `blockHash?` | HASH | EIP-234: restrict to one block. **Mutually exclusive** with `fromBlock`/`toBlock` |

**Returns:** array of log objects (`[]` if none): `address`, `topics[]`, `data`, `blockNumber`, `blockHash`, `blockTimestamp` (newer clients), `transactionHash`, `transactionIndex`, `logIndex`, `removed`.

Topic matching — positions are AND-ed, `null` is a wildcard, an inner array is OR; trailing positions are unconstrained. For a log with topics `[A, B]`:

| `topics` filter | Matches |
|---|---|
| `[]` | any log |
| `[A]` | A at position 0 |
| `[null, B]` | anything at 0 **and** B at 1 |
| `[A, B]` | A at 0 and B at 1 |
| `[[A, C], [B]]` | (A or C) at 0 and B at 1 |

`topics[0]` is `keccak256` of the canonical event signature (non-anonymous events), e.g. `Transfer(address,address,uint256)` = `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`, `Approval(address,address,uint256)` = `0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925`. Indexed `address` arguments are 32-byte left-padded topics; non-indexed arguments are packed in `data` (32-byte words).

```jsonc
// request — USDC Transfer events in a 3-block window
{"jsonrpc":"2.0","method":"eth_getLogs","params":[{"fromBlock":"0x190c67c","toBlock":"0x190c67e","address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}],"id":1}
// response (256 logs in the live window; first one shown)
{"jsonrpc":"2.0","id":1,"result":[{
  "address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            "0x000000000000000000000000000000000004444c5dc75cb358380d2e3de08a90",
            "0x000000000000000000000000111116058b9828cdcdd810c502b925c14f34ca11"],
  "data":"0x000000000000000000000000000000000000000000000000000000000b209584",
  "blockNumber":"0x190c67c", "blockHash":"0x59fadd12290f231a813a2935f2a412213f2e048b9a05f2f326e69300e8a83943", "blockTimestamp":"0x6add236f",
  "transactionHash":"0x23a101b4a82ca671c9cf7c546550dc236bb31dd74e61dda426d72d650aa023fe", "transactionIndex":"0x1", "logIndex":"0x19", "removed":false
}]}
```
ERC-20 and ERC-721 share the `Transfer` topic0: ERC-20 has 3 topics (amount in `data`), ERC-721 has 4 (tokenId in `topics[3]`, empty `data`).

**Limits and paging — read this before scanning**
- There is **no cursor**: you page by block range (some providers add proprietary cursor APIs — `alchemy_getAssetTransfers`, `ankr_getLogs` — non-portable).
- Providers cap any of: block span, result count, response bytes, query time. Violations surface as `-32005`, `-32602`, `-32000` or a provider code (Ankr `-32062`), with a message that usually names the limit (Alchemy's error text can include a suggested working range). Free tiers can be as tight as 10 blocks (table in §14).
- Spec rule: if either bound is beyond the current head, or `fromBlock > toBlock`, clients must answer `-32602` (a public node replied `block range extends beyond current head block`, and `invalid block range params` for `fromBlock > toBlock`) — resolve `latest` via `eth_blockNumber` and never ask past it. Some providers clamp silently instead.
- Always set `address` and/or `topic0`. A wide range with neither is rejected or very slow.
- "Involving address X" (sender **or** receiver) can't be one query (topic positions are AND-ed): run two (`topics[1]=X` and `topics[2]=X`) and merge; de-duplicate on `(blockHash, logIndex)`.
- Block time differs per chain (Ethereum 12 s, Arbitrum ~0.25 s) — size windows in blocks per chain, start from the provider cap, adapt:

```python
def get_logs_paged(flt, start, end, window=1000, min_window=1, max_window=10000):
    """flt = {"address": ..., "topics": [...]}; start/end are ints. Adaptive windowing; uses rpc()/RpcError from §1.6."""
    out, a = [], start
    while a <= end:
        b = min(a + window - 1, end)
        try:
            out += rpc("eth_getLogs", [{**flt, "fromBlock": hex(a), "toBlock": hex(b)}])
            a, window = b + 1, min(window * 2, max_window)           # success: advance, grow window
        except RpcError as e:
            m = str(e).lower()
            too_big = e.code in (-32005, -32062) or any(w in m for w in ("range", "limit", "more than", "exceed", "too large", "too many", "timeout", "size"))
            if window > min_window and too_big:
                window = max(min_window, window // 2)                # halve and retry the same start block
            else:
                raise
    return out
```

### eth_newFilter
Creates a server-side log filter and returns its ID; poll it with `eth_getFilterChanges`. Stateful, and **not served over HTTPS by every provider** (Ankr and BlockPI reject all the filter methods — see their guides) — prefer `eth_getLogs` polling or a WebSocket subscription (§14).
**Params:** `[filter]` — same fields as `eth_getLogs` · **Returns:** filter ID (QUANTITY-like hex string; length varies by client)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_newFilter","params":[{"address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0xa110000000000000752f7b6302c11744"}
```

### eth_newBlockFilter
Creates a filter that collects new block hashes.
**Params:** none · **Returns:** filter ID

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_newBlockFilter","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x711a2218a54adc52fda7cd72764bfbbd"}
```

### eth_newPendingTransactionFilter
Creates a filter that collects pending transaction hashes (mempool view). Very high volume on busy chains; often unsupported or throttled on hosted RPC.
**Params:** none · **Returns:** filter ID

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_newPendingTransactionFilter","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x33d42e63d3ff64edad71d87a10c90620"}
```

### eth_getFilterChanges
Everything new since the previous poll of this filter (and resets the cursor). Poll no faster than the chain's block time.
**Params:** `[filterId]` · **Returns:** array — log objects (log filter), block hashes (block filter) or tx hashes (pending-tx filter); `[]` when nothing changed. Re-orged logs reappear with `removed: true`.

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getFilterChanges","params":["0x711a2218a54adc52fda7cd72764bfbbd"],"id":1}
// response (block filter)
{"jsonrpc":"2.0","id":1,"result":["0x0e1dce8b2cf33fdf4826149ca0074e6f4a03b639e5ac773db5a224894cad7648"]}
// response (unknown or expired id)
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"filter not found"}}
```

### eth_getFilterLogs
All logs matching a log filter created by `eth_newFilter` (not just the new ones). Subject to the same caps as `eth_getLogs`.
**Params:** `[filterId]` · **Returns:** array of log objects

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getFilterLogs","params":["0xa110000000000000752f7b6302c11744"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":[{"address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","topics":["0xddf252ad…"],"data":"0x…","blockNumber":"0x190c67c","transactionHash":"0x23a101b4…","transactionIndex":"0x1","blockHash":"0x59fadd12…","logIndex":"0x19","removed":false}]}
```

### eth_uninstallFilter
Deletes a filter (free server resources when done).
**Params:** `[filterId]` · **Returns:** boolean (`true` if it existed)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_uninstallFilter","params":["0x711a2218a54adc52fda7cd72764bfbbd"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":true}
```

---

## 9. Subscriptions (WebSocket only)

`eth_subscribe` / `eth_unsubscribe` push data over a **persistent WebSocket**, so they need a **`wss://` endpoint** — they fail or are unavailable on the `https://` URL. The WSS URL form and plan gating are provider-specific: Alchemy `wss://{network}.g.alchemy.com/v2/{key}`; Ankr `wss://rpc.ankr.com/{chain}/ws/{key}` (Premium plan only); BlockPI `wss://{chain}.blockpi.network/v1/ws/{key}` (keyed endpoints only) — confirm in the provider guide. Test with `wscat -c "$WSS_URL"` or the snippet below.

### eth_subscribe
Opens a subscription and returns its ID; matching events then arrive as notifications on the same socket.
**Params:** `[kind, arg?]`

| `kind` | `arg` | Notification `result` |
|---|---|---|
| `"newHeads"` | – | block header object (like a block without `transactions`, `withdrawals`, `uncles`, `size`); fires per imported block, and again for a re-orged-in block at the same height |
| `"logs"` | filter `{address?, topics?}` (as in `eth_getLogs`) | one log object per event; re-orged logs come again with `removed: true`. Delivers only logs from blocks imported **after** subscribing — it does not backfill history |
| `"newPendingTransactions"` | `true` for full tx objects (default: hash only) | tx hash string (or full tx with `blockHash/blockNumber/transactionIndex: null`) — mempool firehose; the full-object variant varies by provider |
| `"transactionReceipts"` | `{transactionHashes?: HASH[]}` | **array of receipts** for the txs of each new block (all of them unless filtered — about 1 MB for a busy mainnet block). Newer spec; limited support |
| `"syncing"` | – | **[ext]** geth-family sync status |

**Returns:** subscription ID (hex string)

```jsonc
// request
{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}
// response
{"jsonrpc":"2.0","id":1,"result":"0x3342dcf86d242b98bc87da521426c50b"}
// notification (no "id"; method is always "eth_subscription")
{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0x3342dcf86d242b98bc87da521426c50b","result":{"number":"0x190c68d","hash":"0x0f0826209cf1dab6adada947a03f955a8fa292220715ec573184cfa9b3947583","parentHash":"0x0413d4bae75ad34ba934d69256307787f6d75c2a7aa9be4d9fec478a40af1ccb","timestamp":"0x6add243b","baseFeePerGas":"0x2263b1f","gasUsed":"0x241d5e9","gasLimit":"0x3938700","miner":"0x396343362be2a4da1ce0c1c210945346fb82aa49","…":"…"}}}
```

```jsonc
// logs: USDC Transfer events as they happen
{"jsonrpc":"2.0","id":2,"method":"eth_subscribe","params":["logs",{"address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}]}
// notification
{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0xb0363943ca4e5f516ef4c4a7924260ee","result":{"address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","topics":["0xddf252ad…","0x000…4444c5dc75cb358380d2e3de08a90","0x000…aa232009084bd71a5797d089aa4edfad4"],"data":"0x000000000000000000000000000000000000000000000000000000000983048e","blockNumber":"0x190c68d","blockHash":"0x0f082620…","transactionHash":"0x200eb723594974c6330f3ecc6d49a8964d7b4220c01ac5a80d7233b140f1af3b","transactionIndex":"0x0","logIndex":"0x0","removed":false}}}
```

```jsonc
// pending tx hashes
{"jsonrpc":"2.0","id":3,"method":"eth_subscribe","params":["newPendingTransactions"]}
// notification
{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0xf394ae06ab883092299681836a3b06cf","result":"0xce1005c68d6383ebd2ceeacfbdf0b29cc3cad362ce13a279c38becca7e7ecbce"}}
```

```python
import asyncio, json, os, websockets      # pip install websockets

async def main():
    async with websockets.connect(os.environ["WSS_URL"], ping_interval=20) as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_subscribe", "params": ["newHeads"]}))
        print(await ws.recv())                         # {"jsonrpc":"2.0","id":1,"result":"0x…subId"}
        async for msg in ws:                           # then notifications
            m = json.loads(msg)
            if m.get("method") == "eth_subscription":
                print(int(m["params"]["result"]["number"], 16))

asyncio.run(main())
```
Notes: a subscription dies with its connection — on reconnect, resubscribe **and backfill** the gap with `eth_getLogs` / `eth_getBlockByNumber` from the last block you saw. Handle `removed: true` and repeated block numbers (re-orgs). Providers limit concurrent connections/subscriptions per key, drop idle sockets and may cut long-lived ones (BlockPI every 30 minutes), and some bill by data delivered (Alchemy) — send pings, reconnect with backoff, filter tightly. Large kinds (`transactionReceipts`, full pending txs) can saturate the connection.

### eth_unsubscribe
Cancels a subscription.
**Params:** `[subscriptionId]` · **Returns:** boolean

```jsonc
// request
{"jsonrpc":"2.0","id":99,"method":"eth_unsubscribe","params":["0x3342dcf86d242b98bc87da521426c50b"]}
// response
{"jsonrpc":"2.0","id":99,"result":true}
```

---

## 10. Newer spec methods (limited provider support)

Defined in the `execution-apis` spec; a recent public reth 2.x node answered every one of them on 2026-10-25, but many hosted providers/older clients lag — probe first; `-32601` = unsupported, then use the fallback.

### eth_getHeaderByNumber / eth_getHeaderByHash
Block header only (no transactions) — cheaper than `eth_getBlockBy*`. Fallback: `eth_getBlockBy*` with `false`.
**Params:** `[block]` (QUANTITY or tag) / `[blockHash]` · **Returns:** header object (block fields without `transactions`, `uncles`, `withdrawals`, `size`) or `null` (also `null` for `pending`)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getHeaderByNumber","params":["latest"],"id":1}
// response (trimmed)
{"jsonrpc":"2.0","id":1,"result":{"number":"0x190c682","hash":"0x0e1dce8b2cf33fdf4826149ca0074e6f4a03b639e5ac773db5a224894cad7648","parentHash":"0xda193f6a940f81876f22d0e06edffe31609dc8de2636925013a7c5d625c29509","timestamp":"0x6add23b7","baseFeePerGas":"0x2acd21b","gasUsed":"0x251b3cd","gasLimit":"0x3938700","stateRoot":"0x13895bd5…","miner":"0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97","…":"…"}}
```

### eth_simulateV1
Runs a sequence of calls (optionally across several simulated blocks, with state/block overrides) building on each other's state — multi-step what-if analysis without sending anything. Fallback: chained `eth_call` with state overrides.
**Params:** `[payload, block?]` — `payload`: `{blockStateCalls:[{blockOverrides?, stateOverrides?, calls:[callObject…]}], traceTransfers?, validation?, returnFullTransactions?}`, BLOCK base (default `"latest"`) · **Returns:** array of simulated blocks, each a block object plus `calls[]` with `{status, returnData, gasUsed, maxUsedGas, logs}` (or `error:{code,message}` when a call fails; `code 3` = revert)

```jsonc
// request — USDC.balanceOf simulated on top of latest
{"jsonrpc":"2.0","method":"eth_simulateV1","params":[{"blockStateCalls":[{"calls":[{"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","input":"0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"}]}]},"latest"],"id":1}
// response (trimmed)
{"jsonrpc":"2.0","id":1,"result":[{"number":"0x190c683","hash":"0x93b658756bae9eb67ba4824f29af80d94e73fa54cededbd14828ff07612604e6","…":"…",
  "calls":[{"status":"0x1","returnData":"0x000000000000000000000000000000000000000000000000000000000246c3fc","gasUsed":"0x7a27","maxUsedGas":"0x7a27","logs":[]}]}]}
```

### eth_getStorageValues
Batch-read many storage slots of many contracts in one call. Fallback: batch of `eth_getStorageAt`.
**Params:** `[requests, block?]` — `{ "<address>": ["<slot>", …], … }`, BLOCK · **Returns:** `{ "<address>": ["<32-byte value>", …] }` (address keys lowercased)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getStorageValues","params":[{"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48":["0x0000000000000000000000000000000000000000000000000000000000000000"]},"latest"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":{"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48":["0x000000000000000000000000fcb19e6a322b27c06842a71e8c725399f049ae3a"]}}
```

### eth_baseFee
Base fee per gas of the **next** block. Fallback: last element of `eth_feeHistory.baseFeePerGas`.
**Params:** none · **Returns:** QUANTITY

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_baseFee","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x2dd0773"}
```

### eth_config
Active, next and last scheduled fork configuration (EIP-7910): activation time, blob schedule, fork id, precompile and system-contract addresses.
**Params:** none · **Returns:** `{current, next, last}` (`next`/`last` are `null` when no fork is scheduled)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_config","params":[],"id":1}
// response (trimmed)
{"jsonrpc":"2.0","id":1,"result":{"current":{"activationTime":1767747671,"chainId":"0x1","forkId":"0x07c9462e","blobSchedule":{"baseFeeUpdateFraction":11684671,"max":21,"target":14},"precompiles":{"ECREC":"0x0000000000000000000000000000000000000001","…":"…"},"systemContracts":{"…":"…"}},"next":null,"last":null}}
```

### eth_capabilities
What history the node serves (head, and per-resource `oldestBlock` / retention window) — lets a router or agent know if a historical query can succeed before sending it.
**Params:** none · **Returns:** `{head, state, tx, logs, receipts, blocks, stateproofs}`, each `{disabled, oldestBlock, deleteStrategy?}`

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_capabilities","params":[],"id":1}
// response (trimmed; this public node keeps only ~10,064 blocks of state)
{"jsonrpc":"2.0","id":1,"result":{"head":{"number":"0x190c67f","hash":"0x01b9d2f0c2ef417ce1008b511c39ffc7f041d994aaee688f1c21efd20ce1f7bc"},
  "state":{"disabled":false,"oldestBlock":"0x1909f1d","deleteStrategy":{"type":"window","retentionBlocks":"0x2750"}},
  "logs":{"disabled":false,"oldestBlock":"0x1908b10","deleteStrategy":{"type":"window","retentionBlocks":"0x2750"}},
  "blocks":{"disabled":false,"oldestBlock":"0x18abb57"}, "…":"…"}}
```

### eth_getBlockAccessList
EIP-7928 block-level access list (post-Amsterdam blocks only). Output can be huge (>200 KB per block).
**Params:** `[block]` — QUANTITY, tag or hash · **Returns:** array of `{address, storageChanges, storageReads, balanceChanges, nonceChanges, codeChanges}`, `null` if unknown; error `-32001` for pre-Amsterdam blocks

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_getBlockAccessList","params":["latest"],"id":1}
// response (trimmed)
{"jsonrpc":"2.0","id":1,"result":[{"address":"0x0000000000000000000000000000000000000000","storageChanges":[],"storageReads":[],"balanceChanges":[],"nonceChanges":[],"codeChanges":[]},{"…":"…"}]}
```

### eth_fillTransaction
Fills in missing fields (nonce, gas, fees, chainId) of an unsigned transaction so you can sign it. Node-local logic; rarely exposed on hosted RPC. Fallback: build the fields yourself (§13 P7).
**Params:** `[callObject]` · **Returns:** `{tx: {...filled tx, signature fields zeroed...}}`; reth also returns `raw` (the unsigned RLP)

```jsonc
// request
{"jsonrpc":"2.0","method":"eth_fillTransaction","params":[{"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","to":"0x000000000000000000000000000000000000dEaD","value":"0x1"}],"id":1}
// response (trimmed)
{"jsonrpc":"2.0","id":1,"result":{"raw":"0x02ea0182175182177e8403ff5d8482520894000000000000000000000000000000000000dead0180c0808080",
  "tx":{"type":"0x2","chainId":"0x1","nonce":"0x1751","gas":"0x5208","maxFeePerGas":"0x3ff5d84","maxPriorityFeePerGas":"0x177e","to":"0x000000000000000000000000000000000000dead","value":"0x1","input":"0x","accessList":[],"yParity":"0x0","v":"0x0","r":"0x0","s":"0x0","hash":"0x645d4cb7f201e606c95fa20a679fea4d957df5d8cbe9dca9687413198b866c05"}}}
```

---

## 11. Legacy and node-local methods

Defined in the spec / ethereum.org docs but meaningless or disabled on hosted RPC: there are no unlocked accounts, no mining, no uncles after the Merge. Expect `[]`, `0x0`, `null`, `-32601`, `-32602 unknown account` or `-32603 unimplemented`. **Never rely on them; sign locally and use `eth_sendRawTransaction`.**

| Method | Params → Returns | Hosted-RPC reality |
|---|---|---|
| `eth_accounts` | `[]` → ADDRESS[] | `[]` |
| `eth_coinbase` | `[]` → ADDRESS | error / unsupported |
| `eth_mining` | `[]` → boolean | error / `false` |
| `eth_hashrate` | `[]` → QUANTITY | `"0x0"` |
| `eth_sign` | `[address, message]` → 65-byte signature | needs a node-held key → `-32602 unknown account` |
| `eth_signTransaction` | `[txObject]` → `{raw, tx}` | same |
| `eth_sendTransaction` | `[txObject]` → HASH (signs **and** broadcasts with a node-held key) | same — use `eth_sendRawTransaction` |
| `eth_getUncleCountByBlockHash` | `[blockHash]` → QUANTITY | `"0x0"` post-Merge |
| `eth_getUncleCountByBlockNumber` | `[block]` → QUANTITY | `"0x0"` post-Merge |
| `eth_getUncleByBlockHashAndIndex` | `[blockHash, index]` → block or `null` | `null` |
| `eth_getUncleByBlockNumberAndIndex` | `[block, index]` → block or `null` | `null` |

```jsonc
// request / response, e.g.
{"jsonrpc":"2.0","method":"eth_getUncleCountByBlockNumber","params":["0x190c67e"],"id":1}
{"jsonrpc":"2.0","id":1,"result":"0x0"}
{"jsonrpc":"2.0","method":"eth_sign","params":["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","0xdeadbeef"],"id":1}
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"unknown account"}}
```

Mempool inspection (`txpool_*`, geth/reth namespace; rarely exposed publicly; heavy):

| Method | Params → Returns | Example result |
|---|---|---|
| `txpool_status` | `[]` → `{pending, queued}` (QUANTITY counts) | `{"pending":"0x3b","queued":"0x4d5a"}` |
| `txpool_content` | `[]` → `{pending:{addr:{nonce:tx}}, queued:{…}}` | whole mempool — huge |
| `txpool_contentFrom` | `[address]` → `{pending:{nonce:tx}, queued:{…}}` | that sender's pool entries |

```jsonc
// request
{"jsonrpc":"2.0","method":"txpool_status","params":[],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":{"pending":"0x3b","queued":"0x4d5a"}}
```

---

## 12. debug_* / trace_* (non-standard)

Not part of the core `eth_*` set. They replay transactions inside the node, so they are **heavy, archive-state dependent, client-specific and usually plan-gated** (pricier compute units, shorter timeouts, often paid tiers only; availability varies per chain). A `-32601`, an "archive requests require…" error or a timeout is normal on cheap plans. Provider specifics: [ankr.md](ankr.md) · [alchemy.md](alchemy.md) · [blockpi.md](blockpi.md). Prefer the cheap alternative when it's enough: `eth_getTransactionReceipt`/`eth_getBlockReceipts` for logs and status, `eth_call` for reads.

Two families, **do not mix them up**:
- `debug_*` — geth-style (also reth/erigon/nethermind). Tracers: `callTracer` (call tree), `prestateTracer` (touched state), `4byteTracer`, or none = opcode-level struct logs (enormous).
- `trace_*` — OpenEthereum/Parity-style (erigon, reth, nethermind; **not geth**). Flat list of call/create/suicide/reward frames.

### debug_traceTransaction
**Params:** `[txHash, traceConfig?]` — `traceConfig`: `{tracer?: "callTracer"|"prestateTracer"|"4byteTracer"|…, tracerConfig?: {onlyTopCall?, withLog?, …}, timeout?: "10s", disableStack?, disableStorage?, enableMemory?, enableReturnData?}` (the last four apply only without a tracer) · **Returns:** tracer-specific object (struct logs object if no tracer)

```jsonc
// request
{"jsonrpc":"2.0","method":"debug_traceTransaction","params":["0xdd8cf045113754c306ba9ac8ac8786235e33bc5c087678084ef260a2a583f127",{"tracer":"callTracer","tracerConfig":{"onlyTopCall":false,"withLog":true}}],"id":1}
// response (callTracer; nested frames under "calls"; "error"/"revertReason" appear on failing frames)
{"jsonrpc":"2.0","id":1,"result":{"type":"CALL","from":"0xfe3b557e8fb62b89f4916b721be55ceb828dbd73","to":"0x0100000000000000000000000000000000000000","value":"0x0","gas":"0x1a49e","gasUsed":"0x1a49e","input":"0x","output":"0x","calls":[]}}
```

### debug_traceCall
Same as above but for a hypothetical call. **Params:** `[callObject, block, traceConfig?]` (geth also accepts `stateOverrides`/`blockOverrides` inside the config) · **Returns:** same shape as `debug_traceTransaction`

```jsonc
// request
{"jsonrpc":"2.0","method":"debug_traceCall","params":[{"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"},"latest",{"tracer":"callTracer"}],"id":1}
// response (trimmed; USDC is a proxy, so the top frame delegates to the implementation)
{"jsonrpc":"2.0","id":1,"result":{"type":"CALL","from":"0xd8da6bf26964af9d7eed9e03e53415d37aa96045","to":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","gas":"0x…","gasUsed":"0x…","input":"0x70a08231…","output":"0x000000000000000000000000000000000000000000000000000000000246c3fc",
  "calls":[{"type":"DELEGATECALL","from":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","to":"0x43506849d7c04f9138d1a2050bbf3a0c054402dd","gas":"0x…","gasUsed":"0x…","input":"0x70a08231…","output":"0x…0246c3fc"}]}}
```

### debug_traceBlockByNumber / debug_traceBlockByHash
Trace every transaction of a block. **Params:** `[block, traceConfig?]` / `[blockHash, traceConfig?]` · **Returns:** array of `{txHash, result}` ordered by tx index (genesis can't be traced). Per-block traces time out on busy blocks — trace single transactions instead.

```jsonc
// request
{"jsonrpc":"2.0","method":"debug_traceBlockByNumber","params":["0x190c67e",{"tracer":"callTracer"}],"id":1}
// response (one entry per transaction, in block order)
{"jsonrpc":"2.0","id":1,"result":[{"txHash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa","result":{"type":"CALL","from":"0x5875db54cd9ae2b2a875e09bb731772297ae9d92","to":"0x0000000aa232009084bd71a5797d089aa4edfad4","gasUsed":"0x3de66","calls":[{"…":"…"}],"…":"…"}},{"txHash":"0x…","result":{"…":"…"}}]}
```
Also in the spec but rarely exposed: `debug_getRawHeader`, `debug_getRawBlock`, `debug_getRawTransaction`, `debug_getRawReceipts`, `debug_getBadBlocks`.

### trace_* (Parity-style)

| Method | Params | Returns |
|---|---|---|
| `trace_block` | `[block]` | all traces of the block |
| `trace_transaction` | `[txHash]` | traces of one tx |
| `trace_get` | `[txHash, [traceIndex…]]` e.g. `["0x…",["0x0"]]` | one trace by position |
| `trace_filter` | `[{fromBlock?, toBlock?, fromAddress?[], toAddress?[], after?, count?}]` | traces across a range, filtered by from/to address (paged by `after`/`count`) |
| `trace_call` | `[callObject, traceTypes, block?]` — types ⊆ `["trace","vmTrace","stateDiff"]` | simulated call trace |
| `trace_replayTransaction` | `[txHash, traceTypes]` | re-execution with the requested outputs |
| `trace_replayBlockTransactions` | `[block, traceTypes]` | same for every tx of a block |
| `trace_rawTransaction` | `[signedTx, traceTypes]` | trace a raw tx without sending it |

```jsonc
// request
{"jsonrpc":"2.0","method":"trace_transaction","params":["0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa"],"id":1}
// response (shape as returned by erigon/reth/nethermind; trimmed to one frame — one entry per call frame, depth-first)
{"jsonrpc":"2.0","id":1,"result":[
  {"type":"call",
   "action":{"callType":"call","from":"0x5875db54cd9ae2b2a875e09bb731772297ae9d92","to":"0x0000000aa232009084bd71a5797d089aa4edfad4","gas":"0x6a8d3","input":"0x09c5eabe…","value":"0x0"},
   "result":{"gasUsed":"0x3de66","output":"0x"},
   "subtraces":4, "traceAddress":[],                  // [] = top frame; [0,1] = 2nd child of 1st child
   "blockNumber":26265214, "blockHash":"0xe99c59c4d717b9bf113aa9d4bc955bfc4320e32673f1bf02d95c764770ed3b32",
   "transactionHash":"0x32ce6024571ec8d5ef3e435318f206e4b67a6739718216d4b5b3121499ee9bfa", "transactionPosition":0}
]}
// trace_filter example request
{"jsonrpc":"2.0","method":"trace_filter","params":[{"fromBlock":"0x190c67e","toBlock":"0x190c67e","toAddress":["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],"after":0,"count":100}],"id":2}
```
Frame types: `call`, `create` (result has `address`, `code`), `suicide`, `reward`. A failing frame has `"error":"Reverted"` instead of `result`.

---

## 13. Common patterns

All snippets reuse `rpc()` / `RpcError` from §1.6 (`RPC_URL` = full provider endpoint).

### P1 — Verify the endpoint and its freshness
```jsonc
// one batch: right chain? alive? how old is the head?
[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
 {"jsonrpc":"2.0","id":2,"method":"eth_getBlockByNumber","params":["latest",false]}]
```
Check `chainId` equals the expected one; `age = now − int(block.timestamp, 16)` should be about one block time (stale = degraded node/provider).

### P2 — Latest block and a native balance
```python
head = int(rpc("eth_blockNumber"), 16)
blk = rpc("eth_getBlockByNumber", [hex(head), False])            # tx hashes only
wei = int(rpc("eth_getBalance", ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", hex(head)]), 16)
print(head, int(blk["timestamp"], 16), wei / 10**18)
```
Pass the same `hex(head)` to every follow-up read so all values describe one block.

### P3 — ERC-20 balance via eth_call
`data = selector (4 bytes) ++ each argument ABI-encoded to 32 bytes`. `balanceOf(address)` = `0x70a08231` + the holder address, no `0x`, left-padded with zeros to 64 hex chars.

```python
TOKEN  = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"      # USDC (Ethereum)
HOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
call = lambda data: rpc("eth_call", [{"to": TOKEN, "data": data}, "latest"])
raw = call("0x70a08231" + HOLDER[2:].lower().rjust(64, "0"))
dec = int(call("0x313ce567"), 16)                           # decimals()
print(int(raw, 16) / 10**dec)                              # human amount
```
```jsonc
// raw request for the balance
{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045"},"latest"],"id":1}
```
Selectors: `name()` `0x06fdde03` · `symbol()` `0x95d89b41` · `decimals()` `0x313ce567` · `totalSupply()` `0x18160ddd` · `balanceOf(address)` `0x70a08231` · `allowance(address,address)` `0xdd62ed3e` · `transfer(address,uint256)` `0xa9059cbb` · `approve(address,uint256)` `0x095ea7b3` · `transferFrom(address,address,uint256)` `0x23b872dd` · `ownerOf(uint256)` `0x6352211e` (ERC-721). Selector of any signature = first 4 bytes of its keccak256. Return decoding: a `uint256` is `int(result, 16)`; a `string` is ABI-encoded (offset, length, bytes) — some old tokens (e.g. MKR) return `bytes32` instead:

```python
def decode_string(h):
    b = bytes.fromhex(h[2:])
    if len(b) == 32:                                        # legacy bytes32 symbol/name
        return b.rstrip(b"\0").decode(errors="replace")
    off = int.from_bytes(b[:32], "big"); n = int.from_bytes(b[off:off + 32], "big")
    return b[off + 32:off + 32 + n].decode(errors="replace")
```
Many reads at once: send them as one batch, or aggregate on-chain with Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, same address on most EVM chains; `aggregate3` selector `0x82ad56cb`) via a single `eth_call`.

### P4 — Resolve token metadata in one batch
```jsonc
[{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x313ce567"},"latest"]},
 {"jsonrpc":"2.0","id":2,"method":"eth_call","params":[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x95d89b41"},"latest"]},
 {"jsonrpc":"2.0","id":3,"method":"eth_call","params":[{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x18160ddd"},"latest"]}]
```
→ `decimals` = `0x…06` (6), `symbol` = ABI string `"USDC"`, `totalSupply` = uint256. A token whose `decimals()` reverts or returns `0x` is non-standard (or not a token on this chain).

### P5 — Collect events with eth_getLogs
ERC-20 `Transfer` **to** an address over a block range (`topics = [topic0, null (from = any), to]`):

```python
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
pad = lambda a: "0x" + a[2:].lower().rjust(64, "0")
head = int(rpc("eth_blockNumber"), 16)
logs = get_logs_paged({"address": TOKEN, "topics": [TRANSFER, None, pad(HOLDER)]}, head - 5000, head)   # get_logs_paged from §8
for lg in logs:
    frm, to = "0x" + lg["topics"][1][-40:], "0x" + lg["topics"][2][-40:]
    amount = int(lg["data"], 16)                              # raw units; divide by 10**decimals
    print(int(lg["blockNumber"], 16), frm, to, amount, lg["transactionHash"])
```
Sent-by is `[TRANSFER, pad(HOLDER)]`. Decoding rule: indexed args → `topics[1..3]`, non-indexed → `data` split into 32-byte words (`int(data[2+64*i : 2+64*(i+1)], 16)`). Skip logs with `removed: true`; for finality-sensitive work stop at `finalized`.

### P6 — Follow the chain head
Polling: keep `last`; every ≈ block time fetch `head = eth_blockNumber`; for `n in last+1..head` fetch `eth_getBlockByNumber(n)` (or `eth_getLogs` for the span); confirm `block.parentHash == previous.hash`, and on mismatch walk back and re-process (re-org). Prefer `eth_subscribe newHeads` over WSS (§9) when available, and use the same backfill-on-reconnect loop.

### P7 — Estimate fees and send a signed transaction
1. Preflight reads in one batch:
```jsonc
[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
 {"jsonrpc":"2.0","id":2,"method":"eth_getTransactionCount","params":["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","pending"]},
 {"jsonrpc":"2.0","id":3,"method":"eth_feeHistory","params":["0x1","latest",[50]]},
 {"jsonrpc":"2.0","id":4,"method":"eth_maxPriorityFeePerGas","params":[]},
 {"jsonrpc":"2.0","id":5,"method":"eth_estimateGas","params":[{"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","to":"0x000000000000000000000000000000000000dEaD","value":"0x2386f26fc10000"}]}]
```
2. Fees: `nextBase = feeHistory.baseFeePerGas[-1]`, `tip = maxPriorityFeePerGas` (or the median of `reward`), `maxFeePerGas = 2 × nextBase + tip` (common headroom rule), `gas = estimate × 1.2`. Legacy-gas chains: use `eth_gasPrice`.
3. Build the tx `{chainId, nonce, to, value, data, gas, maxFeePerGas, maxPriorityFeePerGas, type: 2}`, **sign locally** with the private key (never send it to the RPC).
4. Broadcast and wait:
```python
import time
txh = rpc("eth_sendRawTransaction", [raw_signed_hex])      # WRITE — only on explicit user instruction
rc = None
for _ in range(90):
    rc = rpc("eth_getTransactionReceipt", [txh])
    if rc: break
    time.sleep(2)
ok = bool(rc) and rc["status"] == "0x1"
```
Speed-up/cancel: resend with the **same nonce** and ≥ 10% higher `maxFeePerGas` and `maxPriorityFeePerGas` (cancel = 0-value self-send).

### P8 — Contract or EOA? Proxy implementation?
- `eth_getCode(addr)`: `"0x"` → EOA/empty; starts with `0xef0100` → EOA delegated by EIP-7702 (the next 20 bytes are the delegate contract); anything else → contract bytecode.
- EIP-1967 proxy target: `eth_getStorageAt(proxy, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest")` → the **last 20 bytes** are the implementation.
```jsonc
// request — Aave V3 Pool (a transparent-style EIP-1967 proxy)
{"jsonrpc":"2.0","method":"eth_getStorageAt","params":["0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2","0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc","latest"],"id":1}
// response
{"jsonrpc":"2.0","id":1,"result":"0x000000000000000000000000728a138a4823392c2efa55e028d434f526fe03cf"}
```
Other EIP-1967 slots: admin `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`, beacon `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50`. A zero result = not an EIP-1967 proxy (USDC, for instance, uses the older OpenZeppelin slot `0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3`, which holds its implementation `0x43506849d7c04f9138d1a2050bbf3a0c054402dd`).

### P9 — Where is my transaction?
1. `eth_getTransactionReceipt(h)` non-null → mined. `status` `0x1` ok / `0x0` reverted; confirmations = `head − blockNumber + 1`.
2. null → `eth_getTransactionByHash(h)`: non-null with `blockNumber: null` → still pending in that node's mempool.
3. Both null → unknown to this node: not propagated yet (wait a few seconds), wrong chain, dropped/evicted, or replaced. Check `eth_getTransactionCount(from, "latest")` — if it's greater than the tx's nonce, the nonce was consumed (by this tx on another path, or a replacement).

---

## 14. Gotchas

- **Everything numeric is hex** (`0x…`, minimal digits) except `net_version` (decimal string) and a few float/trace fields. Don't send decimals; convert with big integers (§1.4).
- **`null` is a normal answer**: unknown or pending tx/receipt/block returns `result: null`; state and range errors come back as `error`. A call on an address with no code returns `"0x"`, not an error.
- **`latest` is not stable across calls.** Load-balanced providers can serve consecutive requests from nodes a block or two apart (heads can even go backwards). For multi-call consistency pin an explicit block number (or EIP-1898 hash object), or put the calls in one batch. `latest` can also re-org; use `safe`/`finalized` (where supported) for settlement-grade reads and wait for confirmations before acting on a transaction.
- **`eth_getLogs` is capped** per provider/plan by block span, result count, response size and time → page the range (§8 helper), always set `address`/`topic0`, never ask past the head, and expect `-32005`/`-32602`/`-32062`. Indicative snapshot taken from the provider guides (checked 2026-10-25; limits change and the **provider guide wins** if it differs):

  | Provider | `eth_getLogs` block range | Other `eth_getLogs` / response limits | Batch (HTTPS) | Filter methods over HTTPS | WebSocket · trace/debug |
  |---|---|---|---|---|---|
  | Ankr | Freemium 3,000 · Premium 10,000 (Polygon 1,000; BSC 1,000 on Freemium; Monad 100/1,000) | 200,000 logs per response, else an error (no partial result); range error `-32062` | 100 · 1,000 | not supported | Premium only · Premium only |
  | Alchemy | Free 10 · PAYG unlimited on major chains (Ethereum, Base, Optimism, Arbitrum, Polygon, BNB, …), 1,000 on Berachain, 10,000 elsewhere | 150 MB response cap | 1,000 (Alchemy advises < 50; several of its APIs can't be batched) | supported | all plans, streams only, billed by data delivered · PAYG and up |
  | BlockPI | keyed: 1,024 without `address`/`topics`, 5,000 with; over the cap → `-32602` | public endpoints: 3 MB response | keyed 1,000 · public 10 (observed 5) | disabled (`-32000 method is disabled`) | keyed WSS only, cut every 30 min · none on public endpoints |

- **History depth.** Reading state at old blocks (`eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getProof`, `debug_*`, `trace_*`) needs an **archive**-capable plan; full nodes keep only recent state (a public node kept ~10,000 blocks, see `eth_capabilities`). Failures look like `missing trie node`, `header not found`, `historical state … is not available`, or code `4444` (a pruned-history node refused a pre-Merge block). Old blocks/txs/receipts/logs can be pruned too (EIP-4444). Provider coverage differs — see the provider guide.
- **Filters are stateful and expire.** `eth_newFilter` & co. live on one backend node, expire after minutes of no polling, and behind a load balancer the next poll may land elsewhere → `filter not found`. Some providers don't offer them over HTTPS at all (Ankr, BlockPI). For anything long-running use `eth_getLogs` windows or a WebSocket subscription, and recreate filters on error. Always `eth_uninstallFilter` when done.
- **Subscriptions need `wss://`**, die with the connection, don't backfill, and are plan-gated on some providers (§9).
- **Batches**: capped per provider/plan (table above) and often discouraged beyond a few dozen calls, billed per element, rejected as a whole when oversized, each element can fail alone — check every `error`, match by `id`. WebSocket batch limits are lower than HTTP.
- **Cost and rate limits.** Calls bill against the *user's* provider quota (CU/credits); heavy methods (`eth_getLogs`, `eth_getBlockReceipts`, hydrated blocks, `debug_*`/`trace_*`, `eth_getProof`) cost far more than light ones. Failed and unsupported-method calls may still be billed (Ankr does), so don't spray probes — test a method once and remember the answer. Avoid tight polling loops; on `429`/`-32005` back off exponentially with jitter.
- **Keep context small.** A hydrated block, `eth_getBlockReceipts`, a trace or a busy-token `eth_getLogs` can be MBs. Request only what you need (hashes not full txs, narrow ranges/topics) and extract the fields you need in code instead of printing results.
- **Chain differences.** L2s/sidechains: extra block/tx/receipt fields (OP Stack `0x7e` deposit txs, L1 fee fields), different gas/fee semantics (`eth_gasPrice`, `eth_estimateGas` may include L1 data gas), different block times, missing methods (`eth_blobBaseFee`, `eth_maxPriorityFeePerGas` and `safe`/`finalized` tags are not universal). Treat `-32601` as "unsupported here" and fall back; verify with `eth_chainId` before signing.
- **`eth_call` ≠ transaction.** It ignores your balance for gas unless you set fee fields; `from` defaults to the zero address; reverts are errors with `data`; a successful `eth_estimateGas` doesn't guarantee inclusion later. Give `value`-sending simulations a `from` with balance (or use a state override).
- **Calldata field name**: spec says `input`; `data` is the alias all clients accept — send exactly one.
- **Writes are irreversible.** `eth_sendRawTransaction` is the only write; sign locally, double-check chain ID, nonce, `to`, `value`, fees, and broadcast only on an explicit user instruction. A returned hash ≠ mined (§P7). Never send private keys or seed phrases to any RPC method.
- **Secrets**: the endpoint URL contains the key. Don't log/echo it, and be careful with HTTP-library exceptions that print the request path.
- **Post-Merge constants**: `difficulty` `0x0`, `nonce` `0x0000000000000000`, `mixHash` = prevRandao, uncles empty. EIP-7702 delegated EOAs report `0xef0100…` code (§P8).
