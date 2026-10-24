# Solana RPC (BYOK)

Solana **JSON-RPC 2.0** using the user's **own Ankr / Alchemy / BlockPI key**, fetched from the Clawby Key Vault (fetch steps, IP whitelist, vault errors: `rpc/index.yaml` and `rpc/<provider>.md`). Direct to the provider — not via Clawby relay, no Clawby credits.

Solana is **not EVM**: no `eth_*`, no hex quantities, no `0x` addresses. Accounts / mints / programs are base58 pubkeys, balances are **lamports** (1 SOL = 1,000,000,000 lamports), and most reads take a **commitment** level and an **encoding** — both are classic traps (see §2).

> The key sits in the endpoint URL, so **the whole URL is a secret**. Never log, echo or commit it.

## 1 · Endpoints (mainnet)

| Provider | Endpoint | Notes |
|---|---|---|
| Ankr | `https://rpc.ankr.com/solana/{KEY}` | Freemium + Premium plans. `getLargestAccounts` unsupported on Premium. Ledger keeps only **~16 h** of history. Ankr's docs list 50 of the 52 standard methods (no `getRecentPrioritizationFees`, no `getStakeMinimumDelegation`). Devnet slug: `solana_devnet`. |
| Alchemy | `https://solana-mainnet.g.alchemy.com/v2/{KEY}` | All 52 standard methods plus Alchemy-only extras (§5). Historical `getAccountInfo` (Account Archive params `slot` / `lastUpdateBeforeSlot` / `firstUpdateAfterSlot`) needs a paid plan. No Debug / Trace API. |
| BlockPI | `https://solana.blockpi.network/v1/rpc/{KEY}` | All 52 standard methods. Solana is the only network in BlockPI's table gated to the **Premium** RU package. (BlockPI also offers WebSocket + Yellowstone gRPC; not covered here.) |

```bash
SOLANA_RPC="https://rpc.ankr.com/solana/$ANKR_KEY"   # or the Alchemy / BlockPI URL from the table
rpc() { curl -s -X POST "$SOLANA_RPC" -H 'Content-Type: application/json' -d "$1"; }
rpc '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
```

Below, every "Request" is the JSON body to POST to that endpoint. Response samples are trimmed; numbers are illustrative unless noted.

## 2 · Envelope and conventions

```jsonc
// Request  (POST, Content-Type: application/json) — params is a POSITIONAL array; omit it or send [] when a method takes none
{"jsonrpc":"2.0","id":1,"method":"<name>","params":[ /* … */ ]}
// Success
{"jsonrpc":"2.0","result": /* … */,"id":1}
// Error  (HTTP status is usually still 200 — always check for "error")
{"jsonrpc":"2.0","error":{"code":-32602,"message":"…"},"id":1}
```
Batch: send a JSON array of request objects, get an array back.

**Result shape.** Account / token / balance / blockhash / fee methods return an `RpcResponse`: `{"context":{"slot":u64,"apiVersion":"x.y.z"},"value": …}` — read the payload from `result.value`. Others (`getSlot`, `getBlockHeight`, `getEpochInfo`, `getBlock`, `getTransaction`, `getSignaturesForAddress`, `getProgramAccounts`, `sendTransaction`, …) return the payload directly in `result`. `apiVersion` may be absent on old nodes.

### Commitment (`commitment`, default `finalized`)

| Level | Meaning | Use for |
|---|---|---|
| `processed` | newest slot the node has processed on its preferred fork; **can be rolled back** | latency-critical hints only |
| `confirmed` | slot voted for by ≥ 2/3 of active stake; stable, weaker than finalized | UI, polling, most reads |
| `finalized` | max vote lockout, recognized by ≥ 2/3 of stake; strongest | money decisions, accounting |

- Omitting `commitment` means **`finalized`**, which lags `confirmed` / `processed`: a just-landed tx may look "missing" if you read at `finalized`.
- `getBlock`, `getBlocks`, `getBlocksWithLimit`, `getSignaturesForAddress`, `getTransaction` accept only `confirmed` / `finalized` (`processed` → error ``-32602 Method does not support commitment below `confirmed` ``, verified live). `getSignatureStatuses` has no commitment parameter (read `confirmationStatus`).
- `sendTransaction` uses `preflightCommitment` (default `finalized`) — keep it equal to the level you used for `getLatestBlockhash`.
- `minContextSlot` (optional on most reads): reject answers from a node that is behind that slot — use it behind load balancers to avoid stale reads.

### Encoding (`encoding`) — set it explicitly, defaults differ per method

