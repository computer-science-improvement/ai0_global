# Native Meta Publishing (Instagram pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `strategy_binding` publish natively to a Meta platform (Instagram first) on its own cron schedule, drawing from the same content pool, with dedup independent from Telegram — piloted on `recipes`, `ai0-prompts`, `curated-prompts`.

**Architecture:** A binding's destination is either a Telegram channel (today) or a Meta account (`platform` + `meta_account_id`). The scheduler resolves each binding to a `PublishDestination` via a new `DestinationResolver` and threads it through `runner.run()` to `strategy.execute(channelId, params, dest)`. The three pilot strategies branch on the destination: the Telegram path is unchanged; the Meta path publishes through the existing `PublisherDispatcher` and marks a per-account dedup key. Repos take a destination key so `getNext`/`markPosted` dedup per destination.

**Tech Stack:** NestJS (automation), PostgreSQL (`pg`), node:test via `npx tsx --test`, React + TanStack Query (dashboard), Meta Graph API.

**Spec:** `docs/superpowers/specs/2026-06-12-native-meta-publishing-design.md`

**Branch:** `feat/native-meta-publishing` (already created off `feat/crosspost-all-strategies`).

**Cost/safety guard (STANDING):** Implementation is build + `tsc` + unit tests ONLY. Do **not** start/restart automation, do **not** trigger publishing, do **not** call the Claude API. The user performs restarts and live smoke tests. Migrations apply on app boot (user restart) — do not run them against a live DB yourself.

---

## File Structure

**Create:**
- `apps/automation/database/migrations/020_strategy_binding_destination.sql` — wait, migrations live at repo root: `database/migrations/020_strategy_binding_destination.sql`.
- `apps/automation/src/common/content-strategy/publish-destination.ts` — `PublishDestination` type + `META_POSTED_PREFIX`.
- `apps/automation/src/common/content-strategy/destination-resolver.service.ts` — resolves a binding to a `PublishDestination` (+ token).
- `apps/automation/src/common/content-strategy/destination-resolver.service.test.ts` — resolver unit tests.

**Modify (automation):**
- `apps/automation/src/config/strategy-bindings.repository.ts` — add `platform` + `meta_account_id` to row/insert/update/SELECT.
- `apps/automation/src/config/channel-config.service.ts` — `ResolvedStrategyBinding` + `resolveStrategyBindings()` carry the new fields.
- `apps/automation/src/config/config.module.ts` — export `MetaAccountsRepository`.
- `apps/automation/src/common/common.module.ts` — provide + export `DestinationResolver`.
- `apps/automation/src/common/content-strategy/content-strategy.interface.ts` — `execute?(channelId, params, dest?)`.
- `apps/automation/src/common/content-strategy/content-strategy.runner.ts` — trailing `dest?` param, throttle by `throttleKey`, pass `dest` to `execute`, guard generic path.
- `apps/automation/src/scheduler/scheduler.service.ts` — resolve destination per tick, pass to runner.
- `apps/automation/src/strategies/recipes/recipes.repository.ts` — `getNext(postedKey)`, `markPosted(id, postedKey)`.
- `apps/automation/src/strategies/recipes/recipes.strategy.ts` — Meta branch + dispatcher dep.
- `apps/automation/src/strategies/ai0-prompts/prompts.repository.ts` — `getNext(category, postedKey)`, `markPosted(id, postedKey)`.
- `apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.ts` — Meta branch + dispatcher dep.
- `apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts` — `getNext(filter, postedKey)`, `markPosted(id, postedKey)`.
- `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts` — Meta branch + dispatcher dep.
- `apps/automation/src/config/api/dto/strategies.dto.ts` — optional `platform`, `meta_account_id`; `channel_id` optional.
- `apps/automation/src/config/api/strategies.controller.ts` — destination invariant validation.
- Tests: `recipes.strategy.test.ts`, `curated-prompts.strategy.test.ts` (existing — update constructor + add Meta-branch cases).

**Modify (dashboard):**
- `apps/dashboard/src/api/strategies.ts` — `CreateStrategyInput` gains optional `platform`, `meta_account_id`; `channel_id` optional.
- `apps/dashboard/src/components/AddStrategyModal.tsx` — Destination toggle (Telegram channel | Meta account).
- `apps/dashboard/src/components/EditStrategyModal.tsx` — show destination read-only.

---

## Verify-after notes (run from `apps/automation` unless noted)

- Single test file: `npx tsx --test <path/to.test.ts>` → expect `# pass` count > 0, `# fail 0`.
- Type check (automation): `npx tsc --noEmit -p tsconfig.json`.
- Dashboard build (from `apps/dashboard`): `npx tsc --noEmit && npx vite build`.

---

### Task 1: Migration 020 — binding destination columns

**Files:**
- Create: `database/migrations/020_strategy_binding_destination.sql`

There is no DB available during implementation (cost guard). This migration is verified structurally by review + the downstream unit tests (resolver, controller). It applies on the next app boot, which the user performs.

- [ ] **Step 1: Write the migration**

Create `database/migrations/020_strategy_binding_destination.sql`:

```sql
-- 020_strategy_binding_destination.sql
-- A strategy binding can target a Meta account (instagram/facebook/threads)
-- as a first-class destination, instead of a Telegram channel. Existing rows
-- default to 'telegram' and keep their channel_id — no behavior change.

ALTER TABLE strategy_bindings
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'telegram'
    CHECK (platform IN ('telegram','instagram','facebook','threads')),
  ADD COLUMN IF NOT EXISTS meta_account_id UUID REFERENCES meta_accounts(id);

-- A Meta binding has no Telegram channel.
ALTER TABLE strategy_bindings ALTER COLUMN channel_id DROP NOT NULL;

-- Exactly one destination kind per binding.
ALTER TABLE strategy_bindings
  ADD CONSTRAINT strategy_binding_destination_chk CHECK (
       (platform =  'telegram' AND channel_id     IS NOT NULL AND meta_account_id IS NULL)
    OR (platform <> 'telegram' AND meta_account_id IS NOT NULL)
  );
```

- [ ] **Step 2: Verify naming + ordering**

Run: `ls database/migrations | tail -3`
Expected: `020_strategy_binding_destination.sql` sorts last after `019_strategy_low_content_threshold.sql`.

- [ ] **Step 3: Commit**

```bash
git add database/migrations/020_strategy_binding_destination.sql
git commit -m "feat(db): migration 020 — strategy binding Meta destination columns"
```

---

### Task 2: PublishDestination type + DestinationResolver

**Files:**
- Create: `apps/automation/src/common/content-strategy/publish-destination.ts`
- Create: `apps/automation/src/common/content-strategy/destination-resolver.service.ts`
- Create: `apps/automation/src/common/content-strategy/destination-resolver.service.test.ts`
- Modify: `apps/automation/src/config/config.module.ts` (export `MetaAccountsRepository`)
- Modify: `apps/automation/src/common/common.module.ts` (provide + export `DestinationResolver`)
- Modify: `apps/automation/src/config/channel-config.service.ts` (add `platform` + `metaAccountId` to `ResolvedStrategyBinding`)

This task defines the destination type and resolver. The resolver depends on `ResolvedStrategyBinding` having `platform` + `metaAccountId`; add those interface fields here (the mapping that populates them lands in Task 3, but the type must exist now for the resolver to compile/test).

- [ ] **Step 1: Create the destination type**

Create `apps/automation/src/common/content-strategy/publish-destination.ts`:

```ts
// publish-destination.ts — the resolved target a strategy publishes to.
import type { MetaPlatform } from '../../config/meta-accounts.repository';

export type DestinationPlatform = 'telegram' | MetaPlatform;

export interface PublishDestination {
  /** 'telegram' = TG channel; otherwise a Meta platform. */
  platform: DestinationPlatform;
  /** TG channel_key, or the Meta account's publishable target id. */
  targetId: string;
  /** Resolved access token (Meta only; undefined for Telegram). */
  token?: string;
  /** Meta account UUID (null for Telegram). */
  metaAccountId: string | null;
  /** Dedup key written into the `posted` JSONB: 'TELEGRAM' | 'IG:<uuid>' | 'FB:<uuid>' | 'TH:<uuid>'. */
  postedKey: string;
  /** Posting-throttle key: TG channel_key, or 'meta:<uuid>'. */
  throttleKey: string;
}

/** Prefix for a Meta destination's per-account dedup key. */
export const META_POSTED_PREFIX: Record<MetaPlatform, string> = {
  instagram: 'IG',
  facebook:  'FB',
  threads:   'TH',
};
```

