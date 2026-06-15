# TikTok Destination Routing + Strategy Capability Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `platform='tiktok'` a first-class binding destination that routes the recipe-carousel strategy to TikTok at 9:16, plus a backend strategy→supportedPlatforms capability map enforced in the binding API.

**Architecture:** Mirror the existing Meta destination plumbing for `tiktok` — a binding column + CHECK, a `DestinationResolver` branch, a recipe-carousel tiktok branch (9:16 + `TikTokCarouselPublisher` from 5b), and an optional `supportedPlatforms` declaration on strategies surfaced via a new `GET /api/strategies/types` and enforced by the binding DTO. TikTok's token is resolved at publish time (not in the destination).

**Tech Stack:** NestJS 10, pg, `node:test` via `cd apps/automation && npm test`.

---

## Context for the implementer

This is **sub-project 5c** of the TikTok integration; 5a (accounts+tokens) and 5b
(content client + `TikTokCarouselPublisher`) are on this branch's ancestry
(`feat/tiktok-publisher`). Read:

- `apps/automation/src/config/strategy-bindings.repository.ts` — row/insert/update + SELECT lists (you add `tiktok_account_id` everywhere `meta_account_id` appears).
- `apps/automation/src/common/content-strategy/publish-destination.ts` — `DestinationPlatform`, `PublishDestination`.
- `apps/automation/src/common/content-strategy/destination-resolver.service.ts` — the resolver (you add a tiktok branch; it injects `MetaAccountsRepository` already).
- `apps/automation/src/config/channel-config.service.ts` — `ResolvedStrategyBinding` + `resolveStrategyBindings()`.
- `apps/automation/src/common/content-strategy/content-strategy.interface.ts` — `ContentStrategy` (add optional `supportedPlatforms`).
- `apps/automation/src/common/content-strategy/content-strategy.registry.ts` — `get/all/types` (add `supportedPlatforms`).
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts` — meta-only today; add a tiktok branch + declare `supportedPlatforms`.
- `apps/automation/src/config/api/strategies.controller.ts` + `dto/strategies.dto.ts` — binding API.
- `apps/automation/src/config/tiktok-accounts.repository.ts` — `TikTokAccountsRepository.findById` (5a, exported by @Global ChannelConfigModule).
- `apps/automation/src/publishers/tiktok/tiktok-carousel.publisher.ts` — `TikTokCarouselPublisher.publishCarousel(accountId, imageUrls, caption)` (5b, exported by @Global PublishersModule).

Rules:
- Tests run with `cd apps/automation && npm test`. Never run tsx from the repo root.
- No live network in tests; mock collaborators / use fake pools. No service restart. No new dependency.
- Telegram + Meta paths must stay behavior-unchanged (additive only). The recipe-carousel meta branch must keep working.

Spec: `docs/superpowers/specs/2026-06-15-tiktok-strategy-routing-design.md`.

## File Structure

- `database/migrations/024_strategy_binding_tiktok.sql` — column + CHECKs. New.
- `apps/automation/src/config/strategy-bindings.repository.ts` — `tiktok_account_id`. Modify.
- `apps/automation/src/config/strategy-bindings.repository.carousel.test.ts` — fake-pool test. New.
- `apps/automation/src/common/content-strategy/content-strategy.interface.ts` — `supportedPlatforms?`. Modify.
- `apps/automation/src/common/content-strategy/content-strategy.registry.ts` — `supportedPlatforms(type)`. Modify.
- `apps/automation/src/common/content-strategy/content-strategy.registry.test.ts` — registry test. New.
- `apps/automation/src/common/content-strategy/publish-destination.ts` — add `'tiktok'`. Modify.
- `apps/automation/src/config/channel-config.service.ts` — `tiktokAccountId`. Modify.
- `apps/automation/src/common/content-strategy/destination-resolver.service.ts` — tiktok branch. Modify.
- `apps/automation/src/common/content-strategy/destination-resolver.tiktok.test.ts` — resolver test. New.
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts` — tiktok branch + `supportedPlatforms`. Modify.
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel.tiktok.test.ts` — tiktok-branch test. New.
- `apps/automation/src/strategies/{recipes,ai0-prompts/...,curated-prompts/...}` — declare `supportedPlatforms`. Modify (3 strategy classes).
- `apps/automation/src/config/api/dto/strategies.dto.ts` — `tiktok` platform + `tiktok_account_id`. Modify.
- `apps/automation/src/config/api/strategies.controller.ts` — tiktok invariant + `supportedPlatforms` check + `GET /types`. Modify.
- `apps/automation/src/config/config.module.ts` — controller's new deps already global; confirm no change needed.

---

## Task 1: Migration 024 + repository `tiktok_account_id`

**Files:**
- Create: `database/migrations/024_strategy_binding_tiktok.sql`
- Modify: `apps/automation/src/config/strategy-bindings.repository.ts`
- Test: `apps/automation/src/config/strategy-bindings.repository.carousel.test.ts`

- [ ] **Step 1: Create the migration**

Create `database/migrations/024_strategy_binding_tiktok.sql`:

```sql
-- 024_strategy_binding_tiktok.sql — TikTok as a first-class binding destination.
ALTER TABLE strategy_bindings
  ADD COLUMN IF NOT EXISTS tiktok_account_id UUID REFERENCES tiktok_accounts(id);

