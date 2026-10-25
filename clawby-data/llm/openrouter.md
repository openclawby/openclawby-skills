# OpenRouter (BYOK)

One key, hundreds of models (Claude, GPT, Gemini, DeepSeek, Grok, Kimi, Qwen, GLM, Llama, ...) through the user's **own OpenRouter key**, fetched from the Clawby Key Vault. OpenAI-compatible; straight to OpenRouter — not via Clawby relay, no Clawby credits (the user's OpenRouter credit balance pays; OpenRouter adds no markup to inference prices, a small fee applies only when credits are bought).

## 1 · Get the key

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/openrouter -H "X-API-Key: $CLAWBY_API_KEY")
OPENROUTER_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
Trusted-IP whitelist, vault retrieval switch and the 403/404/401/429 error shapes: `rpc/index.yaml`. Key in env only — never echo, log or commit it.

## 2 · Base URL & auth

```text
POST https://openrouter.ai/api/v1/chat/completions     # EU in-region (Business/Enterprise only): https://eu.openrouter.ai/api/v1
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
HTTP-Referer: <site URL>            # optional, attribution only
X-OpenRouter-Title: <app name>      # optional, attribution only (the older name X-Title is still accepted)
```
The two optional headers only feed OpenRouter's public app rankings — never needed for auth, routing or billing. Leave them out unless the user wants attribution (add `X-OpenRouter-App-Visibility: hidden` to keep a new app off public pages).

## 3 · Models

Ids are `vendor/model`. **OpenRouter writes Claude versions with a dot — `anthropic/claude-opus-5.5` — while Anthropic's own API id is `claude-opus-5-5`.** Ids change often; never guess, list them (public, no key needed):

```bash
curl -s https://openrouter.ai/api/v1/models | jq -r '.data[]
  | select(.id|startswith("anthropic/")) | select(.id|endswith(":batch")|not)
  | "\(.id)\tctx=\(.context_length)\tin=$\(((.pricing.prompt|tonumber)*1e10|round)/1e4)/M\tout=$\(((.pricing.completion|tonumber)*1e10|round)/1e4)/M"'
# append ?supported_parameters=tools to the URL to list only tool-capable models
```
`pricing.*` are USD **per token** strings (x1,000,000 = $/M). Snapshot of popular ids on 2026-10-25 (ctx · $/M in -> out):

| id | use | ctx | $/M |
|---|---|---|---|
| `anthropic/claude-opus-5.5` | Claude flagship: coding, agents | 1M | 4 -> 20 |
| `anthropic/claude-sonnet-5.5` | Claude speed + intelligence | 1M | 2 -> 10 |
| `anthropic/claude-haiku-5.5` | Claude cheap/fast (>100K prompt: 0.50 -> 2.50) | 1M | 0.10 -> 0.50 |
| `anthropic/claude-fable-5.1` | Claude top tier | 1M | 10 -> 50 |
| `openai/gpt-6.1-sol` · `openai/gpt-6-luna` | GPT mid · cheap | 1.05M | 2 -> 10 · 0.10 -> 0.50 |
| `google/gemini-4-argon` · `google/gemini-3.8-flash` | Gemini pro · fast | 1M | 2 -> 10 · 0.825 -> 4.125 |
| `deepseek/deepseek-v4.1-flash` · `deepseek/deepseek-v4-pro` | DeepSeek | 1M | 0.02 -> 1 · 0.21 -> 0.42 |
| `x-ai/grok-4.7` | Grok | 500K | 2 -> 6 |
| `moonshotai/kimi-k3.1-pro` · `qwen/qwen3.8-max-prime` · `z-ai/glm-5.3-prime` | Kimi · Qwen · GLM | 1M | 2 -> 10 · 4 -> 12 · 2.8 -> 8.8 |
| `google/gemma-4-31b-it:free` | free tier example | 262K | 0 |

