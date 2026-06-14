# Recipe Carousel Publishers (sub-project 3/5) — Design

**Status:** approved (brainstorming) — 2026-06-14
**Branch:** `feat/carousel-publishers` (off `develop`)
**Parent feature:** recipe image-carousel strategy for IG / FB / Threads / TikTok. This
is **sub-project 3 of 5**. It builds on the existing native Meta publishing infra (on
`develop`): `BasePublisher`, the three Meta publishers, `PublisherDispatcher`,
`meta-graph.util.ts`, `buildCaption`. It does NOT depend on sub-project 1 (renderer) or
2 (hosting) code — it consumes already-public image URLs and returns a post id.

## Goal

Publish a multi-image **carousel** to Instagram and Threads, and a **multi-photo album**
to Facebook, given N public image URLs + a caption. Add this as a new capability on the
existing Meta publishers and the dispatcher — the single-image publish path is untouched.

## Non-goals (other sub-projects)

Rendering slides (1), hosting them at public URLs (2), the strategy that selects a recipe
and orchestrates render → host → publish → delete with per-destination dedup (4), TikTok
(5). The existing single-image Meta publish, the Telegram publishers, and the Telegram
recipes strategy are all untouched.

## Why "extend existing", not new classes

The carousel flow reuses the same platform routing (`MetaPlatform` → publisher), the same
caption builder (`buildCaption`), and the same Graph helper (`graphPost`). Adding a
`publishCarousel` method to each of the three existing Meta publishers and a
`publishCarousel` method to `PublisherDispatcher` reuses all of it with **zero changes to
`publishers.module.ts`** (same classes, same providers). Dedicated `*-carousel.publisher`
classes + a second dispatcher were rejected as redundant surface.

## Components

### 1. `BasePublisher` — add an optional carousel capability

`src/publishers/base.publisher.ts`. Add to the abstract class a concrete method that
throws by default, so only Meta publishers override it (Telegram does not get carousels):

```ts
publishCarousel(_payload: PostPayload, _imageUrls: string[], _target: PublishTarget): Promise<string> {
  throw new Error(`${this.platform} does not support carousel publishing`);
}
```

### 2. The three Meta publishers — override `publishCarousel`

Each adds a `protected post(url, params, timeout, token)` seam that defaults to
`graphPost(...)` (so unit tests can inject a fake — mirrors the `getStorage` seam from
sub-project 2). The existing `publish()` keeps calling `graphPost` directly (not
refactored — YAGNI, avoids touching behavior covered indirectly by strategy tests).

**InstagramPublisher.publishCarousel** (`instagram.publisher.ts`):
```
caption = buildCaption(payload.text, payload.tags, { maxLen: 2200, maxTags: 30 })
assertCarouselSize(imageUrls.length, 10, 'instagram')
root = `${FACEBOOK_GRAPH}/${ver}/${target.id}`
children = []
for each url: POST `${root}/media` { image_url: url, is_carousel_item: 'true', access_token } → push data.id
parent = POST `${root}/media` { media_type: 'CAROUSEL', children: joinChildren(children), caption, access_token } → creation_id
published = POST `${root}/media_publish` { creation_id, access_token }
return published.id ?? creation_id
```

**ThreadsPublisher.publishCarousel** (`threads.publisher.ts`):
```
text = buildCaption(payload.text, payload.tags, { maxLen: 500, maxTags: 0 })
assertCarouselSize(imageUrls.length, 20, 'threads')
root = `${THREADS_GRAPH}/${threadsVersion}/${target.id}`
children = []
for each url: POST `${root}/threads` { media_type: 'IMAGE', image_url: url, is_carousel_item: 'true', access_token } → push data.id
parent = POST `${root}/threads` { media_type: 'CAROUSEL', children: joinChildren(children), text, access_token } → creation_id
published = POST `${root}/threads_publish` { creation_id, access_token }
return published.id ?? creation_id
```

**FacebookPublisher.publishCarousel** (`facebook.publisher.ts`) — multi-photo album:
```
caption = buildCaption(payload.text, payload.tags, { maxLen: 60000, maxTags: 0 })
assertCarouselSize(imageUrls.length, 10, 'facebook')
base = `${FACEBOOK_GRAPH}/${ver}/${target.id}`
fbids = []
for each url: POST `${base}/photos` { url, published: 'false', access_token } → push data.id
post = POST `${base}/feed` { message: caption, attached_media: fbAttachedMedia(fbids), access_token }
return post.post_id ?? post.id
```

### 3. `PublisherDispatcher` — add `publishCarousel`

