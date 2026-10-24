Key + base URL + auth: see social/desearch/_index.yaml. Base https://api.desearch.ai, header `Authorization: $DESEARCH_KEY`.

# Desearch — Search · AI Search · Web · Network Stats

- Desearch is an AI-driven search and data-extraction API (OpenAPI 3.1, v1.0.0, 51 endpoints): live web search, AI-summarised search over web + X, and scrapers for X, TikTok, Facebook and Instagram.
- 9 endpoint groups: **Search** (1) · **AI Search** (3) · **Web Search** (3) · **Network Stats** (3) — the 10 endpoints in this file — plus **X Search** (9) in `x.md`, **TikTok / Facebook / Instagram** (7 + 6 + 6) in `platforms.md`, **People Search** (13) in `people.md`.
- GET = query params; POST = JSON body + `Content-Type: application/json`.
- Responses are JSON, except `GET /web/extract` and `/web/crawl` (plain text or HTML) and `GET /network/stats/stream` (Server-Sent Events).

## Pick an endpoint

| Need | Endpoint |
|---|---|
| Ranked web pages + the passage that best matches the query (simple JSON, no streaming) | `POST /search` |
| AI search over web + X, optional AI-written summary | `POST /desearch/ai/search` |
| AI-ranked web links only | `POST /desearch/ai/search/links/web` |
| AI-ranked X posts only | `POST /desearch/ai/search/links/twitter` |
| Google-style SERP, offset pagination | `GET /web` |
| Read one URL as text or HTML | `GET /web/extract` |
| Desearch's own public counters (no key) | `GET /network/stats` · `/history` · `/stream` |

## Billing metadata (every billable endpoint, here and in `x.md`)

The spec gives **no fixed credit or price per endpoint**. Instead each billable call reports its own cost, in USD:
- Response headers: `X-Desearch-Cost-Usd` (number) · `X-Desearch-Usage-Count` (integer billable units) · `X-Desearch-Service` (priced service name) · `X-Desearch-Currency` (always `USD`). Show them with `curl -sS -D - -o out.json …`.
- JSON-object bodies may also carry optional `cost_usd`, `usage_count`, `service`, `currency` (they are **required** on `POST /search`). JSON arrays, plain text and streams carry billing metadata in headers only.
- Price list: https://desearch.ai/pricing — not part of the spec, so no numbers are quoted here. Each endpoint below names its priced `service` where the spec does.
- The three Network Stats routes need no key and return no billing metadata.

## Search

### POST /search — Search API

Ranked web pages, each with the passage that best matches the query. The simplest one-call web search (JSON, non-streaming).

**Params** (JSON body, schema `SearchRequest`)

| name | in | type | req | note |
|---|---|---|---|---|
| `query` | body | string | yes | 1–2000 characters |
| `mode` | body | enum `fast` / `balanced` | no | default `balanced`. `fast` returns sooner; `balanced` favors relevance |
| `count` | body | integer | no | only `10`, `15` or `20`; default `10` |
| `start_date` | body | string `YYYY-MM-DD` | no | only pages published on or after this date |
| `end_date` | body | string `YYYY-MM-DD` | no | only pages published on or before this date |
| `highlights` | body | boolean | no | default `true`; include the passage that best matches the query |
| `page_text` | body | boolean | no | default `false`; include the full page text (response gets much larger) |

```bash
curl -sS https://api.desearch.ai/search \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -d '{"query":"Bitcoin spot ETF net inflows","mode":"balanced","count":10,"start_date":"2026-10-01","end_date":"2026-10-25","highlights":true,"page_text":false}'
```

**Response** `200` — `SearchResponse`. Shape from the schema (the spec has no literal example):
```jsonc
{
  "results": [
    {
      "url": "https://…",                  // required
      "title": "…",                        // required
      "published_date": "YYYY-MM-DD",      // nullable, "when known"
      "highlights": ["best-matching passage …"], // nullable; present unless highlights:false
      "page_text": "…"                     // nullable; only when page_text:true
    }
  ],
  "cost_usd": <number>,                    // all four cost fields are required on this route
  "usage_count": <integer>,
  "service": "<priced service name>",
  "currency": "USD"
}
```
**Cost:** USD per call, reported in the body (`cost_usd`). No price in spec; service name not given.

## AI Search

### POST /desearch/ai/search — AI Contextual Search

AI-powered search over web pages (`web`) and X posts (`twitter`), optionally with an AI-written summary. Web results arrive in `search`, X results in `tweets`.

**Params** (JSON body, schema `ScraperStreamingSynapseRequest`)

