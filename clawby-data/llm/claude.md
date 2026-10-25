# Claude — Anthropic Messages API (BYOK)

Call Claude with the user's **own Anthropic API key** (vault slug `claudecode`), fetched from the Clawby Key Vault. Anthropic is **NOT OpenAI-compatible**: it has its own Messages API, so this file is the complete spec and the `chat/completions` shape in `llm/index.yaml` does not apply (coming from OpenAI habits? see the differences table in section 7). Straight to Anthropic — not via Clawby relay, no Clawby credits; the user's Anthropic account pays per token, so say which model you are calling. The same key also works as `ANTHROPIC_API_KEY` for the Claude Code CLI.

## 1 · Get the key

```bash
RESP=$(curl -s https://api.openclawby.com/api/vault/claudecode -H "X-API-Key: $CLAWBY_API_KEY")
ANTHROPIC_API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["keys"][0]["fields"]["apiKey"])')
```
Trusted-IP whitelist, vault retrieval switch and the 403/404/401/429 error shapes: `rpc/index.yaml`. Key in env only — never echo, log or commit it. To drive the CLI with it, scope the variable to one process: `ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude -p "<prompt>"`.

The vault must hold a Console API key (`sk-ant-api...`). A `401 authentication_error` means the key is invalid, revoked or expired — ask the user to re-save it in the vault.

## 2 · Endpoint & headers

```text
POST https://api.anthropic.com/v1/messages
x-api-key: $ANTHROPIC_API_KEY          # or  Authorization: Bearer $ANTHROPIC_API_KEY  (the API accepts either)
anthropic-version: 2023-06-01          # REQUIRED
content-type: application/json         # REQUIRED
anthropic-beta: <feature-id>           # only to opt into a beta feature
anthropic-workspace-id: wrkspc_...     # only if the key is not scoped to one workspace (otherwise 400)
```
- **Version:** `2023-06-01` is what Anthropic's curl examples use and it still works; every example here uses it. The newest is `2026-10-21` (Anthropic recommends the latest for new code): it **removes `temperature`/`top_p`/`top_k` on every model (400, even at the default)** and rejects a `document` block inside an `assistant` message and `citations` on `user` text blocks. Use one version consistently.
- Every response carries a `request-id` header (also `request_id` in error bodies) — quote it when reporting a problem.

## 3 · Request & response

### Request body

| field | type | notes |
|---|---|---|
| `model` | string | **required** — id from section 4 |
| `max_tokens` | int | **required**, no default. Caps the whole output **including thinking tokens** (up to 128K on current models). Too low gives `stop_reason: "max_tokens"` with empty or partial text. |
| `messages` | array | **required** — `{"role": "user" or "assistant", "content": string or block[]}`. Starts with `user` and must END with `user` (assistant prefill is a 400 on Claude 4.6+). Consecutive same-role turns are merged. At most 100,000 messages and 32 MB per request. A string `content` is shorthand for one `text` block. |
| `system` | string or text-block[] | top-level system prompt — **not** a message |
| `stream` | bool | server-sent events, section 5 |
| `stop_sequences` | string[] | custom stops; the response sets `stop_reason: "stop_sequence"` and `stop_sequence` |
| `tools`, `tool_choice` | array, object | section 6 |
| `thinking`, `output_config` | object | thinking mode; `output_config` = `{"effort": ..., "format": {json_schema}}` |
| `cache_control` | object | `{"type": "ephemeral"}` automatic prompt caching, section 6 |
| `metadata` | object | `{"user_id": "<opaque id>"}` |
| `temperature`, `top_p`, `top_k` | — | **do not send** (below) |

