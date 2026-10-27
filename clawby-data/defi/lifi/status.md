# LI.FI — tracking a cross-chain transfer (GET /status)

After you broadcast a **cross-chain** `transactionRequest`, the source-chain receipt only proves
the funds *left* — it does not prove they *arrived*. Poll `/status` until the destination side
settles. (A **same-chain** swap has no destination leg: its on-chain receipt is the whole story —
confirm it via `execute.md`'s `--confirm` and you're done.)

## Query params

| Name | Req | Meaning |
|---|---|---|
| `txHash` | ✓ | The sending-chain tx hash (also accepts the receiving-chain hash or a LI.FI step id). |
| `fromChain` | | Source chain (numeric id). Recommended — speeds up the lookup. |
| `toChain` | | Destination chain (numeric id). |
| `bridge` | | The bridge `key` that handled it (from `/tools`), if you know it from the quote (`tool`). |

Use **numeric chain IDs** (upper-case aliases error with code 1011).

```bash
curl -s "${H[@]}" "https://li.quest/v1/status?txHash=$TX&fromChain=42161&toChain=8453"
```

## Response

- `status`: `NOT_FOUND` · `PENDING` · `DONE` · `FAILED` (`INVALID` = unexpected).
- `substatus` (+ `substatusMessage`): e.g. `WAIT_SOURCE_CONFIRMATIONS`, `WAIT_DESTINATION_TRANSACTION`,
  `COMPLETED`, `PARTIAL`, `REFUND_IN_PROGRESS`, `REFUNDED`, `BRIDGE_NOT_AVAILABLE`, `UNKNOWN_ERROR`.
- `sending` (always) and `receiving` (once it exists): `{ txHash, txLink (explorer URL), amount
  (smallest units), token{…}, chainId, gasAmount, … }`.
- `transactionId` = the transfer id (not a hash). `quote.estimate` (if present) lets you compare
  the estimate against the actual `receiving`.

## Polling loop

1. **Set a budget first** — a max duration and an interval (e.g. every 5–10 s). `quote.estimate.executionDuration` hints the window (Across settled in ~2 s in testing; slower bridges take minutes).
2. **Keep polling on "not found"** — both HTTP `404` (code `1003`) and HTTP `200` with
   `status:NOT_FOUND` just mean "not indexed yet," **never** failure and **never** a reason to re-send.
3. **`PENDING`** → keep polling; read `substatus` for progress.
4. **`DONE`** → check `substatus` before declaring success: `COMPLETED` is full success;
   `PARTIAL`/`REFUNDED` are *also* `DONE`. Then verify `receiving` (`txHash`, `amount`, `token`)
   and compare to `quote.estimate`.
5. **`FAILED`** → report it verbatim; don't improvise recovery. Check the status-tracking guide.
6. **Timeout** → outcome unknown. **Do not resubmit.** Look up the source tx on-chain first, then
   keep querying `/status` — a slow bridge can still land after your window closed.

```bash
# poll to a terminal state (budget ~10 min, 8 s interval)
for i in $(seq 1 75); do
  S="$(curl -s "${H[@]}" "https://li.quest/v1/status?txHash=$TX&fromChain=$FROM&toChain=$TO")"
  st="$(printf '%s' "$S" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))')"
  echo "status=$st"
  case "$st" in DONE|FAILED) echo "$S"; break;; esac
  sleep 8
done
```
