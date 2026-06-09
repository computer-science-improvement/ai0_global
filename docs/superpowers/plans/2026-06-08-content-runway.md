# Content Runway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per finite-pool strategy, how many unpublished posts of content remain, and flag the strategy when that supply drops below a per-strategy threshold (default 100).

**Architecture:** Add a `countEligible` method to each of the 8 finite-pool repositories mirroring its `getNext` predicate exactly; aggregate them behind a `ContentRunwayService` (own NestJS module that re-provides the stateless repos so there's no cross-module coupling); surface `content_remaining` + `low_content_threshold` on the existing `GET /api/strategies` payload; let `PATCH /api/strategies/:id` set a per-binding threshold (new nullable column). The dashboard shows the number on the channel-detail strategies table and a ⚠ marker on low strategies in both the channels table and the detail page.

**Tech Stack:** NestJS 10 + raw `pg` (`DB_POOL` token); Postgres migrations (`database/migrations/0NN_*.sql` + `schema_migrations`); React 19 + TanStack Router/Query + Tailwind v4; tests via `node:test` + `node:assert/strict` run with `tsx` (automation only — dashboard has no test runner).

**Naming note:** the existing API/types use **snake_case** (`channel_id`, `next_run_at`). New fields follow suit: `content_remaining`, `low_content_threshold`.

**The 8 finite-pool types** (everything else returns `content_remaining: null`):
`recipes`, `quotes`, `facts`, `curated-prompts`, `ai0-prompts`, `pdr-quiz`, `motivation-biography`, `assets`.

**`posted` JSONB key per type** (must match `getNext`/`markPosted`; the runner passes the **channel_key** as `channelId`, e.g. `@recipes_local`):
- `recipes`, `curated-prompts`, `ai0-prompts` → literal `'TELEGRAM'` (no channel key needed).
- `quotes`, `facts`, `pdr-quiz`, `motivation-biography`, `assets` → the **channel_key**.

---

## Task 1: Migration 019 + binding column plumbing

**Files:**
- Create: `database/migrations/019_strategy_low_content_threshold.sql`
- Modify: `database/init.sql` (the `strategy_bindings` CREATE TABLE)
- Modify: `apps/automation/src/config/strategy-bindings.repository.ts`

- [ ] **Step 1: Write the migration**

Create `database/migrations/019_strategy_low_content_threshold.sql`:

```sql
-- 019_strategy_low_content_threshold.sql — per-strategy low-content alert
-- threshold (posts). NULL means "use the default" (100, in code). Additive,
-- nullable, no backfill.

ALTER TABLE strategy_bindings
  ADD COLUMN IF NOT EXISTS low_content_threshold INTEGER;

INSERT INTO schema_migrations (version) VALUES ('019_strategy_low_content_threshold')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Mirror the column in `database/init.sql`**

Find the `CREATE TABLE strategy_bindings (...)` block in `database/init.sql` and add the column alongside `notes` (match the existing column style):

```sql
  low_content_threshold INTEGER,
```

- [ ] **Step 3: Apply the migration to the local DB**

Run: `bash database/migrate.sh`
Expected: output lists `019_strategy_low_content_threshold` as applied (or "already applied" on a re-run). Verify:

Run: `docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global -c "\d strategy_bindings" | grep low_content_threshold`
Expected: a row showing `low_content_threshold | integer`.

(If the container/credentials differ, use the values from `docker compose` / `.env`; the column add is idempotent.)

- [ ] **Step 4: Extend `StrategyBindingRow` + all SELECT/RETURNING + `update()`**

In `apps/automation/src/config/strategy-bindings.repository.ts`:

Add to the `StrategyBindingRow` interface (after `notes`):
```typescript
  low_content_threshold: number | null;
```

In `list()` (the SELECT around line 32), `findById()` (~line 54), and `findByExtId()` (~line 62), add `low_content_threshold` to the column list. The list becomes:
```sql
SELECT id, ext_id, type, channel_id, schedule, params, enabled, notes, low_content_threshold
```
(apply the same change to all three SELECTs).

In `update()`, extend the patch type and add a SET clause + the RETURNING column. The patch param type gains:
```typescript
  low_content_threshold?: number | null;
```
Add this SET clause after the `notes` clause:
```typescript
  if (patch.low_content_threshold !== undefined) { sets.push(`low_content_threshold = $${i++}`); params.push(patch.low_content_threshold); }
```
And add `low_content_threshold` to the `RETURNING` column list (same list as the SELECTs above).

- [ ] **Step 5: Type-check**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add database/migrations/019_strategy_low_content_threshold.sql database/init.sql apps/automation/src/config/strategy-bindings.repository.ts
git commit -m "feat(runway): migration 019 + low_content_threshold binding column"
```

---

## Task 2: `countEligible` on the 8 finite-pool repositories

**Files:**
- Modify: `apps/automation/src/strategies/recipes/recipes.repository.ts`
- Modify: `apps/automation/src/strategies/quotes/quotes.repository.ts`
- Modify: `apps/automation/src/strategies/facts/facts.repository.ts`
- Modify: `apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts`
- Modify: `apps/automation/src/strategies/ai0-prompts/prompts.repository.ts`
- Modify: `apps/automation/src/strategies/pdr-quiz/pdr-quiz.repository.ts`
- Modify: `apps/automation/src/strategies/motivation-biography/motivation-biography.repository.ts`
- Modify: `apps/automation/src/strategies/assets/assets.repository.ts`
- Create: `apps/automation/src/common/content-runway/count-eligible.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/common/content-runway/count-eligible.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesRepository } from '../../strategies/recipes/recipes.repository';
import { QuotesRepository } from '../../strategies/quotes/quotes.repository';
import { FactsRepository } from '../../strategies/facts/facts.repository';
import { CuratedPromptsRepository } from '../../strategies/curated-prompts/curated-prompts.repository';
import { PromptsRepository } from '../../strategies/ai0-prompts/prompts.repository';
import { PdrQuizRepository } from '../../strategies/pdr-quiz/pdr-quiz.repository';
import { MotivationBiographyRepository } from '../../strategies/motivation-biography/motivation-biography.repository';
import { AssetsRepository } from '../../strategies/assets/assets.repository';

function fakePool(count: string) {
  const captured: { sql?: string; params?: unknown[] } = {};
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      captured.sql = sql; captured.params = params;
      return { rows: [{ count }] };
    },
  };
  return { pool, captured };
}

test('recipes.countEligible parses count and keeps TELEGRAM + kcal + title_uk predicates', async () => {
  const { pool, captured } = fakePool('42');
  assert.equal(await new RecipesRepository(pool as any).countEligible(), 42);
  assert.match(captured.sql!, /count\(\*\)/);
  assert.match(captured.sql!, /NOT \(posted \? 'TELEGRAM'\)/);
  assert.match(captured.sql!, /kcal IS NOT NULL/);
  assert.match(captured.sql!, /title_uk IS DISTINCT FROM ''/);
});

test('quotes.countEligible binds channel key, appends category when present', async () => {
  const { pool, captured } = fakePool('7');
  assert.equal(await new QuotesRepository(pool as any).countEligible('@c', 'wisdom'), 7);
  assert.match(captured.sql!, /NOT \(posted \? \$1\)/);
  assert.deepEqual(captured.params, ['@c', 'wisdom']);
});

test('quotes.countEligible omits category param when absent', async () => {
  const { pool, captured } = fakePool('5');
  await new QuotesRepository(pool as any).countEligible('@c');
  assert.deepEqual(captured.params, ['@c']);
});

test('facts.countEligible binds channel key', async () => {
  const { pool, captured } = fakePool('3');
  assert.equal(await new FactsRepository(pool as any).countEligible('@c'), 3);
  assert.match(captured.sql!, /FROM facts/);
  assert.deepEqual(captured.params, ['@c']);
});

test('curated-prompts.countEligible keeps provider/status predicates, binds filter', async () => {
  const { pool, captured } = fakePool('9');
  assert.equal(await new CuratedPromptsRepository(pool as any).countEligible({ provider: undefined, mediaType: 'image' }), 9);
  assert.match(captured.sql!, /provider <> 'prompthero'/);
  assert.match(captured.sql!, /status IS DISTINCT FROM 'ERROR'/);
  assert.deepEqual(captured.params, [null, 'image']);
});

test('ai0-prompts.countEligible binds category, keeps prompthero/status predicates', async () => {
  const { pool, captured } = fakePool('4');
  assert.equal(await new PromptsRepository(pool as any).countEligible('art'), 4);
  assert.match(captured.sql!, /provider = 'prompthero'/);
  assert.match(captured.sql!, /status IS NULL/);
  assert.deepEqual(captured.params, ['art']);
});

test('pdr-quiz.countEligible binds channel key', async () => {
  const { pool, captured } = fakePool('2');
  assert.equal(await new PdrQuizRepository(pool as any).countEligible('@c'), 2);
  assert.match(captured.sql!, /FROM pdr_questions/);
  assert.deepEqual(captured.params, ['@c']);
});

test('motivation-biography.countEligible counts ALL unposted (no today filter)', async () => {
  const { pool, captured } = fakePool('6');
  assert.equal(await new MotivationBiographyRepository(pool as any).countEligible('@c'), 6);
  assert.match(captured.sql!, /FROM birthdays/);
  assert.doesNotMatch(captured.sql!, /CURRENT_DATE/);
  assert.deepEqual(captured.params, ['@c']);
});

test('assets.countEligible binds data_source + channel key', async () => {
  const { pool, captured } = fakePool('8');
  assert.equal(await new AssetsRepository(pool as any).countEligible('epic', '@c'), 8);
  assert.match(captured.sql!, /data_source = \$1/);
  assert.match(captured.sql!, /NOT \(posted \? \$2\)/);
  assert.deepEqual(captured.params, ['epic', '@c']);
});

test('countEligible returns 0 when no rows', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await new FactsRepository(pool as any).countEligible('@c'), 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/automation && npx tsx --test src/common/content-runway/count-eligible.test.ts`
Expected: FAIL — `countEligible is not a function` (methods don't exist yet).

- [ ] **Step 3: Add `countEligible` to each repository**

In `recipes.repository.ts` (add inside the class, after `getNext`):
```typescript
  async countEligible(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM recipes
       WHERE NOT (posted ? 'TELEGRAM')
         AND title_uk IS DISTINCT FROM ''
         AND kcal IS NOT NULL`,
    );
    return Number(rows[0]?.count ?? 0);
  }