| Method | Options | Default |
|---|---|---|
| `getAccountInfo`, `getProgramAccounts`, `getTokenAccountsByOwner/Delegate` | `base58` · `base64` · `base64+zstd` · `jsonParsed` (`binary` = deprecated alias of base58) | **`binary`** → account `data` is a plain **base58 string** (≤ 128 bytes of data!), *not* an array |
| `getMultipleAccounts` | same | `base64` |
| `getTransaction`, `getBlock` | `json` · `jsonParsed` · `base64` · `base58` (`binary` deprecated) | `json` |
| tx *input* of `sendTransaction` / `simulateTransaction` | `base64` · `base58` | **`base58`** (slow, max 1,232 bytes) — always send `base64` |
| `simulateTransaction` `accounts.encoding` | `base64` · `base64+zstd` · `jsonParsed` | `base64` |

Account `data` shape by encoding: `["<payload>","base64"]` (also `base58`, `base64+zstd`) · plain string for `binary` · `{"program","parsed","space"}` for `jsonParsed` (falls back to `["…","base64"]` when no parser exists). `program` ∈ `address-lookup-table`, `bpf-upgradeable-loader`, `config`, `nonce`, `spl-token`, `spl-token-2022`, `stake`, `sysvar`, `vote`. `dataSlice {offset,length}` works with the raw encodings only (not `jsonParsed`).

### Other conventions
- **Units**: lamports are `u64`; `rentEpoch` is often `18446744073709551615` (> 2^53) → use BigInt-safe JSON parsing. Token `amount` is a **string** (raw integer); divide by `10^decimals` (`uiAmount` is deprecated → use `uiAmountString`).
- **Identifiers**: pubkey = 32-byte base58; signature (= tx id) = 64-byte base58 (~88 chars); blockhash = base58.
- **Slot vs block height** are different counters (slots can be skipped). `lastValidBlockHeight` is compared to `getBlockHeight`, not `getSlot`.
- Well-known addresses: System Program `11111111111111111111111111111111`; Token program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`; wSOL mint `So11111111111111111111111111111111111111112`; USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals).

## 3 · Method reference

The 20 most-used methods first (full request/response), then every other documented method in compact form (§4). Official reference for each: `https://solana.com/docs/rpc/http/<methodname-lowercase>`.

### Accounts

#### getBalance
Lamport balance of one account. Params `[pubkey, {commitment?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["83astBRguLMdt2h5U1Tpdq5tjFoJ6noeGwaY3mDLVcri",{"commitment":"finalized"}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":341197053},"value":1500000000},"id":1}
```
- `value` is lamports (1.5 SOL above). A non-existent account also returns `0` — use `getAccountInfo` (`value: null`) to test existence.

#### getAccountInfo
Account state and metadata for one address. Params `[pubkey, {commitment?, encoding?, dataSlice?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg",{"commitment":"finalized","encoding":"base64"}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":341197053},"value":{"data":["","base64"],"executable":false,"lamports":88849814690250,"owner":"11111111111111111111111111111111","rentEpoch":18446744073709551615,"space":0}},"id":1}
```
With `"encoding":"jsonParsed"` on an SPL mint (sampled live):
```json
{"result":{"context":{"slot":461014249},"value":{"data":{"program":"spl-token","parsed":{"type":"mint","info":{"decimals":9,"freezeAuthority":null,"isInitialized":true,"mintAuthority":null,"supply":"0"}},"space":82},"executable":false,"lamports":1856265097572,"owner":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","rentEpoch":18446744073709551615,"space":82}}}
```
- `value` is **`null`** if the account does not exist at that commitment. `owner` = the program that owns it (System Program for plain wallets). `executable: true` = a program account.
- Omitting `encoding` returns `data` as a base58 **string** (see §2) — pass `"encoding":"base64"`.

#### getMultipleAccounts
Same as `getAccountInfo` for up to **100** pubkeys, results in request order. Params `[[pubkey,…], {commitment?, encoding?, dataSlice?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg","4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"],{"encoding":"base64","commitment":"finalized"}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":341197247},"value":[{"data":["","base64"],"executable":false,"lamports":88849814690250,"owner":"11111111111111111111111111111111","rentEpoch":18446744073709551615,"space":0},null]},"id":1}
```
- Each entry is an account object or `null` (missing). Default encoding here is `base64` (differs from `getAccountInfo`).

