# Qwen — Alibaba DashScope / Model Studio (BYOK)

Chat with Qwen using the user's **own Alibaba Cloud Model Studio (DashScope) key**, fetched from the Clawby Key Vault. OpenAI-compatible; straight to Alibaba — not via Clawby relay, no Clawby credits.

## 1 · Get the key

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/qwen -H "X-API-Key: $CLAWBY_API_KEY")
DASHSCOPE_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
Trusted-IP whitelist, vault retrieval switch and the 403/404/401/429 error shapes: `rpc/index.yaml`. Key in env only — never echo, log or commit it.

## 2 · Base URL & auth

```text
intl  (Singapore): https://dashscope-intl.aliyuncs.com/compatible-mode/v1     # try first
cn    (Beijing):   https://dashscope.aliyuncs.com/compatible-mode/v1
Authorization: Bearer $DASHSCOPE_API_KEY          # POST {base}/chat/completions
```
- **Keys are region-bound.** A Singapore key on the Beijing host (or the reverse) returns HTTP 401 `invalid_api_key` ("Incorrect API key provided") — the key is not bad, the region is wrong. The vault stores no region: try intl, on 401 try cn once; if both 401, ask the user which console/region the key came from.
- US (Virginia), Frankfurt, Tokyo and Hong Kong have **no shared host** — they need the workspace-dedicated host `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1` (`region` = `us-east-1` · `eu-central-1` · `ap-northeast-1` · `cn-hongkong`; also `ap-southeast-1` / `cn-beijing`). `{WorkspaceId}` is in the Model Studio console (Workspace details) — ask the user, it is not in the vault. Alibaba recommends this host for production (3600 s request timeout vs 600 s); the two shared hosts above still work ("existing domain remains fully functional") but get no new features after 2026-09-30.
- `sk-sp-…` keys (Coding Plan / Token Plan) are **not** general keys: they need their own base URL (Coding Plan intl: `https://coding-intl.dashscope.aliyuncs.com/v1`) and get 401 on the hosts above.

## 3 · Current models

| model id | use | context (input) | notable |
|---|---|---|---|
| `qwen3.8-max` | flagship: reasoning, agents, coding | 1M | hybrid thinking (default ON) · image/video input |
| `qwen3.7-plus` | balanced quality/cost | 1M (price steps up >256K) | hybrid thinking (default ON) · image/video input |
| `qwen3.8-flash` | fast / cheap | 1M | hybrid thinking (default ON) |
| `qwen-plus` · `qwen-flash` | stable aliases of the previous generation (`qwen-plus` = 2025-12-01 snapshot) | 1M | thinking default OFF |
| `qwen3-coder-flash` | code | up to 1M | price tiers by input size |
| `qwen3-vl-plus` | vision (image/video understanding) | 256K | thinking optional |
| `qwen3.8-omni-flash` | omni: text/image/audio/video in | — | thinking default ON; `reasoning_effort` sets effort |
| `qwen3.8-27b` · `qwen3.8-2.4t-a95b` | open-weight Qwen3.8 | 1M | `2.4t-a95b` is thinking-only |

Docs checked 2026-10-25 (Model Studio pricing + model pages); context = top input tier on the pricing page. Also listed: `qwen3.7-max`, `qwen3.6-*`, `qwen3.5-*`, legacy non-thinking `qwen-max`, dated snapshots (`qwen3.7-plus-2026-05-26`). Not in the current list (may be retired): `qwen-turbo`, `qwq-*`, `qwen-long`, `qwen3-max` — use `qwen3.8-flash` / `qwen3.8-max`. Availability differs per region; a missing model → 404 `model_not_found`.

## 4 · Example (curl, non-stream)

```bash
BASE=https://dashscope-intl.aliyuncs.com/compatible-mode/v1     # cn key → https://dashscope.aliyuncs.com/compatible-mode/v1
curl -s "$BASE/chat/completions" \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-flash","messages":[{"role":"user","content":"Say hi in 5 words."}],"enable_thinking":false}'
```
Answer: `choices[0].message.content` (thinking text, when on: `choices[0].message.reasoning_content`).

## 5 · Quirks

- **Thinking is ON by default** on Qwen3.5/3.6/3.7/3.8 ids: slower, extra `reasoning_content`, billed as output tokens. `qwen-plus`/`qwen-flash` default OFF. Toggle with top-level `"enable_thinking": true|false`, cap with `"thinking_budget": <tokens>`, multi-turn `"preserve_thinking": true` (qwen3.8/3.7/3.6; history `reasoning_content` then counts as input). These are **non-OpenAI fields**: put them in the raw JSON body as-is; with the Python OpenAI SDK they go in `extra_body`.
- **Long prompt + thinking + non-stream → timeouts.** Use `"stream": true`, or `"enable_thinking": false`, or a ≥180 s client timeout. `stream_options` is only valid with `stream:true`. Some open-weight thinking models (e.g. `qwen3.5-27b`) reject non-stream calls outright.
- **Params:** `temperature` ∈ [0, 2) (0 not recommended), `top_p` ∈ (0, 1]; `max_tokens` above the model's own output cap → 400 "Range of max_tokens should be [1, xxx]" (cap is per model; read it from the error).
- **Rate limits** are per Alibaba *account* (all keys, workspaces, RAM users pooled) and per model: RPM + TPM + burst. 429 `limit_requests` (RPM) · `insufficient_quota` (TPM) · `limit_burst_rate` (ramp up smoothly); recovers in ~1 min → exponential backoff. Alias ids (`qwen-plus`, `qwen3.7-plus`) get looser limits than dated snapshots.
- **Quota/billing errors:** 403 `AllocationQuota.FreeTierOnly` (Singapore free quota used up while "use free tier only" is on — the user must switch it off in the console to pay-as-you-go); 400 `Arrearage` (overdue balance).
- **Context cache:** implicit (automatic) and explicit caching on supported models; cache-hit input is discounted. `Qwen-Audio` is not OpenAI-compatible (DashScope protocol only).

Full chat/completions spec (streaming, tools, params): see `llm/index.yaml`.
