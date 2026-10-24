# Desearch: TikTok, Facebook, Instagram

Key + base URL + auth: see social/desearch/_index.yaml. Base https://api.desearch.ai, header `Authorization: $DESEARCH_KEY`.

19 endpoints in three platform blocks that share a parallel shape: **search / post-by-id / profile / profile-posts / comments / hashtag** (+ **trending**, TikTok only). Learn one block and the others follow. Public data only: no login, posting, messaging, private surfaces or download/no-watermark media. For X/Twitter see `x.md`; for people-finding see `people.md`.

Route map (all GET except `search`; paths are relative to `/desearch/<platform>`):

| platform | search (POST) | post | profile | profile posts | comments | hashtag | trending |
|---|---|---|---|---|---|---|---|
| `tiktok` | `/search` | `/post/{id}` | `/profile/{username}` | `/profile/{username}/posts` | `/comments/{video_id}` | `/hashtag/{tag}` | `/trending` |
| `facebook` | `/search` (Ad Library) | `/post/{id}` | `/profile/{profile_id}` | `/profile/{profile_id}/posts` | `/comments/{post_id}` | `/hashtag/{tag}` (Ad Library) | none |
| `instagram` | `/search` (profiles) | `/media/{id}` | `/profile/{username}` | `/profile/{username}/posts` | `/comments/{shortcode}` | `/hashtag/{tag}` | none |

## Rules for every endpoint in this file

- **Transport**: GET takes query params; POST takes a JSON body with `Content-Type: application/json`. Responses are `application/json`.
- **Lists are bare JSON arrays** (search, profile posts, comments, hashtag, trending): no `{data: [...]}` envelope. Single-item routes (post, profile, media) return one object.
- **The paging cursor is a response HEADER, not part of the body.** When another page exists the response carries `x-desearch-next-cursor`; send that value back unchanged as `cursor` (query param on GET, body field on POST) to the same route with the same target (same username, tag, post or search query). The header is absent on the last page. A cursor is valid for 24 hours; a wrong, foreign or expired one returns 422 and is not charged. Read headers with `curl -D -` (recipe below).
- **`count`** is a ceiling, 1-100 (default 20 on GET lists, 10 on POST search). The spec says "the provider page may be smaller", so a short page is normal; only a missing `x-desearch-next-cursor` means the end.
- **Path values are bare**: username without `@`, hashtag without `#`. Keep every id as a string (TikTok ids exceed 2^53).
- **Everything in a response is optional/nullable**; fields the provider does not send are omitted. Read defensively.
- **Cost**: the spec states NO per-endpoint price, only "current prices are at https://desearch.ai/pricing" (that page, checked 2026-10-25, lists no rate for these endpoints). Billable successful calls return the real charge in headers `X-Desearch-Cost-Usd`, `X-Desearch-Usage-Count`, `X-Desearch-Service`, `X-Desearch-Currency`; object (non-array) responses may also carry body fields `cost_usd`, `usage_count`, `service`, `currency`; array responses carry cost in the headers only. It bills the user's own Desearch account.
- **Errors** (same everywhere):

| code | body | meaning |
|---|---|---|
| 400 | `{"detail":"Invalid JSON body"}` | POST search routes: malformed JSON |
| 401 | `{"detail":"Invalid API key"}` | missing or invalid `Authorization` key |
| 404 | `{"detail":"Resource not found"}` shape | documented for Instagram comments (unknown shortcode) |
| 422 | `{"detail":[{"loc":[..],"msg":"..","type":".."}]}` or `{"detail":"Invalid request parameters"}` | validation error, or a bad/expired/foreign cursor (not charged) |
| 429 | `{"detail":{"error_code":429,"message":"Too Many Requests","retry_after":"60 seconds"}}` | rate limited; back off |
| 500 | `{"detail":{"error_code":500,"message":"Internal Server Error","description":"An unexpected error occurred on the server."}}` | server error |

Paging recipe (GET routes):

