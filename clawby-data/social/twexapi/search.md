Key + base URL + auth: see social/twexapi/_index.yaml. Base https://api.twexapi.io, header `Authorization: Bearer $TWEXAPI_KEY`.

# TwexAPI — Search · Users · About · Account-Based-in (10 endpoints)

- TwexAPI is a third-party public-data API for **X/Twitter only** (OpenAPI 3.1, v1.0.0, 55 endpoints; every path is `/twitter/...` or `/v3/twitter/...`, plus `GET /balance`). It covers no other network.
- Endpoint groups: **Search** · **Users** · **Followers & Following** · **Tweets** · **Replies** · **Tweet interactions** (retweeters, quotes) · **Sentiment** · **Timeline** · **Communities** · **Lists** · **Trending** · **Balance**.
- **This file (10):** Search (`advanced_search` and its `/page` variant, `cashtags`, `hashtags`) · Users (by usernames, by IDs, status, `search-user`) · User About · Account-Based-in. Other groups: `tweets.md` (tweets, replies, retweeters, quotes, sentiment, timeline) · `followers.md` · `communities-lists.md` · `trending.md` (trending + `GET /balance`).
- GET = path/query params; POST = JSON body + `Content-Type: application/json`. Most responses use the envelope `{ "code": 200, "msg": "success", "data": … }`; four batch lookups take a **bare JSON array** as the request body (see Gotchas).

## Pick an endpoint

| Need | Endpoint |
|---|---|
| Tweets matching free text / X search operators, one shot (up to 100,000) | `POST /twitter/advanced_search` |
| Same search, cursor-paged (20 per page) | `POST /twitter/advanced_search/page` |
| Tweets for `$TICKER`s with structured filters (time window, min likes/RTs/replies, verified, language, media type) | `POST /twitter/cashtags` |
| Same structured filters for `#hashtags` | `POST /twitter/hashtags` |
| Profiles for known handles or profile URLs | `POST /twitter/users` |
| Profiles for known numeric user IDs | `POST /twitter/users/by_ids` |
| Is a handle suspended / not found | `POST /twitter/users/status` |
| Find accounts by a name keyword | `GET /twitter/search-user/{keyword}/{target_count}` |
| Country an account is based in, plus verification/label details | `GET /twitter/{screen_name}/about` (one) · `POST /twitter/account/based` (batch) |

## Shared objects

Trimmed from the spec's `TweetModel` and `UserModel`; most TwexAPI endpoints return them (tweets.md, trending.md and the other files point back here). Concrete values are the spec's own examples; `<…>` is a type placeholder where the spec gives no example; `…` marks omitted fields.

**Tweet** (`TweetModel`; required: `tweet_id`, `text`)
```jsonc
{
  "tweet_id": "1803006263529541838",
  "id": "<string|null>",                          // same value as tweet_id
  "text": "<string>",
  "full_text": "<string|null>",                   // full text of extended tweets
  "created_at": "Mon Jun 17 03:51:48 +0000 2024",
  "created_at_datetime": "2024-06-17T03:51:48.000Z",
  "lang": "en",
  "favorite_count": <int>, "retweet_count": <int>, "reply_count": <int>, "quote_count": <int>, "bookmark_count": <int>,
  "view_count": "<string|null>",                  // a STRING, not a number
  "view_count_state": "<string|null>",
  "hashtags": ["AI", "Python"],
  "cashtags": ["$TSLA"],
  "urls": ["<url>"],
  "media": [{ "id": "1802991873836883968", "type": "photo", "media_url": "<url>", "display_url": "pic.twitter.com/...", "width": 1920, "height": 1080 }],
                                                  // video media also carry duration_millis, aspect_ratio [16,9], streams[{url,bitrate,content_type}]
  "in_reply_to": "<tweet_id|null>", "in_reply_to_user_id": "<id|null>", "in_reply_to_screen_name": "<handle|null>",
  "is_quote_status": false, "quoted_status_id_str": "<tweet_id|null>",
  "quote": <Tweet|null>, "retweeted_tweet": <Tweet|null>, "reply_to": <Tweet|null>,
  "replies": [<Tweet>], "related_tweets": [<Tweet>], "thread": [<Tweet>],
  "is_paid_promotion": false, "has_card": false, "community_note": "<string|null>",
  "user": <User|null>
  // …also: bookmarked, favorited, edit_tweet_ids, editable_until_msecs, edits_remaining, is_edit_eligible, is_translatable,
  //   has_community_notes, place, poll, possibly_sensitive(_editable), thumbnail_title, thumbnail_url, status, target_count
}
```

