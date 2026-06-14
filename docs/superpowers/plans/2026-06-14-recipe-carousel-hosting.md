# Recipe Carousel Slide Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload the renderer's 3 PNG slide buffers to Supabase Storage and return public HTTPS URLs (with best-effort deletion), behind a swappable abstract interface.

**Architecture:** An abstract `SlideHostingService` DI token with a `SupabaseSlideHostingService` implementation, bound via `{ provide, useClass }` in `PublishersModule`. Pure path/content-type helpers live in a separate util module. The Supabase client is created lazily and obtained through an overridable protected method so unit tests inject a fake — no live network.

**Tech Stack:** NestJS 10, `@nestjs/config` `ConfigService`, `@supabase/supabase-js`, `node:test` via `npx tsx --test`, pnpm.

---

## Context for the implementer

This is **sub-project 2 of 5** of the recipe image-carousel feature. Sub-project 1 (the
renderer, `RecipeCarouselRendererService`) is done and returns `Buffer[]` of PNG slides.
This sub-project hosts those buffers at public URLs because Instagram and Threads
carousels fetch images by URL — they do not accept raw bytes.

- The automation app is a **pnpm monorepo** at the repo root. Use `pnpm add`, never `npm install`. The lockfile is `pnpm-lock.yaml` at the repo root.
- Config is read through NestJS `ConfigService` (e.g. `this.env.get<string>('SOME_VAR')`), see `apps/automation/src/publishers/telegraph.service.ts` for the exact pattern.
- Tests are plain `node:test` files run with `npx tsx --test <path>` (no Jest). Co-locate `*.test.ts` next to the source, matching `apps/automation/src/common/carousel/recipe-carousel-renderer.service.test.ts`.
- Do NOT restart any service, run any publisher, or make any live network call. Build + typecheck + unit tests only.
- The Supabase project, bucket, and credentials already exist and are user-managed. Do not create them. The code only reads `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_CAROUSEL_BUCKET` from env.

Spec: `docs/superpowers/specs/2026-06-14-recipe-carousel-hosting-design.md`.

## File Structure

- `apps/automation/src/publishers/hosting/slide-hosting.util.ts` — pure helpers (`slideKey`, `slideContentType`). No framework, no I/O.
- `apps/automation/src/publishers/hosting/slide-hosting.util.test.ts` — unit tests for the helpers.
- `apps/automation/src/publishers/hosting/slide-hosting.service.ts` — abstract `SlideHostingService` + `HostedSlide` interface (the DI token consumers depend on).
- `apps/automation/src/publishers/hosting/supabase-slide-hosting.service.ts` — `SupabaseSlideHostingService` (the implementation).
- `apps/automation/src/publishers/hosting/supabase-slide-hosting.service.test.ts` — unit tests using a fake Supabase client.
- `apps/automation/src/publishers/publishers.module.ts` — add the DI binding.
- `apps/automation/.env.example` — document the three Supabase env vars.

---

## Task 1: Add dependency and document env vars

**Files:**
- Modify: `apps/automation/package.json` (via `pnpm add`)
- Modify: `pnpm-lock.yaml` (generated)
- Modify: `apps/automation/.env.example`

- [ ] **Step 1: Add the Supabase SDK**

Run from the repo root:

```bash
pnpm --filter ./apps/automation add @supabase/supabase-js
```

Expected: `package.json` gains `"@supabase/supabase-js": "^2..."` under dependencies; `pnpm-lock.yaml` updates. If `--filter` errors, instead run the install inside the package directory with pnpm (do NOT use `npm install` — it breaks the husky hook in this repo).

- [ ] **Step 2: Document the env vars**

Append to `apps/automation/.env.example`:

```bash

# ─── Carousel slide hosting (Supabase Storage) ───────────────────────────────
# Public-bucket host for IG/Threads carousel slides. Project + bucket are
# created in the Supabase dashboard; the service-role key is a secret.
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_CAROUSEL_BUCKET=carousel
```

- [ ] **Step 3: Verify the dependency resolves**

Run:

```bash
cd apps/automation && node -e "require.resolve('@supabase/supabase-js'); console.log('ok')"
```

Expected: prints `ok` (no MODULE_NOT_FOUND).

- [ ] **Step 4: Commit**

```bash
git add apps/automation/package.json pnpm-lock.yaml apps/automation/.env.example
git commit -m "build(carousel): add @supabase/supabase-js + hosting env vars"
```

---

## Task 2: Pure path/content-type helpers