| name | in | type | req | note |
|---|---|---|---|---|
| `prompt` | body | string | yes | search prompt, e.g. `Bittensor` |
| `tools` | body | array of string | yes | `["web"]`, `["twitter"]` or both. Retired names are still accepted: `youtube` is dropped; `reddit` / `hackernews` / `wikipedia` / `arxiv` become a `web` search **pinned** to reddit.com / news.ycombinator.com / wikipedia.org / arxiv.org (results land in `search`; the pin covers the whole web search of the request). A list with no supported tool, e.g. `["youtube"]`, returns 422 |
| `start_date` | body | string `YYYY-MM-DDTHH:MM:SSZ` | no | UTC, e.g. `2026-10-18T00:00:00Z` |
| `end_date` | body | string `YYYY-MM-DDTHH:MM:SSZ` | no | UTC |
| `date_filter` | body | enum | no | DEPRECATED relative window: `PAST_24_HOURS` `PAST_2_DAYS` `PAST_WEEK` `PAST_2_WEEKS` `PAST_MONTH` `PAST_2_MONTHS` `PAST_YEAR` `PAST_2_YEARS`. Used only when no start/end date is given; prefer `start_date`/`end_date` |
| `streaming` | body | boolean | no | spec default **`true`** ("Whether to stream results"). Send `false` for the single JSON object below (see Gotchas) |
| `result_type` | body | enum | no | `ONLY_LINKS` or `LINKS_WITH_FINAL_SUMMARY` (default) |
| `mode` | body | enum | no | `fast` / `balanced` / `deep`. `fast` is web-only; X search supports `balanced` and `deep`. No default stated |
| `system_message` | body | string | no | default `""`. Steers the AI summary, e.g. `Summarize the content by categorizing key points into 'Pros' and 'Cons' sections.` |
| `scoring_system_message` | body | string | no | system message for scoring the response (spec example: a 2/5/9 "Business Relevance Scoring Guide" rubric for X posts) |
| `count` | body | integer | no | results **per source**; 10–200, default `10` |
| `include_domains` | body | array of string | no | restrict Web Search results to these domains, e.g. `["bbc.com","reuters.com"]` |
| `exclude_domains` | body | array of string | no | drop Web Search results from these domains, e.g. `["pinterest.com"]` |
| `highlights` | body | boolean | no | default `true`; token-efficient key excerpts on web results |
| `page_text` | body | boolean | no | default `false`; full page text on each web result (much larger) |

```bash
curl -sS https://api.desearch.ai/desearch/ai/search \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"Bittensor","tools":["web","twitter"],"mode":"balanced","result_type":"LINKS_WITH_FINAL_SUMMARY","count":10,"start_date":"2026-10-18T00:00:00Z","end_date":"2026-10-25T00:00:00Z","include_domains":["reuters.com","coindesk.com"],"streaming":false}'
```

