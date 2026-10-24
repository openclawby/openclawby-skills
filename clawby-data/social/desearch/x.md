Key + base URL + auth: see social/desearch/_index.yaml. Base https://api.desearch.ai, header `Authorization: $DESEARCH_KEY`.

# Desearch — X / Twitter Search (9 endpoints)

- All nine routes are `GET` with query params (spec tag "X Search"). Eight return **Post** and/or **User** objects (defined once in the "Post object" section below); `/twitter/trends` returns a trends list.
- Billing metadata, common errors (401 / 422 / 429 / 500) and the USD-per-call model: see `overview.md` ("Billing metadata" and "Gotchas"). Each endpoint below names its priced service.
- Two more X routes live in `overview.md`: `POST /desearch/ai/search` (tool `twitter`) and `POST /desearch/ai/search/links/twitter`.

## Pick an endpoint

| Need | Endpoint |
|---|---|
| Search X with filters (sort, dates, language, verified, media, min engagement) | `GET /twitter` |
| Fetch known posts from their URLs | `GET /twitter/urls` |
| Fetch one post by id | `GET /twitter/post` |
| Search one user's posts for a keyword | `GET /twitter/post/user` |
| Who retweeted a post (cursor-paginated) | `GET /twitter/post/retweeters` |
| A user's latest timeline + their profile (cursor-paginated) | `GET /twitter/user/posts` |
| A user's tweets and replies, optional keyword | `GET /twitter/replies` |
| Replies under a post | `GET /twitter/replies/post` |
| Trending topics for a location | `GET /twitter/trends` |

## Post object

Resolved from components `TwitterScraperTweet` and `TwitterScraperUser`.

**Post** (`TwitterScraperTweet`)
- Required: `id` (string), `text`, `created_at`, `reply_count`, `retweet_count`, `like_count`, `quote_count`, `bookmark_count`.
- Optional scalars: `url`, `view_count`, `lang`, `conversation_id`, `is_quote_tweet`, `is_retweet`, `possibly_sensitive`, `in_reply_to_screen_name`, `in_reply_to_status_id`, `in_reply_to_user_id`, `quoted_status_id`, `display_text_range` (`[start, end]`).
- Optional objects: `user` (User), `media[]` (`{media_url, type}`), `entities` (`hashtags`, `symbols`, `urls`, `user_mentions`, `media`, `timestamps`), `extended_entities.media`, `quote` and `retweet` (nested full Post), `replies[]` (nested Posts), `article` (X long-form article: `id`, `title`, `preview_text`, `plain_text`, `cover_media`, `first_published_at`), `card` (link preview: `type`, `url`, `title`, `description`, `domain`, `image`, `image_alt`, `player_url`, `broadcast_url`, `state`), `content_disclosure`, `edit_control`.

**User** (`TwitterScraperUser`)
- Required: `id` (string), `username`.
- Optional: `name`, `url`, `description`, `location`, `website`, `created_at`, `followers_count`, `followings_count`, `statuses_count`, `favourites_count`, `listed_count`, `media_count`, `verified`, `is_blue_verified`, `can_dm`, `can_media_tag`, `profile_image_url`, `profile_banner_url`, `pinned_tweet_ids[]`, `entities` (`description.urls`, `url.urls`), `professional` (`professional_type`, `category[]`), `affiliates_highlighted_label`.