**User** (`UserModel`; required: `id`, `name`, `screen_name`)
```jsonc
{
  "id": "1717001045992251392",
  "name": "Cryptoklepto",
  "screen_name": "CK_Cryptoklepto",
  "created_at": "Mon Oct 28 02:32:47 +0000 2024",
  "created_at_datetime": "2024-10-28T02:32:47.000Z",
  "description": "<bio>", "location": "New York, USA",
  "followers_count": <int>, "following_count": <int>, "statuses_count": <int>,
  "favourites_count": <int>, "listed_count": <int>, "media_count": <int>,
  "is_blue_verified": false, "is_verified": false,   // is_verified = ANY badge (blue, business, government, legacy)
  "verified_type": "<blue | business | government | null>",
  "profile_image_shape": "Circle",                // Circle or Square (Square often means business/government)
  "protected": false, "possibly_sensitive": false,
  "pinned_tweet_ids": ["<tweet_id>"],
  "profile_image_url": "<url>", "profile_banner_url": "<url>",
  "urls": [{ "url": "https://www.google.com", "expanded_url": "https://www.google.com", "display_url": "www.google.com" }],
  "description_urls": ["<url>"]
  // …also: can_media_tag, default_profile, default_profile_image, fast_followers_count, normal_followers_count, has_custom_timelines, is_translator
}
```

## Search

### POST /twitter/advanced_search — Advanced Twitter Search

Search tweets with one or more search-term strings; returns up to `maxItems` tweets in a single, non-paged response.

**Params** (JSON body, schema `SearchQuery`; these three fields are the whole schema)

| name | in | type | req | note |
|---|---|---|---|---|
| `searchTerms` | body | string[] | yes | list of search terms, e.g. `["python programming","AI technology"]`. Operators and filters go inside each string, see "What goes in `searchTerms`" below. Spec: "Visit Advance Search TwitterXAPI (https://advance-search.pages.dev) to generate advanced search terms online" |
| `maxItems` | body | integer 1–100000 | no | max tweets to return; default `10` (spec example `50`) |
| `sortBy` | body | `Latest` or `Top` | no | default `Latest` |

```bash
curl -s -X POST https://api.twexapi.io/twitter/advanced_search \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"searchTerms":["python programming","AI technology"],"maxItems":50,"sortBy":"Latest"}'
```

**Response** `200` — `SearchResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet>, <Tweet>, … ] }          // up to maxItems
```
**Cost:** $0.05 per 1,000 tweets (spec); `maxItems: 100000` would be about $5.00. The max number of input items per call is limited by the user's plan QPS (spec wording; the cap itself is not given).

### POST /twitter/advanced_search/page — Advanced Twitter Search by Page

The same search, cursor-paged: up to 20 tweets per page.