`src/publishers/publisher-dispatcher.service.ts`. Mirrors the existing `publish` method:

```ts
publishCarousel(platform: MetaPlatform, payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
  const publisher = this.byPlatform[platform];
  if (!publisher) throw new Error(`No publisher for platform ${platform}`);
  return publisher.publishCarousel(payload, imageUrls, target);
}
```

### 4. Pure helpers `meta-carousel.ts`

`src/publishers/meta-carousel.ts` — dependency-free, unit-tested:

```ts
/** Throw when a carousel has too few (<2) or too many (>max) items. */
export function assertCarouselSize(count: number, max: number, platform: string): void;

/** Comma-joined child container ids for the CAROUSEL parent's `children` param. */
export function joinChildren(ids: string[]): string; // ids.join(',')

/** JSON for Facebook feed `attached_media`: [{"media_fbid":"<id>"}, …]. */
export function fbAttachedMedia(fbids: string[]): string; // JSON.stringify([...])
```

`assertCarouselSize` message includes the platform and the count, e.g.
`"instagram carousel needs 2–10 images, got 1"`.

## Data flow

```
strategy (sub-project 4)
  → dispatcher.publishCarousel(platform, payload, imageUrls, target)
    → <platform>Publisher.publishCarousel(payload, imageUrls, target)
      → N item-container POSTs → 1 parent/album POST → (IG/Threads) 1 publish POST
    → returns post id (string)
```

`imageUrls` are the public slide URLs from sub-project 2; `payload.text`/`payload.tags`
supply the caption; `target.id`/`target.token` are the account id + OAuth token resolved
upstream by `DestinationResolver` (unchanged).

## Error handling

- Any Graph failure throws (via `graphPost`, which redacts the token from the message).
  The caller (strategy 4) catches it and applies `isPermanentMetaMediaError` to decide
  retry vs mark-done — same as the single-image path today.
- `assertCarouselSize` throws on an out-of-range count (the renderer always emits 3, so
  this is defensive only).
- Partial creation (e.g. the 2nd item container fails) → the method throws and the parent
  container / album feed post is never created. Orphaned IG/Threads item containers expire
  on their own; orphaned Facebook `published=false` photos linger (acceptable slack — no
  cleanup in scope).
- The default `BasePublisher.publishCarousel` throws `"<platform> does not support
  carousel publishing"`, so dispatching a carousel to Telegram fails loudly.

## Testing

`node:test` via `npx tsx --test`. **No live network** (cost/safety guard).

Pure helpers — `meta-carousel.test.ts`:
- `assertCarouselSize(1, 10, 'instagram')` throws / `(0, …)` throws / `(11, 10, …)` throws / `(3, 10, …)` does not throw.
- `joinChildren(['a','b','c'])` → `'a,b,c'`.
- `fbAttachedMedia(['1','2'])` → `'[{"media_fbid":"1"},{"media_fbid":"2"}]'`.

Each Meta publisher — `<platform>.carousel.test.ts`, using a subclass that overrides the
`protected post` seam with a fake recording calls and returning canned `{ id }` bodies:
- **Instagram:** `publishCarousel(payload, [u1,u2,u3], target)` → 3 `media` item POSTs with
  `image_url` + `is_carousel_item:'true'`; 1 `media` parent POST with
  `media_type:'CAROUSEL'`, `children:'<id1>,<id2>,<id3>'`, the caption; 1 `media_publish`
  POST with the parent `creation_id`; returns the published id.
- **Threads:** analogous with `media_type:'IMAGE'` items, `CAROUSEL` parent carrying
  `text`, and `threads_publish`.
- **Facebook:** 3 `photos` POSTs with `url` + `published:'false'`; 1 `feed` POST with
  `message` + `attached_media` equal to `fbAttachedMedia([...])`; returns `post_id`.
- A failing item POST (fake returns/throws) → `publishCarousel` rejects and no
  parent/publish POST is made.

Dispatcher — `publisher-dispatcher.carousel.test.ts`:
- `publishCarousel('instagram', …)` calls the Instagram publisher's `publishCarousel`;
  an unknown platform throws `"No publisher for platform …"`.

## Cost / safety guard (standing)

Build + `tsc` + unit tests only. No service restart, no live Graph calls, no publishing.
No new dependency. `publishers.module.ts` is not modified.

## Deferred to later sub-projects

- **Orchestration** (4): the strategy renders slides, hosts them (sub-project 2), calls
  `dispatcher.publishCarousel`, then deletes the hosted slides on success and records a
  per-destination dedup key.
- **TikTok** (5): a separate integration; not a Graph carousel.