```

In `quotes.repository.ts`:
```typescript
  async countEligible(channelId: string, category?: string): Promise<number> {
    const conditions = ['NOT (posted ? $1)'];
    const params: unknown[] = [channelId];
    if (category) { conditions.push(`category = $${params.length + 1}`); params.push(category); }
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM quotes WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  }
```

In `facts.repository.ts`:
```typescript
  async countEligible(channelId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM facts WHERE NOT (posted ? $1)`, [channelId],
    );
    return Number(rows[0]?.count ?? 0);
  }
```

In `curated-prompts.repository.ts` (reuse the existing `CuratedFilter` type already defined in this file):
```typescript
  async countEligible(filter: CuratedFilter = {}): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM prompts
       WHERE provider <> 'prompthero'
         AND prompt_text IS NOT NULL
         AND NOT (posted ? 'TELEGRAM')
         AND status IS DISTINCT FROM 'ERROR'
         AND ($1::text IS NULL OR provider   = $1)
         AND ($2::text IS NULL OR media_type = $2)`,
      [filter.provider ?? null, filter.mediaType ?? null],
    );
    return Number(rows[0]?.count ?? 0);
  }
```

In `ai0-prompts/prompts.repository.ts`:
```typescript
  async countEligible(category: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM prompts
       WHERE category = $1
         AND provider = 'prompthero'
         AND status IS NULL
         AND NOT (posted ? 'TELEGRAM')`,
      [category],
    );
    return Number(rows[0]?.count ?? 0);
  }
```

In `pdr-quiz.repository.ts`:
```typescript
  async countEligible(channelId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM pdr_questions WHERE NOT (posted ? $1)`, [channelId],
    );
    return Number(rows[0]?.count ?? 0);
  }
