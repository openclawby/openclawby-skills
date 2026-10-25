# OpenAI (BYOK)

Chat with OpenAI models using the user's **own OpenAI API key**, fetched from the Clawby Key Vault. Straight to OpenAI — not via Clawby relay, no Clawby credits. The current GPT-6 models are **reasoning models** with extra rules (token-cap name, no sampling params, **no tool calling on Chat Completions**) — read §5 before coding.

## 1 · Get the key

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/openai -H "X-API-Key: $CLAWBY_API_KEY")
OPENAI_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
Trusted-IP whitelist, vault retrieval switch and the 403/404/401/429 error shapes: `rpc/index.yaml`. Key in env only — never echo, log or commit it.

## 2 · Base URL & auth

```text
https://api.openai.com/v1                   # POST {base}/chat/completions  ·  POST {base}/responses
Authorization: Bearer $OPENAI_API_KEY
```
- Only if the key reaches several orgs/projects (e.g. a legacy user key) also send `OpenAI-Organization: <org_id>` and `OpenAI-Project: <project_id>`.
- Chat Completions "remains supported", but OpenAI recommends the **Responses API** (`/v1/responses`) for new work — and it is **required for tool calling** on the current models (§5).

## 3 · Current models

| model id | use | context / max out | notable |
|---|---|---|---|
| `gpt-6-astra` | flagship: hardest reasoning, coding, computer use | 1.05M / 128K | effort `low`…`max` (**`none` → 400**) · $10 in / $50 out per 1M · **no tools on Chat Completions** |
| `gpt-6.1-sol` | balanced: near-Astra at about 1/5 the price | 1.05M / 128K | effort `low`/`medium` (default)/`high`/`xhigh`/`max` (**no `none`/`minimal`**) · $2 / $10 · **no tools on Chat Completions** |
| `gpt-6-luna` | cheapest / fastest ("mini" tier): extraction, classification, high volume | 1.05M / 128K | effort `none`…`max` (default `medium`) · $0.10 / $0.50 · Chat Completions tools **only with `reasoning_effort:"none"`** |
| `gpt-6-sol` | previous Sol (superseded by 6.1 Sol) | 1.05M / 128K | effort `none`…`max` (default `medium`) · $2 / $10 · Chat Completions tools only with `none` |