- **Sampling params:** Fable 5/5.1, Opus 5.5/5/4.8/4.7 and Sonnet 5 reject `temperature`/`top_p`/`top_k` with a 400; Sonnet 5.5 and Haiku 5.5 reject non-default values; under `anthropic-version: 2026-10-21` they are removed everywhere. Omit them (sampling uses temperature 1.0) and steer through the prompt.
- **Thinking is adaptive and on by default** on every current model: the response may start with `thinking` blocks (their text is empty unless you send `"thinking": {"type": "adaptive", "display": "summarized"}`); thinking tokens are billed as output. Depth: `"output_config": {"effort": "low"}` (levels `low`, `medium`, `high`, `xhigh`, `max`; default per model in section 4).
  - Fable 5.1 and Opus 5.5: always on — omit `thinking` (or `{"type": "adaptive"}`); `{"type": "disabled"}` is a 400.
  - Sonnet 5.5: `disabled` is a 400; to turn up-front thinking off send `{"type": "between_tools"}` (effort `high` or lower).
  - Haiku 5.5: `{"type": "disabled"}` is accepted (effort `high` or lower).
  - `{"type": "enabled", "budget_tokens": N}` is a 400 on every current model.

### Response

```json
{
  "id": "msg_013mHbppMPd2PrVJzGMZPt2D",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5-5",
  "content": [ {"type": "text", "text": "..."} ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "stop_details": null,
  "usage": {"input_tokens": 21, "output_tokens": 305}
}
```
- `content` is always an array of typed blocks: `text`, `thinking` (and `redacted_thinking`), `tool_use`, plus server-tool blocks. **Never read `content[0].text` blindly** — thinking or tool blocks can come first; collect the blocks with `type == "text"`.
- `usage`: `input_tokens` counts only tokens after the last cache breakpoint; total input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
- `stop_details` is `null` unless `stop_reason` is `refusal`.

| `stop_reason` | meaning / what to do |
|---|---|
| `end_turn` | finished normally |
| `max_tokens` | hit `max_tokens` (thinking counts) — raise it or stream; a cut-off `tool_use` block is incomplete, retry bigger |
| `stop_sequence` | one of your `stop_sequences` fired |
| `tool_use` | run the tool(s) and reply with `tool_result` (section 6) |
| `pause_turn` | a server-tool loop hit its iteration limit — send the assistant content back unchanged to continue |
| `refusal` | declined — still HTTP 200; `stop_details.category` says why; rephrase or switch model |
| `model_context_window_exceeded` | the response filled the context window — treat as truncated |

## 4 · Current models

| API id | use | ctx · max out | $/M in -> out | default effort |
|---|---|---|---|---|
| `claude-opus-5-5` | **default** — flagship Opus: long-running agentic coding, knowledge work | 1M · 128K | 4 -> 20 | `medium` |
| `claude-sonnet-5-5` | best speed/intelligence balance for everyday work | 1M · 128K | 2 -> 10 | `high` |
| `claude-haiku-5-5` | fastest/cheapest: classification, extraction, routing, high volume | 1M · 128K | 0.10 -> 0.50 (prompts >100K: 0.50 -> 2.50) | `medium` |
| `claude-fable-5-1` | most capable: hardest reasoning, long-horizon agents — priciest, ask the user first | 1M · 128K | 10 -> 50 | `high` |

