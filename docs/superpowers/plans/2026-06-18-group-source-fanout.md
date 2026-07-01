# Configurable Group Source + Generalized Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each brand group designate ANY one member (Facebook / Instagram / Threads / Telegram) as the "source"; publishing to that source mirrors the same content to every other member of the group (Telegram included, as both source and target).

**Architecture:** Add a `source_platform` enum to `meta_account_groups` (default `'facebook'` → no behavior change on migrate). Extract the per-strategy `fanOutToSiblings` duplication into one shared `GroupFanOutService` that (a) resolves the source's group, (b) no-ops unless the publish dest IS the group's designated source, (c) resolves the OTHER members as mixed `PublishDestination[]` (Meta + Telegram), and (d) publishes the same rendered content to each — Meta via `PublisherDispatcher` (full carousel/single), Telegram via `TelegramPublisher` (cover image + caption; the bot API has no album). recipe-carousel gains a Telegram branch so Telegram can be a recipe group's source.

**Tech Stack:** NestJS, `pg`, `node:test`/`tsx --test` (run from `apps/automation` via `npm test`); dashboard React 19 / TanStack Query / Vite.

**Standing constraints:** never restart automation; never trigger publishing; no live external/AI/network calls in tests; pnpm only; tokens/secrets never logged/returned/rendered; existing Telegram recipes flow changed only additively; don't merge without explicit "мерж".

---

## File Structure

**Backend (apps/automation):**
- Create: `database/migrations/035_group_source_platform.sql` — `source_platform` column.
- Modify: `apps/automation/src/config/meta-account-groups.repository.ts` — row + `setSourcePlatform`.
- Modify: `apps/automation/src/config/meta-accounts.repository.ts` — `findActiveByGroup`.
- Modify: `apps/automation/src/tracking/repositories/tracked-channels.repository.ts` — `findByGroupId`, `findGroupIdByChannelKey`.
- Modify: `apps/automation/src/common/content-strategy/destination-resolver.service.ts` — `resolveGroupTargets`, `resolveGroupForDest`.
- Create: `apps/automation/src/common/content-strategy/group-fanout.service.ts` — orchestrator.
- Create: `apps/automation/src/common/content-strategy/group-fanout.service.test.ts` — tests.
- Modify: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts` — use service + Telegram branch.
- Modify: `apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.ts` — use service in Meta + Telegram branches.
- Modify: the module(s) that provide these strategies + `CommonContentStrategyModule` (or equivalent) — provide/export `GroupFanOutService`.
- Modify: `apps/automation/src/config/api/dto/meta-accounts.dto.ts` — `PatchMetaAccountGroupDto`.
- Modify: `apps/automation/src/config/api/meta-account-groups.controller.ts` — `PATCH :id`.

**Dashboard (apps/dashboard):**
- Modify: `apps/dashboard/src/api/meta-account-groups.ts` — `sourcePlatform` on type + `usePatchMetaAccountGroup`.
- Modify: `apps/dashboard/src/components/connections/MetaGroupsManager.tsx` — Source picker + SOURCE/MIRROR badges + not-publishable warning.

---

## Task 1: Migration 035 — `source_platform`

**Files:**
- Create: `database/migrations/035_group_source_platform.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 035_group_source_platform.sql — designate ONE member of a brand group as the
-- "source". Publishing to the source mirrors the same content to every other
-- member of the group. A group holds <=1 account per platform and <=1 Telegram
-- channel, so a single platform name unambiguously identifies the source member.
--
-- Default 'facebook' preserves the prior behaviour exactly: groups fanned out
-- from their Facebook account before this column existed.
ALTER TABLE meta_account_groups
  ADD COLUMN IF NOT EXISTS source_platform TEXT NOT NULL DEFAULT 'facebook';

ALTER TABLE meta_account_groups
  DROP CONSTRAINT IF EXISTS meta_account_groups_source_platform_chk;
ALTER TABLE meta_account_groups
  ADD CONSTRAINT meta_account_groups_source_platform_chk
  CHECK (source_platform IN ('facebook','instagram','threads','telegram'));

INSERT INTO schema_migrations (version) VALUES ('035_group_source_platform') ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: Verify it parses against the dev DB read-only**

