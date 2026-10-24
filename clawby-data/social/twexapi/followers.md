Key + base URL + auth: see social/twexapi/_index.yaml. Base https://api.twexapi.io, header `Authorization: Bearer $TWEXAPI_KEY`.

# TwexAPI — Followers & Following (13 endpoints)

- Spec tag "Followers & Following Endpoints". Every route answers with the envelope `{ "code", "msg", "data" }`; what `data` holds, and where the paging fields sit, depends on the route family (see "Response envelopes").
- Users come back as **`UserInfo`** objects (camelCase keys, defined once below). The communities and lists routes use a different user object (`UserModel`, snake_case), see `communities-lists.md`.
- None of the 13 routes takes a Twitter cookie or `auth_token`, only the TwexAPI bearer key.
- Cost: every route that returns users is priced **$0.05 per 1,000 users** in the spec (restated per route). The four task `status` / `next` routes state no price.
- Only `200` and `422` are declared for these routes (422 = `{ "detail": [ { "loc": […], "msg": "…", "type": "…" } ] }`). The spec says nothing about 401 / 402 / 429.

## Three ways to pull followers / following (read first)

The `/v3/...` routes are the newer variants of the cursor way (b).

**(a) Quick GETs: one request, one list**

| Route | You pass | You get |
|---|---|---|
| `GET /twitter/latest-followers/{screen_name}` and `GET /twitter/latest-following/{screen_name}` | the handle | the latest followers / following in `data`. No count and no cursor param; how many users come back is not stated |
| `GET /twitter/followers/{screen_name}/{count}` and `GET /twitter/following/{screen_name}/{count}` | the handle + `count` | `count` <= 5000: the users inline in `data`. `count` > 5000: **no users**, an async task handle `{task_id, reused}` (way c) |

**(b) Cursor pages: you drive the loop**

`POST /twitter/followers/page` and `POST /twitter/following/page`, body `{screen_name, next_cursor?}`. Up to **200 users per page**. The response has `data` (the page) and, as top-level siblings of `data`, `has_next_page` + `next_cursor`. Repeat with the previous `next_cursor` until `has_next_page` is false. Nothing is held server-side and nothing is consumed.

**(c) Async task: the server collects, you drain**

```
1 START  GET /twitter/followers/{screen_name}/{count}      count > 5000
            -> data = { "task_id": "…", "reused": false }     returned at once (spec: HTTP 202)
2 POLL   GET /twitter/followers/task/{task_id}/status       status: pending | running | done | error
3 DRAIN  GET /twitter/followers/task/{task_id}/next         ONE page (~200 users) per call; every page is
                                                            removed once it has been returned
         repeat 2-3 until status = done AND `next` returns data = []
Following: the same flow on /twitter/following/{screen_name}/{count} and /twitter/following/task/{task_id}/status|next
```

- There is no separate "start task" route: the by-count GET with `count` > 5000 **is** the start.
- The followers and following tasks are separate: a `task_id` from the followers GET goes to `/twitter/followers/task/...`, one from the following GET goes to `/twitter/following/task/...` (per the `task_id` param descriptions).

**v3 (newer variants of the cursor way)**: `POST /v3/twitter/users/followers`, `POST /v3/twitter/users/following`, `POST /v3/twitter/users/verified-followers`. Cursor paging like (b), but the **page size is yours** (`count` 10-100, default 20), the body fields are named `username` / `count` / `cursor` (legacy: `screen_name` / `next_cursor`), and the response nests the paging fields **inside `data`** (`data.users`, `data.has_next_page`, `data.next_cursor`). `verified-followers` returns only blue-verified followers and has no legacy equivalent.

**Which one**

| Need | Use |
|---|---|
| a quick look at the newest followers / following | (a) `latest-*` |
| the first N followers, N <= 5000, in one call | (a) by-count GET |
| a big pull (> 5000) without writing a paging loop | (c) task |
| paging of any size with the state in your hands | (b) legacy `/page`, or v3 |
| only blue-verified followers | v3 `verified-followers` |
| a smaller page size (10-100) | v3 |

Call counts for 10,000 followers (derived from the page sizes above): legacy `/page` 50 calls, v3 at `count` 100 = 100 calls, task = 1 start + about 50 `next` calls + status polls. Cost at the spec rate: about $0.50 (see Gotchas).

