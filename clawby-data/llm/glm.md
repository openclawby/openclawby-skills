# GLM — Zhipu AI / BigModel · Z.ai (BYOK)

Chat with GLM using the user's **own Zhipu (BigModel / Z.ai) API key**, fetched from the Clawby Key Vault. OpenAI-compatible; straight to Zhipu — not via Clawby relay, no Clawby credits.

## 1 · Get the key

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/glm -H "X-API-Key: $CLAWBY_API_KEY")
ZHIPU_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
Trusted-IP whitelist, vault retrieval switch and the 403/404/401/429 error shapes: `rpc/index.yaml`. Key in env only — never echo, log or commit it.

## 2 · Base URL & auth

```text
mainland (BigModel): https://open.bigmodel.cn/api/paas/v4     # console bigmodel.cn      ← try first
intl     (Z.ai):     https://api.z.ai/api/paas/v4              # console z.ai
Authorization: Bearer $ZHIPU_API_KEY       # POST {base}/chat/completions — base ends in /paas/v4, NOT /v1
```
- **Auth is plain HTTP Bearer with the whole key string** (it looks like `<id>.<secret>` — send it as-is). The old JWT scheme (HS256 signed with the secret half) is still documented as an optional extra; you do not need it, do not implement it.
- **Two platforms, separate accounts and key pages.** The docs never say a key works cross-platform, so assume not: try mainland, on 401 try intl once; if both 401, ask the user which site the key was created on. Models differ slightly per site (below).

## 3 · Current models

| model id | use | context / max out | notable |
|---|---|---|---|
| `glm-5.3` | flagship: coding, agents, long tasks | 1M / 128K | text-only · thinking always on, `reasoning_effort` low/high/max |
| `glm-5.3-flash` · `glm-5.3-flashx` | cheap native multimodal (image/video/file in); FlashX ≈200 tok/s | 1M / 128K | thinking always on · vision request format |
| `glm-5.2` | previous flagship | 1M / 128K | thinking on by default; `reasoning_effort` (5.2+) |
| `glm-5.1` · `glm-5` | agentic coding | 200K / 128K | thinking on by default |
| `glm-5-turbo` | tuned for long agent tasks | 200K / 128K | mainland list only |
| `glm-4.7` | general + agentic | 200K / 128K | thinking on by default (can be disabled) |
| `glm-4.6` | coding, tool use | 200K / 128K | auto thinking |
| `glm-4.7-flash` | **free** text model | 200K / 128K | free: also `glm-4.5-flash` (128K/96K), `glm-4-flash-250414` (128K/16K) |
| `glm-4.5-air` · `glm-4.5-airx` | light / fast | 128K / 96K | cheap |
| `glm-5v-turbo` | multimodal coding base | 200K / 128K | vision |
| `glm-4.6v` (+ `-flashx`; free `-flash`) | vision + tool calls | 128K / 32K | vision |

Docs checked 2026-10-25 (docs.bigmodel.cn model overview + chat-completions spec; docs.z.ai). The intl chat-completions enum lists only `glm-5.3`, `5.2`, `5.1`, `5`, `4.7`, `4.6` + `glm-5.3-flash(x)`; `glm-5-turbo` and the `-flash` free text models are mainland-listed (z.ai prices some others, e.g. `glm-4.7-flash`, `glm-4.5-air`). Unknown id → 400 code `1211`.

## 4 · Example (curl, non-stream)

```bash
curl -s https://open.bigmodel.cn/api/paas/v4/chat/completions \
  -H "Authorization: Bearer $ZHIPU_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","reasoning_effort":"low","messages":[{"role":"user","content":"Say hi in 5 words."}]}'
```
intl key → `https://api.z.ai/api/paas/v4/chat/completions`. Answer: `choices[0].message.content`; thinking text: `choices[0].message.reasoning_content`.

## 5 · Quirks

- **Key types (since 2026-10-16):** *Standard API keys* (pay-as-you-go / resource packs) and *GLM Coding Plan* keys (personal / team) are issued separately and billed differently. Plan keys draw on plan quota (not the balance) and belong to the coding endpoints (`https://open.bigmodel.cn/api/coding/paas/v4` · `https://api.z.ai/api/coding/paas/v4`); on the standard endpoint they may be refused (e.g. `1315` "limited to enterprise coding package scenarios"). The vault should hold a **Standard** key; plan-limit errors `1308`–`1321` (plan expired / usage window hit / model not in plan) most likely mean a plan key was stored → ask the user for a Standard key.
- **Not-quite-OpenAI params:** `temperature` must be within [0, 1] (default 1.0 — not the generic 0–2), `top_p` within [0.01, 1] (default 0.95); `tool_choice` accepts only `"auto"`; `response_format` only `text` | `json_object`; `stop` takes a single entry; `max_tokens` ≤ 131072. `n`, `seed`, penalties, `logprobs`, `stream_options` are not in the schema — don't send them (streams put `usage` in the last chunk automatically). GLM-only fields: `thinking`, `reasoning_effort`, `do_sample`, `request_id` (6–64 chars), `user_id`, `tool_stream`; extra tool types `web_search` / `retrieval` / `mcp`. Extra `finish_reason`s: `sensitive` (content filter), `network_error`, `model_context_window_exceeded`; `content` can be `null` on tool calls.
- **Thinking:** `glm-5.3` / `glm-5.3-flash(x)` always think — `"thinking":{"type":"disabled"}` makes the request **fail**; set depth with `reasoning_effort` `low|high|max` (default `max`; `low` for quick/cheap). Other 5.x / 4.7 think by default; `{"type":"disabled"}` turns it off (on `glm-5.2`, `reasoning_effort` `none`/`minimal` also skips thinking). In tool loops send `reasoning_content` back with the tool results; `"thinking":{"clear_thinking":false}` keeps earlier reasoning (return it unmodified and in order).
- **Errors & limits:** body is `{"error":{"code":"1214","message":"…"}}` (code is a string). 401: bad key (`"401"`) or missing header (`1001`). 429: `1302` rate/concurrency · `1305` model overloaded · `1113` no balance or resource package. Also `1210`/`1214` bad parameter, `1261` prompt too long, `1301` content blocked. Limits are **concurrency per model** (in-flight requests, by account tier), not RPM — see the console "Rate Limits" page.
- **Context cache** is implicit/automatic (the repeated prefix needs roughly 500+ tokens); hits show in `usage.prompt_tokens_details.cached_tokens`.
- **Vision** (`glm-5.3-flash(x)`, `glm-5v-turbo`, `glm-4.6v`): `content` is an array with `{"type":"image_url","image_url":{"url":"<https URL or data: base64>"}}` parts.

Full chat/completions spec (streaming, tools, params): see `llm/index.yaml`.