- Pick the model the user names; if none, `claude-opus-5-5` (Anthropic's recommended starting point). For "cheaper/faster" use `claude-sonnet-5-5` or `claude-haiku-5-5`.
- **Every Claude id is a pinned snapshot** (the dateless 4.6+ ids included) — there is no `-latest` alias, so a newer model means a new id. Ask the API what the key can call (newest first; `limit` up to 1000):
```bash
curl -s "https://api.anthropic.com/v1/models?limit=100" -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  | jq -r '.data[] | "\(.id)\t\(.display_name)\tin=\(.max_input_tokens) out=\(.max_tokens)\t\(.lifecycle)"'
```
- Legacy, still served: `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5` (alias of `claude-haiku-4-5-20251001`, 200K ctx). Opus 4.6, Sonnet 4.6, Haiku 4.5 and older still accept `temperature` (on `anthropic-version: 2023-06-01`) and manual `thinking: {"type": "enabled", "budget_tokens": N}` (N at least 1024 and below `max_tokens`; deprecated on 4.6).

## 5 · Examples

### Non-stream

```bash
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-5-5",
    "max_tokens": 4096,
    "system": "You are a concise market analyst.",
    "messages": [{"role": "user", "content": "In 3 bullets: what drives perp funding rates?"}]
  }' | jq -r '.content[] | select(.type=="text") | .text'
```

Hand-written JSON breaks on quotes and newlines in the prompt; this helper builds the body with `jq` and prints either the text or the error:
```bash
claude_ask() {  # claude_ask "<prompt>" [model] [max_tokens]
  jq -n --arg m "${2:-claude-opus-5-5}" --argjson t "${3:-4096}" --arg p "$1" \
    '{model:$m,max_tokens:$t,messages:[{role:"user",content:$p}]}' |
  curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d @- |
  jq -r 'if .type=="error" then "ERROR \(.error.type): \(.error.message) (\(.request_id))"
         else (.content[] | select(.type=="text") | .text) end'
}
```

### Streaming (SSE)

Set `"stream": true` and add `--no-buffer`. Stream whenever `max_tokens` is large (roughly above 16K) or the answer may take over 10 minutes — a non-streamed long request can time out (504) or have its idle connection dropped.

```bash
curl -s --no-buffer https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-opus-5-5","max_tokens":8192,"stream":true,
       "messages":[{"role":"user","content":"Write a haiku about funding rates."}]}' \
| jq -R -j --unbuffered 'select(startswith("data: ") or startswith("{")) | (if startswith("data: ") then .[6:] else . end) | fromjson
    | if .type=="content_block_delta" and .delta.type=="text_delta" then .delta.text
      elif .type=="error" then "\n[\(.error.type)] \(.error.message)\n"
      else empty end'
echo
```
(The filter also prints a non-200 reply — a plain JSON error body, not SSE.) The raw stream:

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","type":"message","role":"assistant","content":[],"model":"claude-opus-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}

event: message_stop
data: {"type":"message_stop"}
```
- Flow: `message_start`, then per content block `content_block_start`, `content_block_delta`*, `content_block_stop` (`index` = position in the final `content`), then `message_delta` (carries `stop_reason`; its `usage` is **cumulative**), then `message_stop`. There is **no** `data: [DONE]`. `ping` can appear anywhere; ignore unknown event types.
- Delta types: `text_delta` (`text`), `input_json_delta` (`partial_json` — concatenate, parse at `content_block_stop`), `thinking_delta` (`thinking`), `signature_delta` (`signature`).
- An `event: error` (e.g. `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`) can arrive **after** the HTTP 200 — treat the stream as failed and retry.

## 6 · Tool use, caching, images, JSON output

### Tool use (client tools)

Define tools as `{"name", "description", "input_schema"}` (name matches `^[a-zA-Z0-9_-]{1,128}$`; write a detailed description; optional `"strict": true` makes inputs always match the schema). Claude answers with `stop_reason: "tool_use"` and `tool_use` blocks; you run them and send the results back. Run this as one script (it reuses variables):

```bash
H=(-H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json")
URL=https://api.anthropic.com/v1/messages
REQ1='{
  "model": "claude-opus-5-5", "max_tokens": 4096,
  "tools": [{"name": "get_weather",
             "description": "Get the current weather for a city. Returns temperature and conditions.",
             "input_schema": {"type": "object", "properties": {"location": {"type": "string", "description": "City, e.g. Paris"}}, "required": ["location"]}}],
  "messages": [{"role": "user", "content": "What is the weather in Paris?"}]
}'
R1=$(curl -s "$URL" "${H[@]}" -d "$REQ1")
echo "$R1" | jq -r .stop_reason                                            # "tool_use" -> run the tool(s) yourself
echo "$R1" | jq -c '.content[] | select(.type=="tool_use") | {id,name,input}'