- **`~vendor/family-latest` aliases** always redirect to the newest model of that family — use them when the user just says "latest X": `~anthropic/claude-{opus,sonnet,haiku,fable}-latest`, `~openai/gpt-sol-latest`, `~google/gemini-{pro,flash}-latest`, `~deepseek/deepseek-{pro,flash}-latest`, `~x-ai/grok-latest`, `~moonshotai/kimi-latest`, `~z-ai/glm-latest`. Each has its own `pricing` row in `/models`. Quote the id in a shell (a leading `~` expands to `$HOME`).
- **Router slugs:** `openrouter/auto` picks a model per prompt (you pay that model's normal rate, no extra fee; the response `model` field says what ran); `openrouter/free` picks a random free model.
- **Suffix variants** (`vendor/model:suffix`, chainable): `:free` zero-price entry (separate caps, section 5) · `:nitro` throughput-first provider order · `:floor` price-first provider order · `:exacto` providers ranked for dependable tool calls. `:nitro/:floor/:exacto` work on any model; `:free` only where `/models` lists that entry (otherwise the request fails — it does not fall back to the paid model). `:batch` entries are for OpenRouter's async Batch API (`POST /api/v1/batches`) — for normal chat send the base slug. Deprecated: `:online` (use the `openrouter:web_search` server tool), `:thinking` (use `reasoning`), `:extended`.

## 4 · Example (curl, non-stream)

```bash
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-5.5","messages":[{"role":"user","content":"Say hi in 5 words."}]}'
```
Answer: `choices[0].message.content`. Cost of the call: `usage.cost` (credits charged, USD-denominated; `usage` is always returned, no flag needed). Later lookup: `GET /generation?id=<response id>`.

## 5 · Quirks

- **Fallbacks:** send `models` (priority order, instead of `model`). Any error — rate limit, moderation, context length, provider down — moves to the next entry; you are billed for the model that answered and its id comes back in the response `model`. List only `:free` ids to stay free.
```json
{"models":["anthropic/claude-sonnet-5.5","openai/gpt-6.1-sol","google/gemini-4-argon"],
 "messages":[{"role":"user","content":"Hello"}],
 "provider":{"sort":"price","data_collection":"deny","allow_fallbacks":true}}
```
- **Provider prefs** (`provider` object): `order` / `only` / `ignore` (provider slugs) · `allow_fallbacks` (default true) · `require_parameters` (only providers supporting every param you sent) · `sort` (`price`|`throughput`|`latency`) · `data_collection` (`allow`|`deny`) · `zdr` (zero-data-retention endpoints only) · `quantizations` · `max_price`.
- **Unsupported params are dropped, not rejected** (e.g. no `temperature`/`top_p` on Claude 5.x here). `tools`, `reasoning`, `response_format` support varies per model — check `supported_parameters` in `/models`.
- **Reasoning:** `"reasoning":{"effort":"high"}` (`max|xhigh|high|medium|low|minimal|none`) or `{"max_tokens":2000}` (not both); `{"exclude":true}` hides it. Text arrives in `message.reasoning`; it bills as output and counts toward `max_tokens` (a low cap can end in `finish_reason:"length"` with no answer).
- **Prompt caching:** Claude models take `"cache_control":{"type":"ephemeral"}` (optional `"ttl":"1h"`) on message content parts, or top-level for automatic placement; OpenAI and DeepSeek cache automatically. Hits: `usage.prompt_tokens_details.cached_tokens`.
- **Credits & key info:** `GET /key` works with the normal key:
```bash
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | jq '.data | {label, usage, limit, limit_remaining, is_free_tier, free_models_left: .free_model_daily_requests.remaining}'
```
  `GET /credits` (`{"data":{"total_credits","total_usage"}}`) needs a **management key** — a normal key gets 403 "Only management keys can perform this operation".
- **Limits:** `:free` models allow 20 req/min and 50 req/day (1000/day once the user has bought >= 10 credits). Paid models have no platform request cap, but a 429 can come from the upstream provider (`error.metadata.provider_code`) — back off and honor `Retry-After`.
- **Errors:** `{"error":{"code":402,"message":"...","metadata":{...}}}`, HTTP status = `error.code`: 400 bad params · 401 bad key · 402 no credits (`metadata.limit_source`: `openrouter_credits` balance · `openrouter_key_limit` key cap · `openrouter_in_flight_budget` temporary, retry after `Retry-After`) · 403 moderation flag/permissions · 408 timeout · 429 rate limited · 502 model down · 503 no provider matches your routing. **A stream can fail after HTTP 200**: a `data:` event with a top-level `error` and `finish_reason:"error"` — check the body, not just the status. Lines starting `: OPENROUTER PROCESSING` are keep-alive comments — ignore them; the last chunk before `data: [DONE]` carries `usage`.

Docs checked 2026-10-25 (openrouter.ai/docs: quickstart, app-attribution, model variants, model fallbacks, provider selection, limits, errors, streaming, usage accounting, reasoning tokens, prompt caching, FAQ, API-key and credits references; live `GET /api/v1/models`, 467 entries). Full chat/completions spec (streaming, tools, params): see `llm/index.yaml`.