- [ ] **Step 2: Add the new fields to `ResolvedStrategyBinding`**

In `apps/automation/src/config/channel-config.service.ts`, the interface currently is:

```ts
export interface ResolvedStrategyBinding {
  id:         string;
  /** Internal UUID — used by run-logging to FK back into strategy_bindings. */
  uuid:       string;
  type:       string;
  channelId:  string;
  schedule:   string;
  params:     Record<string, unknown>;
  enabled:    boolean;
}
```

Replace it with (add the last two fields + the import at the top of the file):

```ts
export interface ResolvedStrategyBinding {
  id:         string;
  /** Internal UUID — used by run-logging to FK back into strategy_bindings. */
  uuid:       string;
  type:       string;
  /** TG channel_key (resolved) for telegram bindings; '' for meta bindings. */
  channelId:  string;
  schedule:   string;
  params:     Record<string, unknown>;
  enabled:    boolean;
  /** Destination kind. 'telegram' = publish to channelId; otherwise a Meta platform. */
  platform:   'telegram' | 'instagram' | 'facebook' | 'threads';
  /** Meta account UUID when platform != 'telegram'; null otherwise. */
  metaAccountId: string | null;
}
```

(`resolveStrategyBindings()` will be updated to populate these in Task 3. To keep this task compiling, temporarily add `platform: 'telegram' as const,` and `metaAccountId: null,` to the object returned at `channel-config.service.ts:108-118`. Task 3 replaces those literals with real values.)

- [ ] **Step 3: Write the failing resolver test**

Create `apps/automation/src/common/content-strategy/destination-resolver.service.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DestinationResolver } from './destination-resolver.service';
import type { ResolvedStrategyBinding } from '../../config/channel-config.service';

function binding(over: Partial<ResolvedStrategyBinding> = {}): ResolvedStrategyBinding {
  return {
    id: 'recipes-ig', uuid: 'u1', type: 'recipes', channelId: '',
    schedule: '0 9 * * *', params: {}, enabled: true,
    platform: 'instagram', metaAccountId: 'acct-1', ...over,
  };
}

const account = {
  id: 'acct-1', platform: 'instagram', account_id: 'ai0_global_ig',
  token_env: 'INSTAGRAM_TOKEN', target_id: '17841480657952058',
  username: 'ai0.global.info', display_name: null, followers: null,
  picture_url: null, active: true, last_verified_at: null, verify_error: null,
  created_at: new Date(),
};

function make(over: { account?: any; env?: Record<string, string> } = {}) {
  const repo = { findById: async (_id: string) => (over.account === undefined ? account : over.account) };
  const config = { get: (k: string) => (over.env ?? { INSTAGRAM_TOKEN: 'tok-123' })[k] };
  return new DestinationResolver(repo as any, config as any);
}

test('telegram binding maps to channel destination', async () => {
  const r = make();
  const d = await r.resolve(binding({ platform: 'telegram', channelId: '@ai0_recipes', metaAccountId: null }));
  assert.equal(d.platform, 'telegram');
  assert.equal(d.targetId, '@ai0_recipes');
  assert.equal(d.postedKey, 'TELEGRAM');
  assert.equal(d.throttleKey, '@ai0_recipes');
  assert.equal(d.token, undefined);
  assert.equal(d.metaAccountId, null);
});

test('instagram binding resolves token + per-account keys', async () => {
  const r = make();
  const d = await r.resolve(binding());
  assert.equal(d.platform, 'instagram');
  assert.equal(d.targetId, '17841480657952058');
  assert.equal(d.token, 'tok-123');
  assert.equal(d.metaAccountId, 'acct-1');
  assert.equal(d.postedKey, 'IG:acct-1');
  assert.equal(d.throttleKey, 'meta:acct-1');
});

test('throws when meta account not found', async () => {
  const r = make({ account: null });
  await assert.rejects(() => r.resolve(binding()), /meta account acct-1 not found/);
});

test('throws when meta account inactive', async () => {
  const r = make({ account: { ...account, active: false } });
  await assert.rejects(() => r.resolve(binding()), /inactive/);
});

test('throws when token env unset', async () => {
  const r = make({ env: {} });
  await assert.rejects(() => r.resolve(binding()), /token env INSTAGRAM_TOKEN not set/);
});

test('throws when meta binding has no meta_account_id', async () => {
  const r = make();
  await assert.rejects(() => r.resolve(binding({ metaAccountId: null })), /requires a meta_account_id/);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx tsx --test src/common/content-strategy/destination-resolver.service.test.ts`
Expected: FAIL — `Cannot find module './destination-resolver.service'`.

- [ ] **Step 5: Implement the resolver**

Create `apps/automation/src/common/content-strategy/destination-resolver.service.ts`:

```ts
// destination-resolver.service.ts — turn a resolved binding into the concrete
// place a strategy publishes to, resolving the Meta access token from env
// (mirrors CrossPostService's `config.get(token_env)` pattern).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaAccountsRepository } from '../../config/meta-accounts.repository';
import type { ResolvedStrategyBinding } from '../../config/channel-config.service';
import { PublishDestination, META_POSTED_PREFIX } from './publish-destination';

@Injectable()
export class DestinationResolver {
  constructor(
    private readonly metaAccounts: MetaAccountsRepository,
    private readonly config: ConfigService,
  ) {}

  async resolve(b: ResolvedStrategyBinding): Promise<PublishDestination> {
    if (b.platform === 'telegram') {
      return {
        platform: 'telegram',
        targetId: b.channelId,
        token: undefined,
        metaAccountId: null,
        postedKey: 'TELEGRAM',
        throttleKey: b.channelId,
      };
    }

    if (!b.metaAccountId) {
      throw new Error(`binding ${b.id}: platform ${b.platform} requires a meta_account_id`);
    }
    const acct = await this.metaAccounts.findById(b.metaAccountId);
    if (!acct) throw new Error(`binding ${b.id}: meta account ${b.metaAccountId} not found`);
    if (!acct.active) throw new Error(`binding ${b.id}: meta account ${acct.id} is inactive`);
    const token = this.config.get<string>(acct.token_env);
    if (!token) throw new Error(`binding ${b.id}: token env ${acct.token_env} not set`);

    return {
      platform: acct.platform,
      targetId: acct.target_id,
      token,
      metaAccountId: acct.id,
      postedKey: `${META_POSTED_PREFIX[acct.platform]}:${acct.id}`,
      throttleKey: `meta:${acct.id}`,
    };
  }
}
```

- [ ] **Step 6: Export `MetaAccountsRepository` from `ChannelConfigModule`**

In `apps/automation/src/config/config.module.ts`, the `exports:` array (lines 53-64) does not include `MetaAccountsRepository`. Add it so `DestinationResolver` (in the @Global `common.module`) can inject it. Change the exports array to include the line:

```ts
    MetaAccountsRepository,
```

(insert it right after `MetaCrosspostTargetsRepository,` in the `exports` array).

- [ ] **Step 7: Provide + export `DestinationResolver` in `common.module`**

In `apps/automation/src/common/common.module.ts`, add the import near the other content-strategy imports:

```ts
import { DestinationResolver } from './content-strategy/destination-resolver.service';
```

and add `DestinationResolver` to the `SERVICES` array (the list that includes `ContentStrategyRunner` at line 50). Both `providers` and `exports` spread `...SERVICES`, so adding it there provides and exports it.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx tsx --test src/common/content-strategy/destination-resolver.service.test.ts`
Expected: PASS — `# pass 6`, `# fail 0`.