Trimmed Post, taken from the spec's real sample:
```json
{
  "id": "1932946234920349827",
  "url": "https://x.com/HOSS_ibc/status/1932946234920349827",
  "text": "Bittensor $TAO seems oversold here.\n\nGrowth up but price is down …",
  "created_at": "2025-06-11T23:41:09.000Z",
  "lang": "en",
  "reply_count": 16, "retweet_count": 3, "like_count": 31, "quote_count": 3, "bookmark_count": 2,
  "is_quote_tweet": false, "is_retweet": false,
  "conversation_id": "1932946234920349827",
  "display_text_range": [0, 269],
  "media": [{ "media_url": "https://pbs.twimg.com/media/GtMyZtMWMAAPfq9.jpg", "type": "photo" }],
  "entities": { "symbols": [{ "text": "TAO", "indices": [10, 14] }], "hashtags": [], "urls": [], "user_mentions": [], "timestamps": [] },
  "user": {
    "id": "1416628772565143561", "username": "HOSS_ibc", "name": "Hoss", "url": "https://x.com/HOSS_ibc",
    "followers_count": 63156, "statuses_count": 77157, "verified": false, "is_blue_verified": true,
    "created_at": "Sun Jul 18 05:20:07 +0000 2021"
  }
}
```
(`entities.media` and `extended_entities` also carry bulky size/face metadata; they are omitted above.)

## Endpoints

### GET /twitter — X Search API

Search X posts (no AI layer) by query, with sort, user, date, language, verification, media and minimum-engagement filters.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `query` | query | string | yes | "Advanced search query", e.g. `Whats going on with Bittensor`. The spec lists no operator syntax; use the params below to filter |
| `sort` | query | enum `Top` / `Latest` | no | default `Top`; case-sensitive |
| `user` | query | string | no | "User to search for", e.g. `elonmusk` (bare handle) |
| `start_date` | query | string `YYYY-MM-DD` | no | UTC |
| `end_date` | query | string `YYYY-MM-DD` | no | UTC |
| `lang` | query | string | no | language code, e.g. `en`, `es`, `fr` |
| `verified` | query | boolean | no | only verified users |
| `blue_verified` | query | boolean | no | only blue-checkmark verified users |
| `is_quote` | query | boolean | no | only tweets with quotes |
| `is_video` | query | boolean | no | only tweets with videos |
| `is_image` | query | boolean | no | only tweets with images |
| `min_retweets` | query | integer (numeric string also accepted) | no | minimum retweets |
| `min_replies` | query | integer (numeric string also accepted) | no | minimum replies |
| `min_likes` | query | integer (numeric string also accepted) | no | minimum likes |
| `count` | query | integer 1–100 | no | tweets to retrieve; default `20` |

```bash
curl -sS -G https://api.desearch.ai/twitter \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode 'query=Bittensor $TAO' \
  --data-urlencode "sort=Latest" \
  --data-urlencode "lang=en" \
  --data-urlencode "min_likes=10" \
  --data-urlencode "start_date=2026-10-18" \
  --data-urlencode "end_date=2026-10-25" \
  --data-urlencode "count=20"
```
(`'query=…$TAO'` is single-quoted on purpose: inside double quotes the shell would expand `$TAO` to nothing.)

**Response** `200` — JSON array of Post objects (the spec types it `array of Post` or an untyped `object`):
```jsonc
[
  {
    "id": "1932946234920349827",
    "url": "https://x.com/HOSS_ibc/status/1932946234920349827",
    "text": "Bittensor $TAO seems oversold here. …",
    "created_at": "2025-06-11T23:41:09.000Z",
    "like_count": 31, "retweet_count": 3, "reply_count": 16, "quote_count": 3, "bookmark_count": 2,
    "user": { "id": "1416628772565143561", "username": "HOSS_ibc", "name": "Hoss" }
    // …remaining Post fields as in "Post object"
  }
]
```
Errors: `503` X search temporarily unavailable (the X crawler failed or timed out) — **not charged**.
**Cost:** service `X Search` (spec header example). USD per call, no price in spec; an array response carries billing metadata in headers only.

### GET /twitter/urls — Fetch Posts by URLs

Fetch full details (metadata, content, engagement) for several posts at once from their URLs.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `urls` | query | array of string | yes | post URLs, e.g. `https://x.com/RacingTriple/status/1892527552029499853`. Repeat the key once per URL (`urls=…&urls=…`, the OpenAPI default for query arrays; the spec does not state the encoding and it was not verified live) |