Run: `psql "$DATABASE_URL" -c "EXPLAIN SELECT source_platform FROM meta_account_groups LIMIT 0;"` only AFTER the app applies it on next boot — do NOT boot the app here. Instead just confirm the SQL is syntactically valid by eye and that `schema_migrations` insert version matches the filename stem. No DB write in this task.

- [ ] **Step 3: Commit**

```bash
git add database/migrations/035_group_source_platform.sql
git commit -m "feat(groups): add source_platform to meta_account_groups (default facebook)"
```

---

## Task 2: `MetaAccountGroupsRepository` — source column + setter

**Files:**
- Modify: `apps/automation/src/config/meta-account-groups.repository.ts`

- [ ] **Step 1: Add `source_platform` to the row interface**

In `MetaAccountGroupRow`, after `name`, add:

```typescript
  source_platform: 'facebook' | 'instagram' | 'threads' | 'telegram';
```

`SELECT *` already returns the new column, so `list`/`findById`/`findByName`/`create` need no query changes.

- [ ] **Step 2: Add the setter**

After `create`, add:

```typescript
  /** Set which member platform is this group's fan-out source. */
  async setSourcePlatform(
    id: string,
    sourcePlatform: 'facebook' | 'instagram' | 'threads' | 'telegram',
  ): Promise<MetaAccountGroupRow | null> {
    const { rows } = await this.pool.query<MetaAccountGroupRow>(
      `UPDATE meta_account_groups SET source_platform = $2 WHERE id = $1 RETURNING *`,
      [id, sourcePlatform],
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 3: Build**

Run: `cd apps/automation && npm run build`
Expected: clean (no TS errors).

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/config/meta-account-groups.repository.ts
git commit -m "feat(groups): repo source_platform field + setSourcePlatform"
```

---

## Task 3: Member-lookup repo methods

**Files:**
- Modify: `apps/automation/src/config/meta-accounts.repository.ts`
- Modify: `apps/automation/src/tracking/repositories/tracked-channels.repository.ts`

- [ ] **Step 1: `MetaAccountsRepository.findActiveByGroup`**

Add near `findActiveGroupSiblings`:

```typescript
  /** All ACTIVE Meta accounts in a group (any platform). Empty for a missing
   *  or empty group. Drives group fan-out target resolution. */
  async findActiveByGroup(groupId: string): Promise<MetaAccountRow[]> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `SELECT * FROM meta_accounts WHERE group_id = $1 AND active ORDER BY platform`,
      [groupId],
    );
    return rows;
  }
```

- [ ] **Step 2: `TrackedChannelsRepository` group lookups**

Add two methods (mirror the existing `getByUsername` style; the row type is `TrackedChannel`):

```typescript
  /** The single Telegram channel linked to a group (migration 034: <=1 per
   *  group via the partial unique index). Null when the group has none. */
  async findByGroupId(groupId: string): Promise<TrackedChannel | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tracked_channels WHERE group_id = $1 LIMIT 1`, [groupId],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  /** The group a Telegram channel belongs to (by channel_key), or null. */
  async findGroupIdByChannelKey(channelKey: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ group_id: string | null }>(
      `SELECT group_id FROM tracked_channels WHERE channel_key = $1 LIMIT 1`, [channelKey],
    );
    return rows[0]?.group_id ?? null;
  }
```

NOTE for implementer: confirm the row→object mapper name in this file (it may be `map`, `toModel`, or inline). Use whatever the existing reads use; if reads map inline, inline the same mapping here. The `TrackedChannel` interface already exposes `channelKey`, `groupId`, `botId`, `tgChatId` — verify exact field names before writing.

- [ ] **Step 3: Build**

Run: `cd apps/automation && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/config/meta-accounts.repository.ts apps/automation/src/tracking/repositories/tracked-channels.repository.ts
git commit -m "feat(groups): member-lookup repo methods (findActiveByGroup, channel group lookups)"
```

---

## Task 4: `DestinationResolver` — group target resolution

**Files:**
- Modify: `apps/automation/src/common/content-strategy/destination-resolver.service.ts`

**Context:** The resolver already builds Meta `PublishDestination`s with resolved tokens (see `resolve`/`resolveMetaSiblings`). We add (a) `resolveGroupTargets(groupId, excludePlatform)` returning the OTHER members as mixed destinations, and (b) `resolveGroupForDest(dest)` returning the group + whether `dest` is its designated source. Keep `resolveMetaSiblings` for now (still referenced until Task 6/7 land); it can be deleted in Task 8 cleanup. Inject the new repos.

- [ ] **Step 1: Add constructor deps + imports**

Add to the constructor params:

```typescript
    private readonly groups: MetaAccountGroupsRepository,
    private readonly channels: TrackedChannelsRepository,