# Next request = old messages + the assistant content VERBATIM + ONE user message with a tool_result per tool_use.
# Replace the placeholder result with the real tool output for each id.
REQ2=$(jq -c --argjson r1 "$R1" '.messages += [
    {role:"assistant", content:$r1.content},
    {role:"user", content:[ $r1.content[] | select(.type=="tool_use")
                            | {type:"tool_result", tool_use_id:.id, content:"15C, partly cloudy"} ]} ]' <<<"$REQ1")
curl -s "$URL" "${H[@]}" -d "$REQ2" | jq -r '.content[] | select(.type=="text") | .text'   # loop while stop_reason == "tool_use"
```
- The `tool_use` block is `{"type":"tool_use","id":"toolu_...","name":"get_weather","input":{...}}` — `input` is an object, not a JSON string.
- **Result rules:** the `tool_result` message must come right after the assistant message that called; all results for parallel calls go in the **same** user message; `tool_result` blocks come **first**, any text after them (text first is a 400). `content` of a result is a string or blocks (`text`, `image`, `document`); report failures with `"is_error": true` and an instructive message.
- **Echo the assistant `content` back unchanged, `thinking` blocks included** — editing or dropping them is a 400.
- `tool_choice`: `{"type":"auto"}` (default; add `"disable_parallel_tool_use": true` for at most one call per turn), `{"type":"none"}`, and forced `{"type":"any"}` / `{"type":"tool","name":"..."}` — forcing is a **400 on Opus 5.5, Sonnet 5.5 and Fable 5.1**; use `auto` plus an instruction naming the tool (and `strict: true`).
- Server tools run on Anthropic's side and return their results in the same response, e.g. `"tools": [{"type": "web_search_20260209", "name": "web_search"}]` (extra per-search charges).

### Prompt caching

Cache big stable prefixes (the order is tools, then system, then messages). Either set top-level `"cache_control": {"type": "ephemeral"}` (automatic) or mark a block:
```json
{"model": "claude-opus-5-5", "max_tokens": 4096,
 "system": [{"type": "text", "text": "<large stable document or instructions>", "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
 "messages": [{"role": "user", "content": "Summarize the key points."}]}
```
TTL is 5 minutes by default, `"1h"` optional; at most 4 breakpoints; minimum prefix is 512 tokens on Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 (1,024-4,096 on older models, e.g. 1,024 on Sonnet 5; shorter prefixes silently don't cache). Writes cost 1.25x (5m) or 2x (1h) the input price; reads cost 0.1x (0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1). Check `usage.cache_read_input_tokens` — zero on repeats means something in the prefix changed.

### Images & PDFs

Image blocks go in a `user` message, ideally before the text. Sources: `base64`, `url` or a Files-API `file`. Types `image/jpeg`, `image/png`, `image/gif`, `image/webp`; up to 10 MB each (base64), 8000x8000 px, 600 images per request (100 on 200K-context models), 32 MB per request. With more than 20 images in one request, keep each side under 2000 px or they are rejected.
```json
{"role": "user", "content": [
  {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<base64>"}},
  {"type": "image", "source": {"type": "url", "url": "https://example.com/chart.png"}},
  {"type": "text", "text": "What is in this chart?"}
]}
```
A large base64 string passed through `-d '...'` can exceed the shell argument limit — build the body with `jq --rawfile` and send it from stdin:
```bash
jq -n --rawfile img <(base64 < chart.png | tr -d '\n') \
  '{model:"claude-opus-5-5",max_tokens:4096,messages:[{role:"user",content:[
     {type:"image",source:{type:"base64",media_type:"image/png",data:$img}},
     {type:"text",text:"What is in this chart?"}]}]}' \
| curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d @-
```
PDFs: a `{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "<base64>"}}` block in the **user** message, before the text (32 MB request limit, up to 600 pages; 100 on 200K-context models).

### JSON output

Constrain the reply to a schema with `output_config.format` (all objects need `"additionalProperties": false`; no recursive schemas, no `minimum`/`maxLength`-style constraints):
```json
"output_config": {"format": {"type": "json_schema", "schema": {
  "type": "object",
  "properties": {"ticker": {"type": "string"}, "bias": {"type": "string", "enum": ["bull", "bear", "neutral"]}},
  "required": ["ticker", "bias"], "additionalProperties": false}}}
