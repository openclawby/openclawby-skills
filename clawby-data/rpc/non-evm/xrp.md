# XRP Ledger (XRPL) RPC (BYOK, non-EVM)

XRPL reads and submits using the user's **own node key**, fetched from the Clawby Key Vault. Direct to the provider — not via Clawby relay, no Clawby credits. XRPL is **not** EVM and its JSON-RPC is **not** JSON-RPC 2.0: the body is `{"method":…,"params":[{…}]}` (§3). The server software is `rippled`, renamed `xrpld` in current docs; Ripple's public API servers (`s1`/`s2.ripple.com`) run **Clio**, an API server that serves validated data only and forwards the rest to rippled.

## 1 · Get the key (memory only, never write to disk)

Fetch from the vault as in `rpc/ankr.md` §1 (rules, errors, response shape: `rpc/index.yaml`). **The key sits in the endpoint URL → the whole URL is a secret; never log, echo, or commit it.**

## 2 · Endpoints per provider

| Provider | Endpoint | Notes |
|---|---|---|
| Ankr | `https://rpc.ankr.com/xrp_mainnet/{KEY}` | Slug is **`xrp_mainnet`** (not `xrp`). **Premium plans only** (per Ankr docs). Not archival: only ~the latest two weeks of ledgers; older ledgers/transactions fail. Ankr lists all 18 methods below as supported. Not exercised with a real key. |
| Alchemy | not offered | XRP/XRPL is absent from Alchemy's official chain list; guessed hosts (`xrp-mainnet`, `xrpl-mainnet`, `ripple-mainnet` `.g.alchemy.com`) do not resolve. |
| BlockPI | not offered | No XRP/Ripple entry in BlockPI's docs index (checked 2026-10-24). |

