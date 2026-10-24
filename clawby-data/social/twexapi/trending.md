Key + base URL + auth: see social/twexapi/_index.yaml. Base https://api.twexapi.io, header `Authorization: Bearer $TWEXAPI_KEY`.

# TwexAPI — Trending · Balance (6 endpoints)

- X/Twitter trends in two flavours: **Explore trends per country** (`GET /twitter/{country}/trending`, a fixed list of 63 values: `worldwide` plus 62 country slugs) and **Global trending** (four chained GETs: countries, then topics, then content tags, then tweets).
- `GET /balance` returns the account's remaining TwexAPI balance (credit). Agents should call it **before heavy pulls** (large `maxItems` / `count`, paging loops) and again after a small trial pull to measure what an endpoint really costs.
- All six are body-less GETs. Envelope `{ "code": 200, "msg": "success", "data": … }`. The spec leaves `data` **untyped** on five of the six (everything except `global-trending/tweets`), so print a first response before parsing it.
- Other groups: `search.md` (search, users, about), `tweets.md` (tweets, replies, retweeters, quotes, sentiment, timeline), `followers.md`, `communities-lists.md`.

## Pick an endpoint

| Need | Endpoint |
|---|---|
| Trending topics for one country (or the account default) | `GET /twitter/{country}/trending` |
| Valid `country` values for global trending | `GET /twitter/global-trending/countries` |
| Valid `topic` values | `GET /twitter/global-trending/topics` |
| Content tags available for a (country, topic) pair | `GET /twitter/global-trending/contents` |
| Trending **tweets** for a country, optionally narrowed by topic and content tag | `GET /twitter/global-trending/tweets` |
| Remaining TwexAPI balance (check before big pulls) | `GET /balance` |

Global-trending flow: `countries` → `topics` → `contents?country=…&topic=…` → `tweets?country=…[&topic=…][&content=…]`. Copy each value exactly as the previous call returned it.

## Shared object

`global-trending/tweets` returns standard **Tweet** objects (`TweetModel`); the complete trimmed shape is in `search.md` ("Shared objects"). Key fields:
```jsonc
{ "tweet_id": "1803006263529541838", "text": "<string>",
  "created_at": "Mon Jun 17 03:51:48 +0000 2024", "created_at_datetime": "2024-06-17T03:51:48.000Z", "lang": "en",
  "favorite_count": <int>, "retweet_count": <int>, "reply_count": <int>, "quote_count": <int>, "view_count": "<string|null>",
  "hashtags": ["AI"], "cashtags": ["$TSLA"], "media": [ /* … */ ],
  "user": { "id": "1717001045992251392", "name": "Cryptoklepto", "screen_name": "CK_Cryptoklepto" /* … */ }
  /* … */ }
```
(Values are the spec's examples; `<…>` is a type placeholder.)

## Global trending

### GET /twitter/global-trending/countries — List Global Trend Countries

The country (and "global") options you may pass as `country` to the other global-trending routes.

**Params:** none.

```bash
curl -s https://api.twexapi.io/twitter/global-trending/countries \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`; spec text: "Country filter options for global trending tweets."
```jsonc
{ "code": 200, "msg": "success",
  "data": <country options> }                // shape NOT specified in the spec (free-form, nullable): print it and read the exact name/slug values
```
**Cost:** no price stated in the spec.

### GET /twitter/global-trending/topics — List Global Trend Topics

The topic categories available for filtering global trending tweets.

**Params:** none.

```bash
curl -s https://api.twexapi.io/twitter/global-trending/topics \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`; spec text: "Topic filter options for global trending tweets."
```jsonc
{ "code": 200, "msg": "success",
  "data": <topic options> }                  // shape NOT specified in the spec
```
**Cost:** no price stated in the spec.

### GET /twitter/global-trending/contents — List Global Trend Content Tags

Content tags for a chosen country and topic, so the tweets call can be filtered more precisely.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `country` | query | string | yes | "Country name or slug returned by /twitter/global-trending/countries" |
| `topic` | query | string | yes | "Topic name or slug returned by /twitter/global-trending/topics" |

```bash
# take both values verbatim from the /countries and /topics responses (united-states is an assumed example)
curl -s -G https://api.twexapi.io/twitter/global-trending/contents \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  --data-urlencode "country=united-states" \
  --data-urlencode "topic=<topic from /topics>"
```

**Response** `200` — `StandardResponse`; spec text: "Content tag options for the selected country and topic."
```jsonc
{ "code": 200, "msg": "success",
  "data": <content tag options> }            // shape NOT specified in the spec
```
**Cost:** no price stated in the spec.

### GET /twitter/global-trending/tweets — Get Global Trending Tweets

Trending tweets for a country, with optional topic and content-tag filters.

**Params** (query string)

| name | in | type | req | note |
|---|---|---|---|---|
| `country` | query | string | yes | "Country name or slug returned by /twitter/global-trending/countries" |
| `topic` | query | string or null | no | "Optional topic name or slug returned by /twitter/global-trending/topics" |
| `content` | query | string or null | no | "Optional content tag returned by /twitter/global-trending/contents" (note: the param is `content`, the route is `contents`) |
| `count` | query | integer 1–100 | no | max tweets to return; default `20` |

```bash
# country must be a value returned by /countries (united-states is an assumed example)
curl -s -G https://api.twexapi.io/twitter/global-trending/tweets \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  --data-urlencode "country=united-states" \
  --data-urlencode "count=20"
# narrowed: add --data-urlencode "topic=<topic from /topics>" --data-urlencode "content=<tag from /contents>"
```

**Response** `200` — `SearchResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet>, … ] }                   // up to count
```
**Cost:** no price stated in the spec.

## Explore trends

### GET /twitter/{country}/trending — Get Trending Topics

X Explore trending topics for a country. `worldwide` gives "account-default trends".

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `country` | path | enum (63 values) | yes | a country slug, or `worldwide` for the default Explore trends. Lowercase, hyphenated, exactly as listed below |

```text
worldwide algeria argentina australia austria bahrain belarus belgium brazil canada chile colombia denmark
dominican-republic ecuador egypt france germany ghana greece guatemala india indonesia ireland israel italy
japan jordan kenya korea kuwait latvia lebanon malaysia mexico netherlands new-zealand nigeria norway oman
pakistan panama peru philippines poland portugal qatar russia saudi-arabia singapore south-africa spain
sweden switzerland thailand turkey ukraine united-arab-emirates united-kingdom united-states venezuela
vietnam zimbabwe
```

```bash
# {country}=united-states
curl -s "https://api.twexapi.io/twitter/united-states/trending" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`; spec text: "Standard response with list of trending topics in data field."
```jsonc
{ "code": 200, "msg": "success",
  "data": [ /* trending topics; the item shape is NOT specified in the spec */ ] }
```
**Cost:** no price stated in the spec.

## Balance

### GET /balance — Get Balance

The account's remaining TwexAPI credit / balance (the spec's only description is "Get Balance", response "The balance data"). Call it before a heavy pull and compare it with what you are about to spend; call it again after a small trial pull to see the real cost of an endpoint that states no price.

