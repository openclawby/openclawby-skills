# Desearch: People Search (async tasks)

Key + base URL + auth: see social/desearch/_index.yaml. Base https://api.desearch.ai, header `Authorization: $DESEARCH_KEY`.

13 endpoints. People Search finds **people** (profiles / creators), not posts. You describe who you want in plain language; Desearch searches the platform, groups matches by author, reads each profile, scores how well each one fits (fit score 0-100) and returns profiles with the reasons and the evidence (the posts or videos that prove the match). Four platforms: X, YouTube, LinkedIn, TikTok. Public data only. For post-level data use `x.md` (X) or `platforms.md` (TikTok / Facebook / Instagram).

Routes: 4 search starters (`POST /desearch/people/search/{x|youtube|linkedin|tiktok}`), 2 cross-search "people library" routes (`/profiles`, `/profiles/export`), 7 task routes (`/tasks`, `/tasks/{task_id}`, `/results`, `/export`, `/pause`, `/resume`, `/cancel`).

## How it works: the async task model (read first)

A search is a **background task**, not a request/response call. The POST returns at once with a `task_id` and no profiles; you then poll the task and read the results.

```
1 START  POST /desearch/people/search/{x|youtube|linkedin|tiktok}
            -> 202 + task { task_id, status: "queued", ... }     returns immediately; RESERVES count x price
2 POLL   GET  /desearch/people/tasks/{task_id}                   every few seconds (free), until status is
            completed | partial | failed | cancelled
3 READ   GET  /desearch/people/tasks/{task_id}/results           paged with a cursor; profiles arrive WHILE it runs
   or    GET  /desearch/people/tasks/{task_id}/export?format=csv a downloadable file (csv or jsonl)
4 STEER  POST /desearch/people/tasks/{task_id}/pause | resume | cancel      any time
Across all your searches:
         GET  /desearch/people/profiles  (+ /profiles/export)    deduped "people library", one row per person
         GET  /desearch/people/tasks                             list your tasks (recover a lost task_id)
```

Status lifecycle (transitions are inferred from the pause/resume/cancel descriptions; the spec has no formal state machine):

```
queued -> running -> completed | partial | failed
queued -> paused (pause on a queued task is immediate)
running -> pausing -> paused -> running (resume)     paused for more than 7 days: auto-cancelled
queued/running/paused -> cancelling -> cancelled
results older than 30 days after the end: 410 on results/export (status `expired` exists in the enum)
```

| status | note |
|---|---|
| `queued`, `running` | in progress; while running `stage` goes `planning`, `searching`, `processing`, `finalizing` |
| `pausing` | pause requested, the current batch is finishing; then `paused` |
| `paused` | resumable; auto-cancelled after 7 days |
| `cancelling` | cancel in progress (not described further in the spec) |
| `completed` | finished. Does NOT mean `count` was reached, and can hold zero profiles: read `completion_reason` and `coverage_limited` |
| `partial`, `failed`, `cancelled` | terminal; `partial` is not defined further in the spec |
| `expired` | in the enum, not described; consistent with results past the 30-day retention |

`completion_reason` (null until the task ends):

| value | meaning |
|---|---|
| `count_reached` | found `count` profiles |
| `rounds_exhausted` | ran every search it planned and found fewer than `count` |
| `no_candidates` | its searches found nobody to check |
| `zero_qualified` | checked the people found and none fit |
| `candidate_budget` | checked as many candidates as a search of this `count` may: min(1000, max(150, count x 8)) |
| `cost_limit` | what searching cost reached what its results would bill, so it stopped |
| `time_limit` | hit the maximum run time |
| `cancelled` / `failed` | cancelled by you / an error ended it (every search failed, or internal error) |

`coverage_limited: true` means a budget (`candidate_budget`, `cost_limit` or `time_limit`) stopped it before `count`, so more matching people may exist. `warnings[]` lists partial failures (code `partial_enrichment`: some profiles could not be read after search and were scored on the search hit only).