-- Widen the platform CHECK to include 'tiktok'. The 020 CHECK is unnamed; drop it
-- by introspection (the platform-IN check references 'telegram' but not channel_id).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'strategy_bindings'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%platform%'
     AND pg_get_constraintdef(oid) ILIKE '%telegram%'
     AND pg_get_constraintdef(oid) NOT ILIKE '%channel_id%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE strategy_bindings DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE strategy_bindings
  ADD CONSTRAINT strategy_bindings_platform_check
  CHECK (platform IN ('telegram','instagram','facebook','threads','tiktok'));

-- Replace the destination invariant to cover tiktok (exactly one destination kind).
ALTER TABLE strategy_bindings DROP CONSTRAINT IF EXISTS strategy_binding_destination_chk;
ALTER TABLE strategy_bindings
  ADD CONSTRAINT strategy_binding_destination_chk CHECK (
       (platform =  'telegram' AND channel_id IS NOT NULL AND meta_account_id IS NULL AND tiktok_account_id IS NULL)
    OR (platform IN ('instagram','facebook','threads') AND meta_account_id IS NOT NULL AND tiktok_account_id IS NULL)
    OR (platform =  'tiktok' AND tiktok_account_id IS NOT NULL AND meta_account_id IS NULL)
  );
```

- [ ] **Step 2: Write the failing repo test**

Create `apps/automation/src/config/strategy-bindings.repository.carousel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyBindingsRepository } from './strategy-bindings.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [{ id: 'b1' }], rowCount: 1 }; } };
  return { pool, calls };
}

test('insert writes tiktok_account_id and selects it back', async () => {
  const { pool, calls } = fakePool();
  const repo = new StrategyBindingsRepository(pool as any);
  await repo.insert({
    ext_id: 'recipe-carousel:tt', type: 'recipe-carousel', schedule: '0 * * * *',
    params: {}, platform: 'tiktok', tiktok_account_id: 'tt-acc-1',
  });
  const { sql, params } = calls[0];
  assert.match(sql, /tiktok_account_id/);
  assert.ok(params.includes('tt-acc-1'));
});

test('list selects tiktok_account_id', async () => {
  const { pool, calls } = fakePool();
  const repo = new StrategyBindingsRepository(pool as any);
  await repo.list();
  assert.match(calls[0].sql, /tiktok_account_id/);
});
```

- [ ] **Step 3: Run it (fails)**

Run (from `apps/automation`): `npx tsx --test src/config/strategy-bindings.repository.carousel.test.ts`
Expected: FAIL — `insert` doesn't reference `tiktok_account_id` / type error on the input.

- [ ] **Step 4: Update the repository**

In `apps/automation/src/config/strategy-bindings.repository.ts`:

(a) Widen the `platform` union in `StrategyBindingRow`, `StrategyBindingInsertInput`, and the `update()` patch param type to include `'tiktok'`, and add `tiktok_account_id` fields:

```ts
  platform:    'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok';
  meta_account_id: string | null;
  tiktok_account_id: string | null;
```
(add `tiktok_account_id?: string | null;` to `StrategyBindingInsertInput` and to the `update()` patch type, and `'tiktok'` to its `platform?` union too.)

(b) Add `tiktok_account_id` to EVERY `SELECT`/`RETURNING` column list in the file (`list`, `findById`, `findByExtId`, `insert` RETURNING, `update` RETURNING) — append `, tiktok_account_id` after `meta_account_id`.

(c) `insert()` — add the column, a `$9` value, and the param:

```ts
      `INSERT INTO strategy_bindings
         (ext_id, type, channel_id, schedule, params, enabled, platform, meta_account_id, tiktok_account_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, true), COALESCE($7, 'telegram'), $8, $9)
       RETURNING id, ext_id, type, channel_id, schedule, params, enabled, notes,
                 low_content_threshold, platform, meta_account_id, tiktok_account_id`,
      [
        input.ext_id, input.type, input.channel_id ?? null, input.schedule,
        JSON.stringify(input.params), input.enabled ?? true,
        input.platform ?? 'telegram', input.meta_account_id ?? null, input.tiktok_account_id ?? null,
      ],