**Params** (JSON body, schema `AdvancedSearchCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `searchTerms` | body | string[] | yes | same as `/twitter/advanced_search` |
| `sortBy` | body | string: `Latest` or `Top` | **yes** | required on this variant (no default); spec: "Supported values: 'Latest' or 'Top'" |
| `next_cursor` | body | string or null | no | omit (or null) for page 1; then send back the previous response's `next_cursor` unchanged. Spec example `"1234567890"` |

There is no `maxItems` here; the page size is fixed at up to 20.

```bash
# page 1
curl -s -X POST https://api.twexapi.io/twitter/advanced_search/page \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"searchTerms":["python programming"],"sortBy":"Latest"}'
# next page: add the cursor from the previous response
curl -s -X POST https://api.twexapi.io/twitter/advanced_search/page \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"searchTerms":["python programming"],"sortBy":"Latest","next_cursor":"1234567890"}'
```

**Response** `200` — `AdvancedSearchCursorResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet|null>, … ],               // up to 20; items may be null, skip them
  "has_next_page": true,                     // loop until false
  "next_cursor": "1234567890" }              // nullable
```
**Cost:** $0.05 per 1,000 tweets (spec), about $0.001 per full 20-tweet page. Input quantity is limited by plan QPS as above.

#### What goes in `searchTerms` (operators and filters)

The request schema has exactly the fields above. There are **no separate filter fields** (no date range, min-likes, language, verified, media): all of that has to be written **inside each term string** in X's own search syntax. The spec does not list any operators; it only points to the generator above. If you need structured filters, use `POST /twitter/cashtags` or `POST /twitter/hashtags` instead.

General X search syntax, **NOT in the TwexAPI spec and not verified against TwexAPI** (try `maxItems: 5` before a big pull):

| Goal | Term string |
|---|---|
| exact phrase | `"solana ecosystem"` |
| either word | `bitcoin OR ethereum` |
| exclude a word | `-giveaway` |
| from an author / reply to / mention | `from:elonmusk` · `to:elonmusk` · `@elonmusk` |
| hashtag / cashtag | `#AI` · `$TSLA` |
| date window | `since:2026-10-01 until:2026-10-24` |
| language | `lang:en` |
| engagement floor | `min_faves:100` · `min_retweets:50` · `min_replies:10` |
| media / links only | `filter:images` · `filter:videos` · `filter:links` |
| drop replies / retweets | `-filter:replies` · `-filter:retweets` |

Also unstated in the spec: how several entries in `searchTerms` combine (merged, OR-ed?) and whether `maxItems` counts per term or in total. Use one term per call when the count matters.

### POST /twitter/cashtags — Search Cashtags

Tweets containing given cashtags (stock/coin symbols), with structured filters. Every field is optional in the schema, but `cashtags` is what you search by.