## Response envelopes

| Route family | `data` holds | Paging fields |
|---|---|---|
| `latest-*` | `[UserInfo]` | none |
| by-count GET | `[UserInfo]`, or `{task_id, reused}` when `count` > 5000 | none |
| legacy `.../page` | `[UserInfo]` | `has_next_page`, `next_cursor` as TOP-LEVEL siblings of `data` |
| `.../task/{task_id}/status` and `/next` | untyped in the spec (`any`) | n/a |
| `/v3/...` | `{ users: [UserInfo], has_next_page, next_cursor }` (or null) | INSIDE `data` |

## UserInfo object

Resolved from component `UserInfo` (32 fields). The spec gives no sample values for it, so the example below uses `…`.

- Required: `userId` (string), `username`, `name`, `description`, `location`, `createdAt` (string, format not stated), `isBlueVerified` ("Blue verification status"), `verified` ("Legacy verification status"), `protected`, `possiblySensitive`, `defaultProfile`, `defaultProfileImage`, `hasCustomTimelines`, `isTranslator`, `profileImageUrlHttps`, and the integer counts `followersCount`, `followingCount`, `favouritesCount` ("Likes count"), `statusesCount` ("Tweets count"), `listedCount`, `mediaCount`, `fastFollowersCount`, `normalFollowersCount`.
- Optional / nullable: `createdAtDatetime` (ISO), `verified_type` ("Verification badge type: blue, business, government, etc."; **snake_case**, unlike the rest), `translatorType`, `url`, `urls[]`, `descriptionUrls[]`, `pinnedTweetIds[]`, `pinnedTweetIdsStr[]`, `withheldInCountries[]`.

```jsonc
{
  "userId": "…", "username": "…", "name": "…", "description": "…", "location": "…",
  "createdAt": "…", "createdAtDatetime": "…",
  "followersCount": …, "followingCount": …, "statusesCount": …, "favouritesCount": …, "listedCount": …, "mediaCount": …,
  "isBlueVerified": …, "verified": …, "verified_type": null,      // or "blue" / "business" / "government"
  "protected": false, "profileImageUrlHttps": "…"
  // …remaining fields as listed above
}
```

## Endpoints

### GET /twitter/latest-followers/{screen_name} — Get Latest Followers

The latest followers of a user. One request, one list; no count and no cursor.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | "The screen name of the user to get latest followers." Spec example `elonmusk` (bare handle) |

```bash
curl -sS "https://api.twexapi.io/twitter/latest-followers/elonmusk" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `LatestFollowersResponse`:
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": [ { /* UserInfo */ }, { /* UserInfo */ } ]      // required; items typed UserInfo or null
}
```
**Cost:** $0.05 per 1,000 followers (spec). How many users one call returns is not stated.

### GET /twitter/latest-following/{screen_name} — Get Latest Following

The latest accounts a user follows. One request, one list; no count and no cursor.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | "The screen name of the user to get latest following." Spec example `elonmusk` (bare handle) |

```bash
curl -sS "https://api.twexapi.io/twitter/latest-following/elonmusk" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `LatestFollowingsResponse`:
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": [ { /* UserInfo */ }, { /* UserInfo */ } ]      // required; items typed UserInfo or null
}
```
**Cost:** $0.05 per 1,000 following (spec). How many users one call returns is not stated.

### GET /twitter/followers/{screen_name}/{count} — Get Followers

`count` followers of a user. Up to 5000 come back inline; above that the call returns an async task handle instead of users (way c).

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | "The screen name of the user to get followers." Spec example `elonmusk` (bare handle) |
| `count` | path | integer | yes | "The number of followers to get." Spec example `200`. **`count` > 5000 returns a task handle, not users** |

```bash
# up to 5000: users inline
curl -sS "https://api.twexapi.io/twitter/followers/elonmusk/200" \
  -H "Authorization: Bearer $TWEXAPI_KEY"

# more than 5000: returns {task_id, reused} at once; continue with the task routes below
curl -sS "https://api.twexapi.io/twitter/followers/elonmusk/6000" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `GetFollowersResponse`; `data` is a list **or** a task handle:
```jsonc
// count <= 5000
{ "code": 200, "msg": "success", "data": [ { /* UserInfo */ } ] }