```

(d) `update()` — add a branch after the `meta_account_id` one:

```ts
    if (patch.tiktok_account_id !== undefined) { sets.push(`tiktok_account_id = $${i++}`); params.push(patch.tiktok_account_id); }
```

- [ ] **Step 5: Run it (passes)**

Run (from `apps/automation`): `npx tsx --test src/config/strategy-bindings.repository.carousel.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add database/migrations/024_strategy_binding_tiktok.sql apps/automation/src/config/strategy-bindings.repository.ts apps/automation/src/config/strategy-bindings.repository.carousel.test.ts
git commit -m "feat(tiktok): 024 binding tiktok_account_id + repository support"
```

---

## Task 2: `supportedPlatforms` capability map

**Files:**
- Modify: `apps/automation/src/common/content-strategy/content-strategy.interface.ts`
- Modify: `apps/automation/src/common/content-strategy/content-strategy.registry.ts`
- Test: `apps/automation/src/common/content-strategy/content-strategy.registry.test.ts`
- Modify (declare `supportedPlatforms`): `recipe-carousel.strategy.ts`, `recipes.strategy.ts`, `ai0-prompts.strategy.ts`, `curated-prompts.strategy.ts`

- [ ] **Step 1: Add the optional interface field**

In `content-strategy.interface.ts`, add the import and the optional member:

```ts
import type { DestinationPlatform } from './publish-destination';
```
and inside `interface ContentStrategy`, after `readonly type: string;`:
```ts
  /** Platforms this strategy can publish to. Absent → ['telegram']. */
  readonly supportedPlatforms?: DestinationPlatform[];
```

- [ ] **Step 2: Write the failing registry test**

Create `apps/automation/src/common/content-strategy/content-strategy.registry.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentStrategyRegistry } from './content-strategy.registry';

function strat(type: string, supportedPlatforms?: string[]) {
  return { type, supportedPlatforms, getSkills: () => [], fetch: async () => null, generate: async () => null } as any;
}

test('supportedPlatforms returns the declared list', () => {
  const r = new ContentStrategyRegistry();
  r.register(strat('recipe-carousel', ['instagram', 'facebook', 'threads', 'tiktok']));
  assert.deepEqual(r.supportedPlatforms('recipe-carousel'), ['instagram', 'facebook', 'threads', 'tiktok']);
});

test('supportedPlatforms defaults to [telegram] when undeclared or unknown', () => {
  const r = new ContentStrategyRegistry();
  r.register(strat('ai0-news'));
  assert.deepEqual(r.supportedPlatforms('ai0-news'), ['telegram']);
  assert.deepEqual(r.supportedPlatforms('does-not-exist'), ['telegram']);
});
```

- [ ] **Step 3: Run it (fails)**

Run (from `apps/automation`): `npx tsx --test src/common/content-strategy/content-strategy.registry.test.ts`
Expected: FAIL — `supportedPlatforms` is not a function.

- [ ] **Step 4: Add the registry method**

In `content-strategy.registry.ts` add the import and method:

```ts
import type { DestinationPlatform } from './publish-destination';
```
```ts
  /** Platforms a strategy type can target; defaults to ['telegram']. */
  supportedPlatforms(type: string): DestinationPlatform[] {
    return this.strategies.get(type)?.supportedPlatforms ?? ['telegram'];
  }
```

- [ ] **Step 5: Declare on the multi-platform strategies**

Add a `readonly supportedPlatforms` line right after the `readonly type = ...` in each:

- `recipe-carousel.strategy.ts`:
  ```ts
  readonly supportedPlatforms = ['instagram', 'facebook', 'threads', 'tiktok'] as const;
  ```
- `recipes.strategy.ts`, and the ai0-prompts and curated-prompts strategy classes (find the file under `src/strategies/ai0-prompts/` and `src/strategies/curated-prompts/` whose class `implements ContentStrategy`):
  ```ts
  readonly supportedPlatforms = ['telegram', 'instagram', 'facebook', 'threads'] as const;
  ```

(`as const` is assignable to `DestinationPlatform[]` since the literals are valid `DestinationPlatform`s. If tsc complains about readonly-tuple variance, drop `as const` and annotate `: DestinationPlatform[]`.)

- [ ] **Step 6: Run registry test (passes) + typecheck**

Run (from `apps/automation`):
```bash
npx tsx --test src/common/content-strategy/content-strategy.registry.test.ts
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "supportedPlatforms|content-strategy|recipe-carousel|recipes.strategy|prompts.strategy" || echo "no related errors"
```
Expected: 2 tests pass; no related typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/common/content-strategy/content-strategy.interface.ts apps/automation/src/common/content-strategy/content-strategy.registry.ts apps/automation/src/common/content-strategy/content-strategy.registry.test.ts apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts apps/automation/src/strategies/recipes/recipes.strategy.ts apps/automation/src/strategies/ai0-prompts apps/automation/src/strategies/curated-prompts
git commit -m "feat(strategy): supportedPlatforms capability map (default telegram)"
```