#### getProgramAccounts
All accounts owned by a program, optionally filtered. Params `[programId, {commitment?, encoding?, filters?, dataSlice?, withContext?, sortResults?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",{"commitment":"finalized","encoding":"base64","filters":[{"dataSize":165},{"memcmp":{"offset":0,"bytes":"Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"}},{"memcmp":{"offset":32,"bytes":"5wx11hXBHQALycTQNkeQ5w1N9vgup4ardN2yLiDK4JyK"}}],"sortResults":true}]}
```
```json
{"jsonrpc":"2.0","result":[{"pubkey":"CxELquR1gPP8wHe33gZ4QxqGB3sZ9RSwsJ2KshVewkFY","account":{"data":["KgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==","base64"],"executable":false,"lamports":15298080,"owner":"4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T","rentEpoch":28,"space":42}}],"id":1}
```
- `filters`: ≤ 4, all must match. `{"dataSize":N}` = exact data length; `{"memcmp":{"offset":N,"bytes":"…","encoding":"base58"(default)|"base64"|"bytes"}}` (decoded ≤ 128 bytes); `tokenAccountState` (a value-less filter; exact JSON form not shown in the docs) = initialized Token / Token-2022 accounts. The example above = Token accounts (165 bytes) for one mint (offset 0) and one owner (offset 32).
- `withContext:true` wraps the array in `{context,value}`. `sortResults:false` = unspecified order. **Heavy**: unfiltered calls on big programs (e.g. the Token program) time out or return GBs — filter, use `dataSlice`, or prefer `getTokenAccountsByOwner`.

### Network state

#### getLatestBlockhash
Newest blockhash + the last block height it is valid for. Params `[{commitment?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","params":[{"commitment":"processed"}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":2792},"value":{"blockhash":"EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N","lastValidBlockHeight":3090}},"id":1}
```
- A tx using this blockhash is rejected once `getBlockHeight` > `lastValidBlockHeight`. Fetch at the same commitment you pass as `preflightCommitment`.

#### getSlot
Highest slot at the commitment. Params `[{commitment?, minContextSlot?}]` → `u64`.
```json
{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}
```
```json
{"jsonrpc":"2.0","result":341197053,"id":1}
```

#### getBlockHeight
Current block height (number of blocks below it; ≠ slot). Params `[{commitment?, minContextSlot?}]` → `u64`.
```json
{"jsonrpc":"2.0","id":1,"method":"getBlockHeight","params":[{"commitment":"finalized"}]}
```
```json
{"jsonrpc":"2.0","result":1233,"id":1}
```

#### getEpochInfo
Current epoch position. Params `[{commitment?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getEpochInfo","params":[{"commitment":"finalized"}]}
```
```json
{"jsonrpc":"2.0","result":{"absoluteSlot":461014221,"blockHeight":439043329,"epoch":1067,"slotIndex":70221,"slotsInEpoch":432000,"transactionCount":563603778892},"id":1}
```
- Sampled live on mainnet. `transactionCount` can be `null`. Epoch progress = `slotIndex / slotsInEpoch`.

### Blocks and transactions

#### getBlock
A confirmed block by slot. Params `[slot, {commitment?, encoding?, transactionDetails?, rewards?, maxSupportedTransactionVersion?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[378967388,{"commitment":"finalized","encoding":"json","transactionDetails":"full","maxSupportedTransactionVersion":1,"rewards":true}]}
```
```jsonc
{"jsonrpc":"2.0","result":{
  "blockHeight":428,"blockTime":null,
  "blockhash":"3Eq21vXNB5s86c62bVuUfTeaMif1N2kUqRPBmGRJhyTA",
  "parentSlot":429,"previousBlockhash":"mfcyqEXB3DnHXki6KjjmZck6YjmZLvpAByy2fj4nh6B",
  "rewards":[],"numRewardPartitions":null,
  "transactions":[{
    "meta":{"err":null,"fee":5000,"preBalances":[499998937500,26858640,1],"postBalances":[499998932500,26858640,1],"preTokenBalances":[],"postTokenBalances":[],"innerInstructions":[],"logMessages":[],"rewards":null,"status":{"Ok":null}},
    "transaction":{"message":{"accountKeys":["3UVYmEC…","AjozzgE…","Vote111…"],"header":{"numReadonlySignedAccounts":0,"numReadonlyUnsignedAccounts":3,"numRequiredSignatures":1},"instructions":[{"accounts":[1,2,3,0],"data":"37u9WtQp…","programIdIndex":4}],"recentBlockhash":"mfcyqEXB3DnH…"},"signatures":["2nBhEBYY…"]}
  }]
},"id":1}
```
- `transactionDetails`: `full` (default) · `accounts` (signatures + account keys, slimmer `meta`) · `signatures` (just `signatures[]`) · `none`. `rewards:false` drops the rewards array. `encoding`: `json` (default) · `jsonParsed` · `base64` · `base58`.
- `maxSupportedTransactionVersion` — **send JSON number `1`** (legacy + v0 + v1). `0` = legacy + v0 only. If omitted, only legacy txs are allowed. A tx above your value makes the **whole call fail** (`-32015`, no partial result) — only for `full` / `accounts`. **Mainnet now contains v1 transactions** (verified live: a sampled block had 110 v1, 126 v0 and 91 legacy of 327 txs), so `0` — or omitting it — fails on most recent blocks with `-32015 Transaction version (1) is not supported by the requesting client … "maxSupportedTransactionVersion": 1`. `rpc/ankr.md` records the same (required `1` since 2026-09-15).
- Result is `null` if the block isn't confirmed; an unavailable slot errors with `-32004 Block not available for slot N` (verified live for a future slot). A *skipped* slot usually errors with `-32007` (Agave source; not on the fetched doc pages). Full blocks are huge (hundreds–thousands of txs): prefer `signatures` / `none`.

