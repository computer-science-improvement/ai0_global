# TikTok Content Client + Carousel Publisher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish hosted slide URLs as a TikTok photo carousel (DIRECT_POST, PULL_FROM_URL), polling to completion, via a Content Posting API client + a carousel publisher.

**Architecture:** A pure request builder, a `TikTokContentClient` (init + status-fetch over a `post` seam), and a `TikTokCarouselPublisher` that resolves a token (5a), inits, and polls (over a `sleep` seam). Registered in `PublishersModule`; NOT added to `PublisherDispatcher` (TikTok isn't a MetaPlatform — that routing is 5c). Tests use seams, no network.

**Tech Stack:** NestJS 10, `@nestjs/config`, axios, `node:test` via `cd apps/automation && npm test`.

---

## Context for the implementer

This is **sub-project 5b** of the TikTok integration. 5a (accounts + token service) is
merged into `develop`. Read these:

- `apps/automation/src/config/tiktok-token.service.ts` — `TikTokTokenService.getValidAccessToken(accountId): Promise<string>` (exported by the @Global `ChannelConfigModule`).
- `apps/automation/src/publishers/instagram.publisher.ts` — the `protected post()` seam pattern; `apps/automation/src/config/tiktok-token.service.ts` — the same seam over axios.
- `apps/automation/src/publishers/publishers.module.ts` — where the new providers register (it currently has a `SLIDE_HOSTING` provider object + `PUBLISHERS` array).
- `apps/automation/.env.example` — env documentation style.

Rules:
- Tests run with `cd apps/automation && npm test` (`tsx --test`, honoring `experimentalDecorators`). Never run tsx from the repo root.
- No live network / TikTok calls in tests — use the `post` and `sleep` seams. No service restart, no publishing.
- No new dependency (axios present). Do NOT modify `PublisherDispatcher`. The TikTok access token must never be logged or appear in a thrown message.

Spec: `docs/superpowers/specs/2026-06-15-tiktok-publisher-design.md`.

## File Structure

- `apps/automation/src/publishers/tiktok/tiktok-content.util.ts` — pure builder + status helpers. New.
- `apps/automation/src/publishers/tiktok/tiktok-content.util.test.ts` — builder tests. New.
- `apps/automation/src/publishers/tiktok/tiktok-content.client.ts` — HTTP client (init/status, `post` seam). New.
- `apps/automation/src/publishers/tiktok/tiktok-content.client.test.ts` — client tests. New.
- `apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.ts` — orchestration + poll. New.
- `apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.test.ts` — publisher tests. New.
- `apps/automation/src/publishers/publishers.module.ts` — register the two providers. Modify.
- `apps/automation/.env.example` — `TIKTOK_PRIVACY_LEVEL`. Modify.

---

## Task 1: Pure builder + status helpers

**Files:**
- Create: `apps/automation/src/publishers/tiktok/tiktok-content.util.ts`
- Test: `apps/automation/src/publishers/tiktok/tiktok-content.util.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/tiktok/tiktok-content.util.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoPostBody, captionToTitleDescription, isComplete, isFailed } from './tiktok-content.util';

test('buildPhotoPostBody assembles a DIRECT_POST photo body', () => {
  const body = buildPhotoPostBody({
    imageUrls: ['u1', 'u2', 'u3'], title: 'Pommes', description: 'full caption',
    privacyLevel: 'SELF_ONLY',
  }) as any;
  assert.equal(body.post_mode, 'DIRECT_POST');
  assert.equal(body.media_type, 'PHOTO');
  assert.equal(body.source_info.source, 'PULL_FROM_URL');
  assert.deepEqual(body.source_info.photo_images, ['u1', 'u2', 'u3']);
  assert.equal(body.source_info.photo_cover_index, 0);
  assert.equal(body.post_info.title, 'Pommes');
  assert.equal(body.post_info.description, 'full caption');
  assert.equal(body.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(body.post_info.disable_comment, false);
});

test('buildPhotoPostBody honors a custom coverIndex', () => {
  const body = buildPhotoPostBody({
    imageUrls: ['u1', 'u2'], title: 't', description: 'd', privacyLevel: 'PUBLIC_TO_EVERYONE', coverIndex: 1,
  }) as any;
  assert.equal(body.source_info.photo_cover_index, 1);
});

test('buildPhotoPostBody throws on empty urls', () => {
  assert.throws(() => buildPhotoPostBody({ imageUrls: [], title: 't', description: 'd', privacyLevel: 'SELF_ONLY' }), /at least one image/i);
});

test('captionToTitleDescription splits first line as title (capped 90)', () => {
  const r = captionToTitleDescription('Pommes Anna\n\n🍽️ French\n\nгортай');
  assert.equal(r.title, 'Pommes Anna');
  assert.equal(r.description, 'Pommes Anna\n\n🍽️ French\n\nгортай');
});

test('captionToTitleDescription caps a long single-line title at 90 chars', () => {
  const long = 'x'.repeat(120);
  const r = captionToTitleDescription(long);
  assert.equal(r.title.length, 90);
  assert.equal(r.description, long);
});

test('status helpers classify TikTok statuses', () => {
  assert.equal(isComplete('PUBLISH_COMPLETE'), true);
  assert.equal(isComplete('PROCESSING_UPLOAD'), false);
  assert.equal(isFailed('FAILED'), true);
  assert.equal(isFailed('PUBLISH_COMPLETE'), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/publishers/tiktok/tiktok-content.util.test.ts
```
Expected: FAIL — cannot find module `./tiktok-content.util`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/publishers/tiktok/tiktok-content.util.ts`:

```ts
// Pure helpers for TikTok photo (carousel) posting. No I/O — unit-tested directly.

export type TikTokPrivacy =
  | 'SELF_ONLY' | 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR';

export interface PhotoPostInput {
  imageUrls:    string[];
  title:        string;
  description:  string;
  privacyLevel: TikTokPrivacy;
  coverIndex?:  number;
}

const TITLE_MAX = 90;

/** Build the /v2/post/publish/content/init/ body for a DIRECT_POST photo carousel. */
export function buildPhotoPostBody(input: PhotoPostInput): Record<string, unknown> {
  if (input.imageUrls.length < 1) throw new Error('TikTok carousel needs at least one image');
  return {
    post_info: {
      title:           input.title,
      description:     input.description,
      privacy_level:   input.privacyLevel,
      disable_comment: false,
    },
    source_info: {
      source:            'PULL_FROM_URL',
      photo_cover_index: input.coverIndex ?? 0,
      photo_images:      input.imageUrls,
    },
    post_mode:  'DIRECT_POST',
    media_type: 'PHOTO',
  };
}

/** Split one caption into a TikTok title (first line, capped) + the full description. */
export function captionToTitleDescription(caption: string): { title: string; description: string } {
  const firstLine = caption.split('\n', 1)[0] ?? '';
  return { title: firstLine.slice(0, TITLE_MAX), description: caption };
}

export function isComplete(status: string): boolean { return status === 'PUBLISH_COMPLETE'; }
export function isFailed(status: string): boolean { return status === 'FAILED'; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/publishers/tiktok/tiktok-content.util.test.ts
```
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/tiktok/tiktok-content.util.ts apps/automation/src/publishers/tiktok/tiktok-content.util.test.ts
git commit -m "feat(tiktok): pure photo-post body builder + status helpers"
```

---

## Task 2: `TikTokContentClient`

**Files:**
- Create: `apps/automation/src/publishers/tiktok/tiktok-content.client.ts`
- Test: `apps/automation/src/publishers/tiktok/tiktok-content.client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/tiktok/tiktok-content.client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokContentClient } from './tiktok-content.client';

function build(over: any = {}) {
  const calls: any = { posts: [] };
  class TestClient extends TikTokContentClient {
    protected post(url: string, accessToken: string, body: any) {
      calls.posts.push({ url, accessToken, body });
      if (over.throw) throw new Error(over.throw);
      return Promise.resolve(over.response ?? { data: { publish_id: 'pub_1' }, error: { code: 'ok' } });
    }
  }
  return { client: new TestClient(), calls };
}

test('initPhotoPost returns publishId and forwards the token + body', async () => {
  const { client, calls } = build();
  const out = await client.initPhotoPost('TOK', { media_type: 'PHOTO' });
  assert.equal(out.publishId, 'pub_1');
  assert.ok(calls.posts[0].url.endsWith('/v2/post/publish/content/init/'));
  assert.equal(calls.posts[0].accessToken, 'TOK');
  assert.equal(calls.posts[0].body.media_type, 'PHOTO');
});

test('initPhotoPost throws on a non-ok error code (token not in message)', async () => {
  const { client } = build({ response: { data: {}, error: { code: 'invalid_params', message: 'bad url' } } });
  await assert.rejects(() => client.initPhotoPost('SECRET_TOK', {}), (e: any) => {
    assert.match(e.message, /bad url|invalid_params/);
    assert.doesNotMatch(e.message, /SECRET_TOK/);
    return true;
  });
});

test('fetchStatus returns status + failReason', async () => {
  const { client, calls } = build({ response: { data: { status: 'PROCESSING_UPLOAD', fail_reason: '' }, error: { code: 'ok' } } });
  const out = await client.fetchStatus('TOK', 'pub_1');
  assert.equal(out.status, 'PROCESSING_UPLOAD');
  assert.ok(calls.posts[0].url.endsWith('/v2/post/publish/status/fetch/'));
  assert.equal(calls.posts[0].body.publish_id, 'pub_1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/publishers/tiktok/tiktok-content.client.test.ts
```
Expected: FAIL — cannot find module `./tiktok-content.client`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/publishers/tiktok/tiktok-content.client.ts`:

```ts
// TikTok Content Posting API client (photo mode). Transport only: init a post and
// fetch its publish status. The `post` seam is overridable in tests so no live
// network is hit. The access token is sent as a Bearer header and is NEVER logged
// or included in a thrown message.
import { Injectable } from '@nestjs/common';
import axios from 'axios';

const BASE = 'https://open.tiktokapis.com';

@Injectable()
export class TikTokContentClient {
  /** HTTP seam — overridable in tests. Returns the parsed JSON body. */
  protected async post(url: string, accessToken: string, body: unknown): Promise<any> {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      timeout: 15_000,
    });
    return res.data;
  }

  /** Initialize a DIRECT_POST photo carousel. Returns the publish_id. */
  async initPhotoPost(accessToken: string, body: Record<string, unknown>): Promise<{ publishId: string }> {
    const res = await this.post(`${BASE}/v2/post/publish/content/init/`, accessToken, body);
    if (res?.error && res.error.code !== 'ok') {
      throw new Error(`TikTok init failed: ${res.error.message ?? res.error.code}`);
    }
    const publishId = String(res?.data?.publish_id ?? '');
    if (!publishId) throw new Error('TikTok init returned no publish_id');
    return { publishId };
  }

  /** Fetch the publish status for a publish_id. */
  async fetchStatus(accessToken: string, publishId: string): Promise<{ status: string; failReason?: string }> {
    const res = await this.post(`${BASE}/v2/post/publish/status/fetch/`, accessToken, { publish_id: publishId });
    if (res?.error && res.error.code !== 'ok') {
      throw new Error(`TikTok status failed: ${res.error.message ?? res.error.code}`);
    }
    return { status: String(res?.data?.status ?? ''), failReason: res?.data?.fail_reason };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/publishers/tiktok/tiktok-content.client.test.ts
```
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/tiktok/tiktok-content.client.ts apps/automation/src/publishers/tiktok/tiktok-content.client.test.ts
git commit -m "feat(tiktok): TikTokContentClient — init photo post + status fetch"
```

---

## Task 3: `TikTokCarouselPublisher`

**Files:**
- Create: `apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.ts`
- Test: `apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokCarouselPublisher } from './tiktok-carousel.publisher';

function fakeConfig(privacy?: string) {
  return { get: (k: string) => (k === 'TIKTOK_PRIVACY_LEVEL' ? privacy : undefined) } as any;
}

function build(over: any = {}) {
  const calls: any = { tokenFor: null, init: null, statusCalls: 0, slept: 0 };
  const tokenService = {
    getValidAccessToken: async (id: string) => { calls.tokenFor = id; if (over.tokenThrow) throw new Error(over.tokenThrow); return 'TOK'; },
  };
  const statuses: string[] = over.statuses ?? ['PROCESSING_UPLOAD', 'PUBLISH_COMPLETE'];
  const client = {
    initPhotoPost: async (token: string, body: any) => { calls.init = { token, body }; return { publishId: 'pub_1' }; },
    fetchStatus: async () => {
      const s = statuses[Math.min(calls.statusCalls, statuses.length - 1)];
      calls.statusCalls++;
      return { status: s, failReason: over.failReason };
    },
  };
  class TestPub extends TikTokCarouselPublisher {
    constructor() { super(tokenService as any, client as any, fakeConfig(over.privacy)); }
    protected sleep(_ms: number) { calls.slept++; return Promise.resolve(); }
  }
  return { pub: new TestPub(), calls };
}

test('publishCarousel resolves a token, inits, polls to completion, returns publish_id', async () => {
  const { pub, calls } = build({ privacy: 'PUBLIC_TO_EVERYONE' });
  const id = await pub.publishCarousel('acc1', ['u1', 'u2', 'u3'], 'Pommes\n\nгортай');
  assert.equal(id, 'pub_1');
  assert.equal(calls.tokenFor, 'acc1');
  assert.equal(calls.init.token, 'TOK');
  assert.deepEqual(calls.init.body.source_info.photo_images, ['u1', 'u2', 'u3']);
  assert.equal(calls.init.body.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
  assert.equal(calls.init.body.post_info.title, 'Pommes');
  assert.equal(calls.statusCalls, 2);  // PROCESSING then COMPLETE
});

test('publishCarousel defaults privacy to SELF_ONLY when env is unset', async () => {
  const { pub, calls } = build();
  await pub.publishCarousel('acc1', ['u1', 'u2'], 'cap');
  assert.equal(calls.init.body.post_info.privacy_level, 'SELF_ONLY');
});

test('publishCarousel throws with the fail reason on FAILED', async () => {
  const { pub } = build({ statuses: ['PROCESSING_UPLOAD', 'FAILED'], failReason: 'spam_risk' });
  await assert.rejects(() => pub.publishCarousel('acc1', ['u1', 'u2'], 'cap'), /TikTok publish failed.*spam_risk/);
});

test('publishCarousel throws on poll timeout (never completes)', async () => {
  const { pub } = build({ statuses: ['PROCESSING_UPLOAD'] });
  await assert.rejects(() => pub.publishCarousel('acc1', ['u1', 'u2'], 'cap'), /timed out/i);
});

test('publishCarousel propagates a token error before init', async () => {
  const { pub, calls } = build({ tokenThrow: 'inactive' });
  await assert.rejects(() => pub.publishCarousel('acc1', ['u1', 'u2'], 'cap'), /inactive/);
  assert.equal(calls.init, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/publishers/tiktok/tiktok-carousel.publisher.test.ts
```
Expected: FAIL — cannot find module `./tiktok-carousel.publisher`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.ts`:

```ts
// Publishes hosted slide URLs as a TikTok photo carousel (DIRECT_POST): resolve a
// valid access token (5a), init the post, then poll its status to completion.
// The `sleep` seam is overridable in tests so polling needs no real delay.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TikTokTokenService } from '../../config/tiktok-token.service';
import { TikTokContentClient } from './tiktok-content.client';
import {
  buildPhotoPostBody, captionToTitleDescription, isComplete, isFailed, TikTokPrivacy,
} from './tiktok-content.util';

const MAX_POLLS = 10;
const POLL_INTERVAL_MS = 3000;

@Injectable()
export class TikTokCarouselPublisher {
  private readonly logger = new Logger(TikTokCarouselPublisher.name);

  constructor(
    private readonly tokenService: TikTokTokenService,
    private readonly client:       TikTokContentClient,
    private readonly config:       ConfigService,
  ) {}

  /** Delay seam — overridable in tests. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Publish image URLs as a TikTok photo carousel for `accountId`. Returns the publish_id. */
  async publishCarousel(accountId: string, imageUrls: string[], caption: string): Promise<string> {
    const token = await this.tokenService.getValidAccessToken(accountId);
    const { title, description } = captionToTitleDescription(caption);
    const privacyLevel = (this.config.get<string>('TIKTOK_PRIVACY_LEVEL') ?? 'SELF_ONLY') as TikTokPrivacy;

    const body = buildPhotoPostBody({ imageUrls, title, description, privacyLevel });
    const { publishId } = await this.client.initPhotoPost(token, body);

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const { status, failReason } = await this.client.fetchStatus(token, publishId);
      if (isComplete(status)) {
        this.logger.debug(`TikTok carousel published (${publishId})`);
        return publishId;
      }
      if (isFailed(status)) {
        throw new Error(`TikTok publish failed (${publishId}): ${failReason ?? 'unknown'}`);
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`TikTok publish timed out (${publishId})`);
  }
}
```

Note: with `MAX_POLLS = 10`, the "never completes" test sees `PROCESSING_UPLOAD` on every
poll and exhausts the loop → throws "timed out". The happy-path test returns on the 2nd
status. The `sleep` seam is a no-op in tests, so the loop runs instantly.

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/publishers/tiktok/tiktok-carousel.publisher.test.ts
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.ts apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.test.ts
git commit -m "feat(tiktok): TikTokCarouselPublisher — init + poll to completion"
```

---

## Task 4: Wiring + env + full verification

**Files:**
- Modify: `apps/automation/src/publishers/publishers.module.ts`
- Modify: `apps/automation/.env.example`

- [ ] **Step 1: Register the providers**

Edit `apps/automation/src/publishers/publishers.module.ts`. Add imports after the existing hosting imports:

```ts
import { TikTokContentClient } from './tiktok/tiktok-content.client';
import { TikTokCarouselPublisher } from './tiktok/tiktok-carousel.publisher';
```

Add both classes to the `providers` array and the `exports` array of the `@Module({...})`.
The module currently provides `[...PUBLISHERS, SLIDE_HOSTING]` and exports
`[...PUBLISHERS, SlideHostingService]`; change them to:

```ts
@Global()
@Module({
  providers: [...PUBLISHERS, SLIDE_HOSTING, TikTokContentClient, TikTokCarouselPublisher],
  exports:   [...PUBLISHERS, SlideHostingService, TikTokContentClient, TikTokCarouselPublisher],
})
export class PublishersModule {}
```

(`TikTokTokenService`, the publisher's other dependency, is already exported by the @Global
`ChannelConfigModule`, so no import is needed here. `PublisherDispatcher` is NOT touched.)

- [ ] **Step 2: Add the env var**

Append to `apps/automation/.env.example`:

```bash

# TikTok post privacy. Until the TikTok app is audited this MUST be SELF_ONLY
# (posts land private on the creator's profile); set PUBLIC_TO_EVERYONE after audit.
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
```

- [ ] **Step 3: Typecheck**

Run (from `apps/automation`):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `tiktok` or `publishers.module`.

- [ ] **Step 4: Full suite**

Run (from `apps/automation`):
```bash
npm test
```
Expected: all pass, including the new TikTok publisher tests (util 6, client 3, publisher 5). No failures.

- [ ] **Step 5: Build**

Run (from `apps/automation`):
```bash
npm run build
```
Expected: `nest build` completes with no errors (confirms `TikTokCarouselPublisher` resolves `TikTokTokenService` + `TikTokContentClient` + `ConfigService`).

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/publishers/publishers.module.ts apps/automation/.env.example
git commit -m "feat(tiktok): register content client + carousel publisher in PublishersModule"
```

---

## Done criteria

- `TikTokCarouselPublisher.publishCarousel(accountId, imageUrls, caption)` resolves a 5a token, inits a DIRECT_POST photo carousel via `PULL_FROM_URL`, polls to `PUBLISH_COMPLETE`, and returns the publish_id; FAILED → throws with the fail reason; timeout → throws.
- `privacy_level` comes from `TIKTOK_PRIVACY_LEVEL` (default `SELF_ONLY`); the access token is never logged or thrown.
- Both providers are injectable app-wide; `PublisherDispatcher` is unchanged (TikTok routing is 5c).
- All tests pass via `cd apps/automation && npm test`; `npm run build` succeeds; no live network; no new dependency.
- Sub-project 5c can now route the recipe-carousel strategy to `TikTokCarouselPublisher` with 9:16 slides.