---

## Task 3: TikTok destination type + resolver branch

**Files:**
- Modify: `apps/automation/src/common/content-strategy/publish-destination.ts`
- Modify: `apps/automation/src/config/channel-config.service.ts`
- Modify: `apps/automation/src/common/content-strategy/destination-resolver.service.ts`
- Test: `apps/automation/src/common/content-strategy/destination-resolver.tiktok.test.ts`

- [ ] **Step 1: Widen `DestinationPlatform`**

In `publish-destination.ts`:
```ts
export type DestinationPlatform = 'telegram' | MetaPlatform | 'tiktok';
```

- [ ] **Step 2: Thread `tiktokAccountId` through `ResolvedStrategyBinding`**

In `channel-config.service.ts`: add `tiktokAccountId: string | null;` to the `ResolvedStrategyBinding` interface, and in `resolveStrategyBindings()` add `tiktokAccountId: b.tiktok_account_id,` to the mapped object (next to `metaAccountId`).

- [ ] **Step 3: Write the failing resolver test**

Create `apps/automation/src/common/content-strategy/destination-resolver.tiktok.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DestinationResolver } from './destination-resolver.service';

function build(account: any) {
  const tiktok = { findById: async (id: string) => (account && account.id === id ? account : null) };
  // Meta deps unused on the tiktok path; pass minimal stubs.
  const resolver = new DestinationResolver({ findById: async () => null } as any, { get: () => undefined } as any, tiktok as any);
  return resolver;
}

const BINDING = { id: 'b1', platform: 'tiktok', tiktokAccountId: 'tt1', metaAccountId: null, channelId: '' } as any;

test('resolves an active tiktok account to a TT: destination with no token', async () => {
  const r = build({ id: 'tt1', active: true });
  const dest = await r.resolve(BINDING);
  assert.equal(dest.platform, 'tiktok');
  assert.equal(dest.targetId, 'tt1');
  assert.equal(dest.postedKey, 'TT:tt1');
  assert.equal(dest.throttleKey, 'tiktok:tt1');
  assert.equal(dest.token, undefined);
  assert.equal(dest.metaAccountId, null);
});

test('throws when the tiktok account is missing', async () => {
  const r = build({ id: 'other', active: true });
  await assert.rejects(() => r.resolve(BINDING), /not found/i);
});

test('throws when the tiktok account is inactive', async () => {
  const r = build({ id: 'tt1', active: false });
  await assert.rejects(() => r.resolve(BINDING), /inactive/i);
});

test('throws when tiktok binding has no tiktok_account_id', async () => {
  const r = build({ id: 'tt1', active: true });
  await assert.rejects(() => r.resolve({ ...BINDING, tiktokAccountId: null }), /requires a tiktok_account_id/i);
});
```

- [ ] **Step 4: Run it (fails)**

Run (from `apps/automation`): `npx tsx --test src/common/content-strategy/destination-resolver.tiktok.test.ts`
Expected: FAIL — constructor arity / no tiktok branch.

- [ ] **Step 5: Add the resolver branch**

In `destination-resolver.service.ts`:
- Add the import + constructor param:
  ```ts
  import { TikTokAccountsRepository } from '../../config/tiktok-accounts.repository';
  ```
  ```ts
  constructor(
    private readonly metaAccounts: MetaAccountsRepository,
    private readonly config: ConfigService,
    private readonly tiktok: TikTokAccountsRepository,
  ) {}
  ```
- Add this branch BEFORE the meta block (after the telegram block):
  ```ts
  if (b.platform === 'tiktok') {
    if (!b.tiktokAccountId) throw new Error(`binding ${b.id}: platform tiktok requires a tiktok_account_id`);
    const acct = await this.tiktok.findById(b.tiktokAccountId);
    if (!acct) throw new Error(`binding ${b.id}: tiktok account ${b.tiktokAccountId} not found`);
    if (!acct.active) throw new Error(`binding ${b.id}: tiktok account ${acct.id} is inactive`);
    return {
      platform: 'tiktok',
      targetId: acct.id,
      metaAccountId: null,
      postedKey: `TT:${acct.id}`,
      throttleKey: `tiktok:${acct.id}`,
    };
  }
  ```
  (`token` is intentionally omitted — undefined.)

