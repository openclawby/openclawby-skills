Key + base URL + auth: see social/twexapi/_index.yaml. Base https://api.twexapi.io, header `Authorization: Bearer $TWEXAPI_KEY`.

# TwexAPI — Communities & Lists (13 endpoints)

- 7 Communities routes (spec tag "Communities Endpoints") and 6 Lists routes ("Lists Endpoints"). Every route answers with the envelope `{ "code", "msg", "data" }`.
- Two ways to fetch members / tweets: a **by-count GET** (`.../{target_count}`, one request, no cursor) or a **cursor POST** (`.../page`, up to 20 items per page, `has_next_page` + `next_cursor` as top-level siblings of `data`). The search routes take `target_count` in a JSON body.
- Users are `UserModel` and tweets are `TweetModel` (snake_case, defined once under "Shared objects"). This is NOT the camelCase `UserInfo` that the followers routes return (`followers.md`).
- Ids: `$COMMUNITY_ID` / `$LIST_ID` in the examples come from the search routes (`POST /twitter/community/search` and `POST /twitter/list/search`, field `data[].id`). All ids are strings.
- Cost: the spec states **$0.05 per 1,000 items only on the four `/page` routes**. The other nine routes state no price.
- Only `200` and `422` are declared (422 = `{ "detail": [ { "loc": […], "msg": "…", "type": "…" } ] }`). The spec says nothing about 401 / 402 / 429.

## Pick an endpoint

| Need | Endpoint |
|---|---|
| Find a community id by keyword | `POST /twitter/community/search` |
| One community's details | `GET /twitter/community/{community_id}` |
| Community members, one request | `GET /twitter/community/{community_id}/members/{target_count}` |
| Community members, cursor pages | `POST /twitter/community/members/page` |
| Community tweets (Top / Latest / Media), one request | `GET /twitter/community/{community_id}/tweets/{tweet_type}/{target_count}` |
| Community tweets, cursor pages | `POST /twitter/community/tweets/page` |
| Search inside one community's tweets | `POST /twitter/community/search-tweets` |
| Find a list id by keyword | `POST /twitter/list/search` |
| List tweets, one request / cursor pages | `GET /twitter/list/{list_id}/tweets/{target_count}` / `POST /twitter/list/tweets/page` |
| List members, one request / cursor pages | `GET /twitter/list/{list_id}/members/{target_count}` / `POST /twitter/list/members/page` |
| List subscribers (no cursor variant exists) | `GET /twitter/list/{list_id}/subscribers/{target_count}` |

## Shared objects

Resolved from components `UserModel`, `TweetModel`, `MediaModel`, `CommunityModel`, `ListModel`.

**UserModel** (31 fields)
- Required: `id` ("User ID"), `name` ("Display name"), `screen_name` ("Twitter username").
- Optional / nullable: `created_at` (Twitter format), `created_at_datetime` (ISO), `description`, `description_urls[]` (strings), `urls[]` (`{url, expanded_url, display_url}`), `location`, `followers_count`, `following_count`, `statuses_count`, `favourites_count` ("tweets the user has liked"), `listed_count`, `media_count`, `fast_followers_count`, `normal_followers_count`, `is_blue_verified`, `is_verified` ("any verification badge (blue, business, government, or legacy verified)"), `verified_type` ("blue, business, government, etc."), `profile_image_shape` ("Circle" or "Square"; "Square often indicates business/government"), `profile_image_url`, `profile_banner_url`, `protected`, `possibly_sensitive`, `default_profile`, `default_profile_image`, `has_custom_timelines`, `is_translator`, `can_media_tag`, `pinned_tweet_ids[]`.