- [ ] **Step 9: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/common/content-strategy/publish-destination.ts \
        src/common/content-strategy/destination-resolver.service.ts \
        src/common/content-strategy/destination-resolver.service.test.ts \
        src/config/config.module.ts src/common/common.module.ts \
        src/config/channel-config.service.ts
git commit -m "feat(strategy): PublishDestination + DestinationResolver"
```

---

### Task 3: Binding repository + resolution carry the destination

**Files:**
- Modify: `apps/automation/src/config/strategy-bindings.repository.ts`
- Modify: `apps/automation/src/config/channel-config.service.ts:106-119`
- Test: `apps/automation/src/config/strategy-bindings.repository.test.ts` (create — resolution mapping test via a fake cache is in channel-config; here we test the row shape is wired. Use a focused resolution test instead — see Step 1.)

- [ ] **Step 1: Write the failing resolution test**

Create `apps/automation/src/config/channel-config.resolve.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelConfigService } from './channel-config.service';

function svc(bindings: any[], channels: any[] = []) {
  const cache = {
    getBindings: () => bindings,
    getChannelById: (id: string) => channels.find(c => c.id === id) ?? null,
  };
  // Only resolveStrategyBindings is exercised; other deps are unused here.
  return new ChannelConfigService(cache as any);
}

test('telegram binding resolves channel_key + telegram destination fields', () => {
  const s = svc(
    [{ id: 'b1', ext_id: 'recipes-tg', type: 'recipes', channel_id: 'uuid-1',
       schedule: '0 9 * * *', params: {}, enabled: true,
       platform: 'telegram', meta_account_id: null }],
    [{ id: 'uuid-1', channel_key: '@ai0_recipes' }],
  );
  const [r] = s.resolveStrategyBindings();
  assert.equal(r.channelId, '@ai0_recipes');
  assert.equal(r.platform, 'telegram');
  assert.equal(r.metaAccountId, null);
});

test('meta binding resolves empty channelId + platform/account', () => {
  const s = svc(
    [{ id: 'b2', ext_id: 'recipes-ig', type: 'recipes', channel_id: null,
       schedule: '0 9 * * *', params: {}, enabled: true,
       platform: 'instagram', meta_account_id: 'acct-1' }],
  );
  const [r] = s.resolveStrategyBindings();
  assert.equal(r.channelId, '');
  assert.equal(r.platform, 'instagram');
  assert.equal(r.metaAccountId, 'acct-1');
});
```

NOTE: `ChannelConfigService`'s real constructor takes more than `cache`. Before writing the test, open `channel-config.service.ts` and confirm the constructor parameter order; pass `cache` in the correct position and `undefined`/`{}` for the others (they're unused by `resolveStrategyBindings`). Adjust the `new ChannelConfigService(...)` call accordingly so only the cache arg matters.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/config/channel-config.resolve.test.ts`
Expected: FAIL — `resolveStrategyBindings` returns objects missing `platform`/`metaAccountId` (assert fails) or a constructor arity error to fix per the NOTE.

- [ ] **Step 3: Extend `StrategyBindingRow` + `StrategyBindingInsertInput`**

In `apps/automation/src/config/strategy-bindings.repository.ts`:

Change `StrategyBindingRow` (lines 6-16) — make `channel_id` nullable and add two fields:

```ts
export interface StrategyBindingRow {
  id:          string;
  ext_id:      string;
  type:        string;
  channel_id:  string | null;
  schedule:    string;
  params:      Record<string, unknown>;
  enabled:     boolean;
  notes:       string | null;
  low_content_threshold: number | null;
  platform:    'telegram' | 'instagram' | 'facebook' | 'threads';
  meta_account_id: string | null;
}
```

Change `StrategyBindingInsertInput` (lines 18-25):

```ts
export interface StrategyBindingInsertInput {
  ext_id:     string;
  type:       string;
  channel_id?: string | null;
  schedule:   string;
  params:     Record<string, unknown>;
  enabled?:   boolean;
  platform?:  'telegram' | 'instagram' | 'facebook' | 'threads';
  meta_account_id?: string | null;
}
```

- [ ] **Step 4: Add the new columns to every SELECT + INSERT + UPDATE**

In the same file, every `SELECT ... FROM strategy_bindings` column list (in `list`, `findById`, `findByExtId`, and the `RETURNING` clauses) currently reads:

```
id, ext_id, type, channel_id, schedule, params, enabled, notes, low_content_threshold
```

Append `, platform, meta_account_id` to each of those column lists (4 SELECT/RETURNING sites — `list` line 33, `findById` line 55, `findByExtId` line 63, `insert` RETURNING line 73, and `update` RETURNING line 109).

Replace `insert()` (lines 69-80) with a version that writes the destination columns:

```ts
  async insert(input: StrategyBindingInsertInput): Promise<StrategyBindingRow> {
    const { rows } = await this.pool.query<StrategyBindingRow>(
      `INSERT INTO strategy_bindings
         (ext_id, type, channel_id, schedule, params, enabled, platform, meta_account_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, true), COALESCE($7, 'telegram'), $8)
       RETURNING id, ext_id, type, channel_id, schedule, params, enabled, notes,
                 low_content_threshold, platform, meta_account_id`,
      [
        input.ext_id, input.type, input.channel_id ?? null, input.schedule,
        JSON.stringify(input.params), input.enabled ?? true,
        input.platform ?? 'telegram', input.meta_account_id ?? null,
      ],
    );
    return rows[0];
  }
```

Extend `update()`'s patch type (lines 86-94) and SET-builder (lines 98-104) to support the two new columns. Add to the patch type:

```ts
    platform?:        'telegram' | 'instagram' | 'facebook' | 'threads';
    meta_account_id?: string | null;
```

and add to the SET builder (after the `low_content_threshold` line):

```ts
    if (patch.platform        !== undefined) { sets.push(`platform = $${i++}`);        params.push(patch.platform); }
    if (patch.meta_account_id !== undefined) { sets.push(`meta_account_id = $${i++}`); params.push(patch.meta_account_id); }
```

Also update `insertIfMissing` (lines 40-51) only if it's used for destination bindings — it is used for seeding default Telegram bindings, so leave it as-is (defaults `platform='telegram'` via the column default; `meta_account_id` defaults NULL). No change needed there.

- [ ] **Step 5: Populate the new fields in `resolveStrategyBindings()`**

In `apps/automation/src/config/channel-config.service.ts`, replace the body of `resolveStrategyBindings()` (lines 106-119) with:

```ts
  resolveStrategyBindings(): ResolvedStrategyBinding[] {
    return this.cache.getBindings().map(b => {
      const ch = b.channel_id ? this.cache.getChannelById(b.channel_id) : null;
      return {
        id:        b.ext_id,
        uuid:      b.id,
        type:      b.type,
        channelId: ch?.channel_key ?? b.channel_id ?? '',
        schedule:  b.schedule,
        params:    b.params,
        enabled:   b.enabled,
        platform:  b.platform,
        metaAccountId: b.meta_account_id,
      };
    });
  }
```

(This removes the temporary `platform: 'telegram' as const` / `metaAccountId: null` literals added in Task 2 Step 2.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test src/config/channel-config.resolve.test.ts`
Expected: PASS — `# pass 2`.

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/config/strategy-bindings.repository.ts src/config/channel-config.service.ts \
        src/config/channel-config.resolve.test.ts
git commit -m "feat(strategy): bindings carry platform + meta_account_id through resolution"
```

---

### Task 4: Interface + runner thread the destination

**Files:**
- Modify: `apps/automation/src/common/content-strategy/content-strategy.interface.ts:56`
- Modify: `apps/automation/src/common/content-strategy/content-strategy.runner.ts`
- Test: `apps/automation/src/common/content-strategy/content-strategy.runner.dest.test.ts` (create)

- [ ] **Step 1: Widen the `execute` signature**

In `content-strategy.interface.ts`, add the import at the top:

```ts
import type { PublishDestination } from './publish-destination';
```

and change line 56 from:

```ts
  execute?(channelId: string, params: StrategyParams): Promise<void>;
```

to:

```ts
  execute?(channelId: string, params: StrategyParams, dest?: PublishDestination): Promise<void>;
```

- [ ] **Step 2: Write the failing runner test**

Create `apps/automation/src/common/content-strategy/content-strategy.runner.dest.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentStrategyRunner } from './content-strategy.runner';
import type { PublishDestination } from './publish-destination';