`DestinationResolver` is provided in the @Global `CommonModule`. `TikTokAccountsRepository`
is exported by the @Global `ChannelConfigModule`, so the new constructor dep resolves
without a module change — confirm in Task 6's build.

**Also update the existing resolver test** `destination-resolver.service.test.ts`: its
`make()` does `new DestinationResolver(repo as any, config as any)`. Add a 3rd stub arg so
it still compiles/runs:
```ts
return new DestinationResolver(repo as any, config as any, { findById: async () => null } as any);
```

- [ ] **Step 6: Run it (passes)**

Run (from `apps/automation`): `npx tsx --test src/common/content-strategy/destination-resolver.tiktok.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/common/content-strategy/publish-destination.ts apps/automation/src/config/channel-config.service.ts apps/automation/src/common/content-strategy/destination-resolver.service.ts apps/automation/src/common/content-strategy/destination-resolver.tiktok.test.ts apps/automation/src/common/content-strategy/destination-resolver.service.test.ts
git commit -m "feat(tiktok): DestinationResolver tiktok branch (TT: dedup, no upfront token)"
```

---

## Task 4: recipe-carousel TikTok branch (9:16)

**Files:**
- Modify: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts`
- Test: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.tiktok.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/strategies/recipe-carousel/recipe-carousel.tiktok.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeCarouselStrategy } from './recipe-carousel.strategy';

function makeRow(over = {}) {
  return {
    id: 'r1', title: 'Pommes', image_url: 'https://x/i.jpg', category: 'Французька',
    ingredients: null, instructions: null,
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля', instructions_uk: '1.',
    telegraph_url: null, telegraph_path: null,
    kcal: '85', protein_g: '4', fat_g: '1', carbs_g: '15', serving_size_g: '258', ...over,
  };
}

const TT_DEST = { platform: 'tiktok', targetId: 'tt1', metaAccountId: null, postedKey: 'TT:tt1', throttleKey: 'tiktok:tt1' } as any;

function build(over: any = {}) {
  const calls: any = { rendered: null, renderOpts: null, uploaded: null, published: null, posted: [], deleted: [] };
  const repo = {
    getNextForCarousel: async () => ('row' in over ? over.row : makeRow()),
    markPosted: async (id: string, key: string) => { calls.posted.push([id, key]); },
  };
  const renderer = { render: async (recipe: any, _buf: any, opts: any) => { calls.rendered = recipe; calls.renderOpts = opts; return [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]; } };
  const hosting = {
    upload: async (slides: Buffer[], prefix: string) => { calls.uploaded = { count: slides.length, prefix }; return [{ url: 'u1', path: 'p1' }, { url: 'u2', path: 'p2' }, { url: 'u3', path: 'p3' }]; },
    delete: async (paths: string[]) => { calls.deleted = paths; },
  };
  const dispatcher = { publishCarousel: async () => { throw new Error('meta path must not be used for tiktok'); } };
  const images = { download: async () => over.image === null ? null : Buffer.from('img') };
  const registry = { register() {} };
  const tiktok = { publishCarousel: async (accountId: string, urls: string[], caption: string) => { calls.published = { accountId, urls, caption }; if (over.publishError) throw new Error(over.publishError); return 'pub_1'; } };
  const s = new RecipeCarouselStrategy(repo as any, renderer as any, hosting as any, dispatcher as any, images as any, registry as any, tiktok as any);
  return { s, calls };
}

test('tiktok branch renders 9:16, hosts, publishes via TikTokCarouselPublisher, dedups, deletes', async () => {
  const { s, calls } = build();
  await s.execute('', {}, TT_DEST);
  assert.deepEqual(calls.renderOpts, { width: 1080, height: 1920 });
  assert.equal(calls.uploaded.prefix, 'carousel/tiktok/tt1/r1');
  assert.equal(calls.published.accountId, 'tt1');
  assert.deepEqual(calls.published.urls, ['u1', 'u2', 'u3']);
  assert.match(calls.published.caption, /Пом Анна/);
  assert.deepEqual(calls.posted, [['r1', 'TT:tt1']]);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('tiktok publish error: no markPosted, slides deleted, throws', async () => {
  const { s, calls } = build({ publishError: 'rate limited' });
  await assert.rejects(() => s.execute('', {}, TT_DEST), /Carousel publish \(tiktok\)/);
  assert.equal(calls.posted.length, 0);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('tiktok branch: no eligible recipe returns without publishing', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('', {}, TT_DEST);
  assert.equal(calls.published, null);
  assert.equal(calls.posted.length, 0);
});
```