```

Add imports:

```typescript
import { MetaAccountGroupsRepository } from '../../config/meta-account-groups.repository';
import { TrackedChannelsRepository } from '../../tracking/repositories/tracked-channels.repository';
```

- [ ] **Step 2: `resolveGroupForDest`**

```typescript
  /**
   * Resolve the group a publish destination belongs to and whether THIS dest is
   * the group's designated fan-out source. Returns null when the dest is not in
   * any group (then no fan-out happens).
   */
  async resolveGroupForDest(
    dest: PublishDestination,
  ): Promise<{ groupId: string; sourcePlatform: string; isSource: boolean } | null> {
    let groupId: string | null = null;
    let memberPlatform: string = dest.platform;

    if (dest.platform === 'telegram') {
      groupId = await this.channels.findGroupIdByChannelKey(dest.targetId);
      memberPlatform = 'telegram';
    } else if (dest.metaAccountId) {
      const acct = await this.metaAccounts.findById(dest.metaAccountId);
      groupId = acct?.group_id ?? null;
      memberPlatform = acct?.platform ?? dest.platform;
    }
    if (!groupId) return null;

    const group = await this.groups.findById(groupId);
    if (!group) return null;
    return {
      groupId,
      sourcePlatform: group.source_platform,
      isSource: group.source_platform === memberPlatform,
    };
  }
```

- [ ] **Step 3: `resolveGroupTargets`**

```typescript
  /**
   * Every OTHER active member of a group as a ready-to-publish destination —
   * the Meta accounts (with resolved tokens) and the linked Telegram channel.
   * `excludePlatform` is the source's platform (its own member is skipped).
   * Meta members with no usable token are skipped. The Telegram member is
   * skipped when the group has none. The Telegram destination's bot is resolved
   * later by TelegramPublisher (via channel config), so no token is attached.
   */
  async resolveGroupTargets(
    groupId: string,
    excludePlatform: string,
  ): Promise<PublishDestination[]> {
    const out: PublishDestination[] = [];

    const metas = await this.metaAccounts.findActiveByGroup(groupId);
    for (const acct of metas) {
      if (acct.platform === excludePlatform) continue;
      const token = this.secrets.resolveToken(
        { enc: acct.token_enc, env: acct.token_env }, (k) => this.config.get<string>(k),
      );
      if (!token) continue;
      out.push({
        platform: acct.platform,
        targetId: acct.target_id,
        token,
        metaAccountId: acct.id,
        postedKey: `${META_POSTED_PREFIX[acct.platform]}:${acct.id}`,
        throttleKey: `meta:${acct.id}`,
      });
    }

    if (excludePlatform !== 'telegram') {
      const ch = await this.channels.findByGroupId(groupId);
      if (ch?.channelKey) {
        out.push({
          platform: 'telegram',
          targetId: ch.channelKey,
          metaAccountId: null,
          postedKey: 'TELEGRAM',
          throttleKey: ch.channelKey,
        });
      }
    }

    return out;
  }
```

NOTE for implementer: verify `TrackedChannel` exposes `channelKey` (camelCase) — adjust if the mapper uses `channel_key`.

- [ ] **Step 4: Build**

Run: `cd apps/automation && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/content-strategy/destination-resolver.service.ts
git commit -m "feat(groups): DestinationResolver.resolveGroupTargets + resolveGroupForDest"
```

---

## Task 5: `GroupFanOutService` (TDD)

**Files:**
- Create: `apps/automation/src/common/content-strategy/group-fanout.service.ts`
- Test: `apps/automation/src/common/content-strategy/group-fanout.service.test.ts`

**Context:** One shared orchestrator both strategies call after a successful primary publish. It no-ops unless the primary dest is the group's source, then publishes the same content to every other member. Meta → `dispatcher.publishCarousel` when `content.carousel`, else `dispatcher.publish`. Telegram → `telegram.publish` (cover = `imageUrls[0]` + caption); `TelegramPublisher` resolves the bot itself via channel config. Every target is isolated; per-target dedup via the caller's `markPosted(postedKey)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroupFanOutService, GroupContent } from './group-fanout.service';