```bash
# page 1: body -> page1.json, response headers -> stdout, pull the cursor out of them
NEXT=$(curl -s -D - -o page1.json "https://api.desearch.ai/desearch/tiktok/hashtag/bittensor?count=50" \
  -H "Authorization: $DESEARCH_KEY" | grep -i '^x-desearch-next-cursor:' | sed 's/^[^:]*: *//' | tr -d '\r')
# page 2: same route + same tag; the cursor is opaque, so let curl URL-encode it
[ -n "$NEXT" ] && curl -s -G "https://api.desearch.ai/desearch/tiktok/hashtag/bittensor" \
  --data-urlencode "count=50" --data-urlencode "cursor=$NEXT" -H "Authorization: $DESEARCH_KEY"
```
POST search routes (TikTok, Facebook): same idea, read the header the same way and put `"cursor":"<value>"` in the JSON body.

Response samples below reproduce the spec's illustrative field values (they will not match the literal id in the curl line); `{...}` placeholders in a path are replaced by the realistic value in the curl.

---

## TikTok

Shared objects (every field optional/nullable unless noted):

```
TikTokPost     id (canonical video id; feed it to /comments/{video_id}) · providerId (opaque upstream id) · url · text (caption)
               createTime (ISO 8601) · author · stats · music · hashtags[] (empty when none) · mentions[] (always present, empty when none)
               videoDuration · videoWidth · videoHeight (ints) · thumbnailUrl · mediaUrl
TikTokAuthor   id · username · nickname · avatar · verified (bool) · following · followers · heart (ints)
TikTokStats    playCount · digCount · commentCount · shareCount · collectCount (ints)
TikTokMusic    id · title · authorName      (omitted when the provider has none; never present on hashtag/trending posts)
TikTokProfile  id · username · nickname · avatar · verified · following · followers · heart · bio · videoCount · digCount
TikTokComment  id (provider cid; omitted when absent) · videoId · text · createTime · author (TikTokAuthor) · likes · replies[] (untyped objects)
```

### POST /desearch/tiktok/search — Search TikTok posts by keyword

Keyword search over public TikTok posts. Each post `id` is the canonical video id (pass it to `/desearch/tiktok/comments/{video_id}`); opaque upstream ids appear as `providerId`.

| param | in | type | req | note |
|---|---|---|---|---|
| `query` | body | string | yes | keyword or phrase, e.g. `bittensor` |
| `count` | body | int 1-100 | no | default 10 |
| `cursor` | body | string | no | previous page's `x-desearch-next-cursor` (same query); omit for page 1 |
| `sort` | body | string | no | "sort option when supported"; accepted values are not listed in the spec |

```bash
curl -s -X POST https://api.desearch.ai/desearch/tiktok/search \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -d '{"query":"bittensor","count":20}'
```

Response `200`: `TikTokPost[]` + header `x-desearch-next-cursor` when more exist.

```json
[
  {
    "id": "7620891413932166433",
    "url": "https://www.tiktok.com/@tiktok/video/7620891413932166433",
    "text": "caption text",
    "createTime": "2024-01-15T10:30:00Z",
    "author": { "id": "12345", "username": "desearch", "nickname": "Desearch", "verified": true, "followers": 50000 },
    "stats": { "playCount": 120000, "digCount": 5000, "commentCount": 120, "shareCount": 45, "collectCount": 10 },
    "hashtags": [], "mentions": []
  }
]
```

### GET /desearch/tiktok/post/{id} — One TikTok post by ID

Normalized metadata for one public post. No no-watermark/download media URLs are exposed.

| param | in | type | req | note |
|---|---|---|---|---|
| `id` | path | string | yes | TikTok video/post id, e.g. `7620891413932166433` |