**Free public fallback** (read-only, rate-limited, *not* the user's key; verified 2026-10-24): `https://s1.ripple.com:51234/`, `https://s2.ripple.com:51234/` (Clio, full history from ledger 32570), `https://xrplcluster.com/` (rippled). Same body format as below. Use only for reads, and say so to the user.

## 3 · Request envelope (read this — it differs from every EVM chain)

POST to the **root path** `/`, `Content-Type: application/json`:

```json
{"method":"account_info","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index":"validated"}]}
```
- `method` = command name. `params` = an **array with exactly ONE object** holding all arguments. For methods without arguments send `"params":[{}]`.
- Optional `"api_version": 2` goes **inside** that object (default on JSON-RPC is v1 — response shapes differ for some methods, §4 `account_tx`/`tx`).
- **Not JSON-RPC 2.0.** Verified live: extra `jsonrpc` / `id` fields are silently ignored, `id` is never echoed, there is no top-level `error` object, and `params` as a bare object also works. **No batching** (an array body is rejected: `"batched requests are not supported"` / HTTP 400).
- Missing `method` → HTTP 400, plain text `Null method`.

**Success** → HTTP 200 `{"result":{ …, "status":"success"}}`.
**Error** → still **HTTP 200**: `{"result":{"error":"actNotFound","error_code":19,"error_message":"Account not found.","status":"error","request":{…}}}`. Always test `result.status`. The `request` is echoed back (including any secrets you sent — never send secrets).
```json
{"result":{"error":"actNotFound","error_code":19,"error_message":"Account not found.","status":"error","type":"response","request":{"method":"account_info","params":[{"account":"rrrrrrrrrrrrrrrrrrrrrhoLvTp","ledger_index":"validated"}]}}}
```
Universal errors (any method): `amendmentBlocked`, `invalid_API_version`, `noClosed`, `noCurrent`, `noNetwork`, `tooBusy`, `unknownCmd`. Common method-level errors: `invalidParams`, `actNotFound`, `lgrNotFound` (the requested ledger is not on this server), `txnNotFound`. Clio adds `"warnings":[{"id":2001,…}]` ("this is a clio server") — harmless.

**Ledger specifier** (most methods): `"ledger_index"` = integer, or `"validated"` (latest consensus-validated — use this), `"closed"`, `"current"` (in-progress, not final); or `"ledger_hash"`. Give only one. If omitted, rippled uses `current`, **Clio uses `validated`**. Clio forwards `current`/`closed` requests (and `fee`, `server_state`, `submit`, `ledger_current`, `ledger_closed`, `ripple_path_find`) to a rippled node — responses then also carry top-level `"forwarded":true`.

**Units.** XRP amounts are strings of **drops**: 1 XRP = 1,000,000 drops. Issued currencies (IOUs) are objects `{"currency":"USD","issuer":"r…","value":"13.1"}`. Currency code = 3 chars (`USD`) or 40 hex (`524C555344000000000000000000000000000000` = `RLUSD`). Reserve (server_info 2026-10-24): base **1 XRP** + **0.2 XRP** per owned object; base fee 10 drops. **Time** = seconds since the Ripple epoch (2000-01-01 UTC): Unix = Ripple + 946684800.

**Pagination.** `limit` + `marker`: pass the response `marker` back unchanged; no `marker` = end. A page may be empty yet carry a marker — keep going. Markers expire (~10 min). When paging, first resolve `"validated"` to a number and use that **fixed** `ledger_index` for every page.

## 4 · Method catalog

Params are keys inside the single params object. `ledger_hash` / `ledger_index` are accepted by every ledger-scoped method and are not repeated in the tables. Examples are live responses from 2026-10-24 (Bitstamp issuer `rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`), trimmed.

### Accounts

#### account_info
XRP balance, sequence, flags of one account. Params: `account` (required), `queue` (bool; current ledger only), `signer_lists` (bool). Errors: `actNotFound` (account never funded), `invalidParams`, `lgrNotFound`.
```json
{"method":"account_info","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index":"validated","signer_lists":true}]}
```
```json
{"result":{"account_data":{"Account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","Balance":"412602491965","Domain":"6269747374616D702E6E6574","Flags":10092544,"LedgerEntryType":"AccountRoot","OwnerCount":378,"PreviousTxnID":"68D08AD7B5F6975A33AF0CB3DB21A3D2A0E4E9D79E3A765DCF89E689BEE13F44","PreviousTxnLgrSeq":107878667,"Sequence":4827,"TransferRate":1001500000,"index":"B7D526FDDF9E3B3F95C3DC97C353065B0482302500BBB8051A5C090B596C6133","signer_lists":[]},"ledger_hash":"A6607253CD175ADA4FD42A9FD1DDFF31D0E3D58F5ED53B194B4AC7490C432F74","ledger_index":107879359,"validated":true,"account_flags":{"defaultRipple":true,"depositAuth":false,"disableMasterKey":true,"requireDestinationTag":true,"globalFreeze":false},"status":"success"}}
```
`Balance` is **drops** (412602491965 = 412,602.491965 XRP). `Sequence` is the next transaction sequence. IOU balances are NOT here (use `account_lines`). With `signer_lists`, API v1 nests `signer_lists` inside `account_data`; v2 puts it at the result root.

#### account_lines
Trust lines (IOU balances) from this account's side. Params: `account` (required), `peer` (filter to one counterparty), `limit` (10–400, default 200), `marker`, `ignore_default` (bool).
```json
{"method":"account_lines","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index":"validated","limit":10}]}
```
```json
{"result":{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_hash":"A6607253CD175ADA4FD42A9FD1DDFF31D0E3D58F5ED53B194B4AC7490C432F74","ledger_index":107879359,"validated":true,"limit":10,"lines":[{"account":"rKUK9omZqVEnraCipKNFb5q4tuNTeqEDZS","balance":"0","currency":"BTC","limit":"0","limit_peer":"10","quality_in":0,"quality_out":0},{"account":"rngJ9Co6MPZxJcyepRv2hMPV1HqaeGCdVU","balance":"0","currency":"USD","limit":"0","limit_peer":"250","quality_in":0,"quality_out":0,"no_ripple_peer":true}],"marker":"007F346CE0FAC48A51B1865F848F85AFAB0BA6253437E56012F06988A3E6FBAD,0","status":"success"}}
```
`balance` is from the queried account's perspective: positive = it holds value, **negative = it owes** (an issuer shows negative balances). `account` in each line is the counterparty (issuer for holders).

#### account_objects
All ledger entries the account owns, in raw format. Params: `account` (required), `type` (filter; canonical name like `RippleState` or short name, case-insensitive: `state` = trust lines, `offer`, `check`, `escrow`, `payment_channel`, `signer_list`, `ticket`, `nft_offer`, `deposit_preauth`, …; only types that can appear in an owner directory are allowed), `deletion_blockers_only` (bool), `limit` (10–400, default 200), `marker`.
```json
{"method":"account_objects","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index":"validated","type":"state","limit":10}]}
```
```json
{"result":{"ledger_hash":"A6607253CD175ADA4FD42A9FD1DDFF31D0E3D58F5ED53B194B4AC7490C432F74","ledger_index":107879359,"validated":true,"limit":10,"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","account_objects":[{"Balance":{"currency":"BTC","issuer":"rrrrrrrrrrrrrrrrrrrrBZbvji","value":"0"},"Flags":131072,"HighLimit":{"currency":"BTC","issuer":"rKUK9omZqVEnraCipKNFb5q4tuNTeqEDZS","value":"10"},"HighNode":"0","LedgerEntryType":"RippleState","LowLimit":{"currency":"BTC","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","value":"0"},"LowNode":"0","PreviousTxnID":"87591A63051645F37B85D1FBA55EE69B1C96BFF16904F5C99F03FB93D42D0375","PreviousTxnLgrSeq":746872,"index":"000103996A3BAD918657F86E12A67D693E8FC8A814DA4B958A244B5F14D93E58"}],"marker":"007F346CE0FAC48A51B1865F848F85AFAB0BA6253437E56012F06988A3E6FBAD,0","status":"success"}}
```
`account_objects` can be **empty while a `marker` is present** (especially with `type`): keep paging until no marker.

#### account_tx
The main **history** call: validated transactions touching an account. Params: `account` (required), `ledger_index_min` / `ledger_index_max` (`-1` = earliest/latest available), `ledger_hash`/`ledger_index` (one ledger only; v2 rejects combining with min/max), `forward` (bool; default `false` = newest first), `limit` (server may ignore), `marker`, `binary` (bool). Clio-only: `tx_type` (e.g. `"Payment"`), `mpt_issuance_id`.
```json
{"method":"account_tx","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index_min":-1,"ledger_index_max":-1,"forward":false,"limit":2,"api_version":2}]}
```
```json
{"result":{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index_min":32570,"ledger_index_max":107879383,"transactions":[{"meta":{"AffectedNodes":"<trimmed>","TransactionIndex":165,"TransactionResult":"tesSUCCESS"},"tx_json":{"Account":"rBERMc8i2DoMkMDHGF38acFMfudsBffdwA","Fee":"12","Flags":524288,"LastLedgerSequence":107879392,"OfferSequence":68540913,"Sequence":68540921,"TakerGets":{"currency":"USD","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","value":"98.16322119914013"},"TakerPays":{"currency":"524C555344000000000000000000000000000000","issuer":"rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De","value":"98.1092513"},"TransactionType":"OfferCreate"},"ledger_index":107879383,"hash":"39C47D6846E04B225BE0C156988628231765A967C87B26F07C5A80055EFBCA8E","ledger_hash":"2AB31A8F9AD36A79EABCEC0DCE2E57E5726AF1BD38C874F8E4785985DB459508","close_time_iso":"2026-10-24T21:23:11Z","validated":true}],"validated":true,"marker":{"ledger":107879383,"seq":165},"limit":2,"status":"success"}}
```
**v1 vs v2:** with `api_version` omitted (v1) each entry is `{"meta":{…},"tx":{… "hash":"…","date":…},"validated":true}`; with `api_version:2` it is `tx_json` + top-level `hash`, `ledger_index`, `ledger_hash`, `close_time_iso`, `meta`. Pick one and parse accordingly. Page by passing `marker` back with the same range. `meta.TransactionResult` must be `tesSUCCESS` for the effect to have applied (`tec*` results are validated but failed; fee still charged). Payment amount actually delivered: `meta.delivered_amount` (not `tx.Amount`).

#### account_currencies
Currencies an account can send/receive per its trust lines (UI helper; not exhaustive). Params: `account` (required).
```json
{"method":"account_currencies","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index":"validated"}]}
```
```json
{"result":{"ledger_hash":"B1A1D08DFC22AAD424945DCAA95541D35772537EA89268753FEC36BAFD095C73","ledger_index":107879360,"validated":true,"receive_currencies":["AUD","BTC","CHF","ETH","EUR","GBP","JPY","USD"],"send_currencies":["#$%","0000000000000000000000005852500000000000","100","4141564500000000000000000000000000000000","524C555344000000000000000000000000000000","5553440000000000000000000000000000000000"],"status":"success"}}
```
Does not check freezes/authorization. Codes may be 40-hex.

#### gateway_balances
Total IOUs an **issuer** has outstanding. Params: `account` (the issuer, required), `strict` (bool: only accept an address), `hotwallet` (string or array of operational addresses to exclude from `obligations`). Some public servers disable this method (heavy).
```json
{"method":"gateway_balances","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index":"validated","strict":true}]}
```
```json
{"result":{"obligations":{"AUD":"8692.124775162521","BTC":"323.3779989975072","CHF":"8999.899901060894","ETH":"380.9663424909672","EUR":"4960395.162374812","GBP":"2358.979490177198","JPY":"898766.5053091126","USD":"7879888.457823654"},"frozen_balances":{"rEDtyWDqWs9q1aZY82bjoetpADy7iviqhz":[{"currency":"BTC","value":"12.31459690692563"}]},"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","ledger_index":107879360,"ledger_hash":"B1A1D08DFC22AAD424945DCAA95541D35772537EA89268753FEC36BAFD095C73","status":"success"}}
```
`obligations` = what the issuer owes holders (circulating supply per currency). Other fields (omitted if empty): `balances` (held by your `hotwallet`s), `assets`, `frozen_balances`, `locked` (in escrow). Excludes MPTs. Error `invalidHotWallet` if a hotwallet isn't a holder.

#### noripple_check
Compare Default Ripple / No Ripple settings with recommendations. Params: `account`, `role` (`"gateway"` or `"user"`, both required), `transactions` (bool: include fix-up txs), `limit` (default 300).
```json
{"method":"noripple_check","params":[{"account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","role":"gateway","ledger_index":"validated","limit":2,"transactions":true}]}
```
```json
{"result":{"ledger_hash":"B33127F3A868DD5FE9E0A8E58F631E0B5F7FB109FBBCDE4AFAF9F38E2BDB23D4","ledger_index":107879361,"problems":[],"validated":true,"transactions":[],"status":"success"}}
```
Empty `problems` = settings match the recommendation for that role. The suggested `transactions` are unsigned; this method never changes anything.

### Transactions

#### tx
One transaction by hash (or CTID). Params: `transaction` (256-bit hash, hex) **or** `ctid` (uppercase hex) — exactly one; `binary` (bool); `min_ledger` + `max_ledger` (up to 1000 apart; makes a not-found result conclusive).
```json
{"method":"tx","params":[{"transaction":"84BD3C6A93EC5F59B1723BA1CBBD91127E3889B38E0EE9CFC311E7D2751CB0D7","binary":false,"api_version":2}]}
```
```json
{"result":{"tx_json":{"Account":"rMsXVzCug7nUsMYFGPXBTWY732fRZqxgfY","Fee":"5223","Flags":65536,"LastLedgerSequence":107879378,"OfferSequence":90504906,"Sequence":0,"TakerGets":{"currency":"524C555344000000000000000000000000000000","issuer":"rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De","value":"1909.07386"},"TakerPays":{"currency":"ETH","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","value":"0.81741"},"TicketSequence":90504905,"TransactionType":"OfferCreate"},"hash":"84BD3C6A93EC5F59B1723BA1CBBD91127E3889B38E0EE9CFC311E7D2751CB0D7","meta":{"AffectedNodes":"<trimmed>","TransactionIndex":274,"TransactionResult":"tesSUCCESS"},"validated":true,"ledger_index":107879360,"ledger_hash":"B1A1D08DFC22AAD424945DCAA95541D35772537EA89268753FEC36BAFD095C73","close_time_iso":"2026-10-24T21:21:40Z","ctid":"C66E1BC001120000","status":"success"}}
```
v1 (default) flattens the transaction fields at the top of `result` plus `hash`, `inLedger`, `ledger_index`, `date`, `meta`. `validated:false` or absent = not final. Not found: `error:"txnNotFound"` — means *either* never executed *or* outside this server's history; add `min_ledger`/`max_ledger` and read `searched_all` to tell. Other errors: `excessiveLgrRange`, `invalidLgrRange`.

#### submit
Broadcast a **signed** transaction. **Moves funds / changes state — only on explicit user instruction.** Params (submit-only mode): `tx_blob` (hex of the fully signed, serialized transaction), `fail_hard` (bool: don't relay/retry if it fails locally).
```json
{"method":"submit","params":[{"tx_blob":"<hex of signed transaction>","fail_hard":false}]}
```
```json
{"result":{"accepted":true,"account_sequence_available":362,"account_sequence_next":362,"applied":true,"broadcast":true,"engine_result":"tesSUCCESS","engine_result_code":0,"engine_result_message":"The transaction was applied. Only final in a validated ledger.","kept":true,"open_ledger_cost":"10","queued":false,"status":"success","tx_blob":"<hex>","tx_json":{"Account":"rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn","Fee":"10000","Sequence":361,"TransactionType":"Payment","hash":"5B31A7518DC304D5327B4887CD1F7DC2C38D5F684170097020C7C9758B973847"},"validated_ledger_index":21184416}}
```
(Success shape from the XRPL docs; not executed. Malformed blob live-tested: `{"result":{"error":"invalidTransaction","error_exception":"Transaction length invalid","status":"error"}}`.)
`status:"success"` only means the server **received** it. `engine_result` is *preliminary*: `tes*` applied to the open ledger, `ter*` retry, `tec*` claimed fee but failed, `tef*`/`tem*`/`tel*` rejected. Final only when a later `tx` call shows `validated:true` with `TransactionResult` `tesSUCCESS`. Safe to re-submit the same blob (same sequence → applied once). Set `LastLedgerSequence` when signing. **Never use sign-and-submit (`secret`/`seed` in params): keys must never leave the signer, errors echo the request, and public servers disable it.** Sign locally (xrpl.js / xrpl-py) and send only `tx_blob`.

### Ledgers

#### ledger
Header (and optionally transactions) of one ledger. Params: `transactions` (bool), `expand` (bool: full JSON instead of hashes), `owner_funds` (bool), `binary` (bool), `queue` (bool; current ledger only).
```json
{"method":"ledger","params":[{"ledger_index":"validated","transactions":false,"expand":false}]}
```
```json
{"result":{"ledger_hash":"B33127F3A868DD5FE9E0A8E58F631E0B5F7FB109FBBCDE4AFAF9F38E2BDB23D4","ledger_index":107879361,"validated":true,"ledger":{"account_hash":"983F97387F6DCCCDAE029F933B0058408B25F7042FA22276156038C34D629C44","close_flags":0,"close_time":846192101,"close_time_human":"2026-Oct-24 21:21:41.000000000 UTC","close_time_resolution":10,"close_time_iso":"2026-10-24T21:21:41Z","ledger_hash":"B33127F3A868DD5FE9E0A8E58F631E0B5F7FB109FBBCDE4AFAF9F38E2BDB23D4","parent_close_time":846192100,"parent_hash":"B1A1D08DFC22AAD424945DCAA95541D35772537EA89268753FEC36BAFD095C73","total_coins":"99985584122583303","transaction_hash":"672444D531428A72806387F3501EFD809CCA4D072245CF8909C9875688F452C1","ledger_index":"107879361","closed":true},"status":"success"}}
```
`total_coins` is drops (declines as fees burn). `ledger.ledger_index` is a string in v1, number in v2. `transactions:true` lists tx hashes; add `expand:true` for full objects (large).

#### ledger_current
Index of the in-progress ledger. Params: none (`"params":[{}]`).
```json
{"method":"ledger_current","params":[{}]}
```
```json
{"result":{"ledger_current_index":107879362,"status":"success"}}
```
No hash exists (still changing). Mostly for testing.

#### ledger_closed
Hash and index of the most recently closed (not necessarily validated) ledger. Params: none.
```json
{"method":"ledger_closed","params":[{}]}
```
```json
{"result":{"ledger_hash":"B33127F3A868DD5FE9E0A8E58F631E0B5F7FB109FBBCDE4AFAF9F38E2BDB23D4","ledger_index":107879361,"status":"success"}}
```

#### ledger_data
Raw ledger state, paged — heavy; prefer targeted methods. Params: `limit` (max 256 JSON / 2048 binary), `marker`, `binary` (bool), `type` (filter by entry type, canonical or short name, e.g. `account`, `offer`, `state`, `directory`).
```json
{"method":"ledger_data","params":[{"ledger_index":"validated","limit":2}]}
```
```json
{"result":{"ledger_hash":"2AA0C7F2011A42070B6E1ABA18DDA47127AA39300996D5132285D2EC76C225D6","ledger_index":107879362,"validated":true,"state":[{"Flags":0,"IndexNext":"426","IndexPrevious":"424","Indexes":["6BE53687261B6ED0F7C537328D1EA76F0F8A26264B973D85F6AA8B915C9EEF32"],"LedgerEntryType":"DirectoryNode","Owner":"rEMzCUeRZbx6ydthbi2RVNYdRbuqqsrYof","RootIndex":"BADEFEDEA9826CDFBD479D5747E441220ADC501BB32C8FE5D88C6C3CB629F542","index":"00000203EA7B91B283192593F8847E6641930185B3689530AAE24A64A815FF58"}],"ledger":{"ledger_hash":"2AA0C7F2011A42070B6E1ABA18DDA47127AA39300996D5132285D2EC76C225D6","ledger_index":"107879362","close_time_iso":"2026-10-24T21:21:50Z","total_coins":"99985584122519749","closed":true},"marker":"00000203EA7B91B283192593F8847E6641930185B3689530AAE24A64A815FF58","status":"success"}}
```
The full ledger is millions of entries — never walk it without a `type` filter and a fixed `ledger_index`. The `ledger` header only appears on the first page.

### Server and fees

#### server_info
Human-readable server status (also the best liveness / "which ledgers do you have" check). Params: `counters` (bool).
```json
{"method":"server_info","params":[{}]}
```
```json
{"result":{"info":{"build_version":"3.4.1","complete_ledgers":"32570-107879721","server_state":"full","load_factor":1,"peers":133,"network_id":0,"validation_quorum":0,"uptime":74466,"validated_ledger":{"seq":107879721,"hash":"6688E8286C87F7AA174B62D81BDFC972B9C2A2CB7D3DF49D475EEFEBF47FA78A","age":0,"base_fee_xrp":1e-05,"reserve_base_xrp":1,"reserve_inc_xrp":0.2},"last_close":{"converge_time_s":2.893,"proposers":35}},"status":"success"}}
```
Look at `server_state` (`full` = healthy), `validated_ledger.age` (seconds behind), and `complete_ledgers` (the history this server holds — on Ankr expect only ~2 weeks). XRP values here are decimal XRP; `server_state` gives integer drops. A Clio node answers with a different `info` (`clio_version`, `libxrpl_version`, `rippled_version`, `validated_ledger`, `network_id`, no `server_state`).

#### server_state
Same data, machine units (drops, ms). Params: none; on Clio send `{"ledger_index":"current"}` to forward it to a rippled node.
```json
{"method":"server_state","params":[{"ledger_index":"current"}]}
```
```json
{"result":{"state":{"build_version":"3.4.1","complete_ledgers":"106699639-107879362","server_state":"full","load_base":256,"load_factor":130056,"peers":261,"network_id":0,"validated_ledger":{"base_fee":10,"close_time":846192110,"hash":"2AA0C7F2011A42070B6E1ABA18DDA47127AA39300996D5132285D2EC76C225D6","reserve_base":1000000,"reserve_inc":200000,"seq":107879362},"validation_quorum":28},"status":"success"}}
```
`reserve_base` 1000000 drops = 1 XRP, `reserve_inc` 200000 = 0.2 XRP. `load_factor` / `load_base` > 1 means the fee is escalated.

#### fee
Current transaction-cost requirements. Params: none.
```json
{"method":"fee","params":[{}]}
```
```json
{"result":{"current_ledger_size":"503","current_queue_size":"52","drops":{"base_fee":"10","median_fee":"5000","minimum_fee":"10","open_ledger_fee":"5061"},"expected_ledger_size":"500","ledger_current_index":107879363,"levels":{"median_level":"128000","minimum_level":"256","open_ledger_level":"129540","reference_level":"256"},"max_queue_size":"10000","status":"success"}}
```
For a normal transaction to enter the **open ledger now**, set `Fee` ≥ `drops.open_ledger_fee`; to be **queued**, ≥ `drops.minimum_fee`. Under load (as in this sample) the open-ledger fee can be 500× the 10-drop base. All numbers are strings of drops.

### Order books and paths

#### book_offers
The order book for a currency pair. Params: `taker_gets` and `taker_pays` (required; each `{"currency":"XRP"}` or `{"currency":"USD","issuer":"r…"}`, no amounts), `limit`, `taker` (address: also shows that account's unfunded offers).
```json
{"method":"book_offers","params":[{"taker_gets":{"currency":"XRP"},"taker_pays":{"currency":"USD","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B"},"limit":2}]}
```
```json
{"result":{"ledger_hash":"2AB31A8F9AD36A79EABCEC0DCE2E57E5726AF1BD38C874F8E4785985DB459508","ledger_index":107879383,"offers":[{"Account":"rsPrWzpYp5jj278vHVgp1tMvbKdHAZGFbi","BookDirectory":"DFA3B6DDAB58C7E8E5D944E736DA4B7046C30E4F460FD9DE4F04CDC77691DF60","Flags":0,"LedgerEntryType":"Offer","Sequence":10221995,"TakerGets":"473118749","TakerPays":{"currency":"USD","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","value":"639.7305814655416"},"index":"9F46A39081EC54E17B52AFC1BC52293153E2EB084A2AF4139ABAADFF0DDCF3F2","owner_funds":"1225497004","quality":"0.0000013521564783"}],"status":"success"}}
```
Read it from the **taker's** side: you receive `TakerGets` (here 473,118,749 drops = 473.12 XRP) and pay `TakerPays` (639.73 USD). `quality` = `TakerPays / TakerGets`; with XRP in drops multiply by 1,000,000 → 1.352 USD per XRP. Unfunded offers are omitted; partially funded ones carry `taker_gets_funded` / `taker_pays_funded`. For the opposite side swap `taker_gets`/`taker_pays`. Error `badMarket` = same currency on both sides.

#### ripple_path_find
One-shot payment pathfinding (cross-currency routes). Params: `source_account`, `destination_account`, `destination_amount` (all required; amount `"-1"` / `value:"-1"` = deliver as much as possible), `send_max` **or** `source_currencies` (≤ 18 entries; not both), `domain`.
```json
{"method":"ripple_path_find","params":[{"source_account":"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh","destination_account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","destination_amount":{"currency":"USD","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","value":"1"},"source_currencies":[{"currency":"XRP"}]}]}
```
```json
{"result":{"alternatives":[{"paths_canonical":[],"paths_computed":[[{"currency":"USD","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","type":48}]],"source_amount":"777512"}],"destination_account":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","destination_amount":{"currency":"USD","issuer":"rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B","value":"1"},"destination_currencies":["JPY","CHF","ETH","EUR","USD","GBP","BTC","AUD","XRP"],"full_reply":true,"source_account":"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh","status":"success"}}
```
Each alternative's `source_amount` is what the sender must spend (here `"777512"` drops = 0.777512 XRP for 1 USD). Use `paths_computed` as the `Paths` of a Payment. Results go stale in seconds; the server may return suboptimal paths under load — do not trust a single untrusted server for large payments. `path_find` (streaming) is WebSocket-only.

## 5 · Other methods (names only — not exampled here)

From the official public-methods index, same envelope: `account_channels`, `account_nfts`, `account_offers`, `ledger_entry`, `transaction_entry`, `submit_multisigned`, `simulate`, `amm_info`, `book_changes`, `deposit_authorized`, `get_aggregate_price`, `nft_buy_offers`, `nft_sell_offers`, `channel_verify`, `feature`, `manifest`, `server_definitions`, `version`, `ping`, `random`, `tx_history` (deprecated; use `account_tx`). Clio-only: `nft_info`, `nft_history`, `nfts_by_issuer`, `mpt_holders`, `account_mptokens`, `account_mptoken_issuances`, `vault_info`. WebSocket-only: `subscribe`, `unsubscribe`, `path_find`. Admin-only by default (don't use on shared servers): `sign`, `sign_for`, `channel_authorize`.

## 6 · Gotchas

- **Envelope:** `{"method","params":[{…}]}` only. No `jsonrpc`/`id` semantics, no batching, errors are HTTP 200 with `result.status:"error"`.
- **Drops:** every XRP amount is a string of drops (÷1,000,000). `Balance`, `Fee`, `TakerGets` (XRP side), `source_amount`, fee values — all drops. IOU `value` strings are decimal and can be huge/tiny (`"5444166510000000e-26"`).
- **Always set the ledger:** `"ledger_index":"validated"` for final data. `current` data can change or be dropped. Clio rejects non-validated specific ledgers with `lgrNotFound`.
- **History depth:** `complete_ledgers` in `server_info` tells you what the node has. Ankr XRP ≈ two weeks; Ripple's public Clio servers have everything since ledger 32570. A `txnNotFound` or `lgrNotFound` on an old item usually means "not on this node".
- **Paging:** fixed `ledger_index` + the unchanged `marker`; `limit` is a hint (servers may return fewer/more); `account_objects`/`account_tx` can return empty pages with a marker.
- **API versions:** v1 (default) vs v2 (`api_version:2` inside params) change `account_tx`/`tx`/`ledger` shapes (`tx` vs `tx_json`, string vs number `ledger_index`, `signer_lists` placement). Don't mix parsers.
- **Success ≠ applied:** for `submit`, trust only a `validated:true` `tx` result with `tesSUCCESS`. `tec*` results are on-ledger failures that still cost the fee.
- **XRP vs tokens:** `account_info` has XRP only; trust-line tokens via `account_lines`; MPTs via Clio `account_mptokens`. Negative `account_lines` balance = the account is the issuer/owes.
- **Fees spike:** read `fee` right before signing; stale fees are the usual cause of `terQUEUED`/`telINSUF_FEE_P`.
- **Secrets:** never send `secret`/`seed`/`passphrase` to any RPC; error replies echo the whole request. Sign locally.
- Wrong key or slug on Ankr → bare nginx 404, not JSON. Ankr documents XRP as Premium-only, so a free-tier key may be refused (not tested).

Sources: XRPL docs (`xrpl.org` → References → HTTP/WebSocket APIs → Public API Methods; request/response formatting, markers & pagination, basic data types; page sources in `XRPLF/xrpl-dev-portal`); Ankr XRP chain + API pages; Alchemy & BlockPI chain lists; live calls on `s1.ripple.com:51234` (Clio 2.8.0 / rippled 3.4.1) and `xrplcluster.com` on 2026-10-24.
