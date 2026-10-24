Key + base URL + auth: see social/twexapi/_index.yaml. Base https://api.twexapi.io, header `Authorization: Bearer $TWEXAPI_KEY`.

# TwexAPI — Tweets · Replies · Interactions · Sentiment · Timeline (13 endpoints)

- X/Twitter only. Tweet-level reads: a thread, similar tweets, replies (cursor-paged or legacy), a user's tweets and replies, retweeters, quote tweets, text sentiment, a user's timeline. Search and user lookups are in `search.md`; followers in `followers.md`; communities and lists in `communities-lists.md`; trending and `GET /balance` in `trending.md`.
- GET = path/query params; POST = JSON body + `Content-Type: application/json`. Envelope `{ "code": 200, "msg": "success", "data": … }`.
- Three paging styles: **cursor `/page` POSTs** (20 items per page, `next_cursor` + `has_next_page`), **fill-count calls** (`…/{count}`, `quotes`, `timeline`: one request, the server pages for you), and the **Legacy** replies GET. Prefer cursor pages for big pulls.
- Prices are the spec's, where it states one ($0.05 per 1,000 items); each endpoint has a **Cost** line.

## Pick an endpoint

| Need | Endpoint |
|---|---|
| The whole thread from its root tweet | `POST /twitter/tweets/thread_by_id` |
| Tweets similar to a tweet | `GET /twitter/tweets/{tweet_id}/similar` |
| Replies to a tweet (new integrations) | `POST /twitter/tweets/{tweet_id}/replies/page` |
| Replies to a tweet in one request, nested (legacy) | `GET /twitter/tweets/{tweet_id}/replies/{count}` |
| Everything a user posted, original tweets plus their replies (full Tweet objects) | `GET /twitter/{screen_name}/tweets-replies/{count}` · `POST /twitter/tweets-replies/page` |
| Who retweeted a tweet | `GET /twitter/tweets/{tweet_id}/retweeters/{target_count}` · `POST /twitter/tweets/retweeters/page` |
| Quote tweets of a tweet | `POST /twitter/tweets/quotes` · `POST /twitter/tweets/quotes/page` |
| Tone and sentiment of a piece of text | `POST /twitter/tweets/sentiment` |
| A user's recent timeline (light items) | `POST /twitter/{screen_name}/timeline/page` · `POST /twitter/{screen_name}/timeline` |

## Shared objects and paging

Trimmed. The complete trimmed `Tweet` and `User` objects are in `search.md` ("Shared objects"). Values are the spec's own examples; `<…>` is a type placeholder; `…` marks omitted fields.

**Tweet** (`TweetModel`; required: `tweet_id`, `text`)
```jsonc
{
  "tweet_id": "1803006263529541838",
  "text": "<string>", "full_text": "<string|null>",
  "created_at": "Mon Jun 17 03:51:48 +0000 2024", "created_at_datetime": "2024-06-17T03:51:48.000Z", "lang": "en",
  "favorite_count": <int>, "retweet_count": <int>, "reply_count": <int>, "quote_count": <int>, "bookmark_count": <int>,
  "view_count": "<string|null>",                 // a STRING
  "hashtags": ["AI", "Python"], "cashtags": ["$TSLA"], "urls": ["<url>"],
  "media": [{ "id": "1802991873836883968", "type": "photo", "media_url": "<url>", "width": 1920, "height": 1080 }],
  "in_reply_to": "<tweet_id|null>", "in_reply_to_screen_name": "<handle|null>",
  "is_quote_status": false, "quoted_status_id_str": "<tweet_id|null>",
  "quote": <Tweet|null>, "retweeted_tweet": <Tweet|null>, "reply_to": <Tweet|null>, "replies": [<Tweet>],
  "user": <User|null>
  // …
}
```

**User** (`UserModel`; required: `id`, `name`, `screen_name`)
```jsonc
{ "id": "1717001045992251392", "name": "Cryptoklepto", "screen_name": "CK_Cryptoklepto",
  "created_at": "Mon Oct 28 02:32:47 +0000 2024", "description": "<bio>", "location": "New York, USA",
  "followers_count": <int>, "following_count": <int>, "statuses_count": <int>, "listed_count": <int>,
  "is_blue_verified": false, "is_verified": false, "verified_type": "<blue | business | government | null>",
  "protected": false, "profile_image_url": "<url>"  /* … */ }
```