**Files:**
- Create: `apps/automation/src/publishers/hosting/slide-hosting.util.ts`
- Test: `apps/automation/src/publishers/hosting/slide-hosting.util.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/hosting/slide-hosting.util.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideKey, slideContentType } from './slide-hosting.util';

test('slideKey appends slide-<n>.png with 1-based index', () => {
  assert.equal(slideKey('carousel/r1/abc', 0), 'carousel/r1/abc/slide-1.png');
  assert.equal(slideKey('carousel/r1/abc', 2), 'carousel/r1/abc/slide-3.png');
});

test('slideKey normalizes a trailing slash on the prefix', () => {
  assert.equal(slideKey('carousel/r1/abc/', 0), 'carousel/r1/abc/slide-1.png');
});

test('slideContentType is image/png', () => {
  assert.equal(slideContentType(), 'image/png');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx tsx --test apps/automation/src/publishers/hosting/slide-hosting.util.test.ts
```

Expected: FAIL — cannot find module `./slide-hosting.util`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/publishers/hosting/slide-hosting.util.ts`:

```ts
// Pure helpers for slide hosting — no framework, no I/O. Shared by the hosting
// service and its tests so the object-key scheme has a single source of truth.

/** Storage object key for slide `index` (0-based) under `keyPrefix`. 1-based filename. */
export function slideKey(keyPrefix: string, index: number): string {
  const prefix = keyPrefix.replace(/\/+$/, '');
  return `${prefix}/slide-${index + 1}.png`;
}

/** Content type of every slide — the renderer always emits PNG. */
export function slideContentType(): string {
  return 'image/png';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx tsx --test apps/automation/src/publishers/hosting/slide-hosting.util.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/hosting/slide-hosting.util.ts apps/automation/src/publishers/hosting/slide-hosting.util.test.ts
git commit -m "feat(carousel): slide-hosting path/content-type helpers"
```

---

## Task 3: Abstract hosting interface (DI token)

**Files:**
- Create: `apps/automation/src/publishers/hosting/slide-hosting.service.ts`

This is an abstract class + interface only — no behavior to unit-test. It is verified by
the typecheck and by Task 4 (the implementation `extends` it) and Task 5 (the DI binding).

- [ ] **Step 1: Write the abstract class**

Create `apps/automation/src/publishers/hosting/slide-hosting.service.ts`:

```ts
// Abstract slide-hosting interface used as a NestJS DI token. Publishers and the
// carousel strategy depend on this, never on a concrete backend, so the storage
// backend (Supabase today) can be swapped without touching consumers.

/** A hosted slide: a public URL Meta can fetch + the storage path for deletion. */
export interface HostedSlide {
  url:  string;
  path: string;
}

export abstract class SlideHostingService {
  /** True when storage credentials and bucket are all configured. */
  abstract available(): Promise<boolean>;

  /**
   * Upload `slides` as slide-1.png … slide-N.png under `keyPrefix`. Returns one
   * HostedSlide per input buffer, in the same order. Throws on any upload failure
   * (the caller logs and aborts the publish — no partial carousel).
   */
  abstract upload(slides: Buffer[], keyPrefix: string): Promise<HostedSlide[]>;

  /**
   * Best-effort delete by storage path. Never throws — a failed cleanup must not
   * turn an already-successful publish into a failure.
   */
  abstract delete(paths: string[]): Promise<void>;
}
```

- [ ] **Step 2: Verify it typechecks**

Run:

```bash
cd apps/automation && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors related to `slide-hosting.service.ts`. (Pre-existing errors elsewhere, if any, are out of scope — confirm none reference the new file.)

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/publishers/hosting/slide-hosting.service.ts
git commit -m "feat(carousel): abstract SlideHostingService interface"
```

---

## Task 4: Supabase implementation

**Files:**
- Create: `apps/automation/src/publishers/hosting/supabase-slide-hosting.service.ts`
- Test: `apps/automation/src/publishers/hosting/supabase-slide-hosting.service.test.ts`

The implementation reads env through `ConfigService`, lazily builds a Supabase client,
and exposes the client through a `protected getStorage(bucket)` method that tests
override with a fake. No live network in tests.

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/hosting/supabase-slide-hosting.service.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseSlideHostingService } from './supabase-slide-hosting.service';

// Minimal ConfigService stand-in.
function fakeConfig(vars: Record<string, string | undefined>) {
  return { get: (k: string) => vars[k] } as any;
}

const FULL_ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  SUPABASE_CAROUSEL_BUCKET: 'carousel',
};

// A fake "storage.from(bucket)" object recording calls.
function fakeStorage(opts: { uploadError?: (i: number) => string | null; removeError?: string } = {}) {
  const calls: any = { uploads: [], publicUrls: [], removes: [] };
  let uploadCount = 0;
  const storage = {
    upload: async (path: string, body: Buffer, options: any) => {
      const i = uploadCount++;
      calls.uploads.push({ path, body, options });
      const err = opts.uploadError ? opts.uploadError(i) : null;
      return err ? { data: null, error: { message: err } } : { data: { path }, error: null };
    },
    getPublicUrl: (path: string) => {
      calls.publicUrls.push(path);
      return { data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/carousel/${path}` } };
    },
    remove: async (paths: string[]) => {
      calls.removes.push(paths);
      return opts.removeError ? { data: null, error: { message: opts.removeError } } : { data: [], error: null };
    },
  };
  return { storage, calls };
}