```

In `motivation-biography.repository.ts` (intentionally drops the `getToday` month/day filter — counts the full future supply):
```typescript
  /**
   * Total runway: ALL birthdays not yet posted to this channel. Unlike
   * getToday() this omits the today-only month/day filter — the low-content
   * warning must reflect real remaining supply, not the 0–1 eligible today.
   */
  async countEligible(channelId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM birthdays WHERE NOT (posted ? $1)`, [channelId],
    );
    return Number(rows[0]?.count ?? 0);
  }
```

In `assets.repository.ts`:
```typescript
  async countEligible(dataSource: string, channelId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM assets WHERE data_source = $1 AND NOT (posted ? $2)`,
      [dataSource, channelId],
    );
    return Number(rows[0]?.count ?? 0);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/automation && npx tsx --test src/common/content-runway/count-eligible.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Type-check**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/strategies apps/automation/src/common/content-runway/count-eligible.test.ts
git commit -m "feat(runway): countEligible on the 8 finite-pool repositories + tests"
```

---

## Task 3: `ContentRunwayService` + `ContentRunwayModule`

**Files:**
- Create: `apps/automation/src/common/content-runway/content-runway.service.ts`
- Create: `apps/automation/src/common/content-runway/content-runway.module.ts`
- Create: `apps/automation/src/common/content-runway/content-runway.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/common/content-runway/content-runway.service.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentRunwayService, LOW_CONTENT_DEFAULT } from './content-runway.service';