**TimelineItem** (`UserTweetItem`; the **light, flat** item the two timeline endpoints return; required: `tweet_id`)
```jsonc
{ "tweet_id": "<string>", "is_paid_promotion": false,
  "full_text": "<string|null>", "created_at": "<string|null>", "lang": "<string|null>", "conversation_id": "<string|null>",
  "bookmark_count": <int>, "favorite_count": <int>, "reply_count": <int>, "retweet_count": <int>, "quote_count": <int>,
  "view_count": "<string|null>", "view_count_state": "<string|null>",
  "author_user_id": "<string|null>", "author_screen_name": "<string|null>", "author_name": "<string|null>",
  "author_is_blue_verified": <bool|null>, "author_verified": <bool|null>, "author_is_verified_organization_affiliate": <bool|null> }
```

**Cursor paging (every `/page` POST):** page 1 omits `next_cursor`; each response carries `has_next_page` and `next_cursor`; send the previous `next_cursor` back **verbatim** and repeat until `has_next_page` is false. Cursors are opaque and look different per endpoint. `data` items may be `null`; skip them.

## Tweets

### POST /twitter/tweets/thread_by_id — Get Tweet Thread by ID

All tweets in a thread, from the root tweet's ID, sorted by latest. A read, but it takes a JSON body.

**Params** (JSON body, schema `TweetThreadByIdBody`)

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | body | string | yes | "The root tweet ID to fetch the thread for". Must be a JSON **string**: an integer returns 422 |
| `max_items` | body | integer 1–200 | no | max thread tweets to return; default `40` |
| `fields` | body | string[] or null | no | "Fields to include in each tweet. If omitted, all fields are returned." Use it to shrink the payload. The accepted names are not enumerated in the spec (presumably the Tweet keys, e.g. `["tweet_id","text","created_at"]`; unverified) |

```bash
curl -s -X POST https://api.twexapi.io/twitter/tweets/thread_by_id \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tweet_id":"1803006263529541838","max_items":40}'
```

**Response** `200` — the spec declares **no response schema** (`{}`); its text: "A list of tweets in the thread, sorted by latest."
```jsonc
[ <Tweet>, <Tweet>, … ]      // presumed shape, UNVERIFIED (may instead be wrapped in { code, msg, data })
```
**Cost:** no price stated in the spec.

### GET /twitter/tweets/{tweet_id}/similar — Get Similar Tweets

Tweets similar to the given tweet.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | path | string | yes | the tweet to find similar ones for |

```bash
# {tweet_id}=1803006263529541838
curl -s "https://api.twexapi.io/twitter/tweets/1803006263529541838/similar" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `GetTweetsByIdResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet>, … ] }                   // nullable
```
**Cost:** no price stated in the spec.

## Replies

### POST /twitter/tweets/{tweet_id}/replies/page — Get Replies by Page (Recommended)

Replies to a tweet, cursor-paged. The first page also returns the root tweet. Spec: use this for new integrations; it "avoids timeouts on large threads".

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | path | string | yes | the tweet to get replies for |
| `next_cursor` | body | string or null | no | omit for page 1 (then `root_tweet` is returned); afterwards the previous response's `next_cursor` |
| `sort_by` | body | `Relevance`, `Recency` or `Likes` | no | default `Recency` |

```bash
# {tweet_id}=1803006263529541838 ; page 1 (no next_cursor)
curl -s -X POST "https://api.twexapi.io/twitter/tweets/1803006263529541838/replies/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sort_by":"Recency"}'
# next page
curl -s -X POST "https://api.twexapi.io/twitter/tweets/1803006263529541838/replies/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sort_by":"Recency","next_cursor":"<next_cursor from the previous response>"}'
```

**Response** `200` — `GetRepliesPageResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "root_tweet": <Tweet|null>,               // the focal tweet; ONLY on the first page
  "data": [ <Tweet>, … ],                   // replies on this page
  "has_next_page": true,                    // loop until false
  "next_cursor": "<opaque>" }               // nullable