```bash
curl -sS -G https://api.desearch.ai/twitter/urls \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "urls=https://x.com/RacingTriple/status/1892527552029499853" \
  --data-urlencode "urls=https://x.com/HOSS_ibc/status/1932946234920349827"
```

**Response** `200` — the spec's schema is an **array of Post objects**:
```jsonc
[ { /* Post for the first URL */ }, { /* Post for the second URL */ } ]
```
Spec inconsistency: the 200 description says "A JSON object mapping tweet URLs to their details", but the declared schema is an array of Posts. Treat it as an array and check the first response (unresolved). Errors: `503` crawler failed or timed out — **not charged**.
**Cost:** service `X URL Lookup` (spec header example). USD per call, no price in spec.

### GET /twitter/post — Retrieve Post by ID

Full details of one post by its numeric id.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `id` | query | string | yes | numeric X post id, 1–20 digits, e.g. `1932946234920349827` |

```bash
curl -sS -G https://api.desearch.ai/twitter/post \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "id=1932946234920349827"
```

**Response** `200` — a single **Post object** (not an array):
```jsonc
{
  "id": "1932946234920349827",
  "url": "https://x.com/HOSS_ibc/status/1932946234920349827",
  "text": "Bittensor $TAO seems oversold here. …",
  "created_at": "2025-06-11T23:41:09.000Z",
  "like_count": 31, "retweet_count": 3, "reply_count": 16, "quote_count": 3, "bookmark_count": 2,
  "user": { "id": "1416628772565143561", "username": "HOSS_ibc" }
}
```
Errors, all **not charged**: `404` no post with this id; `422` malformed id (must be 1–20 digits); `503` the X crawler failed.
**Cost:** service `X Post Lookup` (spec header example). USD per call, no price in spec.

### GET /twitter/post/user — Search X Posts by User

Search one user's posts for a keyword query.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `user` | query | string | yes | user to search, e.g. `elonmusk` (bare handle) |
| `query` | query | string | no | "Advanced search query"; default empty, e.g. `Whats going on with Bittensor` |
| `count` | query | integer 1–100 | no | tweets to retrieve; default `10` |

```bash
curl -sS -G https://api.desearch.ai/twitter/post/user \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "user=elonmusk" \
  --data-urlencode "query=dogecoin" \
  --data-urlencode "count=10"
```

**Response** `200` — JSON array of Post objects (spec type: `array of Post` or an untyped `object`):
```jsonc
[ { /* Post */ }, { /* Post */ } ]
```
Errors: `503` crawler failed or timed out — **not charged**.
**Cost:** service `X Post User` (spec header example). USD per call, no price in spec.

### GET /twitter/post/retweeters — Get Retweeters of a Post

Users who retweeted a post, cursor-paginated.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `id` | query | string | yes | id of the post, e.g. `1982770537081532854` |
| `cursor` | query | string | no | pagination cursor; omit for page 1, then send the previous response's `next_cursor` |

```bash
curl -sS -G https://api.desearch.ai/twitter/post/retweeters \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "id=1982770537081532854"
# next page:
curl -sS -G https://api.desearch.ai/twitter/post/retweeters \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "id=1982770537081532854" \
  --data-urlencode "cursor=$NEXT_CURSOR"
```

**Response** `200` — `XRetweetersResponse`:
```jsonc
{
  "users": [ { "id": "…", "username": "…", "name": "…", "followers_count": …, "is_blue_verified": … } ],  // User objects
  "next_cursor": "…"       // nullable; send back as ?cursor= for the next page
}
```
Errors: `404` "User not found" (spec wording), `503` X crawler upstream failed or timed out. The spec does not say whether failures are charged. Page size is not specified.
**Cost:** service `X Post Retweeters` (spec header example). USD per call, no price in spec.

### GET /twitter/user/posts — Get X Posts by Username