// count > 5000 (spec: "returns a task_id immediately (HTTP 202)")
{ "code": …, "msg": "…", "data": { "task_id": "…", "reused": false } }     // reused: true = "an in-flight task was reused"
```
**Cost:** $0.05 per 1,000 followers (spec). For a task, when the charge is applied (at start, or per drained page) is not stated.

### GET /twitter/following/{screen_name}/{count} — Get Following

`count` accounts a user follows. Up to 5000 come back inline; above that the call returns an async task handle instead of users (way c).

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | path | string | yes | "The screen name of the user to get following." Spec example `elonmusk` (bare handle) |
| `count` | path | integer | yes | "The number of following to get." Spec example `200`. **`count` > 5000 returns a task handle, not users** |

```bash
# up to 5000: users inline
curl -sS "https://api.twexapi.io/twitter/following/elonmusk/200" \
  -H "Authorization: Bearer $TWEXAPI_KEY"

# more than 5000: returns {task_id, reused} at once; continue with the following task routes below
curl -sS "https://api.twexapi.io/twitter/following/elonmusk/6000" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `GetFollowingResponse`; `data` is a list **or** a task handle:
```jsonc
// count <= 5000
{ "code": 200, "msg": "success", "data": [ { /* UserInfo */ } ] }

// count > 5000 (spec: "returns a task_id immediately (HTTP 202)")
{ "code": …, "msg": "…", "data": { "task_id": "…", "reused": false } }
```
**Cost:** $0.05 per 1,000 following (spec). For a task, when the charge is applied is not stated.

### POST /twitter/followers/page — Get Followers by Page

Cursor-paged followers, up to 200 per page. Send the previous `next_cursor` to continue.

**Params** (JSON body, `GetFollowersCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | body | string | yes | "Twitter screen name of the target user (with or without @)." Spec example `elonmusk` |
| `next_cursor` | body | string or null | no | "Cursor returned by the previous page. Leave empty to fetch the first page." Spec example `"1234567890"` |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/twitter/followers/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"screen_name":"elonmusk"}'

# next page: next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/twitter/followers/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"screen_name\":\"elonmusk\",\"next_cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `GetFollowersCursorResponse` ("Current page data (up to 200 followers) and pagination metadata (has_next_page, next_cursor)."):
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": [ { /* UserInfo */ } ],        // required, up to 200
  "has_next_page": true,                 // required
  "next_cursor": "1234567890"            // spec example value; nullable, send back as next_cursor
}
```
**Cost:** $0.05 per 1,000 followers (spec). A full 200-user page is about $0.01 (derived).

### POST /twitter/following/page — Get Following by Page

Cursor-paged following, up to 200 per page. Send the previous `next_cursor` to continue.

**Params** (JSON body, `GetFollowingCursorQuery`)

| name | in | type | req | note |
|---|---|---|---|---|
| `screen_name` | body | string | yes | "Twitter screen name of the target user (with or without @)." Spec example `elonmusk` |
| `next_cursor` | body | string or null | no | "Cursor returned by the previous page. Leave empty to fetch the first page." Spec example `"1234567890"` |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/twitter/following/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"screen_name":"elonmusk"}'

