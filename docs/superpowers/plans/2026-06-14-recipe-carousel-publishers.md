# Recipe Carousel Publishers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `publishCarousel` capability to the three Meta publishers and the dispatcher — IG/Threads native carousels, Facebook multi-photo album — given N public image URLs + a caption.

**Architecture:** Extend the existing `BasePublisher` with a default-throwing `publishCarousel`; the three Meta publishers override it using a new `protected post()` seam over `graphPost` (so tests inject a fake — no live network). A new pure helper module `meta-carousel.ts` holds size validation + the two param-building helpers. `PublisherDispatcher` gains a `publishCarousel` routing method. No DI/module changes.

**Tech Stack:** NestJS 10, `@nestjs/config` ConfigService, Meta Graph API (axios via `graphPost`), `node:test` via `npx tsx --test`.

---

## Context for the implementer

This is **sub-project 3 of 5** of the recipe image-carousel feature. It extends the
existing native Meta publishing infra. Read these files first to match patterns exactly:

- `apps/automation/src/publishers/base.publisher.ts` — `BasePublisher` (abstract, `publish`), `PublishTarget` ({ id, token? }).
- `apps/automation/src/publishers/instagram.publisher.ts`, `threads.publisher.ts`, `facebook.publisher.ts` — the single-image publishers (the pattern to mirror).
- `apps/automation/src/publishers/publisher-dispatcher.service.ts` — `PublisherDispatcher` (`byPlatform` map, `publish`).
- `apps/automation/src/publishers/meta-graph.util.ts` — `FACEBOOK_GRAPH`, `THREADS_GRAPH`, `graphVersion`, `threadsVersion`, `graphTimeout`, `graphPost(url, params, timeout, token)`.
- `apps/automation/src/publishers/meta-content.ts` — `buildCaption(text, tags, { maxLen, maxTags })`.
- `apps/automation/src/common/types.ts` — `PostPayload` ({ text, imageUrl?, tags, … }).

Rules:
- Tests are plain `node:test` run via `npx tsx --test <path>` (no Jest). Co-locate tests next to source.
- Do NOT make any live Graph/network call (cost/safety guard). Build + typecheck + unit tests only. Do NOT restart/run the service.
- Do NOT modify `publishers.module.ts` (no provider changes). Do NOT touch the single-image `publish()` methods. Do NOT touch the Telegram publishers or any strategy.
- No new dependency.

Spec: `docs/superpowers/specs/2026-06-14-recipe-carousel-publishers-design.md`.

## File Structure

- `apps/automation/src/publishers/meta-carousel.ts` — pure helpers (`assertCarouselSize`, `joinChildren`, `fbAttachedMedia`). New.
- `apps/automation/src/publishers/meta-carousel.test.ts` — helper unit tests. New.
- `apps/automation/src/publishers/base.publisher.ts` — add default-throwing `publishCarousel`. Modify.
- `apps/automation/src/publishers/instagram.publisher.ts` — add `protected post` seam + `publishCarousel`. Modify.
- `apps/automation/src/publishers/instagram.carousel.test.ts` — IG carousel test. New.
- `apps/automation/src/publishers/threads.publisher.ts` — add `protected post` seam + `publishCarousel`. Modify.
- `apps/automation/src/publishers/threads.carousel.test.ts` — Threads carousel test. New.
- `apps/automation/src/publishers/facebook.publisher.ts` — add `protected post` seam + `publishCarousel`. Modify.
- `apps/automation/src/publishers/facebook.carousel.test.ts` — FB album test. New.
- `apps/automation/src/publishers/publisher-dispatcher.service.ts` — add `publishCarousel`. Modify.
- `apps/automation/src/publishers/publisher-dispatcher.carousel.test.ts` — dispatcher routing test. New.

---

## Task 1: Pure carousel helpers

