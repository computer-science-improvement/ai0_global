# TikTok Content Posting Client + Carousel Publisher (sub-project 5b) — Design

**Status:** approved (brainstorming) — 2026-06-15
**Branch:** `feat/tiktok-publisher` (off `develop`)
**Parent feature:** recipe image-carousel for IG / FB / Threads / **TikTok**. This is
**5b** of the TikTok integration (decomposed 5a–5d). 5a (accounts + token service) is
done and merged. 5b builds the actual TikTok publishing path: a Content Posting API
client and a photo-carousel publisher. 5c wires it into the destination/binding model and
the recipe-carousel strategy; 5d adds the dashboard + web OAuth.

## Goal

Publish a set of hosted slide image URLs as a **TikTok photo carousel** (photo mode,
`DIRECT_POST`) to one connected creator account, returning when TikTok reports the post
complete. Consumes `TikTokTokenService.getValidAccessToken(accountId)` from 5a and the
public slide URLs from sub-project 2.

## Non-goals

Routing TikTok into `PublisherDispatcher` / the recipe-carousel strategy (5c — TikTok is
not a `MetaPlatform`). Dashboard / web OAuth (5d). Video posts. `MEDIA_UPLOAD`/inbox-draft
mode. The renderer's 9:16 sizing is passed by the strategy in 5c; 5b just takes URLs.

## External prerequisites (not code)