const META_TARGET = (platform: string, id: string) => ({
  platform, targetId: `tgt-${id}`, token: `tok-${id}`,
  metaAccountId: id, postedKey: `X:${id}`, throttleKey: `meta:${id}`,
});
const TG_TARGET = { platform: 'telegram', targetId: 'recipes', metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: 'recipes' };

function make(overrides: any = {}) {
  const calls: any = { carousel: [], single: [], telegram: [], posted: [] };
  const resolver = {
    resolveGroupForDest: async (_d: any) => overrides.groupForDest ?? { groupId: 'g1', sourcePlatform: 'facebook', isSource: true },
    resolveGroupTargets: async (_g: string, _ex: string) => overrides.targets ?? [META_TARGET('instagram', 'ig'), META_TARGET('threads', 'th'), TG_TARGET],
  };
  const dispatcher = {
    publishCarousel: async (p: string, _pay: any, _urls: string[], _t: any) => { calls.carousel.push(p); return `c-${p}`; },
    publish:         async (p: string, _pay: any, _t: any) => { calls.single.push(p); return `s-${p}`; },
  };
  const telegram = {
    publish: async (_pay: any, t: any) => { calls.telegram.push(t.id); return 'tg-1'; },
  };
  const svc = new GroupFanOutService(resolver as any, dispatcher as any, telegram as any);
  const markPosted = async (key: string) => { calls.posted.push(key); };
  return { svc, calls, markPosted };
}

const SOURCE_FB = { platform: 'facebook', targetId: 'fb', token: 't', metaAccountId: 'fb', postedKey: 'FB:fb', throttleKey: 'meta:fb' } as any;
const CONTENT: GroupContent = { caption: 'A tasty caption that is long enough.', tags: ['food'], imageUrls: ['u1', 'u2', 'u3'], carousel: true };

test('fans a carousel out to Meta siblings + Telegram cover when dest is the source', async () => {
  const { svc, calls } = make();
  await svc.fanOut(SOURCE_FB, CONTENT, async () => {});
  assert.deepEqual(calls.carousel.sort(), ['instagram', 'threads']);
  assert.deepEqual(calls.telegram, ['recipes']);
});

test('marks each target posted with its own dedup key', async () => {
  const { svc, calls, markPosted } = make();
  await svc.fanOut(SOURCE_FB, CONTENT, markPosted);
  assert.deepEqual(calls.posted.sort(), ['TELEGRAM', 'X:ig', 'X:th']);
});

test('no-op when dest is NOT the group source', async () => {
  const { svc, calls } = make({ groupForDest: { groupId: 'g1', sourcePlatform: 'telegram', isSource: false } });
  await svc.fanOut(SOURCE_FB, CONTENT, async () => {});
  assert.deepEqual(calls.carousel, []);
  assert.deepEqual(calls.telegram, []);
});

test('no-op when dest is in no group', async () => {
  const { svc, calls } = make({ groupForDest: null });
  await svc.fanOut(SOURCE_FB, CONTENT, async () => {});
  assert.deepEqual(calls.carousel, []);
});

test('non-carousel content uses single publish for Meta', async () => {
  const { svc, calls } = make({ targets: [META_TARGET('instagram', 'ig')] });
  await svc.fanOut(SOURCE_FB, { ...CONTENT, carousel: false, imageUrls: ['only'] }, async () => {});
  assert.deepEqual(calls.single, ['instagram']);
  assert.deepEqual(calls.carousel, []);
});