**Files:**
- Create: `apps/automation/src/publishers/meta-carousel.ts`
- Test: `apps/automation/src/publishers/meta-carousel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/meta-carousel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCarouselSize, joinChildren, fbAttachedMedia } from './meta-carousel';

test('assertCarouselSize throws below 2', () => {
  assert.throws(() => assertCarouselSize(1, 10, 'instagram'), /instagram.*2.*10.*got 1/i);
  assert.throws(() => assertCarouselSize(0, 10, 'instagram'), /got 0/i);
});

test('assertCarouselSize throws above max', () => {
  assert.throws(() => assertCarouselSize(11, 10, 'instagram'), /got 11/i);
});

test('assertCarouselSize accepts an in-range count', () => {
  assert.doesNotThrow(() => assertCarouselSize(3, 10, 'instagram'));
  assert.doesNotThrow(() => assertCarouselSize(2, 10, 'instagram'));
  assert.doesNotThrow(() => assertCarouselSize(10, 10, 'instagram'));
});

test('joinChildren comma-joins ids', () => {
  assert.equal(joinChildren(['a', 'b', 'c']), 'a,b,c');
});

test('fbAttachedMedia builds the media_fbid JSON array', () => {
  assert.equal(fbAttachedMedia(['1', '2']), '[{"media_fbid":"1"},{"media_fbid":"2"}]');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx tsx --test apps/automation/src/publishers/meta-carousel.test.ts
```
Expected: FAIL — cannot find module `./meta-carousel`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/publishers/meta-carousel.ts`:

```ts
// meta-carousel.ts — pure, dependency-free helpers for carousel/album publishing.
// Safe to unit-test (no I/O). Used by the Meta publishers' publishCarousel methods.

/** Throw when a carousel has too few (<2) or too many (>max) items. */
export function assertCarouselSize(count: number, max: number, platform: string): void {
  if (count < 2 || count > max) {
    throw new Error(`${platform} carousel needs 2–${max} images, got ${count}`);
  }
}

/** Comma-joined child container ids for the CAROUSEL parent's `children` param. */
export function joinChildren(ids: string[]): string {
  return ids.join(',');
}

