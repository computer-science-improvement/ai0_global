# Recipe Carousel Slide Hosting (sub-project 2/5) — Design

**Status:** approved (brainstorming) — 2026-06-14
**Branch:** `feat/carousel-hosting` (off `develop`)
**Parent feature:** recipe image-carousel strategy for IG / FB / Threads / TikTok. This
is **sub-project 2 of 5**. It depends on no other sub-project's code (independent), but
is a hard prerequisite for sub-project 3 (carousel publishers) and 4 (the strategy):
Instagram and Threads carousels require a **public HTTPS URL per slide** — they fetch
the image, they do not accept raw bytes.

## Goal

Take the PNG buffers produced by the renderer (sub-project 1) and make each one
available at a public HTTPS URL that Meta's servers can fetch, using **Supabase
Storage**. Expose this behind an abstract interface so the storage backend can be
swapped later without touching publishers or the strategy.

## Non-goals (other sub-projects)

Rendering slides (sub-project 1, done), the carousel publishers themselves (sub-project
3), the strategy that orchestrates render → host → publish → delete and decides *when*
to delete (sub-project 4), TikTok (sub-project 5). The existing Telegram recipes
strategy is untouched. No DB schema changes.

## Stack / decision

- **`@supabase/supabase-js`** — the canonical Supabase SDK. It sets the auth headers,
  builds public URLs (`getPublicUrl`), removes objects (`remove`), and surfaces
  structured errors. It is dual CJS/ESM, so — unlike satori — it needs no dynamic-import
  workaround under the CommonJS runtime. This is the only new dependency.
- Rejected alternative: raw Storage REST via `axios` (already a dep). No new dependency,
  but more hand-rolled code and weaker error handling. Not worth it.

The Supabase project and bucket already exist (user-managed). Credentials come from env
(see Config). This sub-project does not create the project or bucket.

## Component

`src/publishers/hosting/slide-hosting.service.ts` — the abstract DI token.
`src/publishers/hosting/supabase-slide-hosting.service.ts` — the Supabase implementation.
`src/publishers/hosting/slide-hosting.util.ts` — pure helpers (path/URL), unit-tested.

Placed under `publishers/` because hosting is an outbound-network publishing dependency,
parallel to `telegraph.service.ts`.

### Interface

```ts
export interface HostedSlide {
  url:  string;   // public HTTPS URL Meta can fetch
  path: string;   // storage object path (for later deletion)
}

export abstract class SlideHostingService {
  /** True when storage credentials/bucket are configured (mirrors TelegraphService.available). */
  abstract available(): Promise<boolean>;

  /**
   * Upload slides as slide-1.png … slide-N.png under `keyPrefix`.
   * Returns one HostedSlide per input buffer, in order.
   * Throws on any upload failure (caller logs and fails the publish).
   */
  abstract upload(slides: Buffer[], keyPrefix: string): Promise<HostedSlide[]>;

  /**
   * Best-effort delete by storage path. Never throws — logs and resolves even if
   * removal fails (a leftover object must not fail an already-successful publish).
   */
  abstract delete(paths: string[]): Promise<void>;
}
```

`keyPrefix` is chosen by the caller (the strategy, sub-project 4), e.g.
`carousel/<recipeId>/<unique>` — the hosting service does not invent uniqueness, it just
appends `slide-<i>.png`. A trailing slash in the prefix is tolerated (normalized).

### DI wiring

In `publishers.module.ts`, bind the abstract token to the implementation:

```ts
{ provide: SlideHostingService, useClass: SupabaseSlideHostingService }
```

Consumers inject `SlideHostingService`. Swapping to R2 later = one new impl + one line.

## Config (env, via `ConfigService`)

| Env var | Meaning |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://abcd.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service-role key (server-side upload/delete) |
| `SUPABASE_CAROUSEL_BUCKET` | Bucket name, e.g. `carousel` |