**Billing (from the spec)**: creating a search RESERVES `count` profiles at the route price from the user's Desearch balance (`reserved_cost_usd` on the task). When it ends you pay only for the qualified profiles it delivered (a per-search minimum applies when it finds anyone); the rest is refunded automatically (`final_cost_usd`, `refunded_usd`). A search that delivers no profiles is free; one cancelled before it starts is free. If the balance cannot cover the reservation: 402. An idempotent replay is not charged again. **Every other People Search route is Free** (polling, results, exports, library, pause, resume, cancel).

**Rates (from https://desearch.ai/pricing, NOT in the OpenAPI spec; page dated 19 Oct 2026, confirm in the Desearch console)**: X Profile Search $40.00 / 1,000 profiles (minimum 5 per search that finds anyone); YouTube Creator Search $50.00 / 1,000 creators (min 3); LinkedIn Profile Search $50.00 / 1,000 profiles (min 2); TikTok Creator Search $50.00 / 1,000 creators (min 2). Example: `count: 25` on X reserves about $1.00. The authoritative numbers are `reserved_cost_usd` / `final_cost_usd` on the task.

**Retention**: results stay available for 30 days after the search ends (`results_expire_at`); then results/export return 410 and the search drops out of the people library.

## Quickstart (start, poll, read)

```bash
# 1) start. Idempotency-Key makes a retry safe (same key = same task, not charged twice).
#    On 402 / 429 the body has no task_id: check the HTTP status first.
TASK_ID=$(curl -s -X POST https://api.desearch.ai/desearch/people/search/x \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"query":"Indie hackers building in public who share their MRR","count":25,"min_score":60}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["task_id"])')

# 2) poll (free) until the task is terminal
while :; do
  STATUS=$(curl -s "https://api.desearch.ai/desearch/people/tasks/$TASK_ID" -H "Authorization: $DESEARCH_KEY" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  case "$STATUS" in completed|partial|failed|cancelled|expired) break;; esac
  sleep 5
done

# 3) read the profiles (or download them)
curl -s "https://api.desearch.ai/desearch/people/tasks/$TASK_ID/results?limit=500" -H "Authorization: $DESEARCH_KEY"
curl -s -G "https://api.desearch.ai/desearch/people/tasks/$TASK_ID/export" --data-urlencode "format=csv" \
  -H "Authorization: $DESEARCH_KEY" -o people.csv
```

## Search request (the same for all four POST search routes)

| param | in | type | req | note |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, max 200 | no | any unique string, e.g. a UUID. Whitespace is trimmed, longer keys are cut to 200 (not rejected). Same key again for this account returns the original task with HTTP 200 and is not charged; a new key starts a search (HTTP 202). Without a key every call starts a new search |
| `query` | body | string, 3-1000 chars | yes | who you are looking for, in plain language |
| `count` | body | int 5-200 | no | default 25. Target number of qualified profiles AND the size of the reservation |
| `min_score` | body | int 0-100 | no | only return profiles with at least this fit score |
| `exclude` | body | string[], max 1000 | no | handles to leave out (e.g. people already contacted); handle format is not specified |
| `metadata` | body | object of strings | no | your own labels: max 10 keys; key 1-40 chars of `a-z 0-9 _ . -`; value max 200 chars. Echoed on the task; filter tasks later with `metadata.<key>=<value>`; never used by the search |
| `filters` | body | object | no | platform-specific, see below |

Platform filters (all optional; a filter the platform does not support is rejected as a bad request):

| filter | x | youtube | linkedin | tiktok |
|---|---|---|---|---|
| `min_followers`, `max_followers` (int >= 0) | yes | no | yes | yes |
| `min_subscribers`, `max_subscribers` (int >= 0) | no | yes | no | no |
| `verified_only` (bool, default false: only verified/X Premium) | yes | no | no | no |
| `require_contact` (bool, default false) | no | yes (public email or contact link) | no | yes (public email in the bio) |
| `countries` (string[], "countries to prefer") | yes | yes | yes | no |
| `keywords` (string[], words that should appear) | yes | yes | yes | yes |
| `exclude_keywords` (string[], leave out profiles that mention these) | yes | yes | yes | yes |

For YouTube, a creator whose subscriber count is unknown (hidden or unreadable) does not pass `min_subscribers` or `max_subscribers`.

Search responses: `202` = new task; `200` = same Idempotency-Key as an earlier search (that task, no new charge); both return the `PeopleTask` below. Errors: `400` bad parameter, `401` bad key, `402` not enough credits for the reservation, `422` validation, `429` "Too many searches are already queued, running or paused" (a concurrency cap, value not stated), `500`.

## Shared objects

```
PeopleTask {                         // search routes, get task, pause/resume/cancel, and tasks[] in the list; extra fields may appear
  task_id: uuid                      // the handle for every other route
  search_type: x_profile_search | youtube_creator_search | linkedin_profile_search | tiktok_creator_search
  platform: x | youtube | linkedin | tiktok
  status: queued | running | pausing | paused | cancelling | completed | partial | failed | cancelled | expired
  stage?: planning | searching | processing | finalizing | null
  query: string, count: int, result_count: int          // result_count = profiles delivered so far
  metadata?: { string: string }      // what you sent ({} if none)
  interpreted?: object | null        // how the search was understood: criteria + the queries it ran (free-form)
  progress?: object                  // live counters + `stop_reason` (internal; prefer completion_reason). Free-form
  errors?: any[]
  completion_reason?: count_reached | rounds_exhausted | no_candidates | zero_qualified | candidate_budget | cost_limit | time_limit | cancelled | failed | null
  coverage_limited?: bool            // default false
  warnings?: [ { code: "partial_enrichment", platform?, attempted?, enriched?, failed?, by_reason?: { reason: int }, message? } ]
  reserved_cost_usd: number          // reserved at creation
  final_cost_usd?: number | null     // once ended; the rest of the reservation is returned
  refunded_usd?: number | null
  created_by?: { user_id?, api_key_id?, via? } | null
  created_at: date-time              // required; also started_at?, paused_at?, finished_at?, results_expire_at?
  links?: { self, results, export } | null
}

Person {                             // one qualified profile (X, LinkedIn) or creator (YouTube, TikTok); extra fields may appear
  id: string, platform: x | youtube | linkedin | tiktok, handle: string          // these three always present
  url?, name?, avatar_url?, bio?, location?: string | null
  metrics?: object                   // free-form audience/engagement numbers; keys not specified in the spec
  links?: object[], contacts?: object[]      // free-form; contacts carry public emails etc. when listed; item shape not specified
  evidence?: [ { type, url?, text?, title?, published_at?, metrics? } ]          // the posts/videos behind the match
  score?: {
    value: number | null             // fit score, same 0-100 scale as `min_score`
    qualified: bool | null
    summary: string                  // one line: why this person matched
    matched_signals[], profile_fit[] (why who they are fits), buying_triggers[] (what they post/do that matches),
    evidence[] (post/video/profile text behind the match), reasons[] (those three combined), concerns[]
    criteria_checks?: [ { criterion, verdict: met | not_met | unknown, quote?, source_url?, reason?, is_disqualifier? } ]
    fully_verified?: bool | null     // every criterion met and no disqualifier met
  } | null
  attributes?: object                // platform-specific: verified (X, TikTok); headline, company (LinkedIn); region (TikTok);
                                     // LinkedIn/TikTok/YouTube also enrichment: "ok" | "failed" (+ enrichment_error:
                                     // not_found | rate_limited | timeout | upstream_error | request_error)
}
PeopleProfile = Person + found_by: { task_id: uuid, query, found_at: date-time, times_found: int }   // library routes only
```

Library filters, shared by `GET /profiles`, `GET /profiles/export` and `GET /tasks/{task_id}/export`:

| param | in | type | note |
|---|---|---|---|
| `has` | query | string | comma-separated channels EVERY person must have: `email`, `website`, `x`, `linkedin`, `instagram`, `youtube`, `tiktok` |
| `min_audience`, `max_audience` | query | int >= 0 | followers (subscribers on YouTube) |
| `min_score` | query | int 0-100 | minimum fit score |
| `location` | query | string, max 100 | text in the location, e.g. `united states` |
| `verified` | query | bool | only verified accounts (X and TikTok only) |

---

### POST /desearch/people/search/x — X Profile Search

Find X accounts by what they post and how they describe themselves. Scans recent X posts for people talking about the topic, groups the matches by author, reads each profile (bio, followers, website, location) and scores the fit. Returns profiles, not posts.

Params: header `Idempotency-Key`; body `query` (req), `count`, `min_score`, `exclude`, `metadata`, `filters` (see "Search request"). `filters` for X:

| param | in | type | req | note |
|---|---|---|---|---|
| `filters.min_followers` | body | int >= 0 | no | minimum follower count |
| `filters.max_followers` | body | int >= 0 | no | maximum follower count |
| `filters.verified_only` | body | bool | no | default false; only verified or X Premium accounts |
| `filters.countries` | body | string[] | no | countries to prefer, e.g. `["US","GB"]` |
| `filters.keywords` | body | string[] | no | words that should appear in posts or bios |
| `filters.exclude_keywords` | body | string[] | no | leave out profiles that mention these words |

```bash
curl -s -X POST https://api.desearch.ai/desearch/people/search/x \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"query":"Indie hackers building in public who share their MRR","count":25,"min_score":60,"filters":{"min_followers":200},"metadata":{"campaign":"q4-outbound"}}'
```

Response `202` (or `200` on an idempotent replay): the new `PeopleTask`.

```jsonc
{
  "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872",
  "search_type": "x_profile_search",
  "platform": "x",
  "status": "queued",
  "query": "Indie hackers building in public who share their MRR",
  "count": 25,
  "result_count": 0,
  "metadata": { "campaign": "q4-outbound" },
  "reserved_cost_usd": <number>,      // amount reserved for `count` profiles
  "created_at": "<date-time>",
  "links": { "self": "<url>", "results": "<url>", "export": "<url>" }
}
```

Cost: reserves `count` x route price now; you pay only for the qualified profiles delivered (rates above).

### POST /desearch/people/search/youtube — YouTube Creator Search

Find YouTube creators by what their videos are about. Finds videos and channels on the topic, groups them by creator, reads each channel (About section, subscribers, country, links) and the creator's own website for publicly listed contact details, and scores the fit. Returns creators, not videos: subscribers, links, a public email when the creator lists one, a fit score and the videos that matched.

Params: header `Idempotency-Key`; body `query` (req), `count`, `min_score`, `exclude`, `metadata`, `filters` (see "Search request"). `filters` for YouTube:

| param | in | type | req | note |
|---|---|---|---|---|
| `filters.min_subscribers` | body | int >= 0 | no | unknown subscriber count does not pass |
| `filters.max_subscribers` | body | int >= 0 | no | unknown subscriber count does not pass |
| `filters.countries` | body | string[] | no | channel countries to prefer, e.g. `["US"]` |
| `filters.require_contact` | body | bool | no | default false; only creators with a public email or contact link |
| `filters.keywords` | body | string[] | no | words that should appear in videos or channel descriptions |
| `filters.exclude_keywords` | body | string[] | no | leave out creators that mention these words |

```bash
curl -s -X POST https://api.desearch.ai/desearch/people/search/youtube \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"query":"Fitness creators who review supplements","count":25,"filters":{"min_subscribers":10000,"max_subscribers":500000}}'
```

Response `202` / `200`: a `PeopleTask` with `"search_type": "youtube_creator_search"`, `"platform": "youtube"`.

```jsonc
{ "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872", "search_type": "youtube_creator_search", "platform": "youtube",
  "status": "queued", "query": "Fitness creators who review supplements", "count": 25, "result_count": 0,
  "reserved_cost_usd": <number>, "created_at": "<date-time>" }
```

Cost: reserve-then-charge as above.

### POST /desearch/people/search/linkedin — LinkedIn Profile Search

Find LinkedIn members by what they post and by their role. Looks for public LinkedIn posts on the topic and public profiles whose headline matches the role, reads each profile (headline, company, location, followers, about) and scores the fit. Returns profiles, not posts. Public data only.

Params: header `Idempotency-Key`; body `query` (req), `count`, `min_score`, `exclude`, `metadata`, `filters` (see "Search request"). `filters` for LinkedIn:

| param | in | type | req | note |
|---|---|---|---|---|
| `filters.min_followers` | body | int >= 0 | no | minimum LinkedIn follower count |
| `filters.max_followers` | body | int >= 0 | no | maximum LinkedIn follower count |
| `filters.countries` | body | string[] | no | countries to prefer, e.g. `["US","United Kingdom"]` (full names also appear in the spec example) |
| `filters.keywords` | body | string[] | no | words that should appear in posts, headlines or about sections |
| `filters.exclude_keywords` | body | string[] | no | leave out profiles that mention these words |

```bash
curl -s -X POST https://api.desearch.ai/desearch/people/search/linkedin \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"query":"Heads of sales at fintech startups who post about outbound","count":25,"filters":{"countries":["United States","United Kingdom"]}}'
```

Response `202` / `200`: a `PeopleTask` with `"search_type": "linkedin_profile_search"`, `"platform": "linkedin"`. The spec's own `partial_enrichment` warning example is a LinkedIn run (profiles that could not be read after search); LinkedIn, TikTok and YouTube runs can all report it.

```jsonc
{ "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872", "search_type": "linkedin_profile_search", "platform": "linkedin",
  "status": "queued", "query": "Heads of sales at fintech startups who post about outbound", "count": 25, "result_count": 0,
  "reserved_cost_usd": <number>, "created_at": "<date-time>" }
```

Cost: reserve-then-charge as above.

### POST /desearch/people/search/tiktok — TikTok Creator Search

Find TikTok creators by what their videos are about. Looks for TikTok videos on the topic and accounts whose name or bio matches, groups them by creator, reads each profile (bio, followers, likes, latest videos, public email in the bio) and scores the fit. Returns creators, not videos: followers, links, a public email when the bio lists one, a fit score and the videos that matched. Public data only.

Params: header `Idempotency-Key`; body `query` (req), `count`, `min_score`, `exclude`, `metadata`, `filters` (see "Search request"). `filters` for TikTok (there is no `countries`):

| param | in | type | req | note |
|---|---|---|---|---|
| `filters.min_followers` | body | int >= 0 | no | minimum TikTok follower count |
| `filters.max_followers` | body | int >= 0 | no | maximum TikTok follower count |
| `filters.require_contact` | body | bool | no | default false; only creators with a public email in their bio |
| `filters.keywords` | body | string[] | no | words that should appear in videos or bios |
| `filters.exclude_keywords` | body | string[] | no | leave out creators that mention these words |

```bash
curl -s -X POST https://api.desearch.ai/desearch/people/search/tiktok \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"query":"Skincare creators who review sunscreen","count":25,"filters":{"min_followers":10000,"require_contact":true}}'
```

Response `202` / `200`: a `PeopleTask` with `"search_type": "tiktok_creator_search"`, `"platform": "tiktok"`.

```jsonc
{ "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872", "search_type": "tiktok_creator_search", "platform": "tiktok",
  "status": "queued", "query": "Skincare creators who review sunscreen", "count": 25, "result_count": 0,
  "reserved_cost_usd": <number>, "created_at": "<date-time>" }
```

Cost: reserve-then-charge as above.

### GET /desearch/people/profiles — List the people your searches found

The people library: everyone your searches on ONE platform found, one entry per person (their best-scoring result plus the search behind it, `found_by`). Free-text search, channel / audience / score / location / verification filters, three sort orders. Searches whose results expired (30 days after they ended) are left out.

| param | in | type | req | note |
|---|---|---|---|---|
| `platform` | query | string | yes | `x`, `youtube`, `linkedin` or `tiktok` |
| `q` | query | string, max 200 | no | text in the name, handle, bio or location |
| `sort` | query | string | no | `score` (default), `recent` or `audience` |
| `limit` | query | int 1-200 | no | default 50 |
| `cursor` | query | string | no | `next_cursor` of the previous page |
| `has` | query | string | no | library filter: channels every person must have (see "Library filters") |
| `min_audience`, `max_audience` | query | int >= 0 | no | followers (subscribers on YouTube) |
| `min_score` | query | int 0-100 | no | minimum fit score |
| `location` | query | string, max 100 | no | text in the location |
| `verified` | query | bool | no | X and TikTok only |

```bash
curl -s -G https://api.desearch.ai/desearch/people/profiles \
  --data-urlencode "platform=x" --data-urlencode "has=email" --data-urlencode "min_score=60" \
  --data-urlencode "sort=score" --data-urlencode "limit=50" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`:

```jsonc
{
  "profiles": [ /* PeopleProfile[] = Person + found_by, one per person */ ],
  "total": <int>,                // people matching the filter across all your (unexpired) searches
  "next_cursor": "<opaque>"      // pass as `cursor` for the next page; null on the last page
}
```

Cost: Free.

### GET /desearch/people/profiles/export — Download the people your searches found

Everything `GET /desearch/people/profiles` lists for the same platform and filters, as a CSV or JSON Lines file (up to 10,000 people).

| param | in | type | req | note |
|---|---|---|---|---|
| `platform` | query | string | yes | `x`, `youtube`, `linkedin` or `tiktok` |
| `format` | query | string | no | `csv` (default) or `jsonl` |
| `q` | query | string, max 200 | no | text in the name, handle, bio or location |
| `sort` | query | string | no | `score` (default), `recent` or `audience` |
| `has` | query | string | no | channels every person must have |
| `min_audience`, `max_audience` | query | int >= 0 | no | followers (subscribers on YouTube) |
| `min_score` | query | int 0-100 | no | minimum fit score |
| `location` | query | string, max 100 | no | text in the location |
| `verified` | query | bool | no | X and TikTok only |

```bash
curl -s -G https://api.desearch.ai/desearch/people/profiles/export \
  --data-urlencode "platform=x" --data-urlencode "format=jsonl" --data-urlencode "min_score=60" \
  -H "Authorization: $DESEARCH_KEY" -o x-people.jsonl
```

Response `200`: a file, `text/csv` or `application/x-ndjson` (one `PeopleProfile` JSON object per line for `jsonl`). CSV columns are not specified in the spec. No cursor; capped at 10,000 people.

Cost: Free.

### GET /desearch/people/tasks — List People Search tasks

Your account's People Search tasks, newest first. Use it to recover a `task_id` or to monitor several searches.

| param | in | type | req | note |
|---|---|---|---|---|
| `platform` | query | string | no | `x`, `youtube`, `linkedin` or `tiktok` |
| `status` | query | string | no | comma-separated statuses, e.g. `running,paused` |
| `limit` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | `next_cursor` of the previous page; keep the same filters when paging |
| `metadata.<key>` | query | string | no | exact-match filter on the `metadata` you sent; up to 3 per request, a task must match all of them, e.g. `metadata.campaign=q4-outbound` |

```bash
curl -s -G https://api.desearch.ai/desearch/people/tasks \
  --data-urlencode "platform=x" --data-urlencode "status=running,paused" \
  --data-urlencode "metadata.campaign=q4-outbound" --data-urlencode "limit=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`:

```jsonc
{ "tasks": [ /* PeopleTask[], newest first */ ], "next_cursor": "<opaque or null>" }
```

Cost: Free.

### GET /desearch/people/tasks/{task_id} — Get a People Search task

Status, progress and cost of one task. Poll every few seconds while it runs. Once it has ended, read `completion_reason`, `coverage_limited` and `warnings`.

| param | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | uuid | yes | the `task_id` returned when the search was created |

```bash
# {task_id} = 5b33f3ee-168b-4780-9c8e-63a626781872
curl -s "https://api.desearch.ai/desearch/people/tasks/5b33f3ee-168b-4780-9c8e-63a626781872" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: the `PeopleTask`. `404` if the task is unknown. Trimmed example of a finished LinkedIn search:

```jsonc
{
  "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872",
  "search_type": "linkedin_profile_search", "platform": "linkedin",
  "status": "completed",
  "completion_reason": "count_reached",       // null while queued/running/paused
  "coverage_limited": false,                  // true = a budget stopped it before `count`
  "count": 25, "result_count": 25,
  "warnings": [ { "code": "partial_enrichment", "platform": "linkedin", "attempted": 59, "enriched": 56, "failed": 3,
                  "by_reason": { "not_found": 2, "timeout": 1 }, "message": "3 of 59 LinkedIn profiles could not be read after search; ..." } ],
  "reserved_cost_usd": <number>, "final_cost_usd": <number>, "refunded_usd": <number>,
  "finished_at": "<date-time>", "results_expire_at": "<date-time>"
}
```

Cost: Free.

### GET /desearch/people/tasks/{task_id}/results — Read People Search results

The qualified profiles found so far, in the order they were found. Results arrive while the search is still running: keep the returned `next_cursor` and call again to get only the new profiles.

| param | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | uuid | yes | the task id |
| `cursor` | query | string | no | `next_cursor` from the previous page |
| `limit` | query | int 1-500 | no | default 100 |

```bash
# {task_id} = 5b33f3ee-168b-4780-9c8e-63a626781872
curl -s "https://api.desearch.ai/desearch/people/tasks/5b33f3ee-168b-4780-9c8e-63a626781872/results?limit=100" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`:

```jsonc
{
  "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872",
  "status": "running",                 // same status enum as the task
  "results": [ /* Person[] in the order found */ ],
  "next_cursor": "<opaque>",           // always present; keep it and call again later for only the new profiles
  "has_more": false                    // true = more results are already available after this page
}
```

Errors: `404` task not found; `410` results expired (kept 30 days after the search ends). Cost: Free.

### GET /desearch/people/tasks/{task_id}/export — Download People Search results

Every profile found so far as CSV or JSON Lines, optionally narrowed with the same filters as the library (`has`, `min_audience`, `max_audience`, `min_score`, `location`, `verified`). There is no `q` or `sort` here.

| param | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | uuid | yes | the task id |
| `format` | query | string | no | `csv` (default) or `jsonl` |
| `has` | query | string | no | channels every person must have |
| `min_audience`, `max_audience` | query | int >= 0 | no | followers (subscribers on YouTube) |
| `min_score` | query | int 0-100 | no | minimum fit score |
| `location` | query | string, max 100 | no | text in the location |
| `verified` | query | bool | no | X and TikTok only |

```bash
# {task_id} = 5b33f3ee-168b-4780-9c8e-63a626781872
curl -s -G "https://api.desearch.ai/desearch/people/tasks/5b33f3ee-168b-4780-9c8e-63a626781872/export" \
  --data-urlencode "format=csv" --data-urlencode "has=email" --data-urlencode "min_score=70" \
  -H "Authorization: $DESEARCH_KEY" -o people.csv
```

Response `200`: a file, `text/csv` or `application/x-ndjson`; CSV columns are not specified in the spec. Errors: `404` task not found; `410` results expired. Cost: Free.

### POST /desearch/people/tasks/{task_id}/pause — Pause a People Search task

A queued search pauses at once; a running one finishes its current batch first (status `pausing`, then `paused`). Profiles found so far stay available. A search paused for more than 7 days is cancelled. No request body.

| param | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | uuid | yes | the task id |

```bash
# {task_id} = 5b33f3ee-168b-4780-9c8e-63a626781872
curl -s -X POST "https://api.desearch.ai/desearch/people/tasks/5b33f3ee-168b-4780-9c8e-63a626781872/pause" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: the updated `PeopleTask`.

```jsonc
{ "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872", "status": "pausing", /* ...rest of PeopleTask; "paused" once the batch ends */ }
```

Errors: `404` task not found; `409` `{"detail":"<why>","task":{PeopleTask}}` when the task's current state does not allow pausing. Cost: Free.

### POST /desearch/people/tasks/{task_id}/resume — Resume a People Search task

Continue a paused search from where it stopped. Not charged again. No request body.

| param | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | uuid | yes | the task id |

```bash
# {task_id} = 5b33f3ee-168b-4780-9c8e-63a626781872
curl -s -X POST "https://api.desearch.ai/desearch/people/tasks/5b33f3ee-168b-4780-9c8e-63a626781872/resume" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: the updated `PeopleTask` (status leaves `paused`; the exact status in the reply is not specified).

```jsonc
{ "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872", "status": "<no longer paused>", /* ...rest of PeopleTask */ }
```

Errors: `404` task not found; `409` `{"detail":"<why>","task":{PeopleTask}}` if the task is not resumable (for example not paused). Cost: Free.

### POST /desearch/people/tasks/{task_id}/cancel — Cancel a People Search task

Stop a search. You pay only for the profiles it delivered (a search cancelled before it starts costs nothing); the rest of the reservation is returned. Profiles found so far stay available for 30 days. No request body.

| param | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | uuid | yes | the task id |

```bash
# {task_id} = 5b33f3ee-168b-4780-9c8e-63a626781872
curl -s -X POST "https://api.desearch.ai/desearch/people/tasks/5b33f3ee-168b-4780-9c8e-63a626781872/cancel" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: the updated `PeopleTask` (status `cancelling` then `cancelled`; the exact immediate status is not specified).

```jsonc
{ "task_id": "5b33f3ee-168b-4780-9c8e-63a626781872", "status": "cancelling", /* ...rest of PeopleTask */ }
```

Errors: `404` task not found; `409` `{"detail":"<why>","task":{PeopleTask}}` when the task is already in a state that cannot be cancelled. Cost: Free (settles the bill for delivered profiles only).

---

## Gotchas

- **The POST never returns profiles.** It returns a `task_id` and `status: "queued"`. Save the id. If you lose it, `GET /desearch/people/tasks` lists the account's tasks (filter by `status`, `platform`, or the `metadata.*` labels you set), newest first. Tag every search with `metadata` so you can find it again.
- **Always send `Idempotency-Key` on create.** A blind retry without it starts and reserves a second search. Same key = the original task back with HTTP 200 and no new charge.
- **Reserve vs charge.** `count` is reserved up front (402 if the balance cannot cover it) and settled to the qualified profiles actually delivered; the remainder is refunded. Do not set `count` far above what you need. A search that finds nobody is free.
- **`completed` is not "got `count`".** Check `completion_reason` and `coverage_limited` (budget stops keep `status: "completed"` even with zero profiles). `partial` is terminal but not defined in the spec; treat it as finished-with-caveats and read `warnings`.
- **Read while it runs.** `/results` returns profiles as they are found. `has_more: false` only means "caught up so far"; check `status` for done. Keep the `next_cursor` even at the end and call again later for only the new rows.
- **Thinner data when enrichment fails.** `warnings[].code == "partial_enrichment"` and `attributes.enrichment == "failed"` (with `enrichment_error`) mean followers, location, links or experience may be missing because the profile could not be read; the person was scored on the search hit only.
- **`score.criteria_checks` / `fully_verified` are empty or absent on results scored before 2026-10-20.** `criteria_checks` are informational: a qualified result can still have `unknown` criteria. A `met` verdict on a disqualifier means the disqualifier applies.
- **Pause / resume / cancel only fit certain states.** Otherwise `409` with the current task in the body. `pausing` is transitional (a running task finishes its current batch first). Paused longer than 7 days is auto-cancelled.
- **Retention is 30 days after the search ends.** After that `/results` and `/export` return `410` and the search drops out of the people library. Export or ingest before then.
- **Exports are files**, not the JSON envelope: use `-o`, expect `text/csv` or `application/x-ndjson`. Prefer `format=jsonl` for machine reading (CSV columns are unspecified). `/profiles/export` is capped at 10,000 people. The task `/export` has no `q` / `sort`.
- **Library vs task.** `/profiles` dedupes across all your searches (one best row per person, with `found_by.times_found`); `/tasks/{task_id}/results` is one search. `platform` is required on the library routes.
- **Filters are platform-aware.** `verified` works for X and TikTok only; `has` takes only `email`, `website`, `x`, `linkedin`, `instagram`, `youtube`, `tiktok`; an unknown platform, sort, status, cursor or `has` channel, an unsupported filter, or a bad `metadata.<key>` filter is a `400`.
- **Concurrency cap**: `429` "Too many searches are already queued, running or paused" (a paused task still counts; the limit is not stated). Finish, cancel or wait for old tasks before starting more.
- **Account scope**: tasks and the library belong to the whole Desearch account, not one API key (`created_by` shows who made a task). Pagination here uses `next_cursor` in the response BODY (unlike `platforms.md`, where the cursor is a response header).
- **Not a posts API.** You get profiles with evidence. For raw posts use `x.md` (X) or `platforms.md` (TikTok / Facebook / Instagram).

Unverified / not resolvable from the spec: the exact meaning of statuses `partial`, `cancelling`, `expired` and the immediate status returned by resume/cancel; the poll interval beyond "every few seconds"; the concurrency cap value; the item shapes of `metrics`, `links`, `contacts`, `interpreted`, `progress` and `errors`; the format of `exclude` handles; the CSV column set; and the `reserved_cost_usd` values (the rates quoted above come from the public pricing page, not the spec). The curl examples were derived from the spec and were not run against the live API.