/** JSON for Facebook feed `attached_media`: [{"media_fbid":"<id>"}, …]. */
export function fbAttachedMedia(fbids: string[]): string {
  return JSON.stringify(fbids.map(id => ({ media_fbid: id })));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx tsx --test apps/automation/src/publishers/meta-carousel.test.ts
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/meta-carousel.ts apps/automation/src/publishers/meta-carousel.test.ts
git commit -m "feat(carousel): pure meta-carousel helpers (size/children/attached_media)"
```

---

## Task 2: BasePublisher default carousel method

**Files:**
- Modify: `apps/automation/src/publishers/base.publisher.ts`

This adds a concrete default that throws, so only Meta publishers override it. There is no
direct unit test (it is exercised via the dispatcher test in Task 6 and the publisher
overrides in Tasks 3–5); it is verified here by typecheck.

- [ ] **Step 1: Add the default method**

Edit `apps/automation/src/publishers/base.publisher.ts`. The file currently ends with:

```ts
export abstract class BasePublisher {
  abstract readonly platform: string;

  /**
   * Publish a post to the platform.
   * @returns Published post ID or URL
   */
  abstract publish(payload: PostPayload, target: PublishTarget): Promise<string>;
}
```

Add a default `publishCarousel` after `publish` so the class becomes:

```ts
export abstract class BasePublisher {
  abstract readonly platform: string;

  /**
   * Publish a post to the platform.
   * @returns Published post ID or URL
   */
  abstract publish(payload: PostPayload, target: PublishTarget): Promise<string>;

  /**
   * Publish a multi-image carousel (IG/Threads) or album (FB). Default throws —
   * only the Meta publishers that support it override this.
   * @returns Published post ID or URL
   */
  publishCarousel(_payload: PostPayload, _imageUrls: string[], _target: PublishTarget): Promise<string> {
    throw new Error(`${this.platform} does not support carousel publishing`);
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run:
```bash
cd apps/automation && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "base.publisher|publish-carousel|publishCarousel" || echo "no related errors"
```
Expected: `no related errors`.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/publishers/base.publisher.ts
git commit -m "feat(carousel): default-throwing BasePublisher.publishCarousel"
```

---

## Task 3: Instagram carousel

**Files:**
- Modify: `apps/automation/src/publishers/instagram.publisher.ts`
- Test: `apps/automation/src/publishers/instagram.carousel.test.ts`

The IG publisher already imports `FACEBOOK_GRAPH, graphPost, graphTimeout, graphVersion`
and `buildCaption`. Add a `protected post` seam over `graphPost`, then `publishCarousel`.

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/instagram.carousel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramPublisher } from './instagram.publisher';
import type { PostPayload } from '../common/types';

function fakeConfig() { return { get: () => undefined } as any; }

// Records each graph call and returns canned ids: item containers ig_1.., parent
// ig_parent, publish ig_published.
function makeRecorder() {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  return {
    calls,
    post: async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/media_publish')) return { id: 'ig_published' };
      if (params.media_type === 'CAROUSEL') return { id: 'ig_parent' };
      return { id: `ig_item_${calls.length}` };
    },
  };
}

class TestIg extends InstagramPublisher {
  constructor(private readonly rec: any) { super(fakeConfig()); }
  protected post(url: string, params: Record<string, string>) { return this.rec.post(url, params); }
}

const PAYLOAD: PostPayload = { text: 'Hello', tags: ['food'], source: '' };
const TARGET = { id: 'IG123', token: 'tok' };

test('instagram publishCarousel creates items, a CAROUSEL parent, then publishes', async () => {
  const rec = makeRecorder();
  const ig = new TestIg(rec);

  const id = await ig.publishCarousel(PAYLOAD, ['u1', 'u2', 'u3'], TARGET);

  // 3 item containers + 1 parent + 1 publish = 5 calls
  assert.equal(rec.calls.length, 5);

  const items = rec.calls.slice(0, 3);
  for (const [i, c] of items.entries()) {
    assert.ok(c.url.endsWith('/IG123/media'), `item ${i} hits /media`);
    assert.equal(c.params.image_url, ['u1', 'u2', 'u3'][i]);
    assert.equal(c.params.is_carousel_item, 'true');
    assert.equal(c.params.access_token, 'tok');
  }

  const parent = rec.calls[3];
  assert.ok(parent.url.endsWith('/IG123/media'));
  assert.equal(parent.params.media_type, 'CAROUSEL');
  assert.equal(parent.params.children, 'ig_item_1,ig_item_2,ig_item_3');
  // buildCaption('Hello', ['food'], { maxLen: 2200, maxTags: 30 }) appends the hashtag.
  assert.equal(parent.params.caption, 'Hello\n\n#food');

  const pub = rec.calls[4];
  assert.ok(pub.url.endsWith('/IG123/media_publish'));
  assert.equal(pub.params.creation_id, 'ig_parent');

  assert.equal(id, 'ig_published');
});

// (The caption assertion above uses the exact buildCaption output 'Hello\n\n#food'.)

test('instagram publishCarousel rejects when an item container fails (no parent/publish)', async () => {
  const calls: any[] = [];
  class FailIg extends InstagramPublisher {
    constructor() { super(fakeConfig()); }
    protected post(url: string, params: Record<string, string>) {
      calls.push({ url, params });
      if (params.is_carousel_item === 'true' && calls.length === 2) throw new Error('bad media');
      return Promise.resolve({ id: 'x' });
    }
  }
  await assert.rejects(() => new FailIg().publishCarousel(PAYLOAD, ['u1', 'u2'], TARGET), /bad media/);
  // only the 2 item attempts happened — no CAROUSEL parent, no publish
  assert.equal(calls.length, 2);
  assert.ok(!calls.some(c => c.params.media_type === 'CAROUSEL'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx tsx --test apps/automation/src/publishers/instagram.carousel.test.ts
```
Expected: FAIL — `publishCarousel` inherited default throws `"instagram does not support carousel publishing"` (or a `post` access error), i.e. the assertions fail.

- [ ] **Step 3: Add the seam + implementation**

Edit `apps/automation/src/publishers/instagram.publisher.ts`. Add imports for the helpers at the top (extend the existing import lines):

```ts
import { assertCarouselSize, joinChildren } from './meta-carousel';
```

Inside the class, add a `protected post` seam and the `publishCarousel` method (place after the existing `publish` method):

```ts
  /** Graph POST seam — overridable in tests. */
  protected post(url: string, params: Record<string, string>): Promise<any> {
    return graphPost(url, params, graphTimeout(this.config), params.access_token);
  }

  async publishCarousel(payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Instagram carousel: missing access token');
    assertCarouselSize(imageUrls.length, 10, 'instagram');

    const caption = buildCaption(payload.text, payload.tags, { maxLen: 2200, maxTags: 30 });
    const ver = graphVersion(this.config);
    const root = `${FACEBOOK_GRAPH}/${ver}/${target.id}`;

    // Step 1: one item container per image.
    const children: string[] = [];
    for (const url of imageUrls) {
      const item = await this.post(`${root}/media`,
        { image_url: url, is_carousel_item: 'true', access_token: token });
      const itemId = String(item.id ?? '');
      if (!itemId) throw new Error('Instagram carousel: no item container id');
      children.push(itemId);
    }

    // Step 2: the CAROUSEL parent container.
    const parent = await this.post(`${root}/media`,
      { media_type: 'CAROUSEL', children: joinChildren(children), caption, access_token: token });
    const creationId = String(parent.id ?? '');
    if (!creationId) throw new Error('Instagram carousel: no parent creation id');

    // Step 3: publish.
    const published = await this.post(`${root}/media_publish`,
      { creation_id: creationId, access_token: token });
    return String(published.id ?? creationId);
  }
```

Note: `graphTimeout` is already imported in this file. Confirm `graphTimeout` is in the existing import list from `./meta-graph.util`; it is (`FACEBOOK_GRAPH, graphPost, graphTimeout, graphVersion`).

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx tsx --test apps/automation/src/publishers/instagram.carousel.test.ts
```
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/instagram.publisher.ts apps/automation/src/publishers/instagram.carousel.test.ts
git commit -m "feat(carousel): InstagramPublisher.publishCarousel"
```

---

## Task 4: Threads carousel

**Files:**
- Modify: `apps/automation/src/publishers/threads.publisher.ts`
- Test: `apps/automation/src/publishers/threads.carousel.test.ts`

The Threads publisher already imports `THREADS_GRAPH, graphPost, graphTimeout, threadsVersion`
and `buildCaption`.

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/threads.carousel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadsPublisher } from './threads.publisher';
import type { PostPayload } from '../common/types';

function fakeConfig() { return { get: () => undefined } as any; }

function makeRecorder() {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  return {
    calls,
    post: async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/threads_publish')) return { id: 'th_published' };
      if (params.media_type === 'CAROUSEL') return { id: 'th_parent' };
      return { id: `th_item_${calls.length}` };
    },
  };
}

class TestTh extends ThreadsPublisher {
  constructor(private readonly rec: any) { super(fakeConfig()); }
  protected post(url: string, params: Record<string, string>) { return this.rec.post(url, params); }
}

const PAYLOAD: PostPayload = { text: 'Hello', tags: ['food'], source: '' };
const TARGET = { id: 'TH123', token: 'tok' };

test('threads publishCarousel creates IMAGE items, a CAROUSEL parent, then publishes', async () => {
  const rec = makeRecorder();
  const th = new TestTh(rec);

  const id = await th.publishCarousel(PAYLOAD, ['u1', 'u2', 'u3'], TARGET);

  assert.equal(rec.calls.length, 5);

  const items = rec.calls.slice(0, 3);
  for (const [i, c] of items.entries()) {
    assert.ok(c.url.endsWith('/TH123/threads'), `item ${i} hits /threads`);
    assert.equal(c.params.media_type, 'IMAGE');
    assert.equal(c.params.image_url, ['u1', 'u2', 'u3'][i]);
    assert.equal(c.params.is_carousel_item, 'true');
    assert.equal(c.params.access_token, 'tok');
  }

  const parent = rec.calls[3];
  assert.ok(parent.url.endsWith('/TH123/threads'));
  assert.equal(parent.params.media_type, 'CAROUSEL');
  assert.equal(parent.params.children, 'th_item_1,th_item_2,th_item_3');
  assert.equal(parent.params.text, 'Hello'); // Threads maxTags 0 → no hashtags appended

  const pub = rec.calls[4];
  assert.ok(pub.url.endsWith('/TH123/threads_publish'));
  assert.equal(pub.params.creation_id, 'th_parent');

  assert.equal(id, 'th_published');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx tsx --test apps/automation/src/publishers/threads.carousel.test.ts
```
Expected: FAIL — default `publishCarousel` throws / assertions fail.

- [ ] **Step 3: Add the seam + implementation**

Edit `apps/automation/src/publishers/threads.publisher.ts`. Add the helper import:

```ts
import { assertCarouselSize, joinChildren } from './meta-carousel';
```

Add the seam + method after the existing `publish`:

```ts
  /** Graph POST seam — overridable in tests. */
  protected post(url: string, params: Record<string, string>): Promise<any> {
    return graphPost(url, params, graphTimeout(this.config), params.access_token);
  }

  async publishCarousel(payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Threads carousel: missing access token');
    assertCarouselSize(imageUrls.length, 20, 'threads');

    const text = buildCaption(payload.text, payload.tags, { maxLen: 500, maxTags: 0 });
    const ver = threadsVersion(this.config);
    const root = `${THREADS_GRAPH}/${ver}/${target.id}`;

    // Step 1: one IMAGE item container per image.
    const children: string[] = [];
    for (const url of imageUrls) {
      const item = await this.post(`${root}/threads`,
        { media_type: 'IMAGE', image_url: url, is_carousel_item: 'true', access_token: token });
      const itemId = String(item.id ?? '');
      if (!itemId) throw new Error('Threads carousel: no item container id');
      children.push(itemId);
    }

    // Step 2: the CAROUSEL parent container.
    const parent = await this.post(`${root}/threads`,
      { media_type: 'CAROUSEL', children: joinChildren(children), text, access_token: token });
    const creationId = String(parent.id ?? '');
    if (!creationId) throw new Error('Threads carousel: no parent creation id');

    // Step 3: publish.
    const published = await this.post(`${root}/threads_publish`,
      { creation_id: creationId, access_token: token });
    return String(published.id ?? creationId);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx tsx --test apps/automation/src/publishers/threads.carousel.test.ts
```
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/threads.publisher.ts apps/automation/src/publishers/threads.carousel.test.ts
git commit -m "feat(carousel): ThreadsPublisher.publishCarousel"
```

---

## Task 5: Facebook album

**Files:**
- Modify: `apps/automation/src/publishers/facebook.publisher.ts`
- Test: `apps/automation/src/publishers/facebook.carousel.test.ts`

The FB publisher already imports `FACEBOOK_GRAPH, graphPost, graphTimeout, graphVersion`
and `buildCaption`.

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/facebook.carousel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookPublisher } from './facebook.publisher';
import { fbAttachedMedia } from './meta-carousel';
import type { PostPayload } from '../common/types';

function fakeConfig() { return { get: () => undefined } as any; }

function makeRecorder() {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  return {
    calls,
    post: async (url: string, params: Record<string, string>) => {
      calls.push({ url, params });
      if (url.endsWith('/feed')) return { id: 'fb_post', post_id: 'fb_post' };
      return { id: `fb_photo_${calls.length}` };
    },
  };
}

class TestFb extends FacebookPublisher {
  constructor(private readonly rec: any) { super(fakeConfig()); }
  protected post(url: string, params: Record<string, string>) { return this.rec.post(url, params); }
}

const PAYLOAD: PostPayload = { text: 'Hello', tags: ['food'], source: '' };
const TARGET = { id: 'PAGE123', token: 'tok' };

test('facebook publishCarousel uploads unpublished photos then a feed post with attached_media', async () => {
  const rec = makeRecorder();
  const fb = new TestFb(rec);

  const id = await fb.publishCarousel(PAYLOAD, ['u1', 'u2', 'u3'], TARGET);

  assert.equal(rec.calls.length, 4); // 3 photos + 1 feed

  const photos = rec.calls.slice(0, 3);
  for (const [i, c] of photos.entries()) {
    assert.ok(c.url.endsWith('/PAGE123/photos'), `photo ${i} hits /photos`);
    assert.equal(c.params.url, ['u1', 'u2', 'u3'][i]);
    assert.equal(c.params.published, 'false');
    assert.equal(c.params.access_token, 'tok');
  }

  const feed = rec.calls[3];
  assert.ok(feed.url.endsWith('/PAGE123/feed'));
  assert.equal(feed.params.message, 'Hello'); // FB maxTags 0 → no hashtags
  assert.equal(feed.params.attached_media, fbAttachedMedia(['fb_photo_1', 'fb_photo_2', 'fb_photo_3']));

  assert.equal(id, 'fb_post');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx tsx --test apps/automation/src/publishers/facebook.carousel.test.ts
```
Expected: FAIL — default `publishCarousel` throws / assertions fail.

- [ ] **Step 3: Add the seam + implementation**

Edit `apps/automation/src/publishers/facebook.publisher.ts`. Add the helper import:

```ts
import { assertCarouselSize, fbAttachedMedia } from './meta-carousel';
```

Add the seam + method after the existing `publish`:

```ts
  /** Graph POST seam — overridable in tests. */
  protected post(url: string, params: Record<string, string>): Promise<any> {
    return graphPost(url, params, graphTimeout(this.config), params.access_token);
  }

  async publishCarousel(payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Facebook album: missing access token');
    assertCarouselSize(imageUrls.length, 10, 'facebook');

    const caption = buildCaption(payload.text, payload.tags, { maxLen: 60000, maxTags: 0 });
    const ver = graphVersion(this.config);
    const base = `${FACEBOOK_GRAPH}/${ver}/${target.id}`;

    // Step 1: upload each photo unpublished → collect media_fbid.
    const fbids: string[] = [];
    for (const url of imageUrls) {
      const photo = await this.post(`${base}/photos`,
        { url, published: 'false', access_token: token });
      const photoId = String(photo.id ?? '');
      if (!photoId) throw new Error('Facebook album: no photo id');
      fbids.push(photoId);
    }

    // Step 2: a single feed post attaching all photos.
    const post = await this.post(`${base}/feed`,
      { message: caption, attached_media: fbAttachedMedia(fbids), access_token: token });
    return String(post.post_id ?? post.id ?? '');
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx tsx --test apps/automation/src/publishers/facebook.carousel.test.ts
```
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/publishers/facebook.publisher.ts apps/automation/src/publishers/facebook.carousel.test.ts
git commit -m "feat(carousel): FacebookPublisher.publishCarousel (multi-photo album)"
```

---

## Task 6: Dispatcher carousel routing + full verification

**Files:**
- Modify: `apps/automation/src/publishers/publisher-dispatcher.service.ts`
- Test: `apps/automation/src/publishers/publisher-dispatcher.carousel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/publisher-dispatcher.carousel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublisherDispatcher } from './publisher-dispatcher.service';
import type { PostPayload } from '../common/types';

function stub(platform: string) {
  const seen: any = {};
  return {
    platform,
    publish: async () => 'single',
    publishCarousel: async (payload: PostPayload, imageUrls: string[], target: any) => {
      seen.payload = payload; seen.imageUrls = imageUrls; seen.target = target;
      return `${platform}_carousel`;
    },
    seen,
  } as any;
}

const PAYLOAD: PostPayload = { text: 'x', tags: [], source: '' };

test('dispatcher.publishCarousel routes to the platform publisher', async () => {
  const ig = stub('instagram'), fb = stub('facebook'), th = stub('threads');
  const d = new PublisherDispatcher(fb, ig, th);

  const id = await d.publishCarousel('instagram', PAYLOAD, ['u1', 'u2'], { id: 'X', token: 't' });
  assert.equal(id, 'instagram_carousel');
  assert.deepEqual(ig.seen.imageUrls, ['u1', 'u2']);
  assert.equal(ig.seen.target.id, 'X');
});

test('dispatcher.publishCarousel throws for an unknown platform', async () => {
  const ig = stub('instagram'), fb = stub('facebook'), th = stub('threads');
  const d = new PublisherDispatcher(fb, ig, th);
  await assert.rejects(
    () => d.publishCarousel('tiktok' as any, PAYLOAD, ['u1', 'u2'], { id: 'X' }),
    /No publisher for platform tiktok/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx tsx --test apps/automation/src/publishers/publisher-dispatcher.carousel.test.ts
```
Expected: FAIL — `d.publishCarousel` is not a function.

- [ ] **Step 3: Add the dispatcher method**

Edit `apps/automation/src/publishers/publisher-dispatcher.service.ts`. After the existing
`publish` method (before the closing brace of the class), add:

```ts
  publishCarousel(platform: MetaPlatform, payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
    const publisher = this.byPlatform[platform];
    if (!publisher) throw new Error(`No publisher for platform ${platform}`);
    return publisher.publishCarousel(payload, imageUrls, target);
  }
```

(`PostPayload`, `PublishTarget`, `MetaPlatform` are already imported in this file.)

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx tsx --test apps/automation/src/publishers/publisher-dispatcher.carousel.test.ts
```
Expected: PASS — 2 tests.

- [ ] **Step 5: Typecheck the whole automation app**

Run:
```bash
cd apps/automation && npx tsc --noEmit -p tsconfig.json
```
Expected: no NEW errors referencing any publisher file or `meta-carousel`. (Pre-existing unrelated errors, if any, are out of scope — confirm none reference the changed files.)

- [ ] **Step 6: Run the full automation unit-test suite**

Run from the repo root:
```bash
find apps/automation/src -name '*.test.ts' -print0 | xargs -0 npx tsx --test
```
Expected: the new carousel tests pass (meta-carousel 5, instagram 2, threads 1, facebook 1, dispatcher 2 = 11). The existing suite is unaffected. NOTE: there are 6 pre-existing failing tests on `develop` unrelated to this change (`count-eligible`, `strategies.controller.*`, `meta-accounts.controller.history`, `teleads.client`, `meta-follower-history.repository`); confirm the count of failures did not increase beyond those 6.

- [ ] **Step 7: Build to confirm everything compiles**

Run:
```bash
cd apps/automation && npm run build
```
Expected: `nest build` completes with no errors. (Build only — do not start the service.)

- [ ] **Step 8: Commit**

```bash
git add apps/automation/src/publishers/publisher-dispatcher.service.ts apps/automation/src/publishers/publisher-dispatcher.carousel.test.ts
git commit -m "feat(carousel): PublisherDispatcher.publishCarousel routing"
```

---

## Done criteria

- `PublisherDispatcher.publishCarousel(platform, payload, imageUrls, target)` routes to the right Meta publisher; an unknown platform throws.
- Instagram and Threads build N item containers → a CAROUSEL parent → publish; Facebook uploads N unpublished photos → one feed post with `attached_media`.
- `assertCarouselSize` guards the item count; `graphPost` redacts tokens on error; partial failures throw before the parent/feed post.
- All new tests pass with no live network; `npm run build` succeeds; `publishers.module.ts` unchanged; single-image `publish()` and Telegram untouched.
- Sub-project 4 (the strategy) can now call `dispatcher.publishCarousel` with the hosted slide URLs from sub-project 2.