**Params** (JSON body, schema `CashtagsQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `cashtags` | body | string[] | no | default `[]`; with or without the `$` prefix, e.g. `["AAPL","TSLA"]` |
| `startTime` | body | string or null | no | UNIX timestamp **as a string**; spec example `"1775726400"` (the examples are 10 digits, i.e. seconds) |
| `endTime` | body | string or null | no | UNIX timestamp as a string; spec example `"1775727300"` |
| `sortBy` | body | `Latest` or `Top` | no | default `Latest` |
| `maxItems` | body | integer 1–1000 | no | max tweets to return; default `20` |
| `mininumLikes` | body | integer ≥ 0 | no | minimum likes; default `0`. Spelled **mininum** in the spec, send it exactly so |
| `mininumRetweets` | body | integer ≥ 0 | no | minimum retweets; default `0` (same spelling) |
| `mininumReplies` | body | integer ≥ 0 | no | minimum replies; default `0` (same spelling) |
| `blueVerified` | body | boolean | no | blue-verified authors only |
| `verified` | body | boolean | no | verified authors only |
| `language` | body | enum (60 codes) | no | language filter, e.g. `en`. Values: `am ar bg bn bo ca ch cs da de dv el en es et fa fi fr gu hi ht hu hy in is it iu iw ja ka km kn ko lo lt lv ml my ne nl no or pa pl pt ro ru si sk sl sv ta te th tl tr uk ur vi zh` |
| `onlyImage` | body | boolean | no | tweets with images only |
| `onlyVideo` | body | boolean | no | tweets with videos only |
| `onlyQuote` | body | boolean | no | quote tweets only |
| `onlyReply` | body | boolean | no | replies only |

```bash
# startTime/endTime are UNIX seconds as strings (here the spec's example window); a rolling hour: END=$(date +%s); START=$((END-3600))
curl -s -X POST https://api.twexapi.io/twitter/cashtags \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cashtags":["AAPL","TSLA"],"startTime":"1775726400","endTime":"1775727300","sortBy":"Top","maxItems":20,"mininumLikes":5,"language":"en"}'
```

**Response** `200` — `SearchResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <Tweet>, … ] }                   // tweets that contain the cashtag(s)
```
**Cost:** $0.05 per 1,000 tweets (spec). Input quantity is limited by plan QPS.

### POST /twitter/hashtags — Search Hashtags

Tweets containing given hashtags, with the same structured filters as `/twitter/cashtags`.

**Params** (JSON body, schema `HashtagsQuery`; identical to `/twitter/cashtags` except the first field)

| name | in | type | req | note |
|---|---|---|---|---|
| `hashtags` | body | string[] | no | default `[]`; with or without the `#` prefix, e.g. `["btc","eth"]` |
| `startTime` | body | string or null | no | UNIX timestamp **as a string**; spec example `"1775726400"` |
| `endTime` | body | string or null | no | UNIX timestamp as a string; spec example `"1775727300"` |
| `sortBy` | body | `Latest` or `Top` | no | default `Latest` |
| `maxItems` | body | integer 1–1000 | no | max tweets to return; default `20` |
| `mininumLikes` | body | integer ≥ 0 | no | minimum likes; default `0` (spelled **mininum**, as in the spec) |
| `mininumRetweets` | body | integer ≥ 0 | no | minimum retweets; default `0` |
| `mininumReplies` | body | integer ≥ 0 | no | minimum replies; default `0` |
| `blueVerified` | body | boolean | no | blue-verified authors only |
| `verified` | body | boolean | no | verified authors only |
| `language` | body | enum (60 codes) | no | same 60 codes as `/twitter/cashtags`, e.g. `en` |
| `onlyImage` | body | boolean | no | tweets with images only |
| `onlyVideo` | body | boolean | no | tweets with videos only |
| `onlyQuote` | body | boolean | no | quote tweets only |
| `onlyReply` | body | boolean | no | replies only |

```bash
curl -s -X POST https://api.twexapi.io/twitter/hashtags \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"hashtags":["btc","eth"],"sortBy":"Latest","maxItems":20,"language":"en"}'
```

**Response** `200` — `SearchResponse`: `{ "code": 200, "msg": "success", "data": [ <Tweet>, … ] }`
**Cost:** no price stated for this endpoint in the spec (the sibling search endpoints are $0.05 per 1,000 tweets; assumed the same, not confirmed). Input quantity is limited by plan QPS.

## Users

### POST /twitter/users — Get Multiple Users by Usernames

Profile details for several users, given usernames or profile URLs.

**Params** (JSON body is a **bare array**, not an object)

| name | in | type | req | note |
|---|---|---|---|---|
| (the body itself) | body | string[] | yes | usernames or profile URLs, e.g. `["elonmusk","sundarpichai"]`. No wrapper key |

```bash
curl -s -X POST https://api.twexapi.io/twitter/users \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '["elonmusk","sundarpichai"]'
```

**Response** `200` — the spec declares **no response schema** (`{}`); its text: "A list of user profile objects. Unfound users are represented by `null`."
```jsonc
[ <User>, null, <User> ]      // presumed shape, UNVERIFIED: one entry per requested name; may instead be wrapped in { code, msg, data }
```
**Cost:** $0.05 per 1,000 users (spec). Input quantity is limited by plan QPS.

### POST /twitter/users/by_ids — Users Details by ID

Profile details for several users, given numeric user IDs.

**Params** (JSON body is a **bare array**)