`available()` returns true only when all three are present (same pattern as
`TelegraphService.available()`). Add these three keys to `.env.example` with empty values
and a short comment. The service-role key is a secret — never logged, never returned.

## Pure helpers (`slide-hosting.util.ts`)

- `slideKey(keyPrefix: string, index: number): string` — normalizes the prefix (trim
  trailing `/`) and returns `<prefix>/slide-<index+1>.png`.
- `slideContentType(): string` — returns `'image/png'` (slides are always PNG from the
  renderer). A single constant kept here so the upload call and tests share one source.

These are pure and unit-tested directly. They contain no Supabase types.

## Data flow

```
slides: Buffer[]  ──upload(slides, keyPrefix)──►  for each i:
    key = slideKey(keyPrefix, i)
    storage.from(bucket).upload(key, slides[i], { contentType: 'image/png', upsert: true })
    url = storage.from(bucket).getPublicUrl(key).data.publicUrl
  ──► HostedSlide[] [{url, path: key}, …]   (same order as input)

delete(paths)  ──►  storage.from(bucket).remove(paths)   (best-effort, never throws)
```

The Supabase client is created lazily on first use from the env config (one client
instance cached on the service). The client is obtained through an overridable protected
method so tests can inject a fake (see Testing) — no real network in unit tests.

## Error handling

- **`upload`** — if `available()` is false, throw (`'Slide hosting not configured'`).
  If any per-slide `upload` returns a Supabase error, throw with the slide index and the
  Supabase error message. A throw here means the strategy aborts the publish for that
  destination and logs — no partial carousel is published.
- **`delete`** — best-effort. Catch and `logger.warn` on any error; always resolve. A
  failed cleanup must never turn a successful publish into a failure. (Leftover objects
  are acceptable slack; they can be swept later if ever needed.)
- The service-role key never appears in any thrown message or log line.

## Testing

`node:test` via `npx tsx --test` (matches the renderer sub-project). **No real network**
— honors the standing cost/safety guard.

Pure helpers (`slide-hosting.util.test.ts`):
- `slideKey('carousel/r1/abc', 0)` → `'carousel/r1/abc/slide-1.png'`.
- `slideKey('carousel/r1/abc/', 2)` → `'carousel/r1/abc/slide-3.png'` (trailing slash normalized).
- `slideContentType()` → `'image/png'`.

Service (`supabase-slide-hosting.service.test.ts`) with a **fake Supabase client**
injected via the overridable client method:
- `upload([buf1, buf2, buf3], 'carousel/r1/abc')` →
  - calls `from(bucket).upload` 3× with keys `slide-1.png … slide-3.png`, `contentType
    'image/png'`, `upsert: true`, and the right buffer per index;
  - returns 3 `HostedSlide` in input order with the fake's public URLs and the storage
    paths.
- `upload` when a slide's fake upload returns `{ error }` → throws, message includes the
  failing slide index.
- `upload` when `available()` is false (missing env) → throws `'not configured'`.
- `delete(['a','b'])` → calls `from(bucket).remove(['a','b'])`.
- `delete` when the fake `remove` rejects/returns error → resolves (no throw), warning
  logged.

Optional integration test against a real bucket is **env-gated and skipped** when
`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`SUPABASE_CAROUSEL_BUCKET` are absent (default in
CI/local) — so the suite never makes a live call by default.

## Cost / safety guard (standing)

Build + `tsc` + unit tests only. No service restart, no live network, no publishing. The
only dependency change is adding `@supabase/supabase-js` (via `pnpm add`, committing the
root `pnpm-lock.yaml`). The user owns the Supabase project, bucket, and credentials.

## Deferred to later sub-projects

- **When to delete** (sub-project 4): the strategy calls `delete(paths)` after a
  successful carousel publish. This sub-project only provides the capability.
- **Per-destination concerns** (sub-projects 3–4): which platforms host which slides,
  dedup keys, etc. Hosting is platform-agnostic — it returns URLs; publishers consume them.