```
**Cost:** $0.05 per 1,000 replies (spec).

### GET /twitter/tweets/{tweet_id}/replies/{count} — Get Replies by Tweet ID (Legacy)

Replies in one request, returned as **one nested Tweet** (the root tweet; its replies sit inside `replies`). Spec: for new integrations use the `/page` POST above, it is "more reliable for large reply threads, and avoids request timeouts".

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | path | string | yes | the tweet to get replies for |
| `count` | path | integer 1–5000 | yes | max replies to return |
| `sort_by` | query | `Relevance`, `Recency` or `Likes` | no | default `Recency` ("Sort by Relevancy or Latest or Likes") |

```bash
# {tweet_id}=1803006263529541838  {count}=100
curl -s "https://api.twexapi.io/twitter/tweets/1803006263529541838/replies/100?sort_by=Likes" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `ReplyResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": <Tweet|null> }                     // the root tweet; replies nested in data.replies (per the Tweet schema)
```
**Cost:** $0.05 per 1,000 replies (spec).

### GET /twitter/{screen_name}/tweets-replies/{count} — Get All Tweets and Replies by User

A user's own posts, original tweets **and** the replies they wrote, as full Tweet objects, in one request.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | the user's handle, e.g. `elonmusk` |
| `count` | path | integer 1–10000000 | yes | max tweets and replies to return |

```bash
# {screen_name}=elonmusk  {count}=50
curl -s "https://api.twexapi.io/twitter/elonmusk/tweets-replies/50" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `SearchResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet>, … ] }
```
**Cost:** $0.05 per 1,000 items (spec); 10,000 items is about $0.50. The upper bound (10,000,000) is huge: keep `count` small.

### POST /twitter/tweets-replies/page — Get All Tweets and Replies by User by Page

The cursor-paged version of the call above: up to 20 items per page. Note `screen_name` is in the **body** here.

**Params** (JSON body, schema `GetAllTweetsRepliesCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | body | string | yes | handle, with or without `@`, e.g. `elonmusk` |
| `next_cursor` | body | string or null | no | omit for page 1; spec example `"1234567890"` |

```bash
curl -s -X POST https://api.twexapi.io/twitter/tweets-replies/page \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"screen_name":"elonmusk"}'
```

**Response** `200` — `GetAllTweetsRepliesCursorResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet|null>, … ],               // up to 20; items may be null
  "has_next_page": true,
  "next_cursor": "1234567890" }              // nullable
```
**Cost:** $0.05 per 1,000 items (spec).

## Interactions

### GET /twitter/tweets/{tweet_id}/retweeters/{target_count} — Get Retweeters

Users who retweeted a tweet, in one request: it "automatically paginates until count is reached or no more results".

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | path | string | yes | the tweet to get retweeters for |
| `target_count` | path | integer 1–5000 | yes | number of retweeters to return. Spec text: "minimum 10, maximum 5000" (the schema says 1; see Gotchas) |

```bash
# {tweet_id}=1803006263529541838  {target_count}=100
curl -s "https://api.twexapi.io/twitter/tweets/1803006263529541838/retweeters/100" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `SearchUserResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <User>, … ] }                    // up to target_count
```
**Cost:** no price stated in the spec.

### POST /twitter/tweets/retweeters/page — Get Retweeters by Page

Retweeters, cursor-paged: up to 20 users per page.

**Params** (JSON body, schema `GetRetweetersCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | body | string | yes | the tweet to get retweeters for |
| `next_cursor` | body | string or null | no | omit for page 1; afterwards the previous response's `next_cursor` |

```bash
curl -s -X POST https://api.twexapi.io/twitter/tweets/retweeters/page \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tweet_id":"1803006263529541838"}'
```

**Response** `200` — `GetRetweetersCursorResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <User>, … ],                     // up to 20
  "has_next_page": true,
  "next_cursor": "eyJpZCI6IjIwNjAwNTE1Mzg3OTQ0Mzg2NzciLCJmbG9ja0N1cnNvciI6IjQ2MTE2ODYwMTg2Mjg5ODcxNzkiLCJvcmlnaW5hbERpcmVjdGlvbiI6IkRlc2NlbmRpbmcifQ==-999995" }   // spec example; nullable
```
**Cost:** no price stated in the spec.