- [ ] **Step 2: Run it (fails)**

Run (from `apps/automation`): `npx tsx --test src/strategies/recipe-carousel/recipe-carousel.tiktok.test.ts`
Expected: FAIL — constructor arity (no tiktok publisher) / no tiktok branch.

- [ ] **Step 3: Add the tiktok publisher dep + branch**

Edit `recipe-carousel.strategy.ts`:
- Import: `import { TikTokCarouselPublisher } from '../../publishers/tiktok/tiktok-carousel.publisher';`
- Add the constructor param (last):
  ```ts
    private readonly tiktok: TikTokCarouselPublisher,
  ```
- Replace the early guard so telegram returns but tiktok/meta proceed, and add the tiktok branch. Change the top of `execute`:

```ts
  async execute(_channelId: string, _params: StrategyParams, dest?: PublishDestination): Promise<void> {
    if (!dest || dest.platform === 'telegram') {
      this.logger.warn('recipe-carousel is Meta/TikTok-only — no Telegram destination');
      return;
    }

    if (dest.platform === 'tiktok') {
      const row = await this.repo.getNextForCarousel(dest.postedKey);
      if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }
      const recipe = toCarouselRecipe(row);
      const caption = buildCarouselCaption(row);
      const imageBuffer = await this.images.download(row.image_url);
      if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);
      const slides = await this.renderer.render(recipe, imageBuffer, { width: 1080, height: 1920 });
      const hosted = await this.hosting.upload(slides, `carousel/tiktok/${dest.targetId}/${row.id}`);
      try {
        const id = await this.tiktok.publishCarousel(dest.targetId, hosted.map(h => h.url), caption);
        await this.repo.markPosted(row.id, dest.postedKey);
        this.logger.debug(`Published carousel ${row.id} → tiktok (${id})`);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.error(`TikTok carousel failed (${row.id}): ${msg}`);
        throw new Error(`Carousel publish (tiktok): ${msg}`);
      } finally {
        await this.hosting.delete(hosted.map(h => h.path));
      }
      return;
    }

    // Meta branch (unchanged below)
    if (!dest.token) {
      this.logger.error(`Carousel skipped: token missing for ${dest.platform}`);
      return;
    }
    // ... existing meta-branch body stays exactly as-is ...
```

Keep the entire existing meta-branch body (the `getNextForCarousel` → render (default 4:5)
→ host → `dispatcher.publishCarousel` → markPosted/permanent-error → delete) unchanged
after the `if (!dest.token)` guard.

- [ ] **Step 4: Run it (passes) — and the existing meta test still passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/strategies/recipe-carousel/recipe-carousel.tiktok.test.ts
npx tsx --test src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts
```
Expected: tiktok test 3 pass; the existing meta strategy test still passes (its `build()` constructs the strategy with positional args — add a 7th `tiktok` stub arg there if tsc/runtime needs it; if the existing test omits the 7th arg, update its `build()` to pass a `{ publishCarousel: async () => 'x' }` stub so construction still works).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts apps/automation/src/strategies/recipe-carousel/recipe-carousel.tiktok.test.ts apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts
git commit -m "feat(tiktok): recipe-carousel tiktok branch — 9:16 render + TikTokCarouselPublisher"
```

---

## Task 5: Binding API — tiktok DTO, invariant, `GET /types`

**Files:**
- Modify: `apps/automation/src/config/api/dto/strategies.dto.ts`
- Modify: `apps/automation/src/config/api/strategies.controller.ts`

- [ ] **Step 1: Extend the DTOs**

In `strategies.dto.ts`, for BOTH `CreateStrategyDto` and `PatchStrategyDto`: widen the
`@IsIn([...])` list and the `platform?` type to include `'tiktok'`, and add a
`tiktok_account_id` field mirroring `meta_account_id`:

```ts
  @IsOptional()
  @IsIn(['telegram', 'instagram', 'facebook', 'threads', 'tiktok'])
  platform?: 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok';

  @IsOptional()
  @IsUUID()
  tiktok_account_id?: string;
```

- [ ] **Step 2: Inject the registry + tiktok repo into the controller**