- **TikTok app review** — public posting requires audit. Until then `privacy_level` must be
  `SELF_ONLY` (posts land private on the creator's profile).
- **`PULL_FROM_URL` domain verification** — the slide-host domain (Supabase) must be
  registered as a verified URL prefix in the TikTok developer portal, or `init` rejects the
  image URLs.
- **Env** `TIKTOK_PRIVACY_LEVEL` (default `SELF_ONLY`).

## Approach

Two focused units plus a pure builder (rejected: extending the Meta-only
`PublisherDispatcher` — that's 5c's job; merging client+publisher — they have distinct
responsibilities). The client is pure HTTP transport; the publisher orchestrates
token → init → poll. Both use an overridable seam so tests run with no network.

## Components

### 1. Pure builder — `src/publishers/tiktok/tiktok-content.util.ts`

Dependency-free, unit-tested:

```ts
export type TikTokPrivacy = 'SELF_ONLY' | 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR';

export interface PhotoPostInput {
  imageUrls:    string[];
  title:        string;
  description:  string;
  privacyLevel: TikTokPrivacy;
  coverIndex?:  number;   // default 0
}

/** Build the /v2/post/publish/content/init/ request body for a DIRECT_POST photo carousel. */
export function buildPhotoPostBody(input: PhotoPostInput): Record<string, unknown>;
//  { post_info: { title, description, privacy_level, disable_comment: false },
//    source_info: { source: 'PULL_FROM_URL', photo_cover_index, photo_images },
//    post_mode: 'DIRECT_POST', media_type: 'PHOTO' }

/** Split a single caption into TikTok's title (first line, capped ~90 chars) + description (full). */
export function captionToTitleDescription(caption: string): { title: string; description: string };

/** TikTok publish status classification. */
export function isComplete(status: string): boolean;  // 'PUBLISH_COMPLETE'
export function isFailed(status: string): boolean;    // 'FAILED'
```

`buildPhotoPostBody` validates `imageUrls.length >= 1` (TikTok photo posts allow 1–35;
the renderer emits 3) and throws on empty.

### 2. `TikTokContentClient` — `src/publishers/tiktok/tiktok-content.client.ts`

`@Injectable()`. Base `https://open.tiktokapis.com`. Bearer auth.

```ts
initPhotoPost(accessToken: string, body: Record<string, unknown>): Promise<{ publishId: string }>
fetchStatus(accessToken: string, publishId: string): Promise<{ status: string; failReason?: string }>
```

- `initPhotoPost` → POST `/v2/post/publish/content/init/` (JSON body, `Authorization: Bearer`).
  Reads `res.data.publish_id`; throws on `res.error.code !== 'ok'` (message from `res.error.message`).
- `fetchStatus` → POST `/v2/post/publish/status/fetch/` `{ publish_id }`. Returns
  `res.data.status` + `res.data.fail_reason`.
- **`protected post(url, accessToken, body): Promise<any>`** seam over axios (sets the
  Bearer header, JSON content type, timeout) so tests inject a fake. **The access token is
  never logged or included in any thrown message** (only the TikTok error message/code is).

### 3. `TikTokCarouselPublisher` — `src/publishers/tiktok/tiktok-carousel.publisher.ts`

`@Injectable()`. Injects `TikTokTokenService` (5a, @Global) + `TikTokContentClient` + `ConfigService`.

```ts
/** Publish image URLs as a TikTok photo carousel for `accountId`. Returns the publish_id. */
publishCarousel(accountId: string, imageUrls: string[], caption: string): Promise<string>
```

Flow:
1. `token = await tokenService.getValidAccessToken(accountId)`.
2. `{ title, description } = captionToTitleDescription(caption)`; `privacy = config.get('TIKTOK_PRIVACY_LEVEL') ?? 'SELF_ONLY'`.
3. `body = buildPhotoPostBody({ imageUrls, title, description, privacyLevel: privacy })`.
4. `{ publishId } = await client.initPhotoPost(token, body)`.
5. **Poll** `client.fetchStatus(token, publishId)` up to `MAX_POLLS` (default 10) with
   `POLL_INTERVAL_MS` (default 3000) between attempts via a `protected sleep(ms)` seam:
   - `isComplete(status)` → return `publishId`.
   - `isFailed(status)` → throw `Error('TikTok publish failed: <failReason>')`.
   - otherwise (e.g. `PROCESSING_UPLOAD`/`PROCESSING_DOWNLOAD`) → sleep and retry.
6. Exhausting the polls → throw `Error('TikTok publish timed out (<publishId>)')`.

`MAX_POLLS` / `POLL_INTERVAL_MS` are module constants. `getValidAccessToken` may throw
(account inactive / refresh failed) — that propagates to the caller (5c strategy).

### 4. Wiring — `PublishersModule`

Add `TikTokContentClient` + `TikTokCarouselPublisher` to `providers` and `exports`. They
are **not** added to `PublisherDispatcher` (TikTok ≠ MetaPlatform; 5c routes it). The
token service is already exported by the @Global `ChannelConfigModule`.

## Data flow

```
5c strategy → publisher.publishCarousel(accountId, slideUrls, caption)
   → tokenService.getValidAccessToken(accountId)        (5a; refresh if near expiry)
   → buildPhotoPostBody(...)
   → client.initPhotoPost(token, body)  → publish_id
   → poll client.fetchStatus(token, publish_id) until PUBLISH_COMPLETE / FAILED / timeout
   → return publish_id
```

## Error handling

| Situation | Behavior |
| --- | --- |
| Empty `imageUrls` | `buildPhotoPostBody` throws |
| Token unavailable (inactive / refresh failed) | `getValidAccessToken` throws → propagates |
| `init` returns an error / HTTP failure | client throws (TikTok message/code only — no token) |
| Status `FAILED` | publisher throws with `fail_reason` |
| Poll budget exhausted | publisher throws "timed out" |
| Any logging | the access token is never logged or thrown |

## Testing

`node:test` via `cd apps/automation && npm test`. **No live network** (cost guard).

Pure builder — `tiktok-content.util.test.ts`:
- `buildPhotoPostBody` produces `post_mode:'DIRECT_POST'`, `media_type:'PHOTO'`,
  `source:'PULL_FROM_URL'`, `photo_images` = the urls, `photo_cover_index` default 0,
  `privacy_level` passed through; throws on empty urls.
- `captionToTitleDescription` → title is the first line capped at 90 chars; description is the full caption.
- `isComplete('PUBLISH_COMPLETE')` true; `isFailed('FAILED')` true; both false for `PROCESSING_*`.

Client — `tiktok-content.client.test.ts` (subclass overriding `post`):
- `initPhotoPost` returns `publishId` from `data.publish_id`; passes the token to `post`.
- `initPhotoPost` throws when `res.error.code` is not `ok` (message included, token not).
- `fetchStatus` returns `{ status, failReason }` from `data`.

Publisher — `tiktok-carousel.publisher.test.ts` (fake tokenService + fake client + `sleep` no-op seam):
- happy path: init → status `PROCESSING_UPLOAD` then `PUBLISH_COMPLETE` → returns the publish_id; token came from `getValidAccessToken`; privacy from config.
- status `FAILED` → throws with the fail reason; no further polling.
- never completes within `MAX_POLLS` → throws "timed out".
- empty urls → throws (builder guard) before any init.

## Cost / safety guard (standing)

Build + `tsc` + unit tests only (`cd apps/automation && npm test`). No service restart, no
live TikTok calls, no publishing. One env var documented in `.env.example`
(`TIKTOK_PRIVACY_LEVEL`). No new dependency (axios present). `PublisherDispatcher` untouched.

## Deferred

- **5c** — `DestinationPlatform += 'tiktok'`, a TikTok destination resolver + `TT:<uuid>`
  dedup key, binding `platform='tiktok'`, and recipe-carousel routing that renders 9:16 and
  calls `TikTokCarouselPublisher`.
- **5d** — dashboard TikTok accounts + web OAuth round-trip.
