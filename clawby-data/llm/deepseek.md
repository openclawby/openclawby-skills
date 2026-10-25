# DeepSeek (BYOK)

Chat with DeepSeek using the user's **own DeepSeek API key**, fetched from the Clawby Key Vault. OpenAI-compatible; straight to DeepSeek — not via Clawby relay, no Clawby credits.

## 1 · Get the key

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/deepseek -H "X-API-Key: $CLAWBY_API_KEY")
DEEPSEEK_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
Trusted-IP whitelist, vault retrieval switch and the 403/404/401/429 error shapes: `rpc/index.yaml`. Key in env only — never echo, log or commit it.

## 2 · Base URL & auth

```text
https://api.deepseek.com                    # POST {base}/chat/completions   (no /v1 segment)
Authorization: Bearer $DEEPSEEK_API_KEY
```
- The same host and key also take the OpenAI **Responses** format (`POST /responses`) and the Anthropic format (`https://api.deepseek.com/anthropic`). Beta features (strict-schema tools, chat prefix completion, FIM) use `https://api.deepseek.com/beta`. Plain Chat Completions covers almost everything.

## 3 · Current models

| model id | use | context / max out | notable |
|---|---|---|---|
| `deepseek-flash` | default: fast, cheap chat, coding, agents (DeepSeek-V4.1-Flash-1017) | 1M / 384K | thinking **ON by default** (switchable) · tools · JSON mode · **vision** (`image_url` parts) |
| `deepseek-v4-pro` | hardest reasoning / coding (DeepSeek-V4-Pro-0813) | 1M / 384K | same params and thinking switch · **text-only** · about 3–7x Flash's price |

Docs checked 2026-10-25 (api-docs.deepseek.com: Models & Pricing, Change Log, Thinking Mode, API reference); live list: `GET {base}/models`. **`deepseek-chat` / `deepseek-reasoner` are discontinued** — the 2026-04-24 changelog scheduled their shutdown for 2026-07-24 (they were aliases of V4-Flash non-thinking / thinking) and the current model list omits them; treat as unavailable. Migrate: `deepseek-chat` → `deepseek-flash` + `"thinking":{"type":"disabled"}`; `deepseek-reasoner` → `deepseek-flash` (thinking is already the default) or `deepseek-v4-pro`. The retired `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` are still accepted (served by `deepseek-flash`, billed at Flash price) — don't use them in new code.

## 4 · Example (curl, non-stream)

```bash
curl -s https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [
      {"role": "system", "content": "You are a concise assistant."},
      {"role": "user",   "content": "Say hi in 5 words."}
    ],
    "thinking": {"type": "disabled"},
    "stream": false
  }'
```
Answer: `choices[0].message.content`. With thinking on (the default: drop the `thinking` line, optionally add `"reasoning_effort":"high"`), the chain-of-thought comes back as `choices[0].message.reasoning_content` (streaming: `delta.reasoning_content`, arriving before `delta.content`); `usage.completion_tokens_details.reasoning_tokens` counts it.

## 5 · Quirks

- **Thinking is ON by default** — slower, and the reasoning tokens are billed as output. For plain chat or extraction switch it off with the top-level body field `"thinking":{"type":"disabled"}` (a non-OpenAI field: with the Python OpenAI SDK pass it via `extra_body`). Tune with `"reasoning_effort":"low"|"high"|"max"` (default `high`; `minimal`→low, `medium`/`xhigh`→high, `ultra`→max; `"none"` also disables thinking).
- **Sampling params:** `temperature` (0–2, default 1) only works with thinking off. In thinking mode `temperature`, `presence_penalty`, `frequency_penalty` are accepted but silently ignored (the two penalties are dead in every mode). `top_p`: flash honours it only in thinking mode (floor 0.95), pro only outside thinking.
- **Tools + thinking:** if the request carries `tools`, every later request must send back the `reasoning_content` of **all** earlier assistant turns — append the whole `response.choices[0].message` (with `reasoning_content` + `tool_calls`), then the `role:"tool"` results — or the API returns **HTTP 400**. Without `tools` it is ignored. In thinking mode `tool_choice:"required"` or a named function also returns 400 (use `auto`/`none`, or disable thinking). Validate `tool_calls[].function.arguments` (can be malformed JSON). Schema-enforced `"strict":true` tools are Beta (`/beta` base).
- **`max_tokens`:** unset → 8K (thinking off) / 64K (thinking on) / 128K (`reasoning_effort:"max"`); upper bound 384K (393216). `finish_reason:"length"` = cut off.
- **JSON mode:** `"response_format":{"type":"json_object"}` only (no `json_schema`). The prompt must contain the word "json" and show the target shape (otherwise the model may emit endless whitespace); allow enough `max_tokens`; `content` can occasionally come back empty — retry.
- **Cost** (per 1M tokens, off-peak / peak; peak = 01:00–04:00 and 06:00–10:00 UTC Mon–Fri excl. Chinese public holidays, off-peak is half): `deepseek-flash` input $0.15 / $0.30, output $0.60 / $1.20, cache-hit input $0.003 / $0.006; `deepseek-v4-pro` input $0.66 / $1.32, output $1.98 / $3.96, cache-hit input $0.022 / $0.044. Context caching is automatic and best-effort (prefix match): read `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, and keep the stable prompt prefix first.
- **Limits:** no RPM/TPM quota — only per-account **concurrency** (flash 2500, pro 500, pooled across all the account's keys), **429** when exceeded. While a request waits the server sends blank lines (non-stream) or `: keep-alive` SSE comments (stream) — skip them when parsing raw HTTP; it closes the connection if inference has not started within 10 min.
- **Errors** (OpenAI-style `{"error":{"message","type","param","code"}}`): 400 bad body · 401 bad key · **402 insufficient balance** (the user must top up) · 422 bad params · 429 rate/concurrency · 500/503 retry after a pause.

Full chat/completions spec (streaming SSE, tools/function-calling, params): see `llm/index.yaml`.