In `strategies.controller.ts` add imports + constructor params:
```ts
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TikTokAccountsRepository } from '../tiktok-accounts.repository';
```
```ts
    private readonly registry: ContentStrategyRegistry,
    private readonly tiktokAccounts: TikTokAccountsRepository,
```
(Both are exported by @Global modules — no module wiring change.)

- [ ] **Step 3: Add the `GET /api/strategies/types` endpoint**

Add a method to the controller:
```ts
  @Get('types')
  listTypes() {
    return this.registry.types().map(type => ({
      type,
      supportedPlatforms: this.registry.supportedPlatforms(type),
    }));
  }
```
NOTE: place this BEFORE any `@Get(':id'...)`-style routes are matched. The existing
`@Get()` (list) and `@Get(':id/runs')`/`@Get(':id/preview')` don't collide with the literal
`types` path, but to be safe declare `listTypes()` immediately after the `list()` `@Get()`
method.

- [ ] **Step 4: Extend the create() invariant**

In `create()`, replace the `platform === 'telegram' … else …` destination block with a
three-way branch and add the capability check. After `const platform = body.platform ?? 'telegram';`:

```ts
    const supported = this.registry.supportedPlatforms(body.type);
    if (!supported.includes(platform)) {
      throw new BadRequestException(`strategy ${body.type} does not support platform ${platform}`);
    }

    if (platform === 'telegram') {
      if (!body.channel_id) throw new BadRequestException('channel_id is required for a telegram binding');
      if (!this.cache.getChannelById(body.channel_id)) throw new BadRequestException(`channel_id ${body.channel_id} not found`);
      if (body.meta_account_id) throw new BadRequestException('telegram binding must not set meta_account_id');
      if (body.tiktok_account_id) throw new BadRequestException('telegram binding must not set tiktok_account_id');
    } else if (platform === 'tiktok') {
      if (!body.tiktok_account_id) throw new BadRequestException('tiktok_account_id is required for a tiktok binding');
      const acct = await this.tiktokAccounts.findById(body.tiktok_account_id);
      if (!acct) throw new BadRequestException(`tiktok account ${body.tiktok_account_id} not found`);
      if (body.channel_id) throw new BadRequestException('tiktok binding must not set channel_id');
      if (body.meta_account_id) throw new BadRequestException('tiktok binding must not set meta_account_id');
    } else {
      if (!body.meta_account_id) throw new BadRequestException('meta_account_id is required for a meta binding');
      const acct = await this.metaAccounts.findById(body.meta_account_id);
      if (!acct) throw new BadRequestException(`meta account ${body.meta_account_id} not found`);
      if (body.channel_id) throw new BadRequestException('meta binding must not set channel_id');
      if (body.tiktok_account_id) throw new BadRequestException('meta binding must not set tiktok_account_id');
    }
```

And update the `repo.insert({...})` call to thread the destination columns:
```ts
      channel_id: platform === 'telegram' ? body.channel_id! : null,
      platform,
      meta_account_id: platform === 'instagram' || platform === 'facebook' || platform === 'threads' ? body.meta_account_id! : null,
      tiktok_account_id: platform === 'tiktok' ? body.tiktok_account_id! : null,
```

- [ ] **Step 5: Write a controller test**

Create `apps/automation/src/config/api/strategies.controller.tiktok.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function build(over: any = {}) {
  const inserted: any[] = [];
  const repo = { findByExtId: async () => null, insert: async (r: any) => { inserted.push(r); return { id: 'b1', ...r }; } };
  const registry = {
    types: () => ['recipe-carousel', 'ai0-news'],
    supportedPlatforms: (t: string) => t === 'recipe-carousel' ? ['instagram', 'facebook', 'threads', 'tiktok'] : ['telegram'],
  };
  const tiktokAccounts = { findById: async (id: string) => (id === 'tt1' ? { id: 'tt1', active: true } : null) };
  const cache = { getChannelById: () => ({ id: 'c' }) };
  const publisher = { publish: async () => {} };
  const c = new StrategiesController(
    repo as any, {} as any, {} as any, cache as any, publisher as any,
    {} as any, {} as any, { findById: async () => null } as any, registry as any, tiktokAccounts as any,
  );
  return { c, inserted };
}

test('GET /types returns supportedPlatforms per strategy', () => {
  const { c } = build();
  const types = c.listTypes();
  assert.deepEqual(types.find((t: any) => t.type === 'recipe-carousel').supportedPlatforms, ['instagram', 'facebook', 'threads', 'tiktok']);
});

test('create a tiktok binding inserts tiktok_account_id', async () => {
  const { c, inserted } = build();
  await c.create({ ext_id: 'recipe-carousel:tt', type: 'recipe-carousel', platform: 'tiktok', tiktok_account_id: 'tt1', schedule: '0 * * * *' } as any);
  assert.equal(inserted[0].platform, 'tiktok');
  assert.equal(inserted[0].tiktok_account_id, 'tt1');
});

test('rejects a strategy that does not support the platform', async () => {
  const { c } = build();
  await assert.rejects(() => c.create({ ext_id: 'ai0-news:tt', type: 'ai0-news', platform: 'tiktok', tiktok_account_id: 'tt1', schedule: '0 * * * *' } as any), /does not support platform tiktok/);
});

test('rejects a tiktok binding with an unknown account', async () => {
  const { c } = build();
  await assert.rejects(() => c.create({ ext_id: 'recipe-carousel:tt', type: 'recipe-carousel', platform: 'tiktok', tiktok_account_id: 'nope', schedule: '0 * * * *' } as any), /tiktok account nope not found/);
});
```