function build() {
  const calls: any = {};
  const svc = new ContentRunwayService(
    { countEligible: async () => 5 } as any,                                                       // recipes
    { countEligible: async (k: string, c?: string) => { calls.quotes = { k, c }; return 7; } } as any, // quotes
    { countEligible: async (k: string) => { calls.facts = k; return 3; } } as any,                 // facts
    { countEligible: async () => 9 } as any,                                                       // curated-prompts
    { countEligible: async (cat: string) => { calls.ai0 = cat; return 4; } } as any,               // ai0-prompts
    { countEligible: async (_k: string) => 2 } as any,                                             // pdr-quiz
    { countEligible: async (_k: string) => 6 } as any,                                             // motivation-biography
    { countEligible: async (ds: string, k: string) => { calls.assets = { ds, k }; return 8; } } as any, // assets
  );
  return { svc, calls };
}

test('remainingFor returns null for RSA/unknown types', async () => {
  const { svc } = build();
  assert.equal(await svc.remainingFor('ua-news', '@c', {}), null);
  assert.equal(await svc.remainingFor('daily-photo', '@c', {}), null);
});

test('recipes ignores the channel key', async () => {
  const { svc } = build();
  assert.equal(await svc.remainingFor('recipes', null, {}), 5);
});

test('channel-keyed type returns null when key missing, number when present', async () => {
  const { svc } = build();
  assert.equal(await svc.remainingFor('facts', null, {}), null);
  assert.equal(await svc.remainingFor('facts', '@c', {}), 3);
});

test('quotes passes channel key + category', async () => {
  const { svc, calls } = build();
  assert.equal(await svc.remainingFor('quotes', '@c', { category: 'wisdom' }), 7);
  assert.deepEqual(calls.quotes, { k: '@c', c: 'wisdom' });
});

test('assets passes dataSource + channel key', async () => {
  const { svc, calls } = build();
  assert.equal(await svc.remainingFor('assets', '@c', { dataSource: 'epic' }), 8);
  assert.deepEqual(calls.assets, { ds: 'epic', k: '@c' });
});

test('ai0-prompts passes category (channel key irrelevant)', async () => {
  const { svc, calls } = build();
  assert.equal(await svc.remainingFor('ai0-prompts', null, { category: 'art' }), 4);
  assert.equal(calls.ai0, 'art');
});

test('effectiveThreshold falls back to the default', () => {
  const { svc } = build();
  assert.equal(svc.effectiveThreshold(null), LOW_CONTENT_DEFAULT);
  assert.equal(svc.effectiveThreshold(undefined), LOW_CONTENT_DEFAULT);
  assert.equal(svc.effectiveThreshold(50), 50);
});