### POST /twitter/tweets/quotes — Get Quote Tweets

Quote tweets of a tweet, in one request: it "automatically paginates until count is reached or no more results".

**Params** (JSON body, schema `GetQuotesQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | body | string | yes | the tweet to get quote tweets for |
| `count` | body | integer 1–5000 | **yes** | number of quote tweets to return; spec example `100`. Spec text: "minimum 10, maximum 5000" (the schema says 1; see Gotchas) |
| `sort_by` | body | `Top` or `Latest` | no | default `Top`; `Latest` is chronological, `Top` is ranked |

```bash
curl -s -X POST https://api.twexapi.io/twitter/tweets/quotes \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tweet_id":"1803006263529541838","count":100,"sort_by":"Top"}'
```

**Response** `200` — `GetQuotesResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet>, … ] }                   // up to count
```
**Cost:** no price stated in the spec.

### POST /twitter/tweets/quotes/page — Get Quote Tweets by Page

Quote tweets, cursor-paged: up to 20 per page.

**Params** (JSON body, schema `GetQuotesCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `tweet_id` | body | string | yes | the tweet to get quote tweets for |
| `sort_by` | body | `Top` or `Latest` | no | default `Top` |
| `next_cursor` | body | string or null | no | omit for page 1; spec example `"scroll:thGQYTMwMjU5NDA4ODc4ODc6MjU5NDA4ODc4ODc6"` |

```bash
curl -s -X POST https://api.twexapi.io/twitter/tweets/quotes/page \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tweet_id":"1803006263529541838","sort_by":"Latest"}'
```

**Response** `200` — `GetQuotesCursorResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet>, … ],                    // up to 20
  "has_next_page": true,
  "next_cursor": "scroll:thGQYTMwMjU5NDA4ODc4ODc6MjU5NDA4ODc4ODc6" }   // nullable
```
**Cost:** no price stated in the spec.

## Sentiment

### POST /twitter/tweets/sentiment — Sentiment Analysis

Tone and sentiment of a piece of **text**. The input is the text itself, not a tweet ID: to score a tweet, fetch it first and send its `text`.

**Params** (JSON body, schema `SentimentAnalysisQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `text` | body | string | yes | "The text to analyze." |

```bash
curl -s -X POST https://api.twexapi.io/twitter/tweets/sentiment \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Bitcoin just broke out and the volume is huge."}'
```

**Response** `200` — `SentimentAnalysisResponse` (the two fields are free strings, either may be null):
```jsonc
{ "code": 200, "msg": "success",
  "data": {
    "tone": "<Positive | Negative | Neutral | Humorous | Sarcastic | Enthusiastic | Angry | Informative | null>",
    "sentiment": "<Positive | Negative | Neutral | null>" } }
```
**Cost:** **50 credits per call** (spec). The spec gives no credit-to-dollar conversion; read `GET /balance` before and after a call (trending.md) to see what it actually costs.

## Timeline

### POST /twitter/{screen_name}/timeline/page — Get User Timeline by Page

One page of a user's timeline, as light `TimelineItem`s. A read that takes a JSON body.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | handle, with or without `@`, e.g. `elonmusk` |
| `count` | body | integer 1–100 | no | max tweets for this page; default `20` |
| `next_cursor` | body | string or null | no | omit for page 1; spec example `"DAAHCgABHFeD5h9__-cLAAIAAAATMjAzODIzMzA5NTM4ODY4MDU5NAgAAwAAAAIAAA"` |

```bash
# {screen_name}=elonmusk ; page 1
curl -s -X POST "https://api.twexapi.io/twitter/elonmusk/timeline/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count":20}'
# next page
curl -s -X POST "https://api.twexapi.io/twitter/elonmusk/timeline/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count":20,"next_cursor":"DAAHCgABHFeD5h9__-cLAAIAAAATMjAzODIzMzA5NTM4ODY4MDU5NAgAAwAAAAIAAA"}'
```

**Response** `200` — `UserTimelinePageResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <TimelineItem>, … ],
  "has_next_page": true,
  "next_cursor": "DAAHCgABHFeD5h9__-cLAAIAAAATMjAzODIzMzA5NTM4ODY4MDU5NAgAAwAAAAIAAA",   // nullable
  "requested_count": 20,                     // what you asked for
  "effective_count": 20,                     // "Count after credit throttling was applied"
  "parsed_count": 20 }                       // tweets actually parsed from the upstream response