```bash
# {id} = 7620891413932166433
curl -s "https://api.desearch.ai/desearch/tiktok/post/7620891413932166433" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: one `TikTokPost` object (no cursor header).

```json
{
  "id": "7620891413932166433",
  "text": "caption text",
  "createTime": "2024-01-15T10:30:00Z",
  "author": { "username": "desearch", "followers": 50000, "heart": 300000 },
  "stats": { "playCount": 120000, "digCount": 5000, "commentCount": 120, "shareCount": 45, "collectCount": 10 },
  "music": { "id": "67890", "title": "Song Name", "authorName": "Artist" },
  "videoDuration": 15000, "videoWidth": 1080, "videoHeight": 1920,
  "thumbnailUrl": "https://example.com/thumb.jpg", "mediaUrl": "https://example.com/video.mp4"
}
```

### GET /desearch/tiktok/profile/{username} — TikTok profile

Normalized public profile metadata by username.

| param | in | type | req | note |
|---|---|---|---|---|
| `username` | path | string | yes | without `@`, e.g. `tiktok` |

```bash
# {username} = tiktok
curl -s "https://api.desearch.ai/desearch/tiktok/profile/tiktok" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: one `TikTokProfile` object.

```json
{
  "id": "12345", "username": "desearch", "nickname": "Desearch", "avatar": "https://example.com/avatar.jpg",
  "verified": true, "following": 1200, "followers": 50000, "heart": 300000,
  "bio": "bio text", "videoCount": 250, "digCount": 450000
}
```

### GET /desearch/tiktok/profile/{username}/posts — A user's TikTok posts

Public posts of a TikTok username (paged).

| param | in | type | req | note |
|---|---|---|---|---|
| `username` | path | string | yes | without `@` |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same username) |

```bash
# {username} = tiktok
curl -s "https://api.desearch.ai/desearch/tiktok/profile/tiktok/posts?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `TikTokPost[]` + header `x-desearch-next-cursor` when more exist.

```json
[ { "id": "7620891413932166433", "text": "caption text", "createTime": "2024-01-15T10:30:00Z",
    "stats": { "playCount": 120000, "digCount": 5000 }, "hashtags": [], "mentions": [] } ]
```

### GET /desearch/tiktok/comments/{video_id} — Comments on a TikTok video

Public comments for a video (paged). Take `video_id` from a post's `id`.

| param | in | type | req | note |
|---|---|---|---|---|
| `video_id` | path | string | yes | TikTok video/post id, e.g. `7620891413932166433` |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same video) |

```bash
# {video_id} = 7620891413932166433
curl -s "https://api.desearch.ai/desearch/tiktok/comments/7620891413932166433?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `TikTokComment[]` + header `x-desearch-next-cursor` when more exist.

```json
[
  {
    "id": "7620891413932166433", "videoId": "7620891413932166433",
    "text": "comment text", "createTime": "2024-01-15T11:00:00Z",
    "author": { "username": "desearch", "nickname": "Desearch" },
    "likes": 42, "replies": []
  }
]
```

### GET /desearch/tiktok/hashtag/{tag} — Posts under a TikTok hashtag

Public posts for a hashtag (paged). These posts carry no `music`, and their `mentions` only lists @handles found in the caption.

| param | in | type | req | note |
|---|---|---|---|---|
| `tag` | path | string | yes | hashtag without `#`, e.g. `bittensor` |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same tag) |

```bash
# {tag} = bittensor
curl -s "https://api.desearch.ai/desearch/tiktok/hashtag/bittensor?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `TikTokPost[]` + header `x-desearch-next-cursor` when more exist.

```json
[ { "id": "7620891413932166433", "url": "https://www.tiktok.com/@tiktok/video/7620891413932166433",
    "text": "caption text", "author": { "username": "desearch" },
    "stats": { "playCount": 120000, "digCount": 5000 }, "hashtags": [], "mentions": [] } ]
```

### GET /desearch/tiktok/trending — Trending TikTok posts

Trending posts for a region, "where supported by the public TikTok integration". Not paged: there is no `cursor` and no cursor header.

| param | in | type | req | note |
|---|---|---|---|---|
| `region` | query | string, exactly 2 chars | no | two-letter region code, default `US`; which regions are supported is not listed in the spec |
| `count` | query | int 1-100 | no | default 20 |

```bash
curl -s "https://api.desearch.ai/desearch/tiktok/trending?region=US&count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `TikTokPost[]` (same shape as hashtag posts: no `music`).