#### getSignaturesForAddress
Signatures of txs that include an address in their account keys, **newest first**. Params `[address, {limit?, before?, until?, commitment?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["Vote111111111111111111111111111111111111111",{"commitment":"finalized","limit":1}]}
```
```json
{"jsonrpc":"2.0","result":[{"signature":"5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv","slot":114,"err":null,"memo":null,"blockTime":null,"confirmationStatus":"finalized"}],"id":1}
```
- `limit` 1–1000 (default 1000). Page backwards by passing the **last (oldest) signature** of a page as `before`; `until` stops the scan at a signature. `err` is `null` on success; failed txs are included. `blockTime` is unix seconds or `null`. Unused address → `[]`. Commitment: `confirmed` / `finalized` only.

#### getTransaction
Full transaction + execution metadata by signature. Params `[signature, {commitment?, encoding?, maxSupportedTransactionVersion?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["4ReKprwf3WdLHRrzp4ctPWNBsQDPL3VZz3zMmoZfcGJMJCHh5Vq937mPdyxhCbw54wNnA6hZ7KfNpQdpt13yY7A9",{"commitment":"confirmed","maxSupportedTransactionVersion":1,"encoding":"json"}]}
```
```jsonc
{"jsonrpc":"2.0","result":{
  "slot":423108383,"blockTime":1763747336,"version":"legacy",
  "meta":{"err":null,"fee":5000,"computeUnitsConsumed":150,
          "preBalances":[13086426097436981,0,1],"postBalances":[13086425097431981,1000000000,1],
          "preTokenBalances":[],"postTokenBalances":[],"innerInstructions":[],
          "logMessages":["Program 11111111111111111111111111111111 invoke [1]","Program 11111111111111111111111111111111 success"],
          "loadedAddresses":{"readonly":[],"writable":[]}},
  "transaction":{"message":{"accountKeys":["9B5XszUG…","D1UPrG5k…","11111111111111111111111111111111"],
                  "header":{"numRequiredSignatures":1,"numReadonlySignedAccounts":0,"numReadonlyUnsignedAccounts":1},
                  "instructions":[{"programIdIndex":2,"accounts":[0,1],"data":"3Bxs3zzLZLuLQEYX","stackHeight":1}],
                  "recentBlockhash":"TT2s5saK…"},
                "signatures":["4ReKprwf…"]}
},"id":1}
```
- `null` result = unknown to the node at that commitment (not landed yet, pruned, or wrong signature).
- `meta.err` is `null` on success; SOL movement = `postBalances[i] - preBalances[i]` (lamports, same order as `accountKeys`); token movement = diff of `preTokenBalances`/`postTokenBalances` (`accountIndex`, `mint`, `owner`, `uiTokenAmount`).
- `version` (`"legacy"` | `0` | `1`) appears only if you set `maxSupportedTransactionVersion`; always send `1` (a v0 or v1 tx errors with `-32015` if your value is lower/omitted — the sample above is a legacy tx). Use `encoding:"jsonParsed"` for decoded instructions (`accountKeys` become `{pubkey,signer,writable,source}`). Commitment: `confirmed` / `finalized` only.

#### getSignatureStatuses
Status of up to **256** signatures. Params `[[sig,…], {searchTransactionHistory?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getSignatureStatuses","params":[["4cdd1oX7cfVALfr26tP52BZ6cSzrgnNGtYD7BFhm6FFeZV5sPTnRvg6NRn8yC6DbEikXcrNChBM5vVJnTgKhGhVu"],{"searchTransactionHistory":true}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":82},"value":[{"slot":48,"confirmations":null,"err":null,"status":{"Ok":null},"confirmationStatus":"finalized"},null]},"id":1}
```
- One entry per input, in order; `null` = not found (checked only in the recent-status cache unless `searchTransactionHistory:true`). `confirmations: null` = rooted/finalized. `confirmationStatus` ∈ `processed`/`confirmed`/`finalized`; `err` non-null = failed. `status` is deprecated (mirrors `err`). This is the cheap way to poll after `sendTransaction`.