test('a failing target never blocks the others and is not marked posted', async () => {
  const { svc, calls, markPosted } = make({ targets: [META_TARGET('instagram', 'ig'), TG_TARGET] });
  const telegram = { publish: async () => { throw new Error('no bot bound'); } };
  // re-wire telegram to throw:
  (svc as any).telegram = telegram;
  await svc.fanOut(SOURCE_FB, CONTENT, markPosted);
  assert.deepEqual(calls.carousel, ['instagram']);   // IG still published
  assert.deepEqual(calls.posted, ['X:ig']);          // TG failure NOT marked
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/automation && npx tsx --test src/common/content-strategy/group-fanout.service.test.ts`
Expected: FAIL (module not found / `GroupFanOutService` undefined).

- [ ] **Step 3: Implement the service**

```typescript
// group-fanout.service.ts — one shared fan-out path. After a strategy publishes
// to a group member, mirror the SAME content to every OTHER member — but only
// when the member just published to IS the group's designated source. Meta
// targets go through the dispatcher (full carousel or single); the Telegram
// target gets the cover image + caption (the bot API has no album). Each target
// is isolated: one failure never blocks the others or the primary publish.
import { Injectable, Logger } from '@nestjs/common';
import { DestinationResolver } from './destination-resolver.service';
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import { TelegramPublisher } from '../../publishers/telegram.publisher';
import { isPermanentMetaMediaError } from '../../publishers/meta-graph.util';
import type { PublishDestination } from './publish-destination';
import type { MetaPlatform } from '../../config/meta-accounts.repository';

export interface GroupContent {
  caption: string;
  tags: string[];
  /** >=1 image URL. Meta gets a carousel when `carousel` is true, else a single
   *  post from imageUrls[0]. Telegram always gets imageUrls[0] (cover). */
  imageUrls: string[];
  /** Whether Meta targets receive a multi-image carousel/album. */
  carousel: boolean;
}

@Injectable()
export class GroupFanOutService {
  private readonly logger = new Logger(GroupFanOutService.name);

  constructor(
    private readonly resolver:   DestinationResolver,
    private readonly dispatcher: PublisherDispatcher,
    private readonly telegram:   TelegramPublisher,
  ) {}

  /**
   * @param source     the destination the strategy just published to
   * @param content    the rendered content to mirror
   * @param markPosted records the per-target dedup key on success
   */
  async fanOut(
    source: PublishDestination,
    content: GroupContent,
    markPosted: (postedKey: string) => Promise<void>,
  ): Promise<void> {
    const group = await this.resolver.resolveGroupForDest(source);
    if (!group || !group.isSource) return; // not a source publish → nothing to mirror

    const targets = await this.resolver.resolveGroupTargets(group.groupId, source.platform);
    for (const t of targets) {
      try {
        let id: string;
        if (t.platform === 'telegram') {
          id = await this.telegram.publish(
            { text: content.caption, imageUrl: content.imageUrls[0], source: '', tags: content.tags },
            { id: t.targetId, token: '' },
          );
        } else if (content.carousel) {
          id = await this.dispatcher.publishCarousel(
            t.platform as MetaPlatform,
            { text: content.caption, tags: content.tags, source: '' },
            content.imageUrls,
            { id: t.targetId, token: t.token! },
          );
        } else {
          id = await this.dispatcher.publish(
            t.platform as MetaPlatform,
            { text: content.caption, imageUrl: content.imageUrls[0], source: '', tags: content.tags },
            { id: t.targetId, token: t.token! },
          );
        }
        await markPosted(t.postedKey);
        this.logger.debug(`Fan-out → ${t.platform} (${id})`);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.error(`Fan-out failed → ${t.platform}: ${msg}`);
        if (isPermanentMetaMediaError(msg)) {
          try { await markPosted(t.postedKey); } catch { /* best-effort */ }
        }
      }
    }
  }
}
```

NOTE for implementer: confirm `PostPayload` permits `{ text, tags, source }` without `imageUrl` for the carousel branch (it does — see existing `recipe-carousel.strategy.ts:99`). Confirm `TelegramPublisher.publish(payload, target)` signature matches (it does — `telegram.publisher.ts:57`).

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd apps/automation && npx tsx --test src/common/content-strategy/group-fanout.service.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/content-strategy/group-fanout.service.ts apps/automation/src/common/content-strategy/group-fanout.service.test.ts
git commit -m "feat(groups): GroupFanOutService — source-gated mirror to all members"
```

---

## Task 6: ai0-prompts — use `GroupFanOutService` (Meta + Telegram branches)

**Files:**
- Modify: `apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.ts`

**Context:** Replace the FB-only `fanOutToSiblings` with `groupFanOut.fanOut`. Call it in BOTH the Meta branch (after a successful Meta publish) and the Telegram branch (after the existing Telegram publish — additive, isolated). The Telegram publish path is the existing recipes-equivalent flow: do NOT alter its behavior, only append the fan-out call.

- [ ] **Step 1: Inject the service, drop the old helper**

Add constructor param `private readonly groupFanOut: GroupFanOutService,` and import `GroupFanOutService, GroupContent` from `../../common/content-strategy/group-fanout.service`. Delete the `fanOutToSiblings` method (lines ~203-233). `DestinationResolver` may still be injected if used elsewhere; if `fanOutToSiblings` was its only use, remove that dependency too.

- [ ] **Step 2: Meta branch — replace the FB gate**

Replace:

```typescript
        if (dest.platform === 'facebook' && dest.metaAccountId) {
          await this.fanOutToSiblings(dest.metaAccountId, row.id, message.caption, category);
        }
```

with (fires for ANY source, decided inside the service):

```typescript
        await this.groupFanOut.fanOut(
          dest,
          { caption: message.caption, tags: [category], imageUrls: [row.id], carousel: false },
          (key) => this.db.markPosted(row.id, key),
        );
```

- [ ] **Step 3: Telegram branch — add fan-out after the existing publish**

In the Telegram branch, immediately after `this.logger.debug(\`Published prompt to ${channelId}\`);` (inside the success path, ~line 197), append:

```typescript
        await this.groupFanOut.fanOut(
          { platform: 'telegram', targetId: channelId, metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: channelId },
          { caption: message.caption, tags: [category], imageUrls: [row.id], carousel: false },
          (key) => this.db.markPosted(row.id, key),
        );
```

(`row.id` is the PromptHero image URL Meta fetches directly — same image the Telegram post used.)

- [ ] **Step 4: Build + run the strategy's existing tests**

Run: `cd apps/automation && npm run build && npm test`
Expected: build clean; existing ai0-prompts tests still pass (fan-out is best-effort and not asserted by them; if a test constructs the strategy, it must now pass a `GroupFanOutService` stub — update those constructor calls to inject a stub with an async `fanOut`).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.ts
git commit -m "feat(groups): ai0-prompts fans out via GroupFanOutService (meta + telegram source)"
```

---

## Task 7: recipe-carousel — use service + Telegram source branch

**Files:**
- Modify: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts`

**Context:** Replace `fanOutToSiblings` with `groupFanOut.fanOut`. Add a Telegram branch so Telegram can be a recipe group's source: render + host slides (as the Meta path does), publish the COVER slide + caption to Telegram, then fan the full carousel out to Meta, then delete the hosted slides. Keep the hosted slides alive until fan-out completes (fan-out runs inside the `try`, before the `finally` delete — preserve that ordering).

- [ ] **Step 1: Inject service + add `telegram` to supportedPlatforms**

Add constructor param `private readonly groupFanOut: GroupFanOutService,`, import it, and change:

```typescript
  readonly supportedPlatforms: DestinationPlatform[] = ['instagram', 'facebook', 'threads', 'tiktok'];
```

to include `'telegram'`:

```typescript
  readonly supportedPlatforms: DestinationPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'];
```

Also inject `TelegramPublisher`? NO — the Telegram publish for the recipe COVER goes through the existing `dispatcher`? The dispatcher is Meta-only. For the Telegram cover, inject `TelegramPublisher` directly (`private readonly telegramPub: TelegramPublisher`) and import from `../../publishers/telegram.publisher`.

- [ ] **Step 2: Replace the Telegram early-return with a real branch**

Replace:

```typescript
    if (!dest || dest.platform === 'telegram') {
      this.logger.warn('recipe-carousel is Meta/TikTok-only — no Telegram destination');
      return;
    }
```

with:

```typescript
    if (!dest) {
      this.logger.warn('recipe-carousel: no destination');
      return;
    }

    if (dest.platform === 'telegram') {
      await this.executeTelegramSource(dest);
      return;
    }
```

- [ ] **Step 3: Replace the Meta FB-gate fan-out**

Replace:

```typescript
      if (dest.platform === 'facebook' && dest.metaAccountId) {
        await this.fanOutToSiblings(dest.metaAccountId, row, caption, hosted.map(h => h.url));
      }
```

with:

```typescript
      await this.groupFanOut.fanOut(
        dest,
        { caption, tags: row.category ? [row.category] : [], imageUrls: hosted.map(h => h.url), carousel: true },
        (key) => this.repo.markPosted(row.id, key),
      );
```

Delete the old `fanOutToSiblings` method (lines ~126-158).

- [ ] **Step 4: Add the Telegram-source branch**

Add this private method (renders + hosts like the Meta path, publishes the cover to Telegram, fans the carousel to Meta, deletes slides):

```typescript
  /** Telegram is this group's source: publish the recipe cover + caption to the
   *  Telegram channel, then fan the rendered carousel out to the group's Meta
   *  members. Slides stay hosted until fan-out completes. */
  private async executeTelegramSource(dest: PublishDestination): Promise<void> {
    const row = await this.repo.getNextForCarousel(dest.postedKey); // postedKey === 'TELEGRAM'
    if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }

    const recipe  = toCarouselRecipe(row);
    const caption = buildCarouselCaption(row);
    const imageBuffer = await this.images.download(row.image_url);
    if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);

    const slides = await this.renderer.render(recipe, imageBuffer);
    const hosted = await this.hosting.upload(slides, `carousel/telegram/${dest.targetId}/${row.id}`);

    try {
      const mid = await this.telegramPub.publish(
        { text: caption, imageUrl: hosted[0].url, source: '', tags: row.category ? [row.category] : [] },
        { id: dest.targetId, token: '' },
      );
      await this.repo.markPosted(row.id, dest.postedKey);
      this.logger.debug(`Published carousel cover ${row.id} → telegram (${mid})`);

      await this.groupFanOut.fanOut(
        dest,
        { caption, tags: row.category ? [row.category] : [], imageUrls: hosted.map(h => h.url), carousel: true },
        (key) => this.repo.markPosted(row.id, key),
      );
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.logger.error(`Carousel telegram publish failed (${row.id}): ${msg}`);
      throw new Error(`Carousel publish (telegram): ${msg}`);
    } finally {
      await this.hosting.delete(hosted.map(h => h.path));
    }
  }
```

NOTE: `getNextForCarousel(dest.postedKey)` with `dest.postedKey === 'TELEGRAM'` selects recipes not yet posted to Telegram by this strategy. Confirm `getNextForCarousel` keys off the passed dedup key (it does — used identically in the Meta path).

- [ ] **Step 5: Build + tests**

Run: `cd apps/automation && npm run build && npm test`
Expected: build clean; existing recipe-carousel tests pass (update any direct `new RecipeCarouselStrategy(...)` in tests to inject `GroupFanOutService` + `TelegramPublisher` stubs).

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts
git commit -m "feat(groups): recipe-carousel fans out via service + telegram-source branch"
```

---

## Task 8: Module wiring + remove dead `resolveMetaSiblings`

**Files:**
- Modify: the NestJS module(s) that declare `RecipeCarouselStrategy` / `Ai0PromptsStrategy` and `DestinationResolver`.
- Modify: `apps/automation/src/common/content-strategy/destination-resolver.service.ts`

- [ ] **Step 1: Provide `GroupFanOutService`**

Find the module(s) providing `DestinationResolver` + the two strategies (grep: `rg "DestinationResolver" apps/automation/src/**/*.module.ts`). Add `GroupFanOutService` to that module's `providers` (and `exports` if strategies live in a different module than the service). Ensure `MetaAccountGroupsRepository`, `TrackedChannelsRepository`, `PublisherDispatcher`, and `TelegramPublisher` are all importable/provided in that module's scope (they are already providers elsewhere — import the owning modules if needed).

- [ ] **Step 2: Delete `resolveMetaSiblings`**

Now that no strategy references it, remove `resolveMetaSiblings` from `destination-resolver.service.ts` (replaced by `resolveGroupTargets`). Grep first: `rg "resolveMetaSiblings" apps/automation/src` — expect zero hits after Tasks 6-7.

- [ ] **Step 3: Full build + full test suite**

Run: `cd apps/automation && npm run build && npm test`
Expected: build clean; whole suite green.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src
git commit -m "feat(groups): wire GroupFanOutService into module graph; drop resolveMetaSiblings"
```

---

## Task 9: API — set group source

**Files:**
- Modify: `apps/automation/src/config/api/dto/meta-accounts.dto.ts`
- Modify: `apps/automation/src/config/api/meta-account-groups.controller.ts`

- [ ] **Step 1: DTO**

Add to the meta-accounts DTO file:

```typescript
import { IsIn } from 'class-validator';

export class PatchMetaAccountGroupDto {
  @IsIn(['facebook', 'instagram', 'threads', 'telegram'])
  sourcePlatform!: 'facebook' | 'instagram' | 'threads' | 'telegram';
}
```

- [ ] **Step 2: Controller PATCH**

Add to `MetaAccountGroupsController`:

```typescript
  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchMetaAccountGroupDto) {
    const updated = await this.groups.setSourcePlatform(id, body.sourcePlatform);
    if (!updated) throw new NotFoundException(`Group ${id} not found`);
    return updated;
  }
```

Add `Patch` to the `@nestjs/common` import and import `PatchMetaAccountGroupDto`. The existing `GET /` already returns `source_platform` now (via `SELECT *`).

- [ ] **Step 3: Build**

Run: `cd apps/automation && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/config/api
git commit -m "feat(groups): PATCH /api/meta-account-groups/:id sets source_platform"
```

---

## Task 10: Dashboard — source picker on the Groups page

**Files:**
- Modify: `apps/dashboard/src/api/meta-account-groups.ts`
- Modify: `apps/dashboard/src/components/connections/MetaGroupsManager.tsx`

- [ ] **Step 1: API client**

Add `sourcePlatform: 'facebook'|'instagram'|'threads'|'telegram'` to the group type (map from `source_platform` if the client normalizes; otherwise read `source_platform` directly — match the file's existing field-casing convention). Add a mutation:

```typescript
export function usePatchMetaAccountGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sourcePlatform }: { id: string; sourcePlatform: string }) =>
      api.patch(`/api/meta-account-groups/${id}`, { sourcePlatform }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meta-account-groups'] }),
  });
}
```

(Match the existing hook/`api` import style in this file — it already has create/delete hooks to mirror.)

- [ ] **Step 2: Source picker UI**

In `MetaGroupsManager.tsx`, for each group render a **Source** control: a `SegmentedTabs` (or radio row) over the group's actual members (FB/IG/Threads present in the group + the Telegram channel if linked). Selecting one calls `usePatchMetaAccountGroup().mutate({ id, sourcePlatform })`. Badge the source member `SOURCE` and the rest `MIRROR` (reuse the `.status-dot`/eyebrow primitives already on this page). If the selected source/target is Telegram and the linked channel has no bot (`botId == null` and no default bot known to the client), show a `.callout-warning`: "This Telegram channel has no bot — it can't send or receive group posts." Use the existing design-system classes/primitives already in this file; do not hand-roll new inline styles.

- [ ] **Step 3: Build**

Run: `pnpm --filter dashboard build`
Expected: routeTree + tsc clean.

- [ ] **Step 4: Verify in preview**

Start preview if needed; open `/app/connections/groups`; confirm each group shows the Source picker, switching it persists (network PATCH 200), and the SOURCE/MIRROR badges update. Screenshot for the user.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/api/meta-account-groups.ts apps/dashboard/src/components/connections/MetaGroupsManager.tsx
git commit -m "feat(groups): source picker on Groups page (SOURCE/MIRROR badges + no-bot warning)"
```

---

## Verification

- **Backend:** `cd apps/automation && npm test` (green, incl. new `group-fanout.service.test.ts`) + `npm run build`.
- **Dashboard:** `pnpm --filter dashboard build` + preview smoke of `/app/connections/groups`.
- **Migration:** applied automatically on next app boot (operator-controlled — do NOT boot here). Default `'facebook'` ⇒ existing groups behave identically until the operator changes the source.
- **No live calls:** all new tests use stubs; no network/AI in test or build.

## Risks
- **Double-post to Telegram for recipes:** the existing `recipes` strategy already posts recipes to a Telegram channel. If the operator also binds a *telegram-source* `recipe-carousel` to the SAME channel, that channel gets two posts (the recipe + the carousel cover). Mitigate by binding the telegram-source recipe-carousel to a DIFFERENT channel, or accept the cover as the group's canonical Telegram post. Document in the UI.
- **Telegram fidelity:** Telegram members only ever get the cover image + caption (bot API has no album) — Meta still gets the full carousel. Intentional and noted in the UI.
- **Telegram target needs a bot:** a tracking-only channel (no `bot_id`, no default bot) is skipped on fan-out (logged) and flagged in the UI.
- **`source_platform` points at a missing member:** if the operator sets source = a platform the group doesn't actually have an active account for, no strategy will publish to that source, so nothing fans out (safe no-op). The UI only offers members that exist.
```