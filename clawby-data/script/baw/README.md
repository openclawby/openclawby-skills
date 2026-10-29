# script/baw/ — fast one-shot helpers for the Binance Agentic Wallet (`baw`)

These scripts exist for **ONE reason: speed on time-sensitive on-chain actions**. They
collapse `baw`'s multi-step flows — `preview → confirm → execute`, and
`submit → poll → poll → terminal` — which the agent would otherwise run as several separate
turns, into a **single process = a single agent turn**, which is where most of the latency
goes.

> Thin wrappers around `baw` (`exec/baw/baw.md` is the full connector guide). They run
> **locally with the user's own wallet**, inherit your shell environment (including any
> proxy — nothing about the proxy is hardcoded here), and **never route through Clawby**.
> Run them with `bash script/baw/<name>.sh …` (fetched over HTTP on skill-update, so don't
> rely on an executable bit). `_lib.sh` is shared code (sourced by the others), not run
> directly.

## `yolo` mode (how the fast path is armed)

The fast path (auto-execute with no mid-flow pause) is a **mode that is OFF by default**.

- **Default (yolo OFF)** — the agent runs the safe path: preview/quote, show you the result
  + risks, wait for your confirmation, then execute. It does **not** pass `--yes`.
- **Enabling it** — the first time an action would move funds (send / swap / contract-call /
  sign / rescue) while yolo is off, the agent **asks whether to enable yolo mode**; on your
  "yes" it turns the mode ON. You can also toggle it yourself any time — say **"enable yolo
  mode" / "开启 yolo 模式"** or **"disable yolo mode" / "关闭 yolo 模式"**.
- **While yolo is ON** — the agent may run the write scripts with `--yes` (skipping the
  per-action confirmation) for **every** subsequent baw write, without asking again. The mode
  is **sticky** until you disable it (or the session ends).

yolo mode does **not** disable safety. The non-bypassable risk gate below still applies and
still aborts, even with `--yes`.

## Safety gate (non-bypassable — fires even with `--yes` / `yolo`)

Every `preview → execute` fast path (`fast-contract-call.sh`, `fast-sign.sh`,
`preview-stage.sh`) runs the real `baw` preview and **aborts before executing** if:

- preview failed or was intercepted (`success:false`, or no `requestId` — e.g. risk block
  `351803`);
- preview returned a **`RISK`**-level item, or a counterparty address with `riskLevel >= 4`;
- `requireConfirmation:true` — needs a Binance App tap, so it is not a fast path.

`CAUTION`-level items are printed, not blocking. For `fast-swap.sh` you must still run the
swap **security pre-check** on the target token yourself (a script can't audit it).
The scripts only remove *turns*, not `baw`'s own trust checks.

## Prerequisites

- `baw` installed + signed in (`bash script/baw/warmup.sh`). For `contract-call`/
  `sign-message`, **Developer Mode ON** (7-day window; enable in the Binance App). Turning
  it on **ahead** of the time-sensitive moment is the single biggest latency win.
- `bash` + `python3` (python3 parses `baw --json` safely). EVM receipt confirmation also
  uses `curl`.

## Scripts

| Script | Flow it collapses | Default / `--yes` |
|---|---|---|
| `warmup.sh` | one-time readiness (signed in? Dev Mode? session?) | read-only |
| `fast-contract-call.sh` | `preview → gate → execute [→ --confirm receipt]` | default stops after preview |
| `fast-sign.sh` | `sign-message preview → gate → execute` (EIP-712 / Permit2) | default stops after preview |
| `preview-stage.sh` + `fire-execute.sh` | pre-build preview now; fire `execute` at the trigger instant | stage never executes |
| `fast-swap.sh` | `swap → poll to FINISHED/FAILED` (gas HIGH) | default prints a quote |
| `fast-send.sh` | `send [→ --confirm receipt]` (gas HIGH) | default prints the intent |
| `snapshot.sh` | 5 independent reads in **parallel** → one turn | read-only |
| `rescue.sh` | pending `tx-history → speed-up/cancel` the first stuck tx | default lists the tx |

### Common options

- `--yes` — the pre-authorization the agent passes **only while yolo mode is ON** (see the
  yolo rule above); without it the write scripts preview/quote and **stop**.
- `--confirm` (`fast-contract-call.sh`, `fire-execute.sh`, `fast-send.sh`) — after a
  `txHash`, poll the chain's **public RPC** (`rpc/index.yaml` endpoints) for the receipt and
  report `CONFIRMED` / `REVERTED` / `PENDING` (EVM only).
- `--gasLevel HIGH|MEDIUM|LOW` — `fast-swap.sh` / `fast-send.sh` default to **HIGH** (fastest
  inclusion); override to save fees.
- Env: `BAW_CONFIRM_TIMEOUT` (poll budget, default 60s), `BAW_POLL_INTERVAL` (default 3s),
  `BAW_STAGE_FILE` (preview-stage/fire-execute stage path).

### Examples

```bash
bash script/baw/warmup.sh                       # once, up front

# contract call now (yolo mode on); confirm on chain too
bash script/baw/fast-contract-call.sh --binanceChainId 56 --from 0x.. --to 0x.. --value 0 --inputData 0x.. --yes --confirm

# pre-stage, then fire at the trigger instant
bash script/baw/preview-stage.sh --binanceChainId 56 --from 0x.. --to 0x.. --inputData 0x..
bash script/baw/fire-execute.sh --confirm

# swap (gas HIGH), poll to terminal
bash script/baw/fast-swap.sh --fromTokenQty 0.1 --fromToken 0x.. --toToken 0x.. --binanceChainId 56 --yes

# send + on-chain confirm
bash script/baw/fast-send.sh --amount 10 --recipient 0x..5678 --binanceChainId 56 --tokenAddress 0x.. --yes --confirm

# EIP-712 / Permit2 signature
bash script/baw/fast-sign.sh --binanceChainId 1 --signType EIP712 --message '<eth_signTypedData_v4 json>' --yes

# wallet snapshot in one turn
bash script/baw/snapshot.sh --binanceChainId 56

# unstick a pending tx (speed up, or --cancel)
bash script/baw/rescue.sh --yes          # speed-up the first pending tx (gas HIGH)
bash script/baw/rescue.sh --cancel --yes # cancel it instead
```

## Beyond the scripts (biggest non-script latency wins)

1. **Pre-stage the slow setup OUTSIDE the time window**: sign in, turn on Developer Mode
   (7 days), pre-approve token allowances, and pre-build the preview (`preview-stage.sh`).
   The trigger then costs one `execute`.
2. **Don't re-run preflight / gas / session checks per action** — `warmup.sh` once per
   session.
3. **Gas tier** — `fast-swap.sh` / `fast-send.sh` default to `--gasLevel HIGH`.
4. **Proxy** — a slow proxy multiplies every round-trip; a low-latency/close proxy helps the
   per-call network cost the scripts can't remove.

## Caveat

The `execute` paths move real funds and depend on your live `baw` session + proxy, so they
are written from Binance's official reference, not end-to-end tested against a live wallet
here (the logic — gates, polling, parsing — is tested with fakes). **Validate with one small
transaction first.**