A user's latest timeline posts plus their profile, cursor-paginated.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `username` | query | string | yes | handle to fetch posts for, e.g. `elonmusk` (bare handle) |
| `cursor` | query | string | no | pagination cursor; omit for page 1, then send the previous response's `next_cursor` |

```bash
curl -sS -G https://api.desearch.ai/twitter/user/posts \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "username=elonmusk"
# next page:
curl -sS -G https://api.desearch.ai/twitter/user/posts \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "username=elonmusk" \
  --data-urlencode "cursor=$NEXT_CURSOR"
```

**Response** `200` — `XUserPostsResponse`:
```jsonc
{
  "user": { "id": "…", "username": "elonmusk", "name": "…", "followers_count": …, "description": "…" },  // User object (required)
  "tweets": [ { /* Post */ }, { /* Post */ } ],                                                         // required
  "next_cursor": "…"       // nullable; send back as ?cursor= for the next page
}
```
Errors: `404` "User not found", `503` X crawler upstream failed or timed out. The spec does not say whether failures are charged. Page size is not specified and there is no `count` param.
**Cost:** priced service name not given in the spec. USD per call, no price in spec.

### GET /twitter/replies — Fetch User's Tweets and Replies

A user's tweets and replies, optionally filtered by a keyword query.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `user` | query | string | yes | "The username of the user to search for", e.g. `elonmusk` (bare handle) |
| `count` | query | integer 1–100 | no | tweets to fetch; default `10` |
| `query` | query | string | no | "Advanced search query"; default empty, e.g. `latest news on AI` |

```bash
curl -sS -G https://api.desearch.ai/twitter/replies \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "user=elonmusk" \
  --data-urlencode "query=bitcoin" \
  --data-urlencode "count=10"
```

**Response** `200` — JSON array of Post objects (spec type: `array of Post` or an untyped `object`); replies carry `in_reply_to_*` fields:
```jsonc
[ { /* Post */ }, { /* Post, e.g. with in_reply_to_screen_name / in_reply_to_status_id */ } ]
```
Errors: `503` crawler failed or timed out — **not charged**.
**Cost:** service `X Replies` (spec header example). USD per call, no price in spec.

### GET /twitter/replies/post — Retrieve Replies for a Post

Replies posted under one post, optionally filtered by a keyword query.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `post_id` | query | string | yes | numeric X post id, 1–20 digits, e.g. `1932946234920349827` |
| `count` | query | integer 1–100 | no | tweets to fetch; default `10` |
| `query` | query | string | no | "Advanced search query"; default empty, e.g. `latest news on AI` |

```bash
curl -sS -G https://api.desearch.ai/twitter/replies/post \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "post_id=1932946234920349827" \
  --data-urlencode "count=20"
```

**Response** `200` — JSON array of Post objects (spec type: `array of Post` or an untyped `object`):
```jsonc
[ { /* Post reply */ }, { /* Post reply */ } ]
```
Errors, all **not charged**: `422` malformed `post_id` (must be 1–20 digits); `503` crawler failed or timed out.
**Cost:** service `X Post Replies` (spec header example). USD per call, no price in spec.

### GET /twitter/trends — Get X Trends

Trending topics on X for a location, identified by WOEID (Where On Earth ID).

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `woeid` | query | integer | yes | location id. Worldwide = `1`, United States = `23424977`. Only locations X publishes trends for are accepted; an unsupported WOEID is **rejected**, not replaced by Worldwide |
| `count` | query | integer 30–100 | no | trends to return; minimum 30, maximum 100, default `30` |

```bash
curl -sS -G https://api.desearch.ai/twitter/trends \
  -H "Authorization: $DESEARCH_KEY" \
  --data-urlencode "woeid=23424977" \
  --data-urlencode "count=30"
```