### Tokens

#### getTokenAccountsByOwner
SPL token accounts of a wallet. Params `[owner, {mint}|{programId}, {commitment?, encoding?, dataSlice?, minContextSlot?}]` — **exactly one** of `mint` / `programId` is required.
```json
{"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner","params":["A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd",{"programId":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},{"commitment":"finalized","encoding":"jsonParsed"}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":341197933},"value":[{"pubkey":"BGocb4GEpbTFm8UFV2VsDSaBXHELPfAXrvd4vtt8QWrA","account":{"data":{"program":"spl-token","parsed":{"type":"account","info":{"isNative":false,"mint":"2cHr7QS3xfuSV8wdxo3ztuF4xbiarF6Nrgx3qpx3HzXR","owner":"A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd","state":"initialized","tokenAmount":{"amount":"420000000000000","decimals":6,"uiAmount":420000000.0,"uiAmountString":"420000000"}}},"space":165},"executable":false,"lamports":2039280,"owner":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","rentEpoch":18446744073709551615,"space":165}}]},"id":1}
```
- `value[].pubkey` is the **token account** address; `info.mint` / `info.owner` are the token and the wallet. `state` ∈ `uninitialized`/`initialized`/`frozen`. Token-2022 accounts need a second call with `programId` = `TokenzQd…` (they are *not* returned by the Token-program query). `info.delegate`, `closeAuthority`, `extensions[]` (Token-2022) may be present. Unused owner → `value: []`. Without a filter object the call errors (`-32602`).

#### getTokenAccountBalance
Balance of one token account. Params `[tokenAccountPubkey, {commitment?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getTokenAccountBalance","params":["48gpnn8nsmkvkgso7462Z1nFhUrprGQ71u1YLBPzizbY",{"commitment":"finalized"}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":1114},"value":{"amount":"9864","decimals":2,"uiAmount":98.64,"uiAmountString":"98.64"}},"id":1}
```
- Takes the **token account**, not the wallet. Use `amount` + `decimals`; `uiAmount` is deprecated.

#### getTokenSupply
Total supply of a mint. Params `[mintPubkey, {commitment?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",{"commitment":"finalized"}]}
```
```json
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.2","slot":461014260},"value":{"amount":"7706220722272567","decimals":6,"uiAmount":7706220722.272567,"uiAmountString":"7706220722.272567"}},"id":1}
```
- USDC sampled live. Same `amount`/`decimals`/`uiAmountString` shape as above.

### Sending and simulating

#### sendTransaction
Submit a **fully signed** transaction. Params `[txEncoded, {encoding?, skipPreflight?, preflightCommitment?, maxRetries?, minContextSlot?}]` → first signature (base58).
```json
{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":["<BASE64_SIGNED_TX>",{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":3}]}
```
```json
{"jsonrpc":"2.0","result":"2id3YC2jK9G5Wo2phDx4gJVAew8DcY5NAojnVuao8rkxwPYPe8cSwE5GzhEgJA2y8fVjDEo6iR6ykBvDxrTQrtpb","id":1}
```
- Returns as soon as the node accepts it — **not** a confirmation. Poll `getSignatureStatuses` until `confirmationStatus` is reached or `getBlockHeight` > `lastValidBlockHeight` (then rebuild with a new blockhash).
- Preflight (default on) verifies signatures and simulates at `preflightCommitment` (default `finalized`); failure returns an error whose `data` follows the `simulateTransaction` result format. `skipPreflight:true` ignores `preflightCommitment`. `maxRetries` caps the node's resend attempts (omitted = retry until finalized or blockhash expiry).
- `encoding` default `base58` (limited to 1,232 bytes — larger v1 transactions only fit `base64`): send `base64`. Signing happens locally — never send a private key to an RPC.