**Response** `200` — `ResponseData` (trimmed, from the spec's field examples):
```jsonc
{
  "search": [                          // web results
    {
      "title": "What is Bittensor?",
      "link": "https://www.thebigwhale.io/tokens/bittensor",
      "snippet": "Bittensor (TAO) is a decentralized, open-source, and permissionless machine learning network that transforms machine intelligence into a tradable commodity."
    }
  ],
  "tweets": [                          // X results = Post objects (full shape: x.md "Post object")
    {
      "id": "1932946234920349827",
      "url": "https://x.com/HOSS_ibc/status/1932946234920349827",
      "text": "Bittensor $TAO seems oversold here. …",
      "created_at": "2025-06-11T23:41:09.000Z",
      "like_count": 31, "retweet_count": 3, "reply_count": 16, "quote_count": 3, "bookmark_count": 2,
      "user": { "id": "1416628772565143561", "username": "HOSS_ibc", "name": "Hoss", "followers_count": 63156 }
    }
  ],
  "text": "This is some additional text related to the search query.",
  "completion": "Bittensor is a decentralized, open-source machine learning network that transforms AI models into tradable commodities.",
  "warnings": [
    { "code": "tool_no_results", "tool": "twitter", "field": "tweets", "message": "Twitter Search returned no results or did not finish in time." }
  ]
}
```
- Every key is optional/nullable. `completion` = generated completion text ("typically used in AI-generated content results"); `text` = additional text.
- `warnings[]` appears only when both tools were requested and one returned nothing or did not respond (`code` is `tool_no_results` or `tool_unavailable`; `tool` is `web` or `twitter`). Omitted for single-tool requests and when everything returned results.
- `youtube_search`, `hacker_news_search`, `reddit_search` are deprecated and **never returned**.
- `search` items are loosely typed in the spec (string/integer values); with `highlights` / `page_text` the items may carry extra keys (exact shape unverified).
- The spec's response type is `anyOf` [`ResponseData` object, untyped object, string]; the untyped object and string variants are not described (possibly the streaming forms) — unresolved.

**Cost:** service `AI Search` (spec header example), USD per call, no price in spec.

### POST /desearch/ai/search/links/web — AI Web Search

AI-ranked web links for a prompt (X is not available here — use the X route below). Results arrive in `search_results`.

**Params** (JSON body, schema `LinksSearchRequestWeb`)

| name | in | type | req | note |
|---|---|---|---|---|
| `prompt` | body | string | yes | search prompt, e.g. `What are the recent sport events?` |
| `tools` | body | array of string | yes | only `["web"]` is supported. Retired names (`youtube`, `reddit`, `hackernews`, `wikipedia`, `arxiv`) are accepted but **dropped** (no domain pinning on this route); a list left with no supported tool, e.g. `["youtube"]`, returns 422 |
| `start_date` | body | string `YYYY-MM-DDTHH:MM:SSZ` | no | UTC |
| `end_date` | body | string `YYYY-MM-DDTHH:MM:SSZ` | no | UTC |
| `date_filter` | body | enum | no | DEPRECATED, same values as the AI Contextual Search route; prefer start/end |
| `count` | body | integer | no | results per source; 10–200, default `10` |
| `highlights` | body | boolean | no | default `true` |
| `page_text` | body | boolean | no | default `false`; full page text per result (much larger) |

To scope to one site there is no `include_domains` here: put `site:<domain>` in the prompt, or use `POST /desearch/ai/search` with `include_domains`.

```bash
curl -sS https://api.desearch.ai/desearch/ai/search/links/web \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"Ethereum staking ETF approval site:reuters.com","tools":["web"],"count":10,"highlights":true,"page_text":false}'
```

**Response** `200` — `WebSearchResponse` (trimmed; the item example is the spec's):
```json
{
  "search_results": [
    {
      "title": "EXCLUSIVE Major coffee buyers face losses as Colombia ...",
      "snippet": "Coffee farmers in Colombia, the world's No. 2 arabica producer, have failed to deliver up to 1 million bags of beans this year or nearly 10% ...",
      "link": "https://www.reuters.com/world/americas/exclusive-major-coffee-buyers-face-losses-colombia-farmers-fail-deliver-2021-10-11/",
      "highlights": ["…key excerpt…"],
      "text": "…full page text, only when page_text:true…"
    }
  ]
}
```
`search_results` is always present (empty list when nothing matched). `highlights` is returned unless `highlights:false`. The keys `youtube_search_results`, `hacker_news_search_results`, `reddit_search_results`, `arxiv_search_results`, `wikipedia_search_results` are deprecated and never returned.

**Cost:** service `AI Search Web Links` (spec header example), USD per call, no price in spec.

### POST /desearch/ai/search/links/twitter — AI X Posts Search

AI-ranked X posts for a prompt. Results arrive in `miner_tweets`.

**Params** (JSON body, schema `LinksSearchRequestTwitter`)

| name | in | type | req | note |
|---|---|---|---|---|
| `prompt` | body | string | yes | search prompt, e.g. `What are the recent sport events?` |
| `count` | body | integer | no | results per source; 10–200, default `10` |

```bash
curl -sS https://api.desearch.ai/desearch/ai/search/links/twitter \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"what is crypto twitter saying about the Solana ETF","count":20}'
```

**Response** `200` — `XLinksSearchResponse`:
```jsonc
{
  "miner_tweets": [          // required; array of Post objects (full shape: x.md "Post object")
    {
      "id": "1932946234920349827",
      "url": "https://x.com/HOSS_ibc/status/1932946234920349827",
      "text": "Bittensor $TAO seems oversold here. …",
      "created_at": "2025-06-11T23:41:09.000Z",
      "like_count": 31, "retweet_count": 3, "reply_count": 16, "quote_count": 3, "bookmark_count": 2,
      "user": { "id": "1416628772565143561", "username": "HOSS_ibc", "name": "Hoss" }
    }
  ]
}
```
**Cost:** service `AI Search X Links` (spec header example), USD per call, no price in spec.

## Web Search & Extract

### GET /web — SERP Web Search API

Classic search-engine results for a query, paginated by result offset.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `query` | query | string | yes | e.g. `latest news on AI` |
| `start` | query | integer | no | results to skip, max `100`, default `0`: `0` = page 1, `10` = page 2, `20` = page 3 … |

```bash
curl -sS -G https://api.desearch.ai/web \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "query=latest news on AI" \
  --data-urlencode "start=10"
```

**Response** — the spec documents the success status as **`201`** (no `200`), schema `WebSearchResultsResponse`:
```json
{
  "data": [
    {
      "title": "EXCLUSIVE Major coffee buyers face losses as Colombia ...",
      "snippet": "Coffee farmers in Colombia, the world's No. 2 arabica producer, have failed to deliver up to 1 million bags of beans this year or nearly 10% ...",
      "link": "https://www.reuters.com/world/americas/exclusive-major-coffee-buyers-face-losses-colombia-farmers-fail-deliver-2021-10-11/"
    }
  ]
}
```
Items share the `WebSearchResultItem` schema, which also defines optional `highlights` / `text`; this route has no `highlights` / `page_text` request flags, so expect only `title`, `snippet`, `link` (unverified).

**Cost:** service `Web Search` (spec header example), USD per call, no price in spec.

### GET /web/extract — Extract API

Fetch one public URL and return its extracted text or HTML. The body is the raw page content, **not JSON**.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `url` | query | string | yes | URL to extract, e.g. `https://en.wikipedia.org/wiki/Artificial_intelligence` |
| `format` | query | enum `text` / `html` | no | default `text` → `text/plain; charset=utf-8`; `html` → `text/html; charset=utf-8` |
| `js` | query | string `true` / `false` | no | default `false`. `true` renders the page in a headless browser first (SPAs / JS-populated pages) and **enables a separate billing tier**. Must be exactly lowercase `true` or `false` |
| `wait` | query | integer 0–30000 | no | extra wait in ms after the page loads; applied **only when `js=true`** |

```bash
# static page, plain text
curl -sS -G https://api.desearch.ai/web/extract \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "url=https://en.wikipedia.org/wiki/Artificial_intelligence" \
  --data-urlencode "format=text"

# JavaScript-rendered page, HTML, wait 2 s
curl -sS -G https://api.desearch.ai/web/extract \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "url=https://example.com/app" \
  --data-urlencode "format=html" --data-urlencode "js=true" --data-urlencode "wait=2000"
```

**Response** `200` — the page body as `text/plain` or `text/html` (billing metadata in headers only). Upstream failures: `502` crawler upstream unavailable, `504` crawler upstream timed out.

**Cost:** `js=true` is a separate billing tier; service name not given in the spec. USD per call, no price in spec.

### GET /web/crawl — Extract API (Legacy)

**Deprecated** compatibility alias of `GET /web/extract` (`deprecated: true` in the spec). Same params and response; new code should call `/web/extract`.

**Params** (query string — identical to `/web/extract`)

| name | in | type | req | note |
|---|---|---|---|---|
| `url` | query | string | yes | URL to extract content from |
| `format` | query | enum `text` / `html` | no | default `text` (`text/plain`); `html` → `text/html` |
| `js` | query | string `true` / `false` | no | default `false`; `true` = headless-browser render, separate billing tier; exactly lowercase |
| `wait` | query | integer 0–30000 | no | extra wait in ms; applied only when `js=true` |

```bash
curl -sS -G https://api.desearch.ai/web/crawl \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "url=https://en.wikipedia.org/wiki/Artificial_intelligence" \
  --data-urlencode "format=text"
```
**Cost:** service `Extract API` (spec header example); same billing as `/web/extract`.

## Network Stats (public — no API key)

All three routes have `security: []` in the spec and were checked live on 2026-10-25 without any `Authorization` header (HTTP 200). They report Desearch's own public network counters (the spec says the source is an estimate), not your account usage.

### GET /network/stats — Get public network stats

Latest network counters and their per-second growth rates. Params: none.

```bash
curl -sS https://api.desearch.ai/network/stats
```

**Response** `200` — `NetworkStatsResponse` (live sample, 2026-10-25):
```json
{
  "total_searchable_pages": 1638966672,
  "searches_completed_today": 20553639,
  "urls_crawled_today": 1014160935,
  "rates_per_second": { "total_searchable_pages": 184, "searches_completed_today": 6, "urls_crawled_today": 296 },
  "started_at": "2026-09-16T07:04:12Z",
  "updated_at": "2026-10-24T22:52:56.990150Z",
  "telemetry_kind": "estimated",
  "methodology": "fixed_rate_projection"
}
```
`telemetry_kind` is always `estimated` and `methodology` always `fixed_rate_projection`: the numbers are a fixed-rate projection, **not measured traffic**.

### GET /network/stats/history — Get the latest 20 minutes of network stats

One-second timeline for the latest 20 minutes, to pre-fill a buffer before following the stream. Params: none. Live response is ~260 KB / 1201 points, so slice it:

```bash
curl -sS https://api.desearch.ai/network/stats/history | python3 -c 'import sys,json;d=json.load(sys.stdin);print({k:v for k,v in d.items() if k!="points"}, len(d["points"]), d["points"][-1])'
```

**Response** `200` — `NetworkStatsHistoryResponse` (live sample, `points` trimmed to the last one):
```json
{
  "window_seconds": 1200,
  "interval_seconds": 1,
  "window_started_at": "2026-10-24T22:32:58.304050Z",
  "window_ended_at": "2026-10-24T22:52:58.304050Z",
  "points": [
    {
      "total_searchable_pages": 1638967040,
      "searches_completed_today": 20553651,
      "urls_crawled_today": 1014161527,
      "observed_at": "2026-10-24T22:52:58.304050Z",
      "telemetry_kind": "estimated",
      "methodology": "fixed_rate_projection"
    }
  ]
}
```

### GET /network/stats/stream — Stream live network stats

**Stream:** Server-Sent Events (`text/event-stream`), one `stats` event per second; each `data:` line is the same JSON as `GET /network/stats`. Reconnect with the `Last-Event-ID` header to replay snapshots missed within the last 20 minutes. The connection never ends on its own — always cap it.

```bash
curl -sS -N -m 5 https://api.desearch.ai/network/stats/stream
# resume after a drop:
curl -sS -N -m 5 https://api.desearch.ai/network/stats/stream -H "Last-Event-ID: 1792882380"
```

**Response** (live sample, first event):
```
id: 1792882380
event: stats
data: {"total_searchable_pages":1638967408,"searches_completed_today":20553663,"urls_crawled_today":1014162119,"rates_per_second":{"total_searchable_pages":184,"searches_completed_today":6,"urls_crawled_today":296},"started_at":"2026-09-16T07:04:12Z","updated_at":"2026-10-24T22:53:00.686106Z","telemetry_kind":"estimated","methodology":"fixed_rate_projection"}

```

## Gotchas

- **Auth is the raw key** in `Authorization` (no `Bearer`). Missing key → `401 {"detail":"Unauthorized"}` (live-checked); an invalid key's spec example is `{"detail":"Invalid API key"}`. Do not use `curl -v` — it prints the `Authorization` header.
- **Other errors** (spec): POST routes `400 {"detail":"Invalid JSON body"}`; `422 {"detail":[{"loc":[…],"msg":"…","type":"…"}]}`; `429 {"detail":{"error_code":429,"message":"Too Many Requests","retry_after":"60 seconds"}}` — wait `retry_after`, the spec states no rate-limit numbers; `500 {"detail":{"description":"An unexpected error occurred on the server.","error_code":500,"message":"Internal Server Error"}}`; `503 "Search unavailable"` on `POST /search` and the AI-search routes. The spec also lists `301` / `304` on most routes without describing them.
- **Success status is not always 200**: `GET /web` documents `201` only — treat any 2xx as success.
- **`streaming` defaults to `true` on `POST /desearch/ai/search`** and the spec does not describe the stream wire format. Send `"streaming": false` to ask for the single JSON object that the 200 response describes (not live-verified — no paid call was made while writing this).
- **`count` ranges differ by route**: `/search` only `10`/`15`/`20`; AI-search routes 10–200 **per source** (you cannot ask for fewer than 10); X search is 1–100 (see `x.md`).
- **Date formats differ**: `/search` takes `YYYY-MM-DD`; AI-search routes take `YYYY-MM-DDTHH:MM:SSZ` (UTC). `date_filter` is deprecated and ignored when start/end dates are set.
- **Retired tools** (`youtube`, `reddit`, `hackernews`, `wikipedia`, `arxiv`): never produce their own result keys. In `POST /desearch/ai/search` the last four are mapped to `web` and add their domain to `include_domains`, which **pins the whole web search of the request** to those domains — leave them out unless you want that. Scope by site with `include_domains` or `site:<domain>` in the prompt.
- **`page_text: true` makes responses much larger** (full page text per result) — use it only when you need to read pages; `GET /web/extract` is the targeted way to read one URL.
- **`/web/extract` and `/web/crawl` return the page body, not JSON** — and error bodies are declared `text/plain` in the spec but the live API returned JSON for a missing key; parse defensively. `js` must be exactly `true` or `false`.
- **Network Stats are estimates** (`fixed_rate_projection`), not real telemetry — never use them as a data source.
- **Billing is USD per call** (see Billing metadata). The numeric price list is not in the spec: read `X-Desearch-Cost-Usd` after a call, or https://desearch.ai/pricing, before looping over expensive routes.