```json
[ { "id": "7620891413932166433", "text": "caption text", "author": { "username": "desearch" },
    "stats": { "playCount": 120000, "digCount": 5000 }, "hashtags": [], "mentions": [] } ]
```

---

## Facebook

**Important**: `search` and `hashtag` query the **Meta Ad Library** (ads), not organic Facebook posts. The spec says organic keyword/hashtag search, Facebook trending, private surfaces, messaging and publishing are intentionally not exposed. To read a known page's or profile's own public posts use `profile/{profile_id}/posts`.

Shared objects (every field optional/nullable):

```
FacebookPost      id · url · text · createTime (ISO 8601) · author (FacebookProfile) · stats · media[] · hashtags[]
                  Ad Library extras (search/hashtag records): linkUrl (ad landing URL; `url` stays the Ad Library or post URL)
                  · cta (button text, or the CTA type such as SHOP_NOW) · headline · linkDescription
                  · endDate (provider date string, or ISO 8601 UTC; omitted if none) · active (bool, omitted if unknown)
                  · platforms[] (publisher platforms such as FACEBOOK or INSTAGRAM; empty if none)
FacebookPostStats reactionCount · commentCount · shareCount · viewCount (ints)
FacebookMedia     type (e.g. photo) · url · thumbnail · width · height
FacebookProfile   id · username · name · url · avatar · verified · bio · category · followers · likes
FacebookComment   id · postId · text · createTime · author (FacebookProfile) · likes · replies[] (untyped objects)
```

### POST /desearch/facebook/search — Search Meta Ad Library records

Keyword search over public Meta Ad Library records (ads). Not organic post search.

| param | in | type | req | note |
|---|---|---|---|---|
| `query` | body | string | yes | Ad Library keyword, phrase or hashtag, e.g. `running` |
| `count` | body | int 1-100 | no | default 10 |
| `cursor` | body | string | no | previous page's `x-desearch-next-cursor` (same query); omit for page 1 |

```bash
curl -s -X POST https://api.desearch.ai/desearch/facebook/search \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -d '{"query":"running","count":10}'
```

Response `200`: `FacebookPost[]` (ad records) + header `x-desearch-next-cursor` when more exist.

```json
[
  {
    "id": "1525856912919657",
    "url": "https://www.facebook.com/facebook/posts/1525856912919657",
    "text": "Post text",
    "createTime": "2026-05-01T10:00:00Z",
    "author": { "id": "123456789", "username": "facebook", "name": "Desearch AI", "verified": true },
    "media": [ { "type": "photo", "url": "https://example.com/photo.jpg", "width": 1200, "height": 630 } ],
    "hashtags": [],
    "linkUrl": "<ad landing url>", "cta": "<button text or type, e.g. SHOP_NOW>", "headline": "<ad headline>",
    "linkDescription": "<ad link description>", "endDate": "<date string>", "active": true, "platforms": ["FACEBOOK"]
  }
]
```

### GET /desearch/facebook/post/{id} — One Facebook post by ID

Normalized metadata for one public post/media item.

| param | in | type | req | note |
|---|---|---|---|---|
| `id` | path | string | yes | Facebook public post/media id, e.g. `1525856912919657` |

```bash
# {id} = 1525856912919657
curl -s "https://api.desearch.ai/desearch/facebook/post/1525856912919657" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: one `FacebookPost` object.

```json
{
  "id": "1525856912919657", "url": "https://www.facebook.com/facebook/posts/1525856912919657",
  "text": "Post text", "createTime": "2026-05-01T10:00:00Z",
  "author": { "username": "facebook", "name": "Desearch AI", "followers": 50000 },
  "stats": { "reactionCount": 1200, "commentCount": 80, "shareCount": 24, "viewCount": 10000 }
}
```

### GET /desearch/facebook/profile/{profile_id} — Facebook profile or page

Public profile/page metadata by username, vanity handle or public id.

| param | in | type | req | note |
|---|---|---|---|---|
| `profile_id` | path | string | yes | profile/page id or public handle, e.g. `facebook` |

```bash
# {profile_id} = facebook
curl -s "https://api.desearch.ai/desearch/facebook/profile/facebook" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: one `FacebookProfile` object.