(Adjust the positional constructor stubs in `build()` to match the controller's real
constructor order: repo, runsRepo, preview, cache, publisher, crossposts, runway,
metaAccounts, registry, tiktokAccounts. The `assertCronOrThrow` runs first with a valid
cron, so the schedule above passes.)

- [ ] **Step 6: Fix the existing controller tests for the new constructor deps**

The new required constructor params (`registry`, `tiktokAccounts`, positions 9 & 10) break
the two existing controller tests, which construct with 8 positional args. Update both so
they still compile and pass — add the two stubs as the last args:

In `strategies.controller.dest.test.ts` (its `build()` ends `... metaAccounts as any,`):
```ts
    metaAccounts as any,
    { types: () => [], supportedPlatforms: () => ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'] } as any, // registry
    { findById: async () => null } as any, // tiktokAccounts
  );
```
In `strategies.controller.list.test.ts` (its ctor ends `... metaAccounts as any,`):
```ts
    crossposts as any, runway as any, metaAccounts as any,
    { types: () => [], supportedPlatforms: () => ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'] } as any,
    { findById: async () => null } as any,
  );
```
The permissive `supportedPlatforms` stub keeps their existing telegram/meta create cases
passing (the new `supported.includes(platform)` check sees the platform as supported).

- [ ] **Step 7: Run the controller tests (pass)**

Run (from `apps/automation`):
```bash
npx tsx --test src/config/api/strategies.controller.tiktok.test.ts
npx tsx --test src/config/api/strategies.controller.dest.test.ts
npx tsx --test src/config/api/strategies.controller.list.test.ts
```
Expected: the new test (4) passes; the two existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add apps/automation/src/config/api/dto/strategies.dto.ts apps/automation/src/config/api/strategies.controller.ts apps/automation/src/config/api/strategies.controller.tiktok.test.ts apps/automation/src/config/api/strategies.controller.dest.test.ts apps/automation/src/config/api/strategies.controller.list.test.ts
git commit -m "feat(tiktok): binding API — tiktok destination + supportedPlatforms guard + GET /types"
```

---

## Task 6: Full verification

- [ ] **Step 1: Typecheck**

Run (from `apps/automation`): `npx tsc --noEmit -p tsconfig.json`
Expected: clean (no new errors).

- [ ] **Step 2: Full suite**

Run (from `apps/automation`): `npm test`
Expected: all pass, including the new tests (repo 2, registry 2, resolver 4, strategy-tiktok 3, controller 4) and the unchanged existing suites.

- [ ] **Step 3: Build**

Run (from `apps/automation`): `npm run build`
Expected: `nest build` completes with no errors — confirms `DestinationResolver`
(new `TikTokAccountsRepository` dep) and `StrategiesController` (new `ContentStrategyRegistry`
+ `TikTokAccountsRepository` deps) resolve through the @Global modules.

- [ ] **Step 4: Commit (if anything was touched during verification)**

```bash
git status --porcelain   # if clean, nothing to commit
```

---

## Done criteria

- A `platform='tiktok'` binding with a `tiktok_account_id` resolves to a `TT:<id>`
  destination and routes the recipe-carousel strategy to render 9:16 → host →
  `TikTokCarouselPublisher` → `markPosted('TT:<id>')` → delete.
- The binding API accepts/validates tiktok bindings and rejects platform/strategy
  mismatches; `GET /api/strategies/types` exposes `supportedPlatforms` for the 5d dashboard.
- Telegram + Meta paths are unchanged; all tests pass via `cd apps/automation && npm test`;
  `npm run build` succeeds; no new dependency.
- Sub-project 5d (dashboard form Destination→Type + filtered Type + TikTok account selector
  + web OAuth) is the only remaining TikTok piece.