**Params:** none.

```bash
curl -s https://api.twexapi.io/balance \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`; spec text: "The balance data."
```jsonc
{ "code": 200, "msg": "success",
  "data": <balance data> }                   // shape NOT specified in the spec (free-form, nullable): field names and unit (credits vs USD) are UNVERIFIED, print it once and read the numeric field
```
**Cost:** no price stated in the spec.

Reference prices from the spec for sizing a pull: $0.05 per 1,000 tweets/users/replies/items on the priced routes (advanced_search and its `/page`, cashtags, users, replies, user tweets-replies, followers/following, the list/community `/page` routes); sentiment is 50 credits per call. Many routes state no price, and the unit `/balance` reports (credits vs USD) is not specified.

## Gotchas

- **Five of six responses have no declared `data` shape** (`countries`, `topics`, `contents`, `{country}/trending`, `/balance`). Print the first response, learn the real field names, then parse; do not guess keys.
- **Two country vocabularies.** `GET /twitter/{country}/trending` takes a fixed, **case-sensitive, lowercase** enum (`united-states`, `new-zealand`, `worldwide`); anything else returns 422 (observed: `narnia` and `United-States` both fail validation, `united-states` and `worldwide` pass). The `global-trending/*` routes take a free string, "name or slug returned by /countries": always copy the value from that response instead of reusing an Explore slug.
- **Required parameters (observed 422 when missing):** `contents` needs **both** `country` and `topic`; `tweets` needs `country` (topic and content are optional narrowing); `count` on `tweets` is 1–100 (101 and 0 are rejected).
- **`worldwide` is "account-default trends"** in the spec's words, not necessarily a true global ranking. Use a country slug when you need a specific market.
- **`countries` and `topics` are lookups, not data pulls:** call them once per session and cache the values; `contents` depends on a (country, topic) pair.
- **Prices:** none stated on any route in this file or on `/balance`, so size a trending pull by watching `GET /balance` before and after. `global-trending/tweets` returns full Tweet objects, which are heavy: keep `count` small.
- **Errors:** the spec documents only `200` (and `422` where there are parameters). Observed live on 2026-10-24 (not in the spec): no `Authorization` header gives HTTP 403 `{"code":403,"msg":"Not authenticated","data":[]}`; a wrong token gives HTTP 401 `{"code":401,"msg":"Invalid token!","data":[]}` (also on `/balance`); validation errors are HTTP 422 `{"code":422,"msg":"Validation error: <where>.<field>: <reason>","data":[]}` with `<where>` = `params` (path) or `querystring`. Validation can run before the token check, so a 422 does not prove the token is valid.