**Response** `200` — `XTrendsResponse` (shape from the schema; the spec has no literal example):
```jsonc
{
  "trends": [ { "name": "<topic>", "query": "<search query for the topic>", "rank": <integer> } ],   // name required; query and rank nullable
  "woeid": { "name": "<location name>", "id": <integer> }                                          // nullable
}
```
Errors: `503` trends service unavailable, `504` trends service timed out. The spec does not say whether failures are charged.
**Cost:** priced service name not given in the spec. USD per call, no price in spec.

## Gotchas

- **Billing is USD per call; the price list is not in the spec.** Array responses (`/twitter`, `/twitter/urls`, `/twitter/post/user`, `/twitter/replies`, `/twitter/replies/post`) carry cost only in the `X-Desearch-*` headers (`curl -sS -D - -o out.json …`). The spec says the X-crawler `503`, an unknown post id (`404`) and a malformed id (`422`) are **not charged** where listed above; for retweeters, user posts and trends it says nothing.
- **Quote the query correctly.** Cashtags like `$TAO` must be in single quotes (`--data-urlencode 'query=Bittensor $TAO'`); in double quotes the shell expands them to empty and you silently search the wrong thing. Always use `-G --data-urlencode` so spaces, `#`, `@`, `:` are encoded.
- **IDs are strings.** X ids are ~19 digits, beyond JavaScript's safe-integer range. Keep `id`, `conversation_id`, `in_reply_to_*`, `post_id` as strings; never cast to number.
- **Param names differ by route for the same idea**: `user` on `/twitter`, `/twitter/post/user`, `/twitter/replies`; `username` on `/twitter/user/posts`; `id` on `/twitter/post` and `/twitter/post/retweeters`; `post_id` on `/twitter/replies/post`. Handles are bare (`elonmusk`, no `@`).
- **`count` bounds**: `/twitter` 1–100 (default 20); `/twitter/post/user`, `/twitter/replies`, `/twitter/replies/post` 1–100 (default 10); `/twitter/trends` **30**–100 (default 30). Only `/twitter/post/retweeters` and `/twitter/user/posts` paginate, via `cursor` / `next_cursor` (the spec only says "Cursor for pagination"; a missing or null `next_cursor` is presumably the last page — inferred). The other routes have no cursor: widen `count` or narrow the date range instead.
- **Filters are include-only switches.** `verified`, `blue_verified`, `is_quote`, `is_video`, `is_image` select a subset; omit them rather than sending `false` (what `false` does is not specified). `sort` is case-sensitive: `Top` or `Latest`.
- **Date formats**: X search `start_date` / `end_date` are `YYYY-MM-DD` (UTC). The AI-search routes in `overview.md` use `YYYY-MM-DDTHH:MM:SSZ`. In the spec's sample, `created_at` is ISO on the post (`2025-06-11T23:41:09.000Z`) but legacy X format on the user (`Sun Jul 18 05:20:07 +0000 2021`) — normalise both defensively.
- **`array | object` responses**: `/twitter`, `/twitter/post/user`, `/twitter/replies`, `/twitter/replies/post` are typed in the spec as either an array of Posts or an untyped object. The array is the documented, expected shape; if you ever get an object, look for the post list inside it (unresolved in the spec).
- **Posts are heavy** (entities, media sizes, nested `quote` / `retweet`; `view_count` is optional and absent from the sample). Slim results before putting them in context — one-liner below.
- **Errors**: X-crawler failures return `503` (`504` on trends); retry later. `429` body carries `retry_after` (spec example `60 seconds`). Do not use `curl -v`: it prints the `Authorization` header.

Slim a Post array to one line per post (for `/twitter/user/posts` iterate `json.load(sys.stdin)["tweets"]` instead):
```bash
… | python3 -c 'import sys,json;[print(t["id"], t["created_at"], (t.get("user") or {}).get("username"), t["like_count"], t["text"][:100].replace("\n"," ")) for t in json.load(sys.stdin)]'
```