| name | in | type | req | note |
|---|---|---|---|---|
| (the body itself) | body | string[] | yes | user IDs as strings, e.g. `["44196397","1696160451770429440"]` |

```bash
curl -s -X POST https://api.twexapi.io/twitter/users/by_ids \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '["44196397","1696160451770429440"]'
```

**Response** `200` — `UsersDetailsResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <User>, … ] }
```
**Cost:** no price stated in the spec. Input quantity is limited by plan QPS.

### POST /twitter/users/status — Batch Get User account status

Account status for several usernames (is it suspended, does it exist).

**Params** (JSON body is a **bare array**)

| name | in | type | req | note |
|---|---|---|---|---|
| (the body itself) | body | string[] | yes | usernames, e.g. `["elonmusk","sundarpichai"]` |

```bash
curl -s -X POST https://api.twexapi.io/twitter/users/status \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '["elonmusk","sundarpichai"]'
```

**Response** `200` — the spec declares **no response schema** (`{}`); its text: "A list of user account status strings. If user is suspended return suspended, if unfound return null."
```jsonc
["suspended", null, "<status string>"]   // UNVERIFIED: the value for a normal live account is not documented; the null placeholders imply positional alignment with the input
```
**Cost:** no price stated in the spec. Input quantity is limited by plan QPS.

### GET /twitter/search-user/{keyword}/{target_count} — Search User

Find accounts matching a keyword.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `keyword` | path | string | yes | "The keyword to search for." URL-encode spaces |
| `target_count` | path | integer | yes | "The number of users to return." No min/max given |

