# Kimi — Moonshot AI (BYOK)

Chat with Kimi using the user's **own Moonshot / Kimi Open Platform key**, fetched from the Clawby Key Vault. OpenAI-compatible; straight to Moonshot — not via Clawby relay, no Clawby credits.

## 1 · Get the key

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/kimi -H "X-API-Key: $CLAWBY_API_KEY")
MOONSHOT_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
Trusted-IP whitelist, vault retrieval switch and the 403/404/401/429 error shapes: `rpc/index.yaml`. Key in env only — never echo, log or commit it.

## 2 · Base URL & auth

```text
intl: https://api.moonshot.ai/v1     # console platform.kimi.ai                       ← try first
cn:   https://api.moonshot.cn/v1     # console platform.kimi.com (was platform.moonshot.cn)
Authorization: Bearer $MOONSHOT_API_KEY      # POST {base}/chat/completions · GET {base}/models = live model ids
```
- **Two separate platforms; keys are NOT interchangeable** (docs: mixing keys across platforms returns 401). The vault stores no region: try intl, on 401 (`invalid_authentication_error` / `incorrect_api_key_error`) try cn once; if both 401, ask the user.
- The same hosts also serve OpenAI Responses (`/v1/responses`) and Anthropic Messages (`/anthropic/v1/messages`); this skill only needs `/chat/completions`.

## 3 · Current models

| model id | use | context | notable |
|---|---|---|---|
| `kimi-k3.1-pro` | flagship: long-horizon coding, agents, finance/research | 1M | native vision (image+video) · always thinks, `reasoning_effort` low/high/max · unlocks only after a top-up |
| `kimi-k3.1-pro-highspeed` | same model, ~2–3× faster | 1M | same params as K3.1 Pro |
| `kimi-k3` | previous flagship | 1M | vision · always thinks · same params |
| `kimi-k2.7-code` | coding agents | 256K | thinking always on · image/video input |
| `kimi-k2.7-code-highspeed` | faster 2.7-code (~180 tok/s) | 256K | identical params to `kimi-k2.7-code` |
| `kimi-k2.6` | chat + agents | 256K | vision · thinking on/off via `thinking` |

Docs checked 2026-10-25. **Retired — do not use** (expect 404 `resource_not_found_error`): `moonshot-v1-*` (8k/32k/128k/auto/vision-preview), `kimi-latest`, `kimi-k2-*` (0711/0905/turbo/thinking), `kimi-k2.5` — all discontinued by 2026-08-31; ids in older tutorials are dead. The remaining K2.x ids close to new accounts on 2026-10-31 and retire by end of Dec 2026 → prefer K3.x.

## 4 · Example (curl, non-stream)

```bash
curl -s https://api.moonshot.ai/v1/chat/completions \
  -H "Authorization: Bearer $MOONSHOT_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"kimi-k3.1-pro","reasoning_effort":"low","messages":[{"role":"user","content":"Say hi in 5 words."}]}'
```
cn key → `https://api.moonshot.cn/v1/chat/completions`. Answer: `choices[0].message.content`; the thinking text is `choices[0].message.reasoning_content`.

## 5 · Quirks

- **Sampling params are fixed — omit them.** K3.x and K2.7: `temperature` 1.0 (K2.6: 1.0 thinking / 0.6 non-thinking), `top_p` 0.95, `n` 1, `presence_penalty`/`frequency_penalty` 0. Passing any other value returns an error, so do not send the generic `temperature: 0.7` from `llm/index.yaml`. `max_tokens` is deprecated → use `max_completion_tokens` (K3: default 131072, max 1,048,576; if prompt + cap exceeds the context the API lowers the cap itself).
- **Thinking:** K3.x always thinks — set depth with top-level `reasoning_effort` `low|high|max` (default `max`; changing it mid-session voids the prefix cache). `kimi-k2.6`: `"thinking":{"type":"disabled"}` turns it off; `kimi-k2.7-code`: always on. Replies carry `reasoning_content` beside `content`; in multi-turn and tool loops append the **whole assistant message unchanged** (incl. `reasoning_content`), not just `content`. Python OpenAI SDK: `thinking` only via `extra_body`.
- **Vision:** `content` must be an array of parts. Image URLs are **not supported** — only base64 `data:` URLs or `ms://<file-id>` (upload via `/v1/files`, purpose `image`/`video`); SVG is rejected.
- **Tools:** `tool_choice:"required"` is rejected on K2.6 / K2.7-code (OK on K3.x). The built-in `$web_search` is "being updated — not recommended" for now.
- **Access & limits:** limits scale with the user's cumulative top-up tier (concurrency / RPM / TPM / TPD); $1 minimum top-up to use the API at all, and K3.1 Pro is unlocked only after a successful top-up (a locked account most likely sees 404 `resource_not_found_error` "…does not have permission to access the model"). 429 types: `engine_overloaded_error` (server busy — back off, top-up doesn't help), `exceeded_current_quota_error` (balance), `rate_limit_reached_error` (tier). 403 "Your IP is not allowed to access this organization" = the user's org IP allowlist (common on intl) — add this machine's IP.
- **Context cache** is automatic (5m TTL; `"prompt_cache_options":{"mode":"implicit","ttl":"1h"}` for 1h); only `kimi-k3.1-pro` / `kimi-k3` bill cache writes. Put stable content first; pass `prompt_cache_key` (session id) in agent loops; hits show in `usage.prompt_tokens_details.cached_tokens`.
- **Long non-stream calls** hit an HTML 504 after 900 s of silence → use `"stream": true` (+ `"stream_options":{"include_usage":true}` for the final usage chunk).

Full chat/completions spec (streaming, tools, params): see `llm/index.yaml`.