function makeThrottle() {
  const calls: { lock: string[]; release: string[] } = { lock: [], release: [] };
  return {
    calls,
    tryLock: (key: string) => { calls.lock.push(key); return true; },
    logCooldown: () => {},
    remainingMs: () => 0,
    releaseLock: (key: string) => { calls.release.push(key); },
  };
}

function runner(throttle: any) {
  // Only throttle + the strategy are exercised; other deps go unused on the
  // custom-execute path. Pass empty objects.
  return new ContentStrategyRunner(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    throttle as any, {} as any, {} as any,
  );
}

test('custom execute receives the destination; throttle keyed by throttleKey', async () => {
  const throttle = makeThrottle();
  const r = runner(throttle);
  let got: PublishDestination | undefined;
  const strategy: any = {
    type: 'recipes',
    execute: async (_c: string, _p: any, dest?: PublishDestination) => { got = dest; },
  };
  const dest: PublishDestination = {
    platform: 'instagram', targetId: 'ig-target', token: 't',
    metaAccountId: 'acct-1', postedKey: 'IG:acct-1', throttleKey: 'meta:acct-1',
  };
  await r.run(strategy, '', {}, 'recipes-ig', dest);
  assert.equal(got?.postedKey, 'IG:acct-1');
  assert.deepEqual(throttle.calls.lock, ['meta:acct-1']);
  // No publish happened (execute is a no-op, remainingMs=0) → lock released.
  assert.deepEqual(throttle.calls.release, ['meta:acct-1']);
});