test('a counter that throws yields null, not a crash', async () => {
  const svc = new ContentRunwayService(
    { countEligible: async () => { throw new Error('db down'); } } as any,
    ...(Array(7).fill({ countEligible: async () => 0 }) as any[]),
  );
  assert.equal(await svc.remainingFor('recipes', null, {}), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/automation && npx tsx --test src/common/content-runway/content-runway.service.test.ts`
Expected: FAIL — cannot find module `./content-runway.service`.

- [ ] **Step 3: Write `content-runway.service.ts`**

Create `apps/automation/src/common/content-runway/content-runway.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { RecipesRepository } from '../../strategies/recipes/recipes.repository';
import { QuotesRepository } from '../../strategies/quotes/quotes.repository';
import { FactsRepository } from '../../strategies/facts/facts.repository';
import { CuratedPromptsRepository } from '../../strategies/curated-prompts/curated-prompts.repository';
import { PromptsRepository } from '../../strategies/ai0-prompts/prompts.repository';
import { PdrQuizRepository } from '../../strategies/pdr-quiz/pdr-quiz.repository';
import { MotivationBiographyRepository } from '../../strategies/motivation-biography/motivation-biography.repository';
import { AssetsRepository } from '../../strategies/assets/assets.repository';

/** Default low-content alert threshold (posts) when a binding has no override. */
export const LOW_CONTENT_DEFAULT = 100;

type Counter = (channelKey: string | null, params: Record<string, unknown>) => Promise<number | null>;

/**
 * Computes the remaining unpublished content ("runway") for finite-pool
 * strategies. RSA/live strategies aren't registered → remainingFor returns
 * null. Each counter mirrors its repository's getNext eligibility predicate.
 * The channel key is the same value the runner passes to execute() (the
 * channel_key, used as the `posted` JSONB key).
 */
@Injectable()
export class ContentRunwayService {
  private readonly counters: Record<string, Counter>;

  constructor(
    private readonly recipes: RecipesRepository,
    private readonly quotes: QuotesRepository,
    private readonly facts: FactsRepository,
    private readonly curated: CuratedPromptsRepository,
    private readonly ai0Prompts: PromptsRepository,
    private readonly pdr: PdrQuizRepository,
    private readonly birthdays: MotivationBiographyRepository,
    private readonly assets: AssetsRepository,
  ) {
    // Wrap channel-keyed counters so a missing key yields null (can't count).
    const needKey =
      (fn: (key: string, params: Record<string, unknown>) => Promise<number>): Counter =>
      (key, params) => (key ? fn(key, params) : Promise.resolve(null));

    this.counters = {
      recipes:                () => this.recipes.countEligible(),
      'curated-prompts':      (_key, p) => this.curated.countEligible({ provider: p.provider as string | undefined, mediaType: p.mediaType as string | undefined }),
      'ai0-prompts':          (_key, p) => this.ai0Prompts.countEligible((p.category as string) ?? ''),
      quotes:                 needKey((key, p) => this.quotes.countEligible(key, p.category as string | undefined)),
      facts:                  needKey((key) => this.facts.countEligible(key)),
      'pdr-quiz':             needKey((key) => this.pdr.countEligible(key)),
      'motivation-biography': needKey((key) => this.birthdays.countEligible(key)),
      assets:                 needKey((key, p) => this.assets.countEligible((p.dataSource as string) ?? '', key)),
    };
  }

  /** Remaining unpublished posts, or null for non-finite-pool types / errors. */
  async remainingFor(type: string, channelKey: string | null, params: Record<string, unknown>): Promise<number | null> {
    const counter = this.counters[type];
    if (!counter) return null;
    try {
      return await counter(channelKey, params ?? {});
    } catch {
      return null; // a count failure must never break the strategies list
    }
  }

  /** Effective threshold: the binding override, else the default. */
  effectiveThreshold(stored: number | null | undefined): number {
    return stored ?? LOW_CONTENT_DEFAULT;
  }
}
```

- [ ] **Step 4: Write `content-runway.module.ts`**

Create `apps/automation/src/common/content-runway/content-runway.module.ts`. The 8 repositories only inject `DB_POOL` (a `@Global` provider), so re-providing them here is safe and avoids importing the 8 strategy modules:

```typescript
import { Module } from '@nestjs/common';
import { ContentRunwayService } from './content-runway.service';
import { RecipesRepository } from '../../strategies/recipes/recipes.repository';
import { QuotesRepository } from '../../strategies/quotes/quotes.repository';
import { FactsRepository } from '../../strategies/facts/facts.repository';
import { CuratedPromptsRepository } from '../../strategies/curated-prompts/curated-prompts.repository';
import { PromptsRepository } from '../../strategies/ai0-prompts/prompts.repository';
import { PdrQuizRepository } from '../../strategies/pdr-quiz/pdr-quiz.repository';
import { MotivationBiographyRepository } from '../../strategies/motivation-biography/motivation-biography.repository';
import { AssetsRepository } from '../../strategies/assets/assets.repository';

@Module({
  providers: [
    ContentRunwayService,
    RecipesRepository, QuotesRepository, FactsRepository, CuratedPromptsRepository,
    PromptsRepository, PdrQuizRepository, MotivationBiographyRepository, AssetsRepository,
  ],
  exports: [ContentRunwayService],
})
export class ContentRunwayModule {}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/automation && npx tsx --test src/common/content-runway/content-runway.service.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/common/content-runway/content-runway.service.ts apps/automation/src/common/content-runway/content-runway.module.ts apps/automation/src/common/content-runway/content-runway.service.test.ts
git commit -m "feat(runway): ContentRunwayService + module"
```

---

## Task 4: Wire runway into the strategies API (GET enrich + PATCH threshold)

**Files:**
- Modify: `apps/automation/src/config/api/dto/strategies.dto.ts`
- Modify: `apps/automation/src/config/api/strategies.controller.ts`
- Modify: `apps/automation/src/config/config.module.ts`

- [ ] **Step 1: Extend the PATCH DTO**

In `apps/automation/src/config/api/dto/strategies.dto.ts`, ensure `IsInt` and `Min` are imported from `class-validator` (add them to the existing import if missing), then add to `PatchStrategyDto` (after the `notes` field):

```typescript
  @IsOptional() @IsInt() @Min(0)
  low_content_threshold?: number | null;
```

(`@IsOptional()` skips validation for both `undefined` and `null`, so a `null` reset passes; a number is validated `>= 0`.)

- [ ] **Step 2: Inject `ContentRunwayService` into the controller**

In `apps/automation/src/config/api/strategies.controller.ts`:

Add the import:
```typescript
import { ContentRunwayService } from '../../common/content-runway/content-runway.service';
```

Add `private readonly runway: ContentRunwayService` to the controller's constructor parameter list (alongside the existing injected services such as `repo`, `runsRepo`, `crossposts`, `cache`, `publisher`).

- [ ] **Step 3: Enrich the GET payload**

In the `list()` handler, convert the synchronous `rows.map(r => { ... })` into an async map and add the two fields. Change the return statement from `return rows.map(r => {` to:

```typescript
    return Promise.all(rows.map(async r => {
```

and the closing `});` of the map to:

```typescript
    }));
```

Inside the returned object literal, add these two fields after `last_run`:

```typescript
        content_remaining:     await this.runway.remainingFor(r.type, channel?.channel_key ?? null, r.params),
        low_content_threshold: this.runway.effectiveThreshold(r.low_content_threshold),
```

- [ ] **Step 4: Confirm PATCH forwards the new field**

The PATCH handler already calls `await this.repo.update(id, body)` with the whole DTO. Since `update()` (Task 1) now handles `low_content_threshold`, no further change is needed. Verify the handler body still reads:
```typescript
    const updated = await this.repo.update(id, body);
    await this.publisher.publish('strategy', id);
    return updated;
```

- [ ] **Step 5: Register `ContentRunwayModule` in `config.module.ts`**

In `apps/automation/src/config/config.module.ts`, add the import and include it in the module's `imports` array:

```typescript
import { ContentRunwayModule } from '../common/content-runway/content-runway.module';
```
Add `ContentRunwayModule` to the `imports: [...]` list of `@Module({...})`.

- [ ] **Step 6: Type-check + build**

Run: `cd apps/automation && npx tsc --noEmit && npm run build`
Expected: no errors; nest build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/config
git commit -m "feat(runway): expose content_remaining + low_content_threshold on /api/strategies"
```

---

## Task 5: Frontend types + runway helpers

**Files:**
- Modify: `apps/dashboard/src/api/types.ts`
- Create: `apps/dashboard/src/lib/runway.ts`
- Modify: `apps/dashboard/src/api/strategies.ts`

- [ ] **Step 1: Extend the `Strategy` type**

In `apps/dashboard/src/api/types.ts`, add two fields to the `Strategy` interface (after `last_run`):

```typescript
  /** Remaining unpublished posts for finite-pool strategies; null for live/feed types. */
  content_remaining:     number | null;
  /** Effective low-content alert threshold (posts); binding override or default 100. */
  low_content_threshold: number;
```

- [ ] **Step 2: Create the runway helpers**

Create `apps/dashboard/src/lib/runway.ts`:

```typescript
/** Strategy types that draw from a finite, pre-loaded content pool. */
export const FINITE_POOL_TYPES = new Set<string>([
  'recipes', 'quotes', 'facts', 'curated-prompts',
  'ai0-prompts', 'pdr-quiz', 'motivation-biography', 'assets',
]);

/** True when a finite-pool strategy's remaining supply is below its threshold. */
export function isLowContent(s: { content_remaining: number | null; low_content_threshold: number }): boolean {
  return s.content_remaining != null && s.content_remaining < s.low_content_threshold;
}
```

- [ ] **Step 3: Extend `PatchStrategyInput`**

In `apps/dashboard/src/api/strategies.ts`, add to the `PatchStrategyInput` interface (after `notes`):

```typescript
  low_content_threshold?: number | null;
```

- [ ] **Step 4: Type-check**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: no errors. (The new `Strategy` fields are required, so any object literal building a `Strategy` in the codebase would error — there are none; the type is only consumed from API responses.)

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/api/types.ts apps/dashboard/src/lib/runway.ts apps/dashboard/src/api/strategies.ts
git commit -m "feat(runway): dashboard types + isLowContent/FINITE_POOL_TYPES helpers"
```

---

## Task 6: Channel-detail "Content" column

**Files:**
- Modify: `apps/dashboard/src/routes/channels_.$id.tsx`

- [ ] **Step 1: Add imports**

In `apps/dashboard/src/routes/channels_.$id.tsx`, add:
```typescript
import { Badge } from '../components/ui/Badge';
import { FINITE_POOL_TYPES, isLowContent } from '../lib/runway';
```
(`Icon` is already imported.)

- [ ] **Step 2: Add the table header cell**

In `StrategiesPanel`, add a `<th>Content</th>` to the header row, immediately after `<th>Last run</th>` and before `<th>Status</th>`:

```tsx
            <th>Last run</th>
            <th>Content</th>
            <th>Status</th>
```

- [ ] **Step 3: Add the per-row cell**

In `StrategyTableRow`, add this `<td>` immediately after the "Last run" `<td>` (the one ending `...never</span>}` ) and before the "Status" `<td>`:

```tsx
      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
        {!FINITE_POOL_TYPES.has(s.type) || s.content_remaining == null ? (
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }} title="Live/feed source — unlimited supply, no runway.">—</span>
        ) : isLowContent(s) ? (
          <span title={`Low content: ${s.content_remaining} posts left (alert below ${s.low_content_threshold}). Load more content for this strategy.`}>
            <Badge tone="warning"><Icon name="warning" size={11} /> Low: {s.content_remaining} / {s.low_content_threshold}</Badge>
          </span>
        ) : (
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }} title={`${s.content_remaining} posts of content remaining (alert below ${s.low_content_threshold}).`}>
            {s.content_remaining.toLocaleString()}
          </span>
        )}
      </td>