```json
{
  "id": "123456789", "username": "facebook", "name": "Desearch AI", "url": "https://www.facebook.com/facebook",
  "avatar": "https://example.com/avatar.jpg", "verified": true, "bio": "Public search API",
  "category": "Software", "followers": 50000, "likes": 12000
}
```

### GET /desearch/facebook/profile/{profile_id}/posts — A profile/page's posts

Public posts of a profile or page (paged).

| param | in | type | req | note |
|---|---|---|---|---|
| `profile_id` | path | string | yes | profile/page id or public handle |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same profile) |

```bash
# {profile_id} = facebook
curl -s "https://api.desearch.ai/desearch/facebook/profile/facebook/posts?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `FacebookPost[]` + header `x-desearch-next-cursor` when more exist.

```json
[ { "id": "1525856912919657", "url": "https://www.facebook.com/facebook/posts/1525856912919657",
    "text": "Post text", "createTime": "2026-05-01T10:00:00Z",
    "stats": { "reactionCount": 1200, "commentCount": 80, "shareCount": 24 } } ]
```

### GET /desearch/facebook/comments/{post_id} — Comments on a Facebook post

Public comments of a post/media item (paged). Upstream returns only about 10 comments per page regardless of `count`; use the cursor to get more.

| param | in | type | req | note |
|---|---|---|---|---|
| `post_id` | path | string | yes | Facebook public post/media id |
| `count` | query | int 1-100 | no | default 20, but ~10 per page in practice (see above) |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same post) |

```bash
# {post_id} = 1525856912919657
curl -s "https://api.desearch.ai/desearch/facebook/comments/1525856912919657?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `FacebookComment[]` + header `x-desearch-next-cursor` when more exist.

```json
[
  {
    "id": "comment-123", "postId": "1525856912919657",
    "text": "Comment text", "createTime": "2026-05-01T10:30:00Z",
    "author": { "id": "123456789", "name": "Desearch AI" },
    "likes": 42, "replies": []
  }
]
```

### GET /desearch/facebook/hashtag/{tag} — Ad Library records for a keyword/hashtag

Public Meta Ad Library records for a keyword/hashtag (paged). Not organic hashtag posts; organic hashtag search and trending are not exposed.

| param | in | type | req | note |
|---|---|---|---|---|
| `tag` | path | string | yes | hashtag/keyword without `#`, e.g. `bittensor` |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same tag) |

```bash
# {tag} = bittensor
curl -s "https://api.desearch.ai/desearch/facebook/hashtag/bittensor?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `FacebookPost[]` (ad records, same shape as `search`) + header `x-desearch-next-cursor` when more exist.

```json
[ { "id": "1525856912919657", "text": "Post text", "headline": "<ad headline>", "cta": "<CTA>",
    "linkUrl": "<ad landing url>", "active": true, "platforms": ["FACEBOOK"] } ]
```

---

## Instagram

Shared objects (every field optional/nullable unless noted):

```
InstagramSearchResult type ("profile" | "hashtag" | "media"; always present) · id · username · title · url · avatar
                      · followers (exact count when enrichment has one, else omitted) · mediaCount (documented as "not returned")
InstagramProfile      id · username · fullName · biography · avatar · verified · private · followers (exact, when the provider includes one)
                      · following · postsCount (exact total only when the payload proves one) · externalUrl · category
InstagramMedia        id · shortcode · url · caption · createTime (ISO 8601) · mediaType (e.g. image) · mediaUrl · thumbnailUrl
                      · author (InstagramProfile) · stats · hashtags[] · mentions[] · children[] (untyped objects)