# next page: next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/twitter/following/page" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"screen_name\":\"elonmusk\",\"next_cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `GetFollowingCursorResponse` ("Current page data (up to 200 following users) and pagination metadata (has_next_page, next_cursor)."):
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": [ { /* UserInfo */ } ],        // required, up to 200
  "has_next_page": true,                 // required
  "next_cursor": "1234567890"            // spec example value; nullable
}
```
**Cost:** $0.05 per 1,000 following users (spec).

### GET /twitter/followers/task/{task_id}/status — Get Followers Task Status

Progress of a large followers pull started by `GET /twitter/followers/{screen_name}/{count}` with `count` > 5000.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | string | yes | "task_id returned when submitting a large followers request" |

```bash
curl -sS "https://api.twexapi.io/twitter/followers/task/$TASK_ID/status" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`:
```jsonc
{ "code": 200, "msg": "success", "data": … }     // `data` is untyped (any or null) in the spec
```
Spec description: "status: pending | running | done | error." Where `status` sits in the payload, and any progress counters, are **not specified**: print the first real response and adapt.
**Cost:** no price stated in the spec.

### GET /twitter/followers/task/{task_id}/next — Consume Next Page of Followers Task

Takes the next available page (~200 followers) off the task. **Each page is removed after it is returned.**

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | string | yes | "task_id returned when submitting a large followers request" |

```bash
curl -sS "https://api.twexapi.io/twitter/followers/task/$TASK_ID/next" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`:
```jsonc
{ "code": 200, "msg": "success", "data": … }     // untyped in the spec; by its description: one page of ~200 users, [] once all pages are consumed
```
Spec description: "Keep polling until status=done and data=[] (all pages consumed)."
**Cost:** no price stated in the spec.

### GET /twitter/following/task/{task_id}/status — Get Following Task Status

Progress of a large following pull started by `GET /twitter/following/{screen_name}/{count}` with `count` > 5000.

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | string | yes | "task_id returned when submitting a large following request" |

```bash
curl -sS "https://api.twexapi.io/twitter/following/task/$TASK_ID/status" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`:
```jsonc
{ "code": 200, "msg": "success", "data": … }     // untyped (any or null) in the spec
```
Spec description: "status: pending | running | done | error." Payload location of `status` is not specified.
**Cost:** no price stated in the spec.

### GET /twitter/following/task/{task_id}/next — Consume Next Page of Following Task

Takes the next available page (~200 following) off the task. **Each page is removed after it is returned.**

**Params**

| name | in | type | req | note |
|---|---|---|---|---|
| `task_id` | path | string | yes | "task_id returned when submitting a large following request" |

```bash
curl -sS "https://api.twexapi.io/twitter/following/task/$TASK_ID/next" \
  -H "Authorization: Bearer $TWEXAPI_KEY"
```

**Response** `200` — `StandardResponse`:
```jsonc
{ "code": 200, "msg": "success", "data": … }     // untyped in the spec; by its description: one page of ~200 users, [] once all pages are consumed
```
Spec description: "Keep polling until status=done and data=[] (all pages consumed)."
**Cost:** no price stated in the spec.

### POST /v3/twitter/users/following — Get Following (v3)

Cursor-paged following list with a caller-chosen page size (10-100).

**Params** (JSON body, `FollowersFollowingV3Query`; the same body for all three v3 routes)

| name | in | type | req | note |
|---|---|---|---|---|
| `username` | body | string | yes | "Twitter username (with or without @)." Spec example `elonmusk` |
| `count` | body | integer 10-100, or null | no | "Number of users to return per page (min 10, max 100)." Default `20` |
| `cursor` | body | string or null | no | "Cursor from previous next_cursor to fetch the next page." Omit for page 1 |

Spec cursor example: `1870681402093130182|2076960004551737340` (opaque; it contains a `|`).

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/v3/twitter/users/following" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"elonmusk","count":50}'

# next page: data.next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/v3/twitter/users/following" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"elonmusk\",\"count\":50,\"cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `VerifiedFollowersResponse` (the spec reuses this one schema, "Response for followers / verified followers", for all three v3 routes):
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": {                                    // may be null
    "users": [ { /* UserInfo */ } ],           // required
    "has_next_page": true,                     // required
    "next_cursor": "1870681402093130182|2076960004551737340"     // spec example; nullable
  }
}
```
**Cost:** $0.05 per 1,000 users (spec).

### POST /v3/twitter/users/followers — Get Followers (v3)

Cursor-paged followers list with a caller-chosen page size (10-100). Same body and response as the v3 following route.

**Params** (JSON body, `FollowersFollowingV3Query`)

| name | in | type | req | note |
|---|---|---|---|---|
| `username` | body | string | yes | "Twitter username (with or without @)." Spec example `elonmusk` |
| `count` | body | integer 10-100, or null | no | "Number of users to return per page (min 10, max 100)." Default `20` |
| `cursor` | body | string or null | no | "Cursor from previous next_cursor to fetch the next page." Omit for page 1 |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/v3/twitter/users/followers" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"elonmusk","count":100}'