```

- [ ] **Step 4: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors; vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/routes/channels_.\$id.tsx
git commit -m "feat(runway): Content column on the channel-detail strategies table"
```

---

## Task 7: EditStrategyModal threshold input

**Files:**
- Modify: `apps/dashboard/src/components/EditStrategyModal.tsx`

- [ ] **Step 1: Add the import**

In `apps/dashboard/src/components/EditStrategyModal.tsx`, add:
```typescript
import { FINITE_POOL_TYPES } from '../lib/runway';
```

- [ ] **Step 2: Add threshold state**

Near the other `useState` initializers (where `schedule`, `params`, `notes`, `enabled` are seeded from the `strategy` prop), add:

```typescript
  // Empty string = "use the default" (sends null on save). Number string = override.
  const [threshold, setThreshold] = useState<string>(
    strategy.low_content_threshold == null ? '' : String(strategy.low_content_threshold),
  );
  const showThreshold = FINITE_POOL_TYPES.has(strategy.type);
```

- [ ] **Step 3: Add the form field**

Add this block inside the form, after the `notes` field and before the `enabled` checkbox (only render for finite-pool types):

```tsx
        {showThreshold && (
          <label style={{ display: 'block', marginBottom: 12 }}>
            <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)', display: 'block', marginBottom: 4 }}>
              Low-content alert (posts)
            </span>
            <input
              type="number"
              min={0}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="100 (default)"
              className="input-field"
              style={{ width: 160 }}
              title="Warn when the remaining content for this strategy drops below this many posts. Leave empty to use the default (100)."
            />
          </label>
        )}
```