InstagramStats        likeCount · commentCount · viewCount · playCount (ints)
InstagramComment      id · mediaId · text · createTime · author (InstagramProfile) · likes · replies[] (untyped objects)
```

### POST /desearch/instagram/search — Search Instagram profiles by keyword

Keyword/username search returning public profile-style rows. **One page only**: there is no paging. Hashtag/media discovery is `/desearch/instagram/hashtag/{tag}`.

| param | in | type | req | note |
|---|---|---|---|---|
| `query` | body | string | yes | keyword, username or phrase, e.g. `desearch` |
| `count` | body | int 1-100 | no | default 10 |
| `cursor` | body | string | no | NOT supported: any non-empty value returns 422 (not charged) |

```bash
curl -s -X POST https://api.desearch.ai/desearch/instagram/search \
  -H "Authorization: $DESEARCH_KEY" -H "Content-Type: application/json" \
  -d '{"query":"desearch","count":10}'
```

Response `200`: `InstagramSearchResult[]` (no cursor header).

```json
[
  {
    "id": "12345", "type": "profile", "username": "instagram", "title": "Desearch",
    "url": "https://www.instagram.com/instagram/", "avatar": "https://example.com/avatar.jpg", "followers": 50000
  }
]
```

### GET /desearch/instagram/media/{id} — One Instagram post by shortcode, ID or URL

Normalized metadata for one public post/media item.

| param | in | type | req | note |
|---|---|---|---|---|
| `id` | path | string | yes | media shortcode, numeric id, or public URL; prefer the shortcode (a full URL would have to be percent-encoded; untested) |

```bash
# {id} = DY79rTVS6OK
curl -s "https://api.desearch.ai/desearch/instagram/media/DY79rTVS6OK" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: one `InstagramMedia` object.

```json
{
  "id": "3234567890123456789", "shortcode": "DY79rTVS6OK", "url": "https://www.instagram.com/p/DY79rTVS6OK/",
  "caption": "caption text", "createTime": "2024-01-15T10:30:00Z", "mediaType": "image",
  "mediaUrl": "https://example.com/media.jpg", "thumbnailUrl": "https://example.com/thumb.jpg",
  "author": { "username": "instagram", "fullName": "Desearch", "followers": 50000, "verified": true },
  "stats": { "likeCount": 5000, "commentCount": 120, "viewCount": 120000, "playCount": 120000 },
  "hashtags": [], "mentions": [], "children": []
}
```

### GET /desearch/instagram/profile/{username} — Instagram profile

Normalized public profile metadata by username.

| param | in | type | req | note |
|---|---|---|---|---|
| `username` | path | string | yes | without `@`, e.g. `instagram` |

```bash
# {username} = instagram
curl -s "https://api.desearch.ai/desearch/instagram/profile/instagram" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: one `InstagramProfile` object.

```json
{
  "id": "12345", "username": "instagram", "fullName": "Desearch", "biography": "Search AI",
  "avatar": "https://example.com/avatar.jpg", "verified": true, "private": false,
  "followers": 50000, "following": 1200, "postsCount": 250, "externalUrl": "https://desearch.ai", "category": "Software"
}
```

### GET /desearch/instagram/profile/{username}/posts — A user's Instagram posts

Public posts of an Instagram username (paged).

| param | in | type | req | note |
|---|---|---|---|---|
| `username` | path | string | yes | without `@` |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same username) |

```bash
# {username} = instagram
curl -s "https://api.desearch.ai/desearch/instagram/profile/instagram/posts?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `InstagramMedia[]` + header `x-desearch-next-cursor` when more exist.

```json
[ { "id": "3234567890123456789", "shortcode": "DY79rTVS6OK", "url": "https://www.instagram.com/p/DY79rTVS6OK/",
    "caption": "caption text", "mediaType": "image", "stats": { "likeCount": 5000, "commentCount": 120 } } ]
```

### GET /desearch/instagram/comments/{shortcode} — Comments on an Instagram post

Public comments of a post identified by its **shortcode** (paged).

| param | in | type | req | note |
|---|---|---|---|---|
| `shortcode` | path | string | yes | the code in the post URL, e.g. `DY79rTVS6OK` in `instagram.com/p/DY79rTVS6OK/`; numeric media ids and composite post ids are NOT accepted and return 404 |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same post) |