#### simulateTransaction
Dry-run a transaction without submitting it. Params `[txEncoded, {commitment?, encoding?, sigVerify?, replaceRecentBlockhash?, innerInstructions?, accounts?, minContextSlot?}]`.
```json
{"jsonrpc":"2.0","id":1,"method":"simulateTransaction","params":["<BASE64_TX>",{"commitment":"confirmed","encoding":"base64","replaceRecentBlockhash":true,"innerInstructions":true,"accounts":{"addresses":["So11111111111111111111111111111111111111112"],"encoding":"jsonParsed"}}]}
```
```jsonc
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"3.1.8","slot":393226690},"value":{
  "err":null,"unitsConsumed":3520,"fee":5000,
  "logs":["Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]","…","Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success"],
  "accounts":[{"data":{"program":"spl-token","parsed":{"type":"mint","info":{"decimals":9,"isInitialized":true,"supply":"1000000000"}},"space":82},"executable":false,"lamports":1461600,"owner":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","rentEpoch":18446744073709551615,"space":82}],
  "innerInstructions":[{"index":0,"instructions":[{"program":"system","programId":"11111111111111111111111111111111","parsed":{"type":"createAccount","info":{"lamports":2039280,"space":165}},"stackHeight":2}]}],
  "preBalances":[1000000000,0],"postBalances":[997955720,2039280],
  "replacementBlockhash":{"blockhash":"9Vq2rXcT…","lastValidBlockHeight":381186900},
  "returnData":null,"loadedAccountsDataSize":246012,"loadedAddresses":{"readonly":[],"writable":[]}
}},"id":1}
```
- Signatures are optional unless `sigVerify:true`; `sigVerify` and `replaceRecentBlockhash` are **mutually exclusive**. `value.err` non-null (string or `{"InstructionError":[index,…]}`) = the tx would fail; `logs` explain why. Great for estimating `unitsConsumed` before setting a compute-unit limit.

### Node and fees

#### getHealth
Is the node caught up? No params.
```json
{"jsonrpc":"2.0","id":1,"method":"getHealth"}
```
```json
{"jsonrpc":"2.0","result":"ok","id":1}
```
Unhealthy node (error format is documented as unstable):
```json
{"jsonrpc":"2.0","error":{"code":-32005,"message":"Node is behind by 42 slots","data":{"numSlotsBehind":42}},"id":1}
```

#### getVersion
Node software version. No params.
```json
{"jsonrpc":"2.0","id":1,"method":"getVersion"}
```
```json
{"jsonrpc":"2.0","result":{"solana-core":"3.1.8","feature-set":2891131721},"id":1}
```
- `feature-set` may be `null`. Handy to know whether newer methods (e.g. `getAgGenesisCert`, Agave ≥ 4.3) exist.

#### getRecentPrioritizationFees
Recent per-slot prioritization fees (micro-lamports per compute unit). Params `[[address,…]?]` (≤ 128 addresses; **no config object**).
```json
{"jsonrpc":"2.0","id":1,"method":"getRecentPrioritizationFees","params":[["CxELquR1gPP8wHe33gZ4QxqGB3sZ9RSwsJ2KshVewkFY"]]}
```
```json
{"jsonrpc":"2.0","result":[{"slot":348125,"prioritizationFee":0},{"slot":348126,"prioritizationFee":1000},{"slot":348127,"prioritizationFee":500},{"slot":348129,"prioritizationFee":1234}],"id":1}
```
- Returns the node's recent cache (**150 slots** observed live). With addresses: only txs that write-lock **all** of them are counted. Priority fee (lamports) ≈ `computeUnitLimit × microLamportsPerCU / 1,000,000`. Not in Ankr's documented list; Alchemy adds `getPriorityFeeEstimate`.

## 4 · Remaining standard methods (compact)

Same envelope as above; the Params column lists exactly what each method accepts. `?` = optional.