# next page: data.next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/v3/twitter/users/followers" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"elonmusk\",\"count\":100,\"cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `VerifiedFollowersResponse`:
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": {                                    // may be null
    "users": [ { /* UserInfo */ } ],           // required
    "has_next_page": true,                     // required
    "next_cursor": "1870681402093130182|2076960004551737340"     // spec example; nullable
  }
}
```
**Cost:** $0.05 per 1,000 users (spec).

### POST /v3/twitter/users/verified-followers — Get Verified Followers

Cursor-paged **blue-verified** followers of a user, page size 10-100. No legacy equivalent.

**Params** (JSON body, `FollowersFollowingV3Query`)

| name | in | type | req | note |
|---|---|---|---|---|
| `username` | body | string | yes | "Twitter username (with or without @)." Spec example `elonmusk` |
| `count` | body | integer 10-100, or null | no | "Number of users to return per page (min 10, max 100)." Default `20` |
| `cursor` | body | string or null | no | "Cursor from previous next_cursor to fetch the next page." Omit for page 1 |

```bash
# page 1
curl -sS -X POST "https://api.twexapi.io/v3/twitter/users/verified-followers" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"elonmusk","count":100}'

# next page: data.next_cursor from the previous response
curl -sS -X POST "https://api.twexapi.io/v3/twitter/users/verified-followers" \
  -H "Authorization: Bearer $TWEXAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"elonmusk\",\"count\":100,\"cursor\":\"$NEXT_CURSOR\"}"
```

**Response** `200` — `VerifiedFollowersResponse` ("Verified followers page with cursor pagination"):
```jsonc
{
  "code": 200,
  "msg": "success",
  "data": {                                    // may be null
    "users": [ { /* UserInfo, isBlueVerified true */ } ],     // required
    "has_next_page": true,                     // required
    "next_cursor": "1870681402093130182|2076960004551737340"     // spec example; nullable
  }
}
```
**Cost:** $0.05 per 1,000 users (spec). Whether the charge counts users returned or scanned is not stated.

## Loops (sketches)

One sketch for all three loops, standard library only. The task loop depends on payload shapes the spec leaves untyped; the lines marked `(?)` are assumptions, check them against the first real responses.

```python
import json, os, time, urllib.request

BASE, KEY = "https://api.twexapi.io", os.environ["TWEXAPI_KEY"]