- [ ] **Step 4: Include the field in the PATCH body**

In the submit handler (where it assembles the `patch` object of changed fields and calls `patch.mutateAsync({ id: strategy.id, patch: body })`), add — after the other field diffs — logic that maps the input to the API value and only sends it when changed:

```typescript
    if (showThreshold) {
      const next = threshold.trim() === '' ? null : Math.max(0, Math.floor(Number(threshold)));
      const current = strategy.low_content_threshold;
      if (next !== current && !(next === null && current == null)) {
        body.low_content_threshold = next;
      }
    }
```

(`body` is the existing patch-accumulator object; if it's typed, it already matches `PatchStrategyInput` which now includes `low_content_threshold`. If the value is `NaN` because of bad input, the `type="number"` input prevents non-numeric entry, but `Math.floor(Number(''))` is guarded by the empty-string branch.)

- [ ] **Step 5: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/EditStrategyModal.tsx
git commit -m "feat(runway): per-strategy low-content threshold input in EditStrategyModal"
```

---

## Task 8: Channels-table ⚠ marker on low strategies

**Files:**
- Modify: `apps/dashboard/src/routes/channels.tsx`
- Modify: `apps/dashboard/src/components/ChannelRow.tsx`

- [ ] **Step 1: Load strategies + build the low-content id set in `channels.tsx`**

Add imports:
```typescript
import { useMemo } from 'react';
import { useStrategies } from '../api/strategies';
import { isLowContent } from '../lib/runway';
```
(Merge `useMemo` into the existing `react` import if one exists.)

Inside `ChannelsPage`, after the existing `useQuery`/`useBots` hooks, add:
```typescript
  const { data: strategies } = useStrategies();
  const lowContentIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of strategies ?? []) if (isLowContent(s)) set.add(s.id);
    return set;
  }, [strategies]);