```bash
# {shortcode} = DY79rTVS6OK
curl -s "https://api.desearch.ai/desearch/instagram/comments/DY79rTVS6OK?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `InstagramComment[]` + header `x-desearch-next-cursor` when more exist. `404` `{"detail":"..."}` when no post matches the shortcode.

```json
[
  {
    "id": "1789123456789", "mediaId": "DY79rTVS6OK",
    "text": "comment text", "createTime": "2024-01-15T11:00:00Z",
    "author": { "username": "instagram", "fullName": "Desearch" },
    "likes": 42, "replies": []
  }
]
```

### GET /desearch/instagram/hashtag/{tag} — Instagram media under a hashtag

Public media for a hashtag (paged). Instagram trending is not exposed.

| param | in | type | req | note |
|---|---|---|---|---|
| `tag` | path | string | yes | hashtag without `#`, e.g. `bittensor` |
| `count` | query | int 1-100 | no | default 20 |
| `cursor` | query | string | no | previous page's `x-desearch-next-cursor` (same tag) |

```bash
# {tag} = bittensor
curl -s "https://api.desearch.ai/desearch/instagram/hashtag/bittensor?count=20" \
  -H "Authorization: $DESEARCH_KEY"
```

Response `200`: `InstagramMedia[]` + header `x-desearch-next-cursor` when more exist.

```json
[ { "id": "3234567890123456789", "shortcode": "DY79rTVS6OK", "url": "https://www.instagram.com/p/DY79rTVS6OK/",
    "caption": "caption text", "author": { "username": "instagram" }, "hashtags": [], "mentions": [] } ]
```

---

## Gotchas

- **Cursor is in a header, the body is a bare array.** A client that only parses the body can never page. Use `curl -D -` (or `-i`). The cursor is bound to route + target + 24 h; reusing it elsewhere is a free 422. Do not mix cursors across tags, users, posts or queries.
- **`count` is a ceiling, not a promise.** Short pages happen; keep paging until `x-desearch-next-cursor` disappears.
- **Facebook search and hashtag are Meta Ad Library lookups**, so rows are ads (`cta`, `headline`, `linkUrl`, `active`, `platforms`), not people talking. There is no organic Facebook keyword/hashtag search and no Facebook trending.
- **Facebook comments** come back at ~10 per page whatever `count` says; page with the cursor.
- **Instagram search is single-page** (any non-empty `cursor` is a free 422) and returns profile-style rows; for hashtag/media discovery call the hashtag route. Neither Instagram nor Facebook has a trending route; TikTok does.
- **Instagram comments need the shortcode.** The media route is lenient (shortcode, numeric id or URL) but comments return 404 for numeric or composite ids. Get the shortcode from `media`, `profile/.../posts` or `hashtag` rows.
- **TikTok `id` is the canonical video id** and the input for `/comments/{video_id}`. Hashtag and trending posts have no `music`, and their `mentions` is derived from caption @handles only.
- **TikTok trending** takes only `region` + `count` (no cursor); region support is "where supported" with no list in the spec.
- **IDs are strings.** Never round-trip them through a JSON number or a spreadsheet.
- **Everything is nullable**: `author`, `stats`, counts, URLs. Check before using, and do not treat `null` follower counts as zero.
- **Rate limit (429)**: back off by the `retry_after` hint (the spec example says `"60 seconds"`); the actual limits are not stated.
- **Cost**: read `X-Desearch-Cost-Usd` / `X-Desearch-Usage-Count` after a call; there is no price table in the spec. Calls rejected for an invalid cursor are not charged.

Unverified / not resolvable from the spec: accepted values for TikTok `sort`; the unit of `videoDuration` (the spec example 15000 hints at milliseconds); the list of supported trending regions; whether a URL percent-encoded into Instagram `media/{id}` actually routes; the exact rate limits; and the unspecified plain-object alternative the spec allows next to each array 200 (always treat the body as an array on list routes, but check `Array.isArray`). The curl examples were derived from the spec and were not run against the live API.