Docs checked 2026-10-25 (developers.openai.com: Models, Pricing, Deprecations, GPT-6 guide, API reference). All four: text + image in, text out; a prompt over 272K input tokens costs 2x input / 1.5x output for the whole request. Previous generation still served: `gpt-5.6-sol` / `-terra` / `-luna`, `gpt-5.5`, `gpt-5.4` / `gpt-5.4-mini`. **Do not pick the old ones — shut down or being retired:** the o-series (`o1`, `o1-pro`, `o3-mini`, `o4-mini` were shut down 2026-10-23; `o3`, `o3-pro`, `gpt-5`/`-mini`/`-nano`/`-pro` go 2026-12-11), `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` (2027-01-14), `gpt-5.1`, `gpt-5.4-nano`, `gpt-5.3-codex` (2027-04-01). `GET /v1/models` lists what the key can use (a model's optional `shutdown_date` flags retirements).

## 4 · Example (curl, non-stream)

Chat Completions (no tools):

```bash
curl -s https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6.1-sol",
    "messages": [
      {"role": "developer", "content": "You are a concise assistant."},
      {"role": "user",      "content": "Say hi in 5 words."}
    ],
    "reasoning_effort": "low",
    "max_completion_tokens": 4096
  }'
```
Answer: `choices[0].message.content`. The hidden reasoning is never returned as text — only counted in `usage.completion_tokens_details.reasoning_tokens`.

Tools need the Responses API (note the **flat** tool object: `name` / `parameters` sit beside `type`, no nested `function`):

```bash
curl -s https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6.1-sol",
    "instructions": "You are a concise assistant.",
    "input": "What is the weather in Boston?",
    "reasoning": {"effort": "low"},
    "max_output_tokens": 4096,
    "tools": [{"type": "function", "name": "get_weather", "description": "Current weather for a city",
               "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
  }'
```
The reply's `output[]` mixes item types: `{"type":"message","content":[{"type":"output_text","text":"…"}]}`, `{"type":"reasoning",…}`, and for a tool call `{"type":"function_call","call_id":"call_…","name":"get_weather","arguments":"{\"city\":\"Boston\"}"}` (`arguments` is a JSON string). Raw JSON has no top-level `output_text` (SDK helper only) — join the text items:

```bash
… | python3 -c 'import sys,json;r=json.load(sys.stdin);print("".join(c["text"] for o in r["output"] if o["type"]=="message" for c in o["content"] if c["type"]=="output_text"))'
```
Tool loop: run the function, then POST again with `"previous_response_id":"<previous resp id>"` and `"input":[{"type":"function_call_output","call_id":"call_…","output":"<result string>"}]`, re-sending `instructions` (documented as not carried over by `previous_response_id`) and `tools`; repeat until `output[]` has no `function_call`.

## 5 · Quirks

- **Reasoning models:** hidden reasoning tokens are billed as output and count against the token cap. Set effort with `reasoning_effort` (Chat Completions) / `reasoning.effort` (Responses). `gpt-6-astra` returns **HTTP 400** on `none`; `gpt-6.1-sol` rejects `none` and `minimal`; Luna and 6-Sol accept `none` (no reasoning, fastest).
- **Drop sampling params** whenever effort ≠ `none`: `temperature`, `top_p`, `top_logprobs` (and `logprobs` on Chat Completions) are unsupported — omit them.
- **Token cap name:** `max_completion_tokens` (Chat Completions) / `max_output_tokens` (Responses). `max_tokens` is deprecated and not compatible with reasoning models. A cap that is too small gets eaten by reasoning → `finish_reason:"length"` with empty or partial text (Responses: `status:"incomplete"`); OpenAI advises reserving at least 25,000 tokens while experimenting.
- **Tool calling = Responses API.** Chat Completions has no function calling on `gpt-6-astra` / `gpt-6.1-sol`, and on Luna / 6-Sol only with `reasoning_effort:"none"`. Responses also adds built-in tools (web_search, file_search, code_interpreter, MCP, …). Other shape differences vs Chat Completions: `input` + `instructions` instead of `messages`; `output[]` items instead of `choices`; `usage.input_tokens` / `output_tokens` instead of `prompt_tokens` / `completion_tokens`; `text.format` instead of `response_format`.
- **Instructions role:** in Chat Completions use `developer` for instructions (the role OpenAI's current docs and examples use).
- **JSON output:** prefer Structured Outputs — `"response_format":{"type":"json_schema","json_schema":{"name":"…","strict":true,"schema":{…}}}` (Responses: `text.format`). Legacy `{"type":"json_object"}` only guarantees parseable JSON, and the API errors unless the word "JSON" appears somewhere in the messages.
- **Storage:** Responses are stored (≥30 days) by default; Chat Completions too on new accounts. `"store": false` opts out — then replay the `output` items yourself instead of using `previous_response_id`.
- **Caching & price tiers:** prompt caching is automatic (`usage.prompt_tokens_details.cached_tokens`; Responses: `input_tokens_details`); cached input costs 5–10% of the input rate, but **cache writes cost 1.25x** the input rate. `prompt_cache_retention` is deprecated → `prompt_cache_options.ttl` (`"30m"` is the only value). `service_tier`: `"flex"` (and the Batch API) = 50% off but slower; `"priority"` = 2x price, faster.
- **Limits & errors:** per-org usage tier (Build / Launch / Grow) and per model — e.g. Astra 5k–15k RPM, 1M–40M TPM; watch the `x-ratelimit-*` headers and follow `Retry-After` on 429/503. 429 `credit_balance_exhausted` / `organization_spend_limit_exceeded` / `project_spend_limit_exceeded` → the user must add credit or raise the limit; 401 `invalid_api_key`; 401 "IP not authorized" → the user's OpenAI project has an IP allowlist and this machine is not on it; 403 → region not supported. Body: `{"error":{"message","type","param","code"}}`.

Full chat/completions spec (streaming SSE, tools/function-calling, params): see `llm/index.yaml`.