test('without a destination, throttle falls back to channelId', async () => {
  const throttle = makeThrottle();
  const r = runner(throttle);
  const strategy: any = { type: 'recipes', execute: async () => {} };
  await r.run(strategy, '@ai0_recipes', {}, 'recipes-tg');
  assert.deepEqual(throttle.calls.lock, ['@ai0_recipes']);
  assert.deepEqual(throttle.calls.release, ['@ai0_recipes']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test src/common/content-strategy/content-strategy.runner.dest.test.ts`
Expected: FAIL — `run()` ignores the 5th arg; `execute` called without `dest`, and throttle keyed by `''`/channelId not `throttleKey`.

- [ ] **Step 4: Thread `dest` through the runner**

In `content-strategy.runner.ts`:

Add the import:

```ts
import type { PublishDestination } from './publish-destination';
```

Change the `run` signature (lines 34-39) to add a trailing optional param:

```ts
  async run(
    strategy: ContentStrategy,
    channelId: string,
    params: StrategyParams,
    strategyId: string,
    dest?: PublishDestination,
  ): Promise<void> {
```

Immediately after `const tag = ...` (line 40), add:

```ts
    const lockKey = dest?.throttleKey ?? channelId;
```

Replace every `this.throttle.*(channelId)` call in the method with `lockKey`. Specifically:
- line 48 `if (!this.throttle.tryLock(channelId))` → `if (!this.throttle.tryLock(lockKey))`
- line 49 `this.throttle.logCooldown(strategyId, channelId)` → `this.throttle.logCooldown(strategyId, lockKey)`
- line 73 `if (this.throttle.remainingMs(channelId) === 0)` → `if (this.throttle.remainingMs(lockKey) === 0)`
- line 74 `this.throttle.releaseLock(channelId)` → `this.throttle.releaseLock(lockKey)`
- lines 84, 105, 114, 123, 182 `this.throttle.releaseLock(channelId)` → `this.throttle.releaseLock(lockKey)` (the generic-path release sites).

Change the custom-execute call (line 63) to pass the destination:

```ts
        await strategy.execute(channelId, params, dest);
```

Guard the generic (non-execute) path against a Meta destination — the generic pipeline only knows how to publish to Telegram. Right after the `if (strategy.execute) { ... return; }` block (after line 79), add:

```ts
    if (dest && dest.platform !== 'telegram') {
      this.throttle.releaseLock(lockKey);
      this.logger.warn(`${tag} Meta destination not supported by the generic pipeline — skipping`);
      return;
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/common/content-strategy/content-strategy.runner.dest.test.ts`
Expected: PASS — `# pass 2`.

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/common/content-strategy/content-strategy.interface.ts \
        src/common/content-strategy/content-strategy.runner.ts \
        src/common/content-strategy/content-strategy.runner.dest.test.ts
git commit -m "feat(strategy): runner threads PublishDestination to execute()"
```

---

### Task 5: Scheduler resolves + passes the destination

**Files:**
- Modify: `apps/automation/src/scheduler/scheduler.service.ts`

The scheduler tick is wrapped in a `CronJob` and is impractical to unit-test in isolation; this task is verified by `tsc` (wiring) and is exercised end-to-end by the user's smoke test. Keep the change minimal and mechanical.

- [ ] **Step 1: Inject `DestinationResolver`**

In `scheduler.service.ts`, add the import:

```ts
import { DestinationResolver } from '../common/content-strategy/destination-resolver.service';
```

Add it to the constructor (after `strategyRegistry`, before the `@Inject(REDIS_CLIENT)` param):

```ts
    private readonly destinationResolver: DestinationResolver,
```

(`DestinationResolver` is exported from the @Global `common.module`, so no module-imports change is needed.)

- [ ] **Step 2: Resolve the destination in the tick and pass it to the runner**

In `startJob`, the tick currently does (lines 174-194):

```ts
      const fresh = this.channelConfig.resolveStrategyBindings()
        .find(b => b.id === job.meta.extId);
      if (!fresh || !fresh.enabled) {
        this.inFlight.delete(name);
        return;
      }
      const strategy = this.strategyRegistry.get(fresh.type);
      if (!strategy) {
        this.inFlight.delete(name);
        return;
      }
      ...
      try {
        await this.strategyRunner.run(strategy, fresh.channelId, fresh.params, fresh.id);
```

After the `strategy` null-check block (after line 184), add destination resolution:

```ts
      let dest;
      try {
        dest = await this.destinationResolver.resolve(fresh);
      } catch (err: any) {
        this.logger.warn(`${name} destination resolve failed: ${err.message}`);
        this.inFlight.delete(name);
        return;
      }
```

Change the runner call (line 194) to pass it:

```ts
        await this.strategyRunner.run(strategy, fresh.channelId, fresh.params, fresh.id, dest);
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/scheduler.service.ts
git commit -m "feat(scheduler): resolve PublishDestination per tick and pass to runner"
```

---

### Task 6: recipes — per-destination dedup + Meta branch

**Files:**
- Modify: `apps/automation/src/strategies/recipes/recipes.repository.ts:42-56,88-95`
- Modify: `apps/automation/src/strategies/recipes/recipes.strategy.ts`
- Modify: `apps/automation/src/strategies/recipes/recipes.strategy.test.ts`

- [ ] **Step 1: Parameterize the repo dedup key**

In `recipes.repository.ts`, change `getNext()` to take a destination key (default `'TELEGRAM'`):

```ts
  async getNext(postedKey = 'TELEGRAM'): Promise<RecipeRow | null> {
    const { rows } = await this.pool.query<RecipeRow>(
      `SELECT id, title, image_url, category, ingredients, instructions,
              title_uk, ingredients_uk, instructions_uk,
              telegraph_url, telegraph_path,
              kcal, protein_g, fat_g, carbs_g, serving_size_g
       FROM recipes
       WHERE NOT (posted ? $1)
         AND title_uk IS DISTINCT FROM ''
         AND kcal IS NOT NULL
       ORDER BY created_at
       LIMIT 1`,
      [postedKey],
    );
    return rows[0] ?? null;
  }
```

and `markPosted()`:

```ts
  async markPosted(id: string, postedKey = 'TELEGRAM'): Promise<void> {
    await this.pool.query(
      `UPDATE recipes
       SET posted = posted || jsonb_build_object($2, to_jsonb(now()))
       WHERE id = $1`,
      [id, postedKey],
    );
  }
```

- [ ] **Step 2: Add the dispatcher dependency to the strategy**

In `recipes.strategy.ts`, add imports:

```ts
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import type { PublishDestination } from '../../common/content-strategy/publish-destination';
```

Add `private readonly dispatcher: PublisherDispatcher,` as the LAST constructor parameter (after `crossPost`). `PublisherDispatcher` is exported from the @Global `PublishersModule`, so no module change is needed.

- [ ] **Step 3: Write the failing Meta-branch test**

In `recipes.strategy.test.ts`: update the `build()` helper's `new RecipesStrategy(...)` call to append a `dispatcher` fake as the final arg, and add the fake. After the `crossPost` fake (around line 40), add:

```ts
  const dispatcher = { publish: async (...a: any[]) => { calls.dispatch = a; return 'ig-99'; } };
```

and add `dispatch: null as any,` to the `calls` object initializer. Append `dispatcher as any` to the constructor call.

Then add a new test (the existing tests already cover the Telegram path):

```ts
test('meta destination publishes via dispatcher and marks the per-account key', async () => {
  const calls = { dispatch: null as any, posted: [] as any[] };
  const repo = {
    getNext: async (_k?: string) => makeRow({ title_uk: 'Пом Анна', ingredients_uk: 'Картопля', kcal: '84' }),
    saveTranslation: async () => {}, saveTelegraph: async () => {},
    markPosted: async (id: string, key?: string) => { calls.posted.push([id, key]); },
  };
  const dispatcher = { publish: async (...a: any[]) => { calls.dispatch = a; return 'ig-99'; } };
  const telegraph = { available: async () => false, createPage: async () => ({ url: '', path: '' }) };
  const s = new RecipesStrategy(
    { available: true, chat: async () => JSON.stringify({ title_uk: 'Пом Анна', ingredients_uk: 'Картопля', instructions_uk: '1.' }) } as any,
    { check: () => true } as any, { register() {} } as any,
    { publishPrompt: async () => '42' } as any,
    telegraph as any, repo as any, { notifyPublished: async () => {} } as any,
    { insert: async () => {} } as any, { afterPublish: async () => {} } as any,
    dispatcher as any,
  );
  const dest = {
    platform: 'instagram', targetId: 'ig-target', token: 'tok',
    metaAccountId: 'acct-1', postedKey: 'IG:acct-1', throttleKey: 'meta:acct-1',
  };
  await s.execute('', {}, dest as any);
  assert.ok(calls.dispatch, 'dispatcher.publish was called');
  assert.equal(calls.dispatch[0], 'instagram');           // platform
  assert.equal(calls.dispatch[2].id, 'ig-target');        // target id
  assert.equal(calls.dispatch[2].token, 'tok');           // token
  assert.ok(calls.dispatch[1].imageUrl, 'image url present');
  assert.deepEqual(calls.posted, [['r1', 'IG:acct-1']]);  // per-account dedup key
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx tsx --test src/strategies/recipes/recipes.strategy.test.ts`
Expected: FAIL — `execute` ignores `dest`, takes the Telegram path; `dispatcher.publish` never called.

- [ ] **Step 5: Implement the Meta branch in `execute`**

In `recipes.strategy.ts`, change the `execute` signature and add the branch. Current head (lines 68-72):

```ts
  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const row = await this.repo.getNext();
    if (!row) { this.logger.debug('No unposted recipes'); return; }

    const uk = await this.resolveTranslation(row);
    if (!uk) return;
```

Replace with:

```ts
  async execute(channelId: string, _params: StrategyParams, dest?: PublishDestination): Promise<void> {
    const postedKey = dest?.postedKey ?? 'TELEGRAM';
    const row = await this.repo.getNext(postedKey);
    if (!row) { this.logger.debug('No unposted recipes'); return; }

    const uk = await this.resolveTranslation(row);
    if (!uk) return;

    // Native Meta publish: same recipe pool, inline caption + dish photo, no
    // Telegraph / notifier / publications / cross-post (those are TG-only).
    if (dest && dest.platform !== 'telegram') {
      const nutri   = this.nutritionLine(row);
      const caption = this.buildCaption(uk.titleUk, row.category, uk.ingredientsUk, nutri);
      try {
        const id = await this.dispatcher.publish(
          dest.platform,
          { text: caption, imageUrl: row.image_url, source: '', tags: row.category ? [row.category] : [] },
          { id: dest.targetId, token: dest.token! },
        );
        await this.repo.markPosted(row.id, postedKey);
        this.logger.debug(`Published recipe ${row.id} to ${dest.platform} (${id})`);
      } catch (err: any) {
        this.logger.error(`Meta publish failed (${row.id} → ${dest.platform}): ${err.message}`);
      }
      return;
    }
```

Leave the rest of the Telegram path below unchanged, EXCEPT change its `markPosted` call (currently `await this.repo.markPosted(row.id);`) to pass the key explicitly:

```ts
    await this.repo.markPosted(row.id, postedKey);
```

(On the Telegram path `postedKey === 'TELEGRAM'`, so behavior is identical.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test src/strategies/recipes/recipes.strategy.test.ts`
Expected: PASS — all existing tests plus the new Meta-branch test.

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/strategies/recipes/recipes.repository.ts \
        src/strategies/recipes/recipes.strategy.ts \
        src/strategies/recipes/recipes.strategy.test.ts
git commit -m "feat(recipes): native Meta publishing + per-destination dedup"
```

---

### Task 7: ai0-prompts — per-destination dedup + Meta branch

**Files:**
- Modify: `apps/automation/src/strategies/ai0-prompts/prompts.repository.ts:18-30,44-48`
- Modify: `apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.ts`
- Test: `apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.meta.test.ts` (create — there is no existing ai0-prompts test)

Confirm the repository filename first: `ls apps/automation/src/strategies/ai0-prompts/`. The repo class is `PromptsRepository`. If the file is named differently (e.g. `prompts.repository.ts`), use that path.

- [ ] **Step 1: Parameterize the repo dedup key**

In `prompts.repository.ts`, change `getNext()`:

```ts
  async getNext(category: string, postedKey = 'TELEGRAM'): Promise<PromptRow | null> {
    const { rows } = await this.pool.query<PromptRow>(
      `SELECT id, prompt_source, category, status, posted
       FROM prompts
       WHERE category = $1
         AND provider = 'prompthero'
         AND status IS NULL
         AND NOT (posted ? $2)
       LIMIT 1`,
      [category, postedKey],
    );
    return rows[0] ?? null;
  }
```

and `markPosted()`:

```ts
  async markPosted(id: string, postedKey = 'TELEGRAM'): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET posted = posted || jsonb_build_object($2, NOW()) WHERE id = $1`,
      [id, postedKey],
    );
  }
```

- [ ] **Step 2: Add the dispatcher dependency + Meta branch**

In `ai0-prompts.strategy.ts`, add imports:

```ts
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import type { PublishDestination } from '../../common/content-strategy/publish-destination';
```

Add `private readonly dispatcher: PublisherDispatcher,` as the LAST constructor parameter.

Change `execute` to accept `dest?` and thread the posted key. Head currently (lines 59-72):

```ts
  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const MIN_PROMPT_LENGTH = 50;
    const USER_AGENT = ...;
    const category = this.categories[Math.floor(Math.random() * this.categories.length)];
    this.logger.debug(`Selected category: ${category}`);
    const row = await this.db.getNext(category);
    if (!row) { ... return; }
```

Change to:

```ts
  async execute(channelId: string, _params: StrategyParams, dest?: PublishDestination): Promise<void> {
    const MIN_PROMPT_LENGTH = 50;
    const USER_AGENT = ...;  // keep existing value
    const postedKey = dest?.postedKey ?? 'TELEGRAM';
    const category = this.categories[Math.floor(Math.random() * this.categories.length)];
    this.logger.debug(`Selected category: ${category}`);
    const row = await this.db.getNext(category, postedKey);
    if (!row) { this.logger.debug(`No unposted prompts for category: ${category}`); return; }
```

The scrape/validate/build steps (fetch page → `extractMeta` → length check → `buildMessage`) are shared and stay as-is. At the publish step, branch. The current publish block (lines ~118-153) downloads the image and calls `this.telegram.publishPrompt(...)`. Wrap it:

```ts
    if (dest && dest.platform !== 'telegram') {
      // row.id IS the PromptHero image URL — Meta fetches it directly.
      try {
        const id = await this.dispatcher.publish(
          dest.platform,
          { text: message.caption, imageUrl: row.id, source: '', tags: [category] },
          { id: dest.targetId, token: dest.token! },
        );
        await this.db.markPosted(row.id, postedKey);
        this.logger.debug(`Published prompt to ${dest.platform} (${id})`);
      } catch (err: any) {
        this.logger.error(`Meta publish failed → ${dest.platform}: ${err.message}`);
      }
      return;
    }
```

Place that block immediately before the existing "6. Download image" step, so the Meta path skips the Telegram image download + `publishPrompt` + notifier + publications + crossPost entirely. In the remaining Telegram path, change `await this.db.markPosted(row.id);` to `await this.db.markPosted(row.id, postedKey);` (key is `'TELEGRAM'`).

- [ ] **Step 3: Write the Meta-branch test**

Create `apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.meta.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ai0PromptsStrategy } from './ai0-prompts.strategy';

test('meta destination publishes prompthero image url via dispatcher', async () => {
  const calls = { dispatch: null as any, posted: [] as any[] };
  // Scraper returns a valid long prompt + caption so the strategy reaches publish.
  const scraper = {
    extractMeta: () => ({ prompt: 'x'.repeat(80) }),
    buildMessage: () => ({ isError: false, caption: 'A caption', replyText: null }),
  };
  const db = {
    getNext: async (_cat: string, _key?: string) => ({ id: 'https://img/p.png', prompt_source: 'https://prompthero/p', category: 'art', status: null, posted: null }),
    markPosted: async (id: string, key?: string) => { calls.posted.push([id, key]); },
    markError: async () => {},
  };
  const dispatcher = { publish: async (...a: any[]) => { calls.dispatch = a; return 'ig-7'; } };

  // axios.get is called for the page fetch; stub the strategy's http via a
  // module-level mock is overkill — instead, the strategy fetches row.prompt_source.
  // Provide a scraper that doesn't need real HTML by making extractMeta ignore input.
  // Constructor order (verified): registry, telegram, db, scraper, notifier,
  // publications, crossPost, dispatcher (dispatcher appended last in Step 2).
  const s = new Ai0PromptsStrategy(
    { register() {} } as any,                  // registry
    { publishPrompt: async () => '1' } as any, // telegram
    db as any,                                 // db (PromptsRepository)
    scraper as any,                            // scraper
    { notifyPublished: async () => {} } as any,// notifier
    { insert: async () => {} } as any,         // publications
    { afterPublish: async () => {} } as any,   // crossPost
    dispatcher as any,                         // dispatcher (NEW, last)
  );

  const dest = { platform: 'instagram', targetId: 'ig-target', token: 'tok', metaAccountId: 'acct-1', postedKey: 'IG:acct-1', throttleKey: 'meta:acct-1' };
  // The page fetch uses axios; it will throw on a fake URL and return early UNLESS
  // the scrape is reached. If your class fetches before scraping, set the test to
  // mock axios via `import { mock } from 'node:test'`; see note below.
  await s.execute('', {}, dest as any);

  assert.ok(calls.dispatch, 'dispatcher.publish called');
  assert.equal(calls.dispatch[0], 'instagram');
  assert.equal(calls.dispatch[1].imageUrl, 'https://img/p.png');
  assert.deepEqual(calls.posted, [['https://img/p.png', 'IG:acct-1']]);
});
```

IMPLEMENTER NOTE: `ai0-prompts.strategy.ts` fetches `row.prompt_source` via `axios.get` BEFORE scraping. For a hermetic unit test, mock axios with `node:test`'s `mock.method` on the imported `axios` default, returning `{ data: '<html>' }` for the page GET. Read the top of `ai0-prompts.strategy.ts` to confirm the exact axios import, then mock it:

```ts
import { mock } from 'node:test';
import axios from 'axios';
// inside the test, before s.execute:
mock.method(axios, 'get', async () => ({ data: '<html></html>' }));
```

- [ ] **Step 4: Run the test to verify it fails, implement, then passes**

Run: `npx tsx --test src/strategies/ai0-prompts/ai0-prompts.strategy.meta.test.ts`
Expected: FAIL first (no Meta branch), PASS after Step 2.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/strategies/ai0-prompts/prompts.repository.ts \
        src/strategies/ai0-prompts/ai0-prompts.strategy.ts \
        src/strategies/ai0-prompts/ai0-prompts.strategy.meta.test.ts
git commit -m "feat(ai0-prompts): native Meta publishing + per-destination dedup"
```

---

### Task 8: curated-prompts — per-destination dedup + Meta branch (image only)

**Files:**
- Modify: `apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts:24-39,56-60`
- Modify: `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts:48-102`
- Modify: `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.test.ts`

- [ ] **Step 1: Parameterize the repo dedup key**

In `curated-prompts.repository.ts`, change `getNext()` to take a trailing `postedKey`:

```ts
  async getNext(filter: CuratedFilter = {}, postedKey = 'TELEGRAM'): Promise<CuratedPromptRow | null> {
    const { rows } = await this.pool.query<CuratedPromptRow>(
      `SELECT id, category, title, prompt_text, source, media_url, media_type
       FROM prompts
       WHERE provider <> 'prompthero'
         AND prompt_text IS NOT NULL
         AND NOT (posted ? $3)
         AND status IS DISTINCT FROM 'ERROR'
         AND ($1::text IS NULL OR provider   = $1)
         AND ($2::text IS NULL OR media_type = $2)
       ORDER BY created_at
       LIMIT 1`,
      [filter.provider ?? null, filter.mediaType ?? null, postedKey],
    );
    return rows[0] ?? null;
  }
```

and `markPosted()`:

```ts
  async markPosted(id: string, postedKey = 'TELEGRAM'): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET posted = posted || jsonb_build_object($2, NOW()) WHERE id = $1`,
      [id, postedKey],
    );
  }
```

- [ ] **Step 2: Add dispatcher + Meta branch (image rows only)**

In `curated-prompts.strategy.ts`, add imports:

```ts
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import type { PublishDestination } from '../../common/content-strategy/publish-destination';
```

Add `private readonly dispatcher: PublisherDispatcher,` as the LAST constructor parameter.

Change `execute` (lines 48-52 head):

```ts
  async execute(channelId: string, params: StrategyParams, dest?: PublishDestination): Promise<void> {
    const postedKey = dest?.postedKey ?? 'TELEGRAM';
    const p = (params ?? {}) as { provider?: string; mediaType?: string };
    const row = await this.repo.getNext({ provider: p.provider, mediaType: p.mediaType }, postedKey);
    if (!row) { this.logger.debug('No unposted curated prompts'); return; }

    const { caption, replyText } = this.buildMessage(row);

    if (dest && dest.platform !== 'telegram') {
      // Instagram publisher takes a public image only; skip video rows (set
      // params.mediaType = 'image' on an IG binding to avoid selecting them).
      if (row.media_type !== 'image') {
        this.logger.debug(`Skipping ${row.media_type} row ${row.id} for ${dest.platform}`);
        return;
      }
      try {
        const id = await this.dispatcher.publish(
          dest.platform,
          { text: caption, imageUrl: row.media_url, source: '', tags: row.category ? [row.category] : [] },
          { id: dest.targetId, token: dest.token! },
        );
        await this.repo.markPosted(row.id, postedKey);
        this.logger.debug(`Published curated ${row.id} to ${dest.platform} (${id})`);
      } catch (err: any) {
        this.logger.error(`Meta publish failed (${row.id} → ${dest.platform}): ${err.message}`);
      }
      return;
    }
```

Leave the existing Telegram body (the `try { ... publishVideo/publishPrompt ... }` block) unchanged, except change its `await this.repo.markPosted(row.id);` to `await this.repo.markPosted(row.id, postedKey);`.

- [ ] **Step 3: Update the existing test constructor + add a Meta-branch case**

In `curated-prompts.strategy.test.ts`, append a `dispatcher` fake to the `new CuratedPromptsStrategy(...)` call (final arg) and add:

```ts
test('meta destination publishes image row via dispatcher; video skipped', async () => {
  const calls = { dispatch: null as any, posted: [] as any[] };
  const make = (media_type: string) => ({
    repo: {
      getNext: async (_f: any, _k?: string) => ({ id: 'c1', category: 'art', title: 't', prompt_text: 'p', source: null, media_url: 'https://img/a.png', media_type }),
      markPosted: async (id: string, key?: string) => { calls.posted.push([id, key]); },
      markError: async () => {},
    },
    dispatcher: { publish: async (...a: any[]) => { calls.dispatch = a; return 'ig-3'; } },
  });
  const dest = { platform: 'instagram', targetId: 'ig-target', token: 'tok', metaAccountId: 'acct-1', postedKey: 'IG:acct-1', throttleKey: 'meta:acct-1' };

  // Constructor order (verified): registry, publisher, repo, notifier,
  // publications, crossPost, dispatcher (dispatcher appended last in Step 2).
  const construct = (m: any) => new CuratedPromptsStrategy(
    { register() {} } as any,                                                 // registry
    { publishPrompt: async () => '1', publishVideo: async () => '1' } as any, // publisher
    m.repo as any,                                                            // repo
    { notifyPublished: async () => {} } as any,                              // notifier
    { insert: async () => {} } as any,                                       // publications
    { afterPublish: async () => {} } as any,                                 // crossPost
    m.dispatcher as any,                                                     // dispatcher (NEW)
  );

  // image row → published
  let m = make('image');
  let s = construct(m);
  await s.execute('', {}, dest as any);
  assert.equal(calls.dispatch[1].imageUrl, 'https://img/a.png');
  assert.deepEqual(calls.posted, [['c1', 'IG:acct-1']]);

  // video row → skipped, no dispatch, no markPosted
  calls.dispatch = null; calls.posted.length = 0;
  m = make('video');
  s = construct(m);
  await s.execute('', {}, dest as any);
  assert.equal(calls.dispatch, null);
  assert.deepEqual(calls.posted, []);
});
```

- [ ] **Step 4: Run the test to verify it fails, implement, then passes**

Run: `npx tsx --test src/strategies/curated-prompts/curated-prompts.strategy.test.ts`
Expected: FAIL first, PASS after Step 2.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/strategies/curated-prompts/curated-prompts.repository.ts \
        src/strategies/curated-prompts/curated-prompts.strategy.ts \
        src/strategies/curated-prompts/curated-prompts.strategy.test.ts
git commit -m "feat(curated-prompts): native Meta publishing (image) + per-destination dedup"
```

---

### Task 9: API DTO + controller destination invariant

**Files:**
- Modify: `apps/automation/src/config/api/dto/strategies.dto.ts`
- Modify: `apps/automation/src/config/api/strategies.controller.ts`
- Test: `apps/automation/src/config/api/strategies.controller.dest.test.ts` (create)

- [ ] **Step 1: Extend the DTOs**

In `strategies.dto.ts`, in `CreateStrategyDto` make `channel_id` optional and add the two destination fields. Replace the `@IsUUID() channel_id!: string;` block with:

```ts
  @IsOptional()
  @IsUUID()
  channel_id?: string;

  @IsOptional()
  @IsIn(['telegram', 'instagram', 'facebook', 'threads'])
  platform?: 'telegram' | 'instagram' | 'facebook' | 'threads';

  @IsOptional()
  @IsUUID()
  meta_account_id?: string;
```

Add `IsIn` to the `class-validator` import at the top of the file. Mirror the same three fields onto `PatchStrategyDto` (all `@IsOptional()`).

- [ ] **Step 2: Write the failing controller test**

Create `apps/automation/src/config/api/strategies.controller.dest.test.ts`. The controller's `create()` throws `BadRequestException`/`ConflictException` for invalid input; test the destination invariant with fakes:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function make(over: any = {}) {
  const repo = {
    findByExtId: async () => null,
    insert: async (row: any) => ({ id: 'new', ...row }),
    findById: async () => null,
    update: async () => null,
    ...over.repo,
  };
  const cache = { getChannelById: (id: string) => (over.channelExists === false ? null : { id }) };
  const metaAccounts = { findById: async () => (over.accountExists === false ? null : { id: 'acct-1', active: true }) };
  const publisher = { publish: async () => {} };
  // Constructor order (verified): repo, runsRepo, preview, cache, publisher,
  // crossposts, runway, metaAccounts (metaAccounts appended last in Step 4).
  // Unused deps get empty fakes.
  return new StrategiesController(
    repo as any,        // repo
    {} as any,          // runsRepo
    {} as any,          // preview
    cache as any,       // cache
    publisher as any,   // publisher (ConfigEventsPublisher)
    {} as any,          // crossposts
    {} as any,          // runway
    metaAccounts as any,// metaAccounts (NEW, last)
  );
}

test('telegram binding requires channel_id', async () => {
  const c = make();
  await assert.rejects(
    () => c.create({ ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', platform: 'telegram' } as any),
    /channel_id is required/,
  );
});

test('meta binding requires meta_account_id', async () => {
  const c = make();
  await assert.rejects(
    () => c.create({ ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', platform: 'instagram' } as any),
    /meta_account_id is required/,
  );
});

test('meta binding rejects unknown account', async () => {
  const c = make({ accountExists: false });
  await assert.rejects(
    () => c.create({ ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', platform: 'instagram', meta_account_id: 'nope' } as any),
    /meta account .* not found/,
  );
});

test('valid meta binding inserts with platform + meta_account_id', async () => {
  const c = make();
  const row = await c.create({ ext_id: 'recipes-ig', type: 'recipes', schedule: '0 9 * * *', platform: 'instagram', meta_account_id: 'acct-1' } as any);
  assert.equal(row.platform, 'instagram');
  assert.equal(row.meta_account_id, 'acct-1');
  assert.equal(row.channel_id ?? null, null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test src/config/api/strategies.controller.dest.test.ts`
Expected: FAIL — controller doesn't inject `metaAccounts` / doesn't enforce the invariant.

- [ ] **Step 4: Implement the invariant**

In `strategies.controller.ts`:
- Add `import { MetaAccountsRepository } from '../meta-accounts.repository';`.
- Inject `private readonly metaAccounts: MetaAccountsRepository,` as the LAST constructor parameter (after `runway`). It's a provider in the same `ChannelConfigModule`, so no module change is needed.

Replace the `create()` body (lines 140-162) with destination-aware validation:

```ts
  @Post()
  async create(@Body() body: CreateStrategyDto) {
    assertCronOrThrow(body.schedule);

    const existing = await this.repo.findByExtId(body.ext_id);
    if (existing) throw new ConflictException(`ext_id ${body.ext_id} already exists`);

    const platform = body.platform ?? 'telegram';
    if (platform === 'telegram') {
      if (!body.channel_id) throw new BadRequestException('channel_id is required for a telegram binding');
      if (!this.cache.getChannelById(body.channel_id)) {
        throw new BadRequestException(`channel_id ${body.channel_id} not found`);
      }
      if (body.meta_account_id) throw new BadRequestException('telegram binding must not set meta_account_id');
    } else {
      if (!body.meta_account_id) throw new BadRequestException('meta_account_id is required for a meta binding');
      const acct = await this.metaAccounts.findById(body.meta_account_id);
      if (!acct) throw new BadRequestException(`meta account ${body.meta_account_id} not found`);
      if (body.channel_id) throw new BadRequestException('meta binding must not set channel_id');
    }

    const row = await this.repo.insert({
      ext_id:     body.ext_id,
      type:       body.type,
      channel_id: platform === 'telegram' ? body.channel_id! : null,
      schedule:   body.schedule,
      params:     body.params ?? {},
      enabled:    body.enabled ?? false,
      platform,
      meta_account_id: platform === 'telegram' ? null : body.meta_account_id!,
    });
    await this.publisher.publish('strategy', row.id);
    return row;
  }
```

In `patch()` (lines 164-177), add the same channel/meta validation when `body.platform` or `body.meta_account_id` or `body.channel_id` is present. Minimal addition after the existing `channel_id` existence check:

```ts
    if (body.meta_account_id !== undefined && body.meta_account_id !== null) {
      const acct = await this.metaAccounts.findById(body.meta_account_id);
      if (!acct) throw new BadRequestException(`meta account ${body.meta_account_id} not found`);
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/config/api/strategies.controller.dest.test.ts`
Expected: PASS — `# pass 4`.

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config/api/dto/strategies.dto.ts src/config/api/strategies.controller.ts \
        src/config/api/strategies.controller.dest.test.ts
git commit -m "feat(api): strategy binding destination invariant (telegram | meta)"
```

---

### Task 10: Dashboard — destination selector

**Files:**
- Modify: `apps/dashboard/src/api/strategies.ts:33-49`
- Modify: `apps/dashboard/src/components/AddStrategyModal.tsx`
- Modify: `apps/dashboard/src/components/EditStrategyModal.tsx`

The dashboard has no unit test runner; verify with `tsc` + `vite build` + a Cyrillic-free grep (UI is English-only per the i18n work).

- [ ] **Step 1: Extend the create input type**

In `apps/dashboard/src/api/strategies.ts`, change `CreateStrategyInput` (lines 33-40):

```ts
export interface CreateStrategyInput {
  ext_id:      string;
  type:        string;
  channel_id?: string;
  schedule:    string;
  params?:     Record<string, unknown>;
  enabled?:    boolean;
  platform?:   'telegram' | 'instagram' | 'facebook' | 'threads';
  meta_account_id?: string;
}
```

- [ ] **Step 2: Add the Destination toggle to `AddStrategyModal`**

In `AddStrategyModal.tsx`:

Add state after the existing `useState` calls:

```tsx
  const [destKind,  setDestKind]  = useState<'telegram' | 'meta'>('telegram');
  const [metaId,    setMetaId]    = useState('');
```

Add a query for verified Meta accounts (the endpoint `GET /api/meta-accounts` already exists; import the shared `api` client):

```tsx
  // top of file:
  import { api } from '../api/client';
  // inside the component:
  const metaQ = useQuery({
    queryKey: ['meta-accounts', 'picker'],
    queryFn:  () => api<Array<{ id: string; platform: string; username: string | null; active: boolean }>>('/api/meta-accounts'),
    enabled:  open && destKind === 'meta',
  });
```

Add a Destination field BEFORE the Channel field:

```tsx
      <Field label="Destination">
        <select
          value={destKind}
          onChange={e => setDestKind(e.target.value as 'telegram' | 'meta')}
          className="input-field"
          style={{ width: '100%' }}
        >
          <option value="telegram">Telegram channel</option>
          <option value="meta">Meta account (Instagram / Facebook / Threads)</option>
        </select>
      </Field>
```

Wrap the existing Channel `<Field>` so it shows only for Telegram (`{destKind === 'telegram' && ( ...existing Channel Field... )}`), and add a Meta-account picker shown only for Meta:

```tsx
      {destKind === 'meta' && (
        <Field label="Meta account" hint="verified accounts only">
          <select
            value={metaId}
            onChange={e => setMetaId(e.target.value)}
            className="input-field"
            style={{ width: '100%' }}
          >
            <option value="" disabled>
              {metaQ.isLoading ? 'Loading…' : 'Pick a Meta account'}
            </option>
            {metaQ.data?.filter(a => a.active).map(a => (
              <option key={a.id} value={a.id}>{a.platform} — {a.username ?? a.id}</option>
            ))}
          </select>
        </Field>
      )}
```

Update `submit()` to send the right destination, and `valid`:

```tsx
  const submit = async () => {
    try {
      await create.mutateAsync({
        ext_id:   extId.trim(),
        type:     type.trim(),
        schedule: schedule.trim(),
        enabled:  false,
        params:   {},
        ...(destKind === 'telegram'
          ? { channel_id: channelId, platform: 'telegram' as const }
          : { platform: (metaPlatformOf(metaQ.data, metaId) ?? 'instagram'), meta_account_id: metaId }),
      });
      setExtId(''); setType(''); setChannelId(''); setSchedule('0 9 * * *');
      setDestKind('telegram'); setMetaId('');
      onClose();
    } catch { /* error rendered below */ }
  };

  const valid = !!extId && !!type && !!schedule &&
    (destKind === 'telegram' ? !!channelId : !!metaId);
```

Add the small helper near the bottom of the file (next to `Field`):

```tsx
function metaPlatformOf(
  accounts: Array<{ id: string; platform: string }> | undefined,
  id: string,
): 'instagram' | 'facebook' | 'threads' | undefined {
  const p = accounts?.find(a => a.id === id)?.platform;
  return p === 'instagram' || p === 'facebook' || p === 'threads' ? p : undefined;
}
```

- [ ] **Step 3: Show destination read-only in `EditStrategyModal`**

In `EditStrategyModal.tsx`, add a small read-only line near the top of the form showing the binding's destination (the `Strategy` object already carries `channel_key`; if it doesn't carry `platform`, show the channel and a note). Minimal, non-editable:

```tsx
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 12 }}>
        Destination is fixed at creation. To change it, delete and recreate the strategy.
      </div>
```

Read the existing `EditStrategyModal.tsx` to place this above the schedule/params fields. Do not add destination editing.

- [ ] **Step 4: Type check + build**

Run (from `apps/dashboard`): `npx tsc --noEmit && npx vite build`
Expected: build succeeds, no TS errors.

- [ ] **Step 5: Cyrillic guard (UI is English-only)**

Run (from `apps/dashboard`): `grep -RnP "[\\x{0400}-\\x{04FF}]" src/components/AddStrategyModal.tsx src/components/EditStrategyModal.tsx || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
git add src/api/strategies.ts src/components/AddStrategyModal.tsx src/components/EditStrategyModal.tsx
git commit -m "feat(dashboard): strategy destination selector (Telegram channel | Meta account)"
```

---

### Task 11: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the automation unit suite**

Run (from `apps/automation`): `npx tsx --test 'src/**/*.test.ts'`
Expected: all tests pass, `# fail 0`. (If the glob is unsupported by the shell, run the touched test files individually: the resolver, runner-dest, channel-config.resolve, recipes, ai0-prompts meta, curated, controller-dest tests.)

- [ ] **Step 2: Automation type check**

Run (from `apps/automation`): `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Dashboard build**

Run (from `apps/dashboard`): `npx tsc --noEmit && npx vite build`
Expected: success.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test: native Meta publishing — full-suite verification" || echo "nothing to commit"
```

---

## Manual smoke test (USER performs — not the implementer)

After merging + restarting automation (the user does this):
1. Set `INSTAGRAM_TOKEN` in `.env` (already done) and ensure the `ai0.global.info` Meta account is verified + active in the dashboard.
2. Create a strategy via the dashboard: type `recipes`, Destination = Meta account → Instagram `ai0.global.info`, schedule e.g. `0 12 * * *`, leave paused.
3. (Optional) trigger once via `GET /trigger/recipes` (dev only) or enable and wait for the cron tick.
4. Confirm the post appears on Instagram and the `recipes.posted` JSONB gains an `IG:<account_id>` key (independent of `TELEGRAM`).

---

## Post-implementation

Use `superpowers:finishing-a-development-branch` to merge `feat/native-meta-publishing` (decide ordering vs the pending `feat/crosspost-all-strategies` + `feat/responsive-ui` branches with the user).