```bash
# {keyword}=solana  {target_count}=20
curl -s "https://api.twexapi.io/twitter/search-user/solana/20" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `SearchUserResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ <User>, … ] }                    // up to target_count
```
**Cost:** no price stated in the spec.

## About / Account-Based-in

### GET /twitter/{screen_name}/about — Get Twitter User About by Screen Name

The "About this account" panel: which country the account is based in, whether that location is accurate, label/verification details, username-change count.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | the user's handle, e.g. `elonmusk` |

```bash
# {screen_name}=elonmusk
curl -s "https://api.twexapi.io/twitter/elonmusk/about" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `TwitterUserAboutStandardResponse` (values below are the spec's examples):
```jsonc
{ "code": 200, "msg": "success",
  "data": {                                   // nullable
    "user_id": "44196397",
    "avatar": "https://pbs.twimg.com/profile_images/1983681414370619392/oTT3nm5Z_normal.jpg",
    "name": "Elon Musk",
    "screen_name": "elonmusk",
    "created_at": "Tue Jun 02 20:12:29 +0000 2009",
    "profile_image_shape": "Circle",
    "verification": false,
    "userLabelDisplayType": "Badge",
    "userLabelType": "BusinessLabel",
    "is_blue_verified": true,
    "privacy_policy_url": "https://help.twitter.com/managing-your-account/about-twitter-verified-accounts",
    "account_based_in": "United States",      // country or region the account is based in
    "location_accurate": true,
    "affiliate_username": "X",
    "source": "United States App Store",
    "username_changes_count": 0,
    "override_verified_year": -3000,          // negative values = special cases
    "verified_since_msec": -156836000000000   // negative values = special cases
  } }
```
**Cost:** no price stated in the spec.

### POST /twitter/account/based — Get Twitter Account Based in

The same About data for several accounts at once (batch of `/twitter/{screen_name}/about`).

**Params** (JSON body is a **bare array**)

| name | in | type | req | note |
|---|---|---|---|---|
| (the body itself) | body | string[] | yes | screen names, e.g. `["elonmusk","sundarpichai"]`. No wrapper key |

```bash
curl -s -X POST https://api.twexapi.io/twitter/account/based \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '["elonmusk","sundarpichai"]'
```

**Response** `200` — `TwitterAccountBasedStandardResponse`:
```jsonc
{ "code": 200, "msg": "success",
  "data": [ { /* the About object above: user_id, name, screen_name, account_based_in, location_accurate, … */ } ] }   // data is nullable
```
**Cost:** no price stated in the spec. Input quantity is limited by plan QPS.

## Gotchas

- **Four POSTs take a bare JSON array, not an object:** `/twitter/users`, `/twitter/users/by_ids`, `/twitter/users/status`, `/twitter/account/based`. Sending `{"usernames":["elonmusk"]}` fails with HTTP 422 (observed live: `{"code":422,"msg":"Validation error: body: Input should be an array","data":[]}`). IDs go in as strings.
- **Misspelled filter names are the real names:** `mininumLikes`, `mininumRetweets`, `mininumReplies` (cashtags and hashtags). The correctly spelled `minimumLikes` is **not rejected** (observed: it passes validation, i.e. unknown fields are not refused), so a misspelled filter is almost certainly ignored and you get unfiltered tweets. Copy the field names exactly.
- **`startTime` / `endTime` are strings of UNIX seconds**, not ints and not ISO dates; an integer `startTime` returns 422 (observed: `body.startTime: Input does not match any permitted type`). They exist only on `/twitter/cashtags` and `/twitter/hashtags`; `advanced_search` has no time fields (use `since:` / `until:` in the term, unverified syntax).
- **`advanced_search` vs `/page`:** the plain call has `maxItems` (default 10, cap 100,000) and a default `sortBy`; the `/page` call has no `maxItems`, **requires** `sortBy` (omitting it returns 422, observed: `body.sortBy: Field required`), and returns at most 20 tweets. Start small: `maxItems` is a cost dial, $0.05 per 1,000 tweets. Range limits are enforced (e.g. cashtags `maxItems: 5000` returns 422).
- **Cursor paging:** page 1 omits `next_cursor`; keep sending the previous `next_cursor` verbatim while `has_next_page` is true. `data` can hold `null` items, skip them.
- **Prices are only stated for some endpoints** ($0.05 per 1,000 tweets/users on advanced_search, its `/page`, cashtags, users). Where the spec says nothing it is marked "no price stated"; check the balance before and after a small pull (`GET /balance`, see trending.md) to calibrate. Batch endpoints cap the number of input items per call by the user's plan QPS (cap not given): send small chunks.
- **Unspecified response shapes:** `POST /twitter/users` and `POST /twitter/users/status` declare an empty (`{}`) 200 schema, so their shape above is presumed. Print the first response before parsing it.
- **`null` means not found:** unfound users come back as `null` in `/twitter/users` and `/twitter/users/status`; `/twitter/{screen_name}/about` and `/twitter/account/based` have nullable `data`.
- **Strings, not numbers:** tweet and user IDs are strings (modern ones are ~19 digits, beyond JavaScript's safe-integer range), so never cast them; `view_count` is a string too.
- **Enums are closed and case-sensitive** (observed 422s): `language` accepts only the 60 codes listed above (`en`, `zh`, `in`, `ch` pass; `EN` and `xx` are rejected); `sortBy` on advanced_search/cashtags/hashtags accepts only `Latest` or `Top` (`top` and `Relevance` are rejected). On `/advanced_search/page`, `sortBy` is a free string at validation (any value passes) but only `Latest` / `Top` are documented, so send one of those.
- **Errors:** the spec documents only `200` and `422`. Observed live on 2026-10-24 (unauthenticated probes, not in the spec): no `Authorization` header gives HTTP 403 `{"code":403,"msg":"Not authenticated","data":[]}`; a wrong token gives HTTP 401 `{"code":401,"msg":"Invalid token!","data":[]}`. The live 422 body is the same `{code,msg,data}` envelope with `msg` of the form `Validation error: body.<field>: <reason>`, not the `{"detail":[…]}` the spec declares. A request with a bad token **and** a malformed body returned 422, not 401, so a 422 does not prove the token is valid.