def call(path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        method="GET" if body is None else "POST",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

# --- (b) legacy cursor pages: paging fields are siblings of `data` -----------------------------
def legacy_pages(kind, handle):                          # kind: "followers" | "following"
    cursor = None
    while True:
        body = {"screen_name": handle}
        if cursor:
            body["next_cursor"] = cursor
        r = call(f"/twitter/{kind}/page", body)
        yield from (u for u in r["data"] if u)           # items may be null
        if not r["has_next_page"]:
            return
        cursor = r["next_cursor"]

# --- v3 cursor pages: paging fields are INSIDE `data` -------------------------------------------
def v3_pages(route, handle, count=100):                  # route: "followers" | "following" | "verified-followers"
    cursor = None
    while True:
        body = {"username": handle, "count": count}
        if cursor:
            body["cursor"] = cursor
        d = call(f"/v3/twitter/users/{route}", body)["data"] or {}
        yield from d.get("users", [])
        if not d.get("has_next_page"):
            return
        cursor = d["next_cursor"]

# --- (c) async task: count > 5000 -------------------------------------------------------------
def task_pull(kind, handle, count, outfile):             # kind: "followers" | "following"
    data = call(f"/twitter/{kind}/{handle}/{count}")["data"]
    if isinstance(data, list):                           # small request: users came back inline
        return [u for u in data if u]
    task_id, n = data["task_id"], 0
    with open(outfile, "a") as out:                      # pages are deleted server-side once returned: persist at once
        while True:
            st = call(f"/twitter/{kind}/task/{task_id}/status")["data"]
            state = st.get("status") if isinstance(st, dict) else st      # (?) where `status` sits is not in the spec
            page = call(f"/twitter/{kind}/task/{task_id}/next")["data"]   # (?) assumed: a plain array of ~200 UserInfo
            if page:
                for u in page:
                    if u:
                        out.write(json.dumps(u) + "\n"); n += 1
                out.flush()
                continue
            if state == "done":                          # status read BEFORE `next`, so an empty `next` really means drained
                return n
            if state == "error":
                raise RuntimeError(f"task {task_id} failed after {n} users")
            time.sleep(3)                                # poll interval is not specified; 3 s is arbitrary
```

## Gotchas

- **Four `data` shapes, one envelope.** Quick GET: `data` is the list (or a task handle). Legacy `/page`: `data` is the list and `has_next_page` / `next_cursor` sit next to it. v3: `data` is an object and the paging fields are inside it. Task `status` / `next`: untyped. Do not reuse one parser across families.
- **The by-count GET can return a task instead of users.** With `count` > 5000, `data` is `{task_id, reused}`, not a list. The spec describes it as HTTP 202 but declares only `200` / `422`, so branch on the shape of `data` (list vs object with `task_id`), not on the status code alone. The body `code` value in that case is not shown in the spec.
- **No separate "start task" route**, and followers / following tasks are separate: use `/twitter/followers/task/...` for a followers `task_id`, `/twitter/following/task/...` for a following one.
- **`next` is destructive.** "Each page is removed after being returned." Write every page to disk the moment you get it, before asking for the next one; a page you drop (crash, parse error, timeout after the server answered) cannot be fetched again (inferred from that sentence).
- **When to stop the task loop.** The spec's rule: "Keep polling until status=done and data=[]". An empty `next` while the task is still `pending` / `running` most likely just means no page is ready yet (inferred), so only stop when `status` is `done` and `next` is empty. `error` is terminal; what happens to pages not yet drained is not stated.
- **`reused: true`** means the call attached you to an already in-flight task ("an in-flight task was reused"). It may already be partly drained by an earlier consumer; what it matches on (same handle and count?) is not stated.
- **Items can be `null`.** `data` is typed `UserInfo or null` per item on the quick and legacy routes. Skip nulls.
- **Cursors are opaque strings.** Pass them back verbatim in the right field (legacy `next_cursor`, v3 `cursor`); the spec's v3 example cursor contains a `|`, which is fine inside a JSON string. Omit the field (or send null) for page 1. When `has_next_page` is false, `next_cursor` can be null.
- **Handles.** Path routes take the bare handle (spec example `elonmusk`, no `@`). The body routes say "with or without @".
- **`latest-*` has no paging.** It cannot go beyond the newest batch; use `/page` or v3 when you need more than that.
- **Field naming.** `UserInfo` is camelCase (`userId`, `username`, `followersCount`, `profileImageUrlHttps`, `isBlueVerified`) with one snake_case outlier `verified_type`. `communities-lists.md` returns `UserModel` (`id`, `screen_name`, `followers_count`, `is_blue_verified`), a different object. `verified` here means legacy verification only; `isBlueVerified` is the blue check.
- **Big payloads.** Each user has about 32 fields, so a few thousand users is a very large JSON body. Save to a file (`curl -o`) and extract only the fields you need (for example `username`, `followersCount`, `isBlueVerified`) instead of printing it.
- **Money.** All user-returning routes: $0.05 per 1,000 users, so about $0.01 per full 200-user page, $0.25 for 5,000 users, $5 for 100,000 (derived). Decide the budget before starting a task pull. The spec does not say whether billing counts users returned or requested, whether failed or empty calls are charged, or whether `status` / `next` polling costs anything.
- **Validation errors** are `422` with `{ "detail": [ { "loc", "msg", "type" } ] }`: a missing required body field, or a `count` outside 10-100 on the v3 routes, is the kind of request that ends up there. That is the only error shape the spec documents.

Unverified / not resolvable from the spec: the shape of `data` on the task `status` and `next` routes (typed `any`; the spec only says `status: pending | running | done | error` and that `next` returns ~200 users per page and `[]` when all pages are consumed); where `status` sits in the payload; the poll interval; task lifetime and what an `error` leaves behind; what `reused` matches on; how many users `latest-*` returns; any max for `count` on the by-count routes; whether billing counts users returned or requested and when it is applied for tasks; the `code` value in the body for the HTTP 202 task case; the format of `createdAt`; whether a `verified-followers` page always holds `count` users after filtering; behaviour for 401 / 402 / 429 (only `200` and `422` are declared). The curl examples and loops were derived from the spec and were not run against the live API.