```
The JSON comes back as a **string** in the `text` block — check `stop_reason` first (`max_tokens` or `refusal` may leave it incomplete), then parse.

### Other endpoints

`GET /v1/models` (above) · `POST /v1/messages/count_tokens` (same body as Messages, returns input token count) · `POST /v1/messages/batches` (async, 50% cheaper) · `POST /v1/files` (upload once, reference by `file_id`).

## 7 · Gotchas

### Coming from OpenAI conventions

| OpenAI habit | Anthropic Messages API |
|---|---|
| `Authorization: Bearer` + `POST /chat/completions` | `x-api-key` (Bearer also accepted) + `anthropic-version` + `POST /v1/messages` |
| `max_tokens` optional | **required** |
| `{"role": "system"}` as the first message | top-level `system` field |
| `choices[0].message.content` | `content[]` blocks — take those with `type == "text"` |
| `finish_reason`: `stop` / `length` / `tool_calls` | `stop_reason`: `end_turn` / `max_tokens` / `tool_use` (+ `stop_sequence`, `pause_turn`, `refusal`) |
| `usage.prompt_tokens` / `completion_tokens` | `usage.input_tokens` / `output_tokens` (+ cache fields) |
| `tools: [{type: "function", function: {parameters}}]`, `tool_calls`, role `tool` | `tools: [{name, description, input_schema}]`; `tool_use` blocks in the assistant message, `tool_result` blocks in a **user** message |
| stream ends with `data: [DONE]` | named SSE events, ends with `message_stop` |
| `temperature`, `top_p`, `response_format` | omit sampling params; `output_config.format` for JSON |
| error `{"error": {"message", "type", "code"}}` | `{"type": "error", "error": {"type", "message"}, "request_id": "req_..."}` |

### Errors & limits

| status | `error.type` | do |
|---|---|---|
| 400 | `invalid_request_error` | fix the request (prefill, sampling params, thinking mode, forced `tool_choice`, missing workspace header, too many images); also returned when a spend limit the user set is hit ("You have reached your specified API usage limits") |
| 401 | `authentication_error` | bad, revoked or expired key — ask the user |
| 402 | `billing_error` | billing or payment problem on the user's account |
| 403 | `permission_error` | key lacks access to that model or resource |
| 404 | `not_found_error` | wrong model id or path (check section 4) |
| 413 | `request_too_large` | over 32 MB — shrink, or upload via the Files API |
| 429 | `rate_limit_error` | wait `retry-after` seconds; a 429 **without** `retry-after` and `error.details.error_code: "enforced_spend_limit_reached"` is the monthly spend cap — retrying cannot help |
| 500 / 529 | `api_error` / `overloaded_error` | retry with exponential backoff |
| 504 | `timeout_error` | stream instead of waiting |

- Rate limits are per organization and model class: requests, input tokens and output tokens per minute (cached input tokens mostly don't count). Response headers: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` (reset is RFC 3339) and `retry-after`. Don't retry other 4xx errors.
- A `refusal` is a normal 200 response, not an error.
- Never print the key or an `-H "x-api-key: ..."` line (`curl -v` shows it).

Docs checked 2026-10-25 (platform.claude.com/docs/en: models overview, api/overview, api/versioning, migration-2026-10-21, api/errors, api/rate-limits, manage-claude/authentication, build-with-claude: streaming, prompt-caching, vision, structured-outputs, handling-stop-reasons; agents-and-tools/tool-use: overview, define-tools, handle-tool-calls; models/opus-5-5 migration guide; api/models/list). Probed live with a deliberately invalid key only: endpoint reachable, 401 `authentication_error` body with `request_id`; no authenticated call was made, so response shapes come from the docs.