```

Pass the set into each row — change `<ChannelRow key={c.id} c={c} />` to:
```tsx
                {data.items.map((c) => <ChannelRow key={c.id} c={c} lowContentIds={lowContentIds} />)}
```

- [ ] **Step 2: Accept the prop + render the marker in `ChannelRow.tsx`**

Change the component signature:
```tsx
export function ChannelRow({ c, lowContentIds }: { c: TrackedChannel; lowContentIds?: Set<string> }) {
```

In the strategies-chip `map`, inside the returned `<span ... className={s.enabled ? 'chip is-active' : 'chip'}>`, add the marker after the `{s.role === 'forward' && ...}` line and before the closing `</span>`:
```tsx
                  {lowContentIds?.has(s.id) && (
                    <Icon name="warning" size={11} style={{ marginLeft: 4, color: 'var(--color-warning)' }} />
                  )}
```

Also extend that chip's `tooltip` array (built just above the `return`) with a low-content note so hovering explains the ⚠:
```tsx
                ...(lowContentIds?.has(s.id) ? ['⚠ Low content — running out of posts for this strategy.'] : []),
```
(append this as the last element passed into the `[...].join('\n\n')` array.)

- [ ] **Step 3: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/channels.tsx apps/dashboard/src/components/ChannelRow.tsx
git commit -m "feat(runway): low-content warning marker on the channels table"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend tests + type-check + build**

Run: `cd apps/automation && npx tsx --test 'src/**/*.test.ts' && npx tsc --noEmit && npm run build`
Expected: all tests pass; no type errors; build succeeds.

- [ ] **Step 2: Dashboard type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors; vite build succeeds.

- [ ] **Step 3: Confirm cost-safe**

No automation restart, no posting, no Claude calls were triggered — the only DB writes are migration `019` (DDL) and any user-initiated PATCH. The user performs any restart / real smoke test. Note in the final summary that the new counts appear after the automation image is rebuilt/restarted (the user's step) and that `GET /api/strategies` will then include `content_remaining` / `low_content_threshold`.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(runway): verification fixups" || echo "nothing to commit"
```

---

## Notes for the implementer

- **Do not restart local automation, trigger publishing, or call the Claude API** — standing cost guard. Build + `tsc` + `node:test` only. The user runs restarts and real smoke tests.
- **Never edit an applied migration.** `019` is new; if it's already in `schema_migrations` from a prior run, the `ADD COLUMN IF NOT EXISTS` is still safe.
- The `posted` JSONB key for channel-keyed types is the **channel_key** (e.g. `@recipes_local`), the same value the runner passes to `execute()` and `markPosted()`. The controller already has it as `channel?.channel_key`.
- The channels table reuses the globally-cached `useStrategies()` query (30 s refetch) — no new endpoint and no extra fetch per row.