// Subclass that injects the fake storage instead of a real Supabase client.
class TestService extends SupabaseSlideHostingService {
  constructor(env: any, private readonly fake: any) { super(env); }
  protected getStorage(_bucket: string) { return this.fake; }
}

test('available() is true only when all three env vars are set', async () => {
  assert.equal(await new SupabaseSlideHostingService(fakeConfig(FULL_ENV)).available(), true);
  assert.equal(await new SupabaseSlideHostingService(fakeConfig({ ...FULL_ENV, SUPABASE_SERVICE_KEY: undefined })).available(), false);
  assert.equal(await new SupabaseSlideHostingService(fakeConfig({})).available(), false);
});

test('upload() stores each slide and returns urls+paths in order', async () => {
  const { storage, calls } = fakeStorage();
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  const slides = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];

  const result = await svc.upload(slides, 'carousel/r1/abc');

  assert.equal(calls.uploads.length, 3);
  assert.deepEqual(calls.uploads.map((u: any) => u.path), [
    'carousel/r1/abc/slide-1.png',
    'carousel/r1/abc/slide-2.png',
    'carousel/r1/abc/slide-3.png',
  ]);
  assert.equal(calls.uploads[0].body, slides[0]);
  assert.deepEqual(calls.uploads[0].options, { contentType: 'image/png', upsert: true });
  assert.deepEqual(result.map(r => r.path), [
    'carousel/r1/abc/slide-1.png',
    'carousel/r1/abc/slide-2.png',
    'carousel/r1/abc/slide-3.png',
  ]);
  assert.match(result[2].url, /slide-3\.png$/);
});

test('upload() throws with the slide index when a slide fails', async () => {
  const { storage } = fakeStorage({ uploadError: (i) => (i === 1 ? 'boom' : null) });
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await assert.rejects(
    () => svc.upload([Buffer.from('a'), Buffer.from('b')], 'carousel/r1/abc'),
    /slide 2.*boom/i,
  );
});

test('upload() throws when not configured', async () => {
  const svc = new SupabaseSlideHostingService(fakeConfig({}));
  await assert.rejects(() => svc.upload([Buffer.from('a')], 'carousel/r1/abc'), /not configured/i);
});

test('delete() forwards paths to storage.remove', async () => {
  const { storage, calls } = fakeStorage();
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await svc.delete(['carousel/r1/abc/slide-1.png', 'carousel/r1/abc/slide-2.png']);
  assert.deepEqual(calls.removes, [['carousel/r1/abc/slide-1.png', 'carousel/r1/abc/slide-2.png']]);
});

test('delete() resolves (no throw) when removal errors', async () => {
  const { storage } = fakeStorage({ removeError: 'nope' });
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await svc.delete(['x']); // must not reject
});