| Method | Params | Returns |
|---|---|---|
| `getLargestAccounts` | `[{commitment?, filter?: "circulating"\|"nonCirculating", sortResults?}]` | 20 largest accounts by lamports (may be cached ≤ 2 h). **Unsupported on Ankr Premium.** |
| `getMinimumBalanceForRentExemption` | `[dataLength, {commitment?}]` | lamports (u64) to make an account of that size rent-exempt |
| `getTokenAccountsByDelegate` | `[delegate, {mint}\|{programId}, {commitment?, encoding?, dataSlice?, minContextSlot?}]` | token accounts with that approved delegate (same shape as `getTokenAccountsByOwner`) |
| `getTokenLargestAccounts` | `[mint, {commitment?}]` | 20 largest token accounts of a mint |
| `getFeeForMessage` | `[base64Message, {commitment?, minContextSlot?}]` | `{context,value}` — lamports the cluster would charge |
| `getTransactionCount` | `[{commitment?, minContextSlot?}]` | total transactions processed (u64) |
| `isBlockhashValid` | `[blockhash, {commitment?, minContextSlot?}]` | `{context,value:bool}` |
| `requestAirdrop` | `[pubkey, lamports, {commitment?, recentBlockhash?}]` | signature — faucet; devnet/testnet only |
| `getBlockCommitment` | `[slot]` | stake-weighted commitment info for a slot |
| `getBlockProduction` | `[{commitment?, identity?, range?}]` | block-production counts per validator identity (current epoch by default) |
| `getBlocks` | `[startSlot, endSlot?, {commitment: confirmed\|finalized}]` | array of confirmed slots (inclusive range) |
| `getBlocksWithLimit` | `[startSlot, limit ≤ 500000, {commitment: confirmed\|finalized}]` | up to `limit` confirmed slots from `startSlot` |
| `getBlockTime` | `[slot]` | unix timestamp (i64) or `null`; `-32004` if block unavailable |
| `getFirstAvailableBlock` | `[]` | lowest confirmed slot still in the node's ledger |
| `getRecentPerformanceSamples` | `[limit? ≤ 720 (default 720)]` | 60-second samples (tx count, slots), newest first |
| `minimumLedgerSlot` | `[]` | lowest slot present in the node's ledger |
| `getClusterNodes` | `[]` | endpoints / versions of known cluster nodes |
| `getEpochSchedule` | `[]` | epoch schedule parameters |
| `getGenesisHash` | `[]` | genesis hash (identifies the cluster) |
| `getHighestSnapshotSlot` | `[]` | `{full, incremental?}`; error `-32008 No snapshot` if none |
| `getIdentity` | `[]` | this node's identity pubkey |
| `getLeaderSchedule` | `[slot\|null?, {commitment?, identity?}]` | leader schedule of the epoch containing `slot` (current epoch if omitted) |
| `getMaxRetransmitSlot` | `[]` | highest slot seen in retransmit |
| `getMaxShredInsertSlot` | `[]` | highest slot with inserted shreds |
| `getSlotLeader` | `[{commitment?, minContextSlot?}]` | current slot leader identity |
| `getSlotLeaders` | `[startSlot, limit 1–5000]` | leader identity per slot in the range |
| `getVoteAccounts` | `[{commitment?, votePubkey?, keepUnstakedDelinquents?, delinquentSlotDistance? (default 128)}]` | `{current:[…], delinquent:[…]}` vote accounts |
| `getInflationGovernor` | `[{commitment?}]` | inflation governor parameters |
| `getInflationRate` | `[]` | current-epoch effective inflation rates |
| `getInflationReward` | `[[address,…], {commitment?, epoch?, minContextSlot?}]` | staking / voting reward per address (previous epoch if `epoch` omitted) |
| `getStakeMinimumDelegation` | `[{commitment?, minContextSlot?}]` | minimum stake delegation, lamports (**not in Ankr's list**) |
| `getSupply` | `[{commitment?, excludeNonCirculatingAccountsList?}]` | total / circulating / non-circulating supply |

That is **52 standard HTTP methods** (the 20 in §3 + 32 above). Newer node-only method: `getAgGenesisCert` (Alpenglow genesis certificate; `null` while TowerBFT is active; Agave ≥ 4.3, older nodes answer `-32601 Method not found`).

**Removed in Agave 2.0 — do not call** (replacement): `getRecentBlockhash` / `getFees` → `getLatestBlockhash` (+ `getFeeForMessage`); `getConfirmedTransaction` → `getTransaction`; `getConfirmedBlock(s)` → `getBlock(s)`; `getConfirmedSignaturesForAddress2` → `getSignaturesForAddress`; `getSignatureStatus` / `confirmTransaction` → `getSignatureStatuses`; `getSnapshotSlot` → `getHighestSnapshotSlot`; `getFeeCalculatorForBlockhash` → `isBlockhashValid` / `getFeeForMessage`; `getStakeActivation` → decode the stake account.

## 5 · Provider extras (non-portable)

- **Alchemy-only** (names from Alchemy's method index; parameters not verified here): `getProgramAccountsV2` and `getTokenAccountsByOwnerV2` (paginated: `limit` 1–10,000 default 1,000, `paginationKey` cursor until it is `null`; V2 program variant also `changedSinceSlot`), `getPriorityFeeEstimate`, `getTransactionsForAddress`, `getTokenHoldersAtSlot`, `getBalanceByOwnerAtSlot`, `getTokenAccountsByOwnerAtSlot`, `simulateTransactionsAtSlot`, `simulateBundle`. Alchemy also still lists `getStakeActivation`, which the official docs mark as removed. `rpc/alchemy.md` additionally records Alchemy's DAS methods (`getAssetsByOwner`, …) and native `*Subscribe` WebSocket on the same endpoint — not verified here.
- **Ankr / BlockPI**: standard methods only (see §1 for the gaps).

## 6 · Recipes

- **Wallet portfolio**: `getBalance` (SOL) + `getTokenAccountsByOwner` with `programId` = Token program, **and again** with Token-2022, `encoding:"jsonParsed"`; convert each `tokenAmount.amount` with `decimals`.
- **Recent activity**: `getSignaturesForAddress(limit)` → `getTransaction(sig, jsonParsed, maxSupportedTransactionVersion:1)` per signature (or `getSignatureStatuses` for just pass/fail).
- **Send + confirm**: `getLatestBlockhash(confirmed)` → build + sign locally → `simulateTransaction` (optional) → `sendTransaction(base64, preflightCommitment:confirmed)` → poll `getSignatureStatuses` → give up when `getBlockHeight` > `lastValidBlockHeight`.

## 7 · Errors

| Code | Seen message | When |
|---|---|---|
| `-32602` | `Invalid param: WrongSize` · ``Method does not support commitment below `confirmed` `` · `Invalid parameter: unknown variant …` · `failed to deserialize …` | bad / missing params, wrong-size signature or pubkey, `processed` where unsupported, missing mint/programId filter, malformed tx |
| `-32004` | `Block not available for slot N` | unavailable (e.g. future) slot (`getBlock`, `getBlockTime`) |
| `-32005` | `Node is behind by N slots` (+ `data.numSlotsBehind`) | `getHealth` on an unhealthy node |
| `-32015` | `Transaction version (1) is not supported by the requesting client. Please try the request again with … "maxSupportedTransactionVersion": 1` (verified live) | `getBlock` / `getTransaction` when a tx is newer than `maxSupportedTransactionVersion` (or the param is omitted) — resend with `1` |
| `-32008` | `No snapshot` | `getHighestSnapshotSlot` |
| `-32601` | Method not found | method unsupported by the node / provider / plan |
| HTTP `429` / `403` | rate-limited / blocked | provider plan limits — back off and retry |

Other codes defined in Agave's RPC source (**not on the doc pages I fetched — unverified here**): `-32001` block cleaned up, `-32002` `sendTransaction` preflight failure (its `data` carries the simulation result), `-32007` slot skipped / missing, `-32009` skipped in long-term storage, `-32010` key excluded from secondary index, `-32011` tx history not available, `-32016` min context slot not reached.

## 8 · Gotchas

- **Commitment defaults to `finalized`**, so default reads lag what `confirmed` / `processed` show. Reading at `finalized` right after `sendTransaction` makes the tx look missing; poll `getSignatureStatuses` instead.
- **Encoding defaults are inconsistent** (§2): `getAccountInfo` returns a base58 *string* by default (base58 is only valid for account data ≤ 128 bytes, per the docs), `getMultipleAccounts` returns `[b64,"base64"]`. Always pass `encoding` explicitly (`base64` for raw, `jsonParsed` for tokens/stakes).
- **`maxSupportedTransactionVersion` must be `1`** (JSON number, not a string) on `getTransaction` / `getBlock`: transaction v1 is live on mainnet, so `0` or omitting it makes `getBlock(full|accounts)` fail wholesale with `-32015` and any v0/v1 `getTransaction` fail. `transactionDetails:"signatures"` / `"none"` never fail on version.
- **`null` is data, not an error**: `getAccountInfo.value`, `getTransaction`, `getSignatureStatuses.value[i]` can be `null` (missing / not yet visible / pruned). `getBalance` of a missing account is `0`.
- **History retention is provider-specific** — Ankr's Solana nodes keep ~16 h; older `getTransaction` / `getBlock` / `getSignaturesForAddress` return `null` or an error. Use an archive-capable provider or explorer API for deep history.
- **`getProgramAccounts` and `getBlock(full)` are the expensive calls** — they hit response-size and timeout limits first. Filter, slice, or switch to `getTokenAccountsByOwner` / `transactionDetails:"signatures"`.
- **Token balances**: query both Token and Token-2022 programs; the token *account* (ATA) address is not the wallet address; `getTokenAccountBalance` wants the token account.
- **Never put private keys or seed phrases in any RPC call.** `sendTransaction` takes an already-signed tx; signing is local.
- **Slots vs blocks vs epochs**: slot numbers have gaps (skipped slots). Don't iterate `getBlock` over consecutive slots without handling `-32004`; use `getBlocks` to list real blocks.
- **Large integers**: parse `rentEpoch` (and any u64 you sum) as BigInt / string; do not use floating point for lamports or raw token amounts.
- The key is part of the URL — keep it out of logs, error reports and shared transcripts.

*Sources checked*: solana.com/docs/rpc, /docs/rpc/http (+ all 52 method pages, `/docs/rpc/deprecated`); Ankr chain list + `chains-api/solana`; Alchemy `rpc/solana` + Solana API index; BlockPI `blockpi.io/chain/solana`, docs Solana index, supported-networks table; behaviours marked "live" were sampled read-only on a public mainnet node.