```jsonc
{
  "id": "1717001045992251392",
  "name": "Cryptoklepto",
  "screen_name": "CK_Cryptoklepto",
  "created_at": "Mon Oct 28 02:32:47 +0000 2024",
  "created_at_datetime": "2024-10-28T02:32:47.000Z",
  "description": "…", "location": "New York, USA",
  "followers_count": …, "following_count": …, "statuses_count": …, "listed_count": …,
  "is_blue_verified": …, "is_verified": …, "verified_type": null,        // or "blue" / "business" / "government"
  "profile_image_shape": "Circle",                                        // or "Square"
  "profile_image_url": "…", "protected": false, "pinned_tweet_ids": []
  // …remaining fields as listed above
}
```
(`id`, `name`, `screen_name`, the two dates, `location` and the enum values are the spec's own field examples; `…` marks values the spec does not exemplify.)

**TweetModel** (49 fields)
- Required: `tweet_id` (string), `text`.
- Time / language: `created_at` (Twitter format), `created_at_datetime` (ISO 8601), `lang` (BCP 47), `id` ("same as tweet_id"), `target_count` ("The target count of items requested, for context").
- Text / links: `full_text`, `hashtags[]`, `cashtags[]`, `urls[]` (strings), `media[]` (MediaModel), `has_card`, `thumbnail_title`, `thumbnail_url`, `place`, `poll`.
- Counts: `favorite_count`, `retweet_count`, `reply_count`, `quote_count`, `bookmark_count`, `view_count` (**a string**), `view_count_state`.
- Relations (nested TweetModel): `quote`, `reply_to`, `retweeted_tweet`, `replies[]`, `related_tweets[]`, `thread[]`; plus `in_reply_to` (tweet id), `in_reply_to_user_id`, `in_reply_to_screen_name`, `is_quote_status`, `quoted_status_id_str`.
- Author: `user` (UserModel).
- Flags / edit / notes: `is_paid_promotion`, `possibly_sensitive`, `possibly_sensitive_editable`, `is_translatable`, `is_edit_eligible`, `edit_tweet_ids[]`, `editable_until_msecs`, `edits_remaining`, `has_community_notes`, `community_note`, `bookmarked`, `favorited` (the last two "authenticating user" flags), `status` (raw status dict).

```jsonc
{
  "tweet_id": "1803006263529541838",
  "id": "1803006263529541838",
  "text": "…",
  "created_at": "Mon Jun 17 03:51:48 +0000 2024",
  "created_at_datetime": "2024-06-17T03:51:48.000Z",
  "lang": "en",
  "favorite_count": …, "retweet_count": …, "reply_count": …, "quote_count": …, "bookmark_count": …,
  "view_count": "…",                                          // string
  "hashtags": ["AI", "Python"], "cashtags": ["$TSLA"], "urls": [],
  "media": [ { "id": "1802991873836883968", "type": "photo", "display_url": "pic.twitter.com/…", "width": 1920, "height": 1080 } ],
  "is_quote_status": false, "in_reply_to": null,
  "user": { /* UserModel */ }
  // …remaining fields as listed above
}
```

**MediaModel** (17 fields): required `id`, `type` (for example "photo"); optional `media_url`, `display_url`, `expanded_url`, `url` (t.co), `width`, `height`, `aspect_ratio` (integer array, for example [16, 9]), `duration_millis`, `source_status_id`, `source_user_id`, `features{}`, `original_info{}`, `sizes{}`, `video_info{}`, `streams[]` (`{url, bitrate, content_type}`, for example 832000 and "video/mp4").

**CommunityModel** (14 fields)
- Required: `id`, `name`, `description`, `member_count` (integer).
- Optional: `is_nsfw`, `members_facepile_results[]` ("The profile image URLs of members"), `banner{}`, `is_member`, `role`, `admin` (UserModel), `join_policy`, `invites_policy`, `is_pinned`, `created_at` (**integer** timestamp, unit not stated).

```jsonc
{
  "id": "…", "name": "…", "description": "…", "member_count": …,
  "is_nsfw": false, "members_facepile_results": ["https://…"], "banner": { … },
  "admin": { /* UserModel */ }, "join_policy": "…", "invites_policy": "…", "created_at": …
}
```

**ListModel** (6 fields, all required): `id`, `name`, `description`, `is_private` (boolean), `member_count`, `subscriber_count`.

**Paged envelope** (all four cursor POSTs; `code`, `msg`, `data` and `has_next_page` are required, `next_cursor` is nullable):
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": [ … ],                 // up to 20 items (UserModel or TweetModel)
  "has_next_page": true,
  "next_cursor": "1234567890"    // spec example value; send back as next_cursor
}
```

## Communities

Get a `community_id` from `POST /twitter/community/search` (`data[].id`).

### GET /twitter/community/{community_id}/members/{target_count} — Get Community Members

Members of a community: you ask for `target_count`, one request, no cursor.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `community_id` | path | string | yes | the community id; the spec gives no description or example |
| `target_count` | path | integer | yes | how many members to fetch; the spec gives no description, bounds or example |

```bash
curl -sS "https://api.twexapi.io/twitter/community/$COMMUNITY_ID/members/100" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `SearchUserResponse` ("A list of user objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* UserModel */ }, { /* UserModel */ } ] }
```
**Cost:** no price stated in the spec (the `/page` sibling is $0.05 per 1,000 members; do not assume this route is the same).

### POST /twitter/community/members/page — Get Community Members by Page

Cursor-paged community members, up to 20 per page.

**Params** (JSON body, `GetCommunityMembersCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `community_id` | body | string | yes | "The ID of the community to get members from." |
| `next_cursor` | body | string or null | no | "Cursor returned by the previous page. Leave empty to fetch the first page." Spec example `"1234567890"` |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/twitter/community/members/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"community_id\":\"$COMMUNITY_ID\"}"

# next page: next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/twitter/community/members/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"community_id\":\"$COMMUNITY_ID\",\"next_cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `GetCommunityMembersCursorResponse` ("Current page data (up to 20 members) and pagination metadata (has_next_page, next_cursor)."):
```jsonc
{
  "code": 200, "msg": "success",
  "data": [ { /* UserModel */ } ],      // up to 20
  "has_next_page": true,
  "next_cursor": "1234567890"           // nullable
}
```
**Cost:** $0.05 per 1,000 members (spec). A full 20-member page is about $0.001 (derived).

### GET /twitter/community/{community_id}/tweets/{tweet_type}/{target_count} — Get Community Tweets

Tweets of a community feed (`Top`, `Latest` or `Media`): you ask for `target_count`, one request, no cursor.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `community_id` | path | string | yes | the community id; the spec gives no description or example |
| `tweet_type` | path | enum: `Top`, `Latest`, `Media` | yes | which feed; the spec gives no description. Capitalized exactly as listed |
| `target_count` | path | integer | yes | how many tweets to fetch; the spec gives no description, bounds or example |

```bash
curl -sS "https://api.twexapi.io/twitter/community/$COMMUNITY_ID/tweets/Latest/40" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `CommunityTweetsResponse` ("A list of tweet objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* TweetModel */ }, { /* TweetModel */ } ] }
```
**Cost:** no price stated in the spec (the `/page` sibling is $0.05 per 1,000 tweets).

### POST /twitter/community/tweets/page — Get Community Tweets by Page

Cursor-paged community tweets, up to 20 per page.

**Params** (JSON body, `GetCommunityTweetsCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `community_id` | body | string | yes | "The ID of the community to get tweets from." |
| `tweet_type` | body | enum: `Top`, `Latest`, `Media` | yes | "The type of tweets to get." |
| `next_cursor` | body | string or null | no | "Cursor returned by the previous page. Leave empty to fetch the first page." Spec example `"1234567890"` |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/twitter/community/tweets/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"community_id\":\"$COMMUNITY_ID\",\"tweet_type\":\"Latest\"}"

# next page: next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/twitter/community/tweets/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"community_id\":\"$COMMUNITY_ID\",\"tweet_type\":\"Latest\",\"next_cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `GetCommunityTweetsCursorResponse` ("Current page data (up to 20 tweets) and pagination metadata (has_next_page, next_cursor)."):
```jsonc
{
  "code": 200, "msg": "success",
  "data": [ { /* TweetModel */ } ],     // up to 20
  "has_next_page": true,
  "next_cursor": "1234567890"           // nullable
}
```
**Cost:** $0.05 per 1,000 tweets (spec).

### POST /twitter/community/search — Search Community

Search communities by keyword. The `id` of each result is the `community_id` the other community routes need.

**Params** (JSON body, `SearchCommunityQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `query` | body | string | yes | "The query to search for." No operator syntax is described |
| `target_count` | body | integer | yes | "The number of communities to search." No bounds in the spec |

```bash
curl -sS -X POST "https://api.twexapi.io/twitter/community/search" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"solana","target_count":20}'
```

**Response** `200` — `SearchCommunityResponse` ("A list of community objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* CommunityModel */ }, { /* CommunityModel */ } ] }
```
**Cost:** no price stated in the spec.

### GET /twitter/community/{community_id} — Get Community

One community's details.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `community_id` | path | string | yes | the community id; the spec gives no description or example |

```bash
curl -sS "https://api.twexapi.io/twitter/community/$COMMUNITY_ID" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `GetCommunityResponse` ("A community object."):
```jsonc
{ "code": 200, "msg": "success", "data": { /* CommunityModel */ } }      // data may be null
```
**Cost:** no price stated in the spec.

### POST /twitter/community/search-tweets — Search Community Tweets

Search the tweets of one community by keyword.

**Params** (JSON body, `SearchCommunityTweetsQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `community_id` | body | string | yes | "The ID of the community." |
| `query` | body | string | yes | "The query to search for." No operator syntax is described |
| `target_count` | body | integer | yes | "The number of tweets to search." No bounds in the spec |

```bash
curl -sS -X POST "https://api.twexapi.io/twitter/community/search-tweets" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"community_id\":\"$COMMUNITY_ID\",\"query\":\"airdrop\",\"target_count\":30}"
```

**Response** `200` — `CommunityTweetsResponse` ("A list of tweet objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* TweetModel */ }, { /* TweetModel */ } ] }
```
**Cost:** no price stated in the spec.

## Lists

Get a `list_id` from `POST /twitter/list/search` (`data[].id`).

### GET /twitter/list/{list_id}/tweets/{target_count} — Get List Tweets

Tweets of a list: you ask for `target_count`, one request, no cursor.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `list_id` | path | string | yes | the list id; the spec gives no description or example |
| `target_count` | path | integer | yes | how many tweets to fetch; the spec gives no description, bounds or example |

```bash
curl -sS "https://api.twexapi.io/twitter/list/$LIST_ID/tweets/40" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `ListTweetsResponse` ("A list of tweet objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* TweetModel */ }, { /* TweetModel */ } ] }
```
**Cost:** no price stated in the spec (the `/page` sibling is $0.05 per 1,000 tweets).

### POST /twitter/list/tweets/page — Get List Tweets by Page

Cursor-paged list tweets, up to 20 per page.

**Params** (JSON body, `GetListTweetsCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `list_id` | body | string | yes | "The ID of the list to get tweets from." |
| `next_cursor` | body | string or null | no | "Cursor returned by the previous page. Leave empty to fetch the first page." Spec example `"1234567890"` |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/twitter/list/tweets/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"list_id\":\"$LIST_ID\"}"

# next page: next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/twitter/list/tweets/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"list_id\":\"$LIST_ID\",\"next_cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `GetListTweetsCursorResponse` ("Current page data (up to 20 tweets) and pagination metadata (has_next_page, next_cursor)."):
```jsonc
{
  "code": 200, "msg": "success",
  "data": [ { /* TweetModel */ } ],     // up to 20
  "has_next_page": true,
  "next_cursor": "1234567890"           // nullable
}
```
**Cost:** $0.05 per 1,000 tweets (spec).

### GET /twitter/list/{list_id}/subscribers/{target_count} — Get List Subscribers

Subscribers of a list: you ask for `target_count`, one request. There is no cursor variant for subscribers.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `list_id` | path | string | yes | the list id; the spec gives no description or example |
| `target_count` | path | integer | yes | how many subscribers to fetch; the spec gives no description, bounds or example |

```bash
curl -sS "https://api.twexapi.io/twitter/list/$LIST_ID/subscribers/100" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `ListSubscribersResponse` ("A list of user objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* UserModel */ }, { /* UserModel */ } ] }
```
**Cost:** no price stated in the spec.

### GET /twitter/list/{list_id}/members/{target_count} — Get List Members

Members of a list: you ask for `target_count`, one request, no cursor.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `list_id` | path | string | yes | the list id; the spec gives no description or example |
| `target_count` | path | integer | yes | how many members to fetch; the spec gives no description, bounds or example |

```bash
curl -sS "https://api.twexapi.io/twitter/list/$LIST_ID/members/100" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `ListMembersResponse` ("A list of user objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* UserModel */ }, { /* UserModel */ } ] }
```
**Cost:** no price stated in the spec (the `/page` sibling is $0.05 per 1,000 members).

### POST /twitter/list/members/page — Get List Members by Page

Cursor-paged list members, up to 20 per page.

**Params** (JSON body, `GetListMembersCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `list_id` | body | string | yes | "The ID of the list to get members from." |
| `next_cursor` | body | string or null | no | "Cursor returned by the previous page. Leave empty to fetch the first page." Spec example `"1234567890"` |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/twitter/list/members/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"list_id\":\"$LIST_ID\"}"

# next page: next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/twitter/list/members/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"list_id\":\"$LIST_ID\",\"next_cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `GetListMembersCursorResponse` ("Current page data (up to 20 members) and pagination metadata (has_next_page, next_cursor)."):
```jsonc
{
  "code": 200, "msg": "success",
  "data": [ { /* UserModel */ } ],      // up to 20
  "has_next_page": true,
  "next_cursor": "1234567890"           // nullable
}
```
**Cost:** $0.05 per 1,000 members (spec).

### POST /twitter/list/search — Search List

Search lists by keyword. The `id` of each result is the `list_id` the other list routes need.

**Params** (JSON body, `SearchListQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `query` | body | string | yes | "The query to search for." No operator syntax is described |
| `target_count` | body | integer | yes | "The number of lists to search." No bounds in the spec |

```bash
curl -sS -X POST "https://api.twexapi.io/twitter/list/search" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"crypto researchers","target_count":20}'
```

**Response** `200` — `SearchListResponse` ("A list of list objects."):
```jsonc
{ "code": 200, "msg": "success", "data": [ { /* ListModel */ }, { /* ListModel */ } ] }
```
**Cost:** no price stated in the spec.

## Cursor loop (sketch)

One loop serves all four `/page` routes (swap the path and the id field). Standard library only.

```python
import json, os, urllib.request

BASE, KEY = "https://api.twexapi.io", os.environ["TWEXAPI_KEY"]

def post(path, body):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def pages(path, base_body, limit=None):
    """base_body: {"community_id": cid, "tweet_type": "Latest"}, {"community_id": cid}, or {"list_id": lid}"""
    cursor, n = None, 0
    while True:
        body = dict(base_body)
        if cursor:
            body["next_cursor"] = cursor            # omit for page 1
        r = post(path, body)
        for item in r["data"]:
            yield item
            n += 1
            if limit and n >= limit:
                return
        if not r["has_next_page"]:
            return
        cursor = r["next_cursor"]

# the newest 200 tweets of a community (10 requests of up to 20)
# tweets = list(pages("/twitter/community/tweets/page", {"community_id": cid, "tweet_type": "Latest"}, limit=200))
```

## Gotchas

- **Two object families.** Communities and lists return `UserModel` / `TweetModel` (snake_case). The followers routes return `UserInfo` (camelCase). If you merge the two, map the fields:

  | `UserInfo` (`followers.md`) | `UserModel` (here) |
  |---|---|
  | `userId` | `id` |
  | `username` | `screen_name` |
  | `profileImageUrlHttps` | `profile_image_url` |
  | `followersCount`, `followingCount` | `followers_count`, `following_count` |
  | `statusesCount`, `favouritesCount` | `statuses_count`, `favourites_count` |
  | `isBlueVerified` | `is_blue_verified` |
  | `verified` (legacy verification only) | `is_verified` (true for ANY badge: blue, business, government or legacy) |
  | `createdAt`, `createdAtDatetime` | `created_at`, `created_at_datetime` |

- **Ids stay strings.** Keep `community_id`, `list_id`, `tweet_id`, `id` as strings end to end. They are large integers (the spec's own tweet id example `1803006263529541838` is above 2^53), so parsing them as JSON numbers can corrupt them; the spec types them all as `string`.
- **Two sizes of request.** A by-count GET aims at `target_count` items in one response, with no declared maximum (whether it can return fewer is not stated). A `/page` POST returns at most 20 items, so 1,000 items = 50 calls. The spec warns about request timeouts only for the legacy replies route, not for these routes, but a very large `target_count` on a GET is the same kind of risk (inference); for big pulls prefer `/page`.
- **Which routes have a cursor.** `/page` variants exist only for community members, community tweets, list tweets and list members. There is no `/page` for list subscribers, and the search routes (`community/search`, `community/search-tweets`, `list/search`) take `target_count` instead. `GET /twitter/community/{community_id}` returns a single object.
- **First page.** Omit `next_cursor` (or send null). When `has_next_page` is false, `next_cursor` can be null. Keep the cursor opaque.
- **`tweet_type`** is exactly `Top`, `Latest` or `Media` (capitalized): in the path for the GET, in the body for the POST. What "Top" ranks by is not stated.
- **`GET /twitter/community/{community_id}`** types `data` as `CommunityModel` or null; what null means (not found, hidden, private) is not stated.
- **Viewer-relative fields look unreliable.** `is_member`, `role` (CommunityModel), `bookmarked` and `favorited` (TweetModel) are described relative to "the user" / "the authenticating user", but these routes take no X account, only the TwexAPI key. Do not build logic on them.
- **Type quirks.** `view_count` is a string. `CommunityModel.created_at` is an integer timestamp (unit not stated) while user and tweet `created_at` are Twitter-format strings (use `created_at_datetime` for ISO). `TweetModel.thread` is typed as an array of tweets although its description says "The conversation thread ID". `TweetModel.id` duplicates `tweet_id`.
- **Heavy payloads.** A `TweetModel` has 49 fields, nests more tweets (`quote`, `reply_to`, `retweeted_tweet`, `replies`, `related_tweets`, `thread`) and carries a full `UserModel` in `user`. Save big pulls to a file (`curl -o`) and extract only the fields you need.
- **Money.** Only the four `/page` routes state a price: $0.05 per 1,000 items, about $0.001 per full 20-item page (derived). The other nine state none: do not assume they are free or priced the same. The spec does not say whether billing counts items returned or requested, nor whether failed or empty calls are charged. Check the balance with `GET /balance` (`trending.md`) before large pulls.
- **Search `query`** is just "The query to search for." The spec describes no operators or filters, so use plain keywords; `target_count` has no declared bounds.
- **Errors.** Only `422` (`{ "detail": [ { "loc", "msg", "type" } ] }`) is documented, for example a missing required field or a `tweet_type` outside the enum.

Unverified / not resolvable from the spec: the format of `community_id` and `list_id` (the spec exemplifies neither); min / max and fill behaviour of `target_count` (does a GET return fewer when the community or list is smaller, and does a huge value time out); the price of the nine routes that state none; whether billing counts items returned or requested; the meaning of `null` from `GET /twitter/community/{community_id}`; the unit of `CommunityModel.created_at`; what the viewer-relative flags return without an X account; whether private lists (`is_private`) can be read; the ordering and ranking of results (including `Top`); search operator syntax; behaviour for 401 / 402 / 429 (only `200` and `422` are declared). The curl examples and the loop were derived from the spec and were not run against the live API.