test('delete() no-ops on empty input', async () => {
  const { storage, calls } = fakeStorage();
  const svc = new TestService(fakeConfig(FULL_ENV), storage);
  await svc.delete([]);
  assert.equal(calls.removes.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx tsx --test apps/automation/src/publishers/hosting/supabase-slide-hosting.service.test.ts
```

Expected: FAIL — cannot find module `./supabase-slide-hosting.service`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/publishers/hosting/supabase-slide-hosting.service.ts`:

```ts
// Supabase Storage implementation of SlideHostingService. Uploads PNG slides to a
// public bucket and returns public URLs Meta can fetch; deletes are best-effort.
// The Supabase client is built lazily; getStorage() is protected so tests inject
// a fake — no live network in unit tests. The service-role key is never logged.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SlideHostingService, HostedSlide } from './slide-hosting.service';
import { slideKey, slideContentType } from './slide-hosting.util';

@Injectable()
export class SupabaseSlideHostingService extends SlideHostingService {
  private readonly logger = new Logger(SupabaseSlideHostingService.name);
  private client?: SupabaseClient;

  constructor(private readonly env: ConfigService) {
    super();
  }

  private cfg(): { url?: string; key?: string; bucket?: string } {
    return {
      url:    this.env.get<string>('SUPABASE_URL'),
      key:    this.env.get<string>('SUPABASE_SERVICE_KEY'),
      bucket: this.env.get<string>('SUPABASE_CAROUSEL_BUCKET'),
    };
  }

  async available(): Promise<boolean> {
    const { url, key, bucket } = this.cfg();
    return Boolean(url && key && bucket);
  }

  /** Storage handle for `bucket`. Overridable in tests. */
  protected getStorage(bucket: string): any {
    if (!this.client) {
      const { url, key } = this.cfg();
      this.client = createClient(url!, key!);
    }
    return this.client.storage.from(bucket);
  }

  async upload(slides: Buffer[], keyPrefix: string): Promise<HostedSlide[]> {
    if (!(await this.available())) throw new Error('Slide hosting not configured');
    const { bucket } = this.cfg();
    const storage = this.getStorage(bucket!);

    const out: HostedSlide[] = [];
    for (let i = 0; i < slides.length; i++) {
      const path = slideKey(keyPrefix, i);
      const { error } = await storage.upload(path, slides[i], {
        contentType: slideContentType(),
        upsert: true,
      });
      if (error) throw new Error(`Slide ${i + 1} upload failed: ${error.message}`);
      const { data } = storage.getPublicUrl(path);
      out.push({ url: data.publicUrl, path });
    }
    return out;
  }

  async delete(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      const { bucket } = this.cfg();
      const { error } = await this.getStorage(bucket!).remove(paths);
      if (error) this.logger.warn(`Slide cleanup failed: ${error.message}`);
    } catch (e) {
      this.logger.warn(`Slide cleanup error: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx tsx --test apps/automation/src/publishers/hosting/supabase-slide-hosting.service.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/hosting/supabase-slide-hosting.service.ts apps/automation/src/publishers/hosting/supabase-slide-hosting.service.test.ts
git commit -m "feat(carousel): SupabaseSlideHostingService — upload/delete slides"
```

---

## Task 5: DI wiring + full verification

**Files:**
- Modify: `apps/automation/src/publishers/publishers.module.ts`

- [ ] **Step 1: Bind the abstract token to the Supabase impl**

Edit `apps/automation/src/publishers/publishers.module.ts`. Add the two imports after the existing publisher imports (after line 12, the `CrossPostService` import):

```ts
import { SlideHostingService } from './hosting/slide-hosting.service';
import { SupabaseSlideHostingService } from './hosting/supabase-slide-hosting.service';
```

Replace the `@Module({ ... })` decorator so the abstract token is provided via the implementation and exported (consumers inject `SlideHostingService`):

```ts
const SLIDE_HOSTING = { provide: SlideHostingService, useClass: SupabaseSlideHostingService };

@Global()
@Module({
  providers: [...PUBLISHERS, SLIDE_HOSTING],
  exports:   [...PUBLISHERS, SlideHostingService],
})
export class PublishersModule {}
```

- [ ] **Step 2: Typecheck the whole automation app**

Run:

```bash
cd apps/automation && npx tsc --noEmit -p tsconfig.json
```

Expected: no new errors referencing `hosting/` or `publishers.module.ts`.

- [ ] **Step 3: Run the full automation unit-test suite**

Run from the repo root:

```bash
npx tsx --test apps/automation/src/**/*.test.ts
```

Expected: all tests pass, including the new `slide-hosting.util.test.ts` (3) and `supabase-slide-hosting.service.test.ts` (7), and the existing suite (renderer etc.) unaffected. If the glob does not expand in your shell, run `find apps/automation/src -name '*.test.ts' -print0 | xargs -0 npx tsx --test`.

- [ ] **Step 4: Build to confirm Nest can construct the module graph**

Run:

```bash
cd apps/automation && npm run build
```

Expected: `nest build` completes with no errors (confirms the DI binding compiles into the module).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/publishers.module.ts
git commit -m "feat(carousel): provide SlideHostingService (Supabase) in PublishersModule"
```

---

## Done criteria

- `SlideHostingService` is injectable across the app (it's in the `@Global()` `PublishersModule` exports).
- `SupabaseSlideHostingService.upload` returns `HostedSlide[]` with public URLs; `delete` is best-effort; `available()` gates on the three env vars.
- All unit tests pass with no live network; `npm run build` succeeds.
- No changes to the Telegram strategy, no service restart, no publishing.
- Sub-project 3 (carousel publishers) can now inject `SlideHostingService` to turn rendered buffers into public URLs.