```
**Cost:** no price stated in the spec.

### POST /twitter/{screen_name}/timeline — Get User Timeline and Fill Count

A user's timeline across pages in one call: the server pages until it fills `count` (it "tries to", so it may return fewer).

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | handle, with or without `@`, e.g. `elonmusk` |
| `count` | body | integer 1–1000 | no | max tweets to return across all pages; default `20` |

```bash
# {screen_name}=elonmusk
curl -s -X POST "https://api.twexapi.io/twitter/elonmusk/timeline" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"count":100}'
```

**Response** `200` — `UserTimelineResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <TimelineItem>, … ],
  "total_fetched_count": 100,                // total tweets fetched across pages
  "page_count": 5 }                          // pages fetched
```
**Cost:** no price stated in the spec.

## Gotchas

- **Prefer the cursor pages for replies.** The legacy replies GET returns one nested object and, per the spec, can hit request timeouts on large threads. Loop: call without `next_cursor`, then repeat with the previous `next_cursor` while `has_next_page` is true. `root_tweet` appears only on the first replies page.
- **Tweet IDs must be strings.** IDs are ~19 digits (beyond JavaScript's safe-integer range). `thread_by_id` rejects an integer `tweet_id` with 422 (observed: `body.tweet_id: Input should be a string`). Keep every ID as a string, in the path, body and your own code.
- **Where `screen_name` goes differs by route:** in the PATH for `/twitter/{screen_name}/timeline[/page]` and `/twitter/{screen_name}/tweets-replies/{count}`, but in the BODY for `POST /twitter/tweets-replies/page`.
- **Sort enums are not the same everywhere (and are case-sensitive):** replies use `sort_by` = `Relevance`, `Recency` or `Likes` (default `Recency`); quotes use `sort_by` = `Top` or `Latest` (default `Top`); search endpoints use camelCase `sortBy` = `Latest` or `Top`. A wrong value returns 422 (observed).
- **Counts: spec text vs schema.** For retweeters and quotes the text says "minimum 10" but the schema minimum is 1 and live validation accepts 1 to 9 (observed); what the backend then does below 10 (error, or silently 10) is unknown, so ask for at least 10. Bounds are enforced with a 422 when out of range (upper limits observed live, lower limits per schema): retweeters/quotes 1–5000, legacy replies `count` 1–5000, user tweets-replies `count` 1–10,000,000, timeline/page `count` 1–100, timeline `count` 1–1000, thread `max_items` 1–200.
- **Cost control:** only replies/page, legacy replies and the two tweets-replies routes state a price ($0.05 per 1,000). A `count` of 10,000,000 is accepted, so cap it yourself (10,000 items is about $0.50). For routes with "no price stated", read `GET /balance` (trending.md) before and after a small pull to calibrate.
- **Timeline items are light and flat:** `TimelineItem` has `author_*` fields and engagement counts, but no nested `user`, `media`, `hashtags` or `urls`. For full Tweet objects use `tweets-replies` or the search endpoints. `effective_count` can be lower than `requested_count` ("credit throttling"), so check it instead of assuming you got `count`.
- **Sentiment is by text, not by tweet ID,** costs a flat 50 credits per call, and returns only two labels (`tone`, `sentiment`).
- **Unspecified shape:** `thread_by_id` declares an empty 200 schema; print the first response before parsing. All counts are `int|null` in the Tweet schema and `view_count` is a string: coerce defensively.
- **Errors:** the spec documents only `200` and `422`. Observed live on 2026-10-24 (not in the spec): no `Authorization` header gives HTTP 403 `{"code":403,"msg":"Not authenticated","data":[]}`; a wrong token gives HTTP 401 `{"code":401,"msg":"Invalid token!","data":[]}`; validation errors are HTTP 422 `{"code":422,"msg":"Validation error: <where>.<field>: <reason>","data":[]}` with `<where>` = `body`, `params` (path) or `querystring`, not the spec's `{"detail":[…]}`. Validation can run before the token check, so a 422 does not prove the token is valid.
