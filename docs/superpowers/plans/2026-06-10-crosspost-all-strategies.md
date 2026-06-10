# Cross-posting for All Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every content strategy calls `CrossPostService.afterPublish(...)` after its successful Telegram publish, so any channel can cross-post to attached Instagram/Facebook/Threads targets; recipes gains a mirror payload (enables Instagram); `CrossPostService` quietly skips imageless Instagram targets.

**Architecture:** Additive one-call wiring per strategy after the TG publish success path — identical to the existing recipes/ai0-news pattern. `PublishersModule` is `@Global()` and already exports `CrossPostService`, so each strategy only adds a constructor param + import. No DB/API/UI changes.

**Tech Stack:** NestJS 10; tests via `node:test` + `node:assert/strict` run with `npx tsx --test <file>`; verify with `npx tsc --noEmit` + `npm run build` in `apps/automation`.

**Global rules for every wiring task:**
- The `afterPublish` call goes INSIDE the existing success `try` block, after `publications.insert(...)` (or the strategy's equivalent last success step), before the final success `logger` line or right after it — never outside the try.
- `afterPublish` never throws (failures are isolated internally) — no extra try/catch around it.
- Import: `import { CrossPostService } from '../../publishers/cross-post.service';`
- Constructor: append `private readonly crossPost: CrossPostService,` as the LAST parameter.
- Do NOT touch any `*-strategy.module.ts` — `PublishersModule` is `@Global()`.

---

## Task 1: CrossPostService — skip imageless Instagram targets (TDD)

**Files:**
- Modify: `apps/automation/src/publishers/cross-post.service.ts`
- Create: `apps/automation/src/publishers/cross-post.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/publishers/cross-post.service.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrossPostService } from './cross-post.service';

function target(platform: string, mode: 'mirror' | 'teaser' = 'mirror') {
  return {
    platform, mode,
    meta_account_id:   `acct-${platform}`,
    account_active:    true,
    account_token_env: 'TOK_ENV',
    account_target_id: `target-${platform}`,
  };
}

function build(targets: any[]) {
  const published: Array<{ platform: string; imageUrl?: string }> = [];
  const svc = new CrossPostService(
    { listEnabledResolved: async () => targets } as any,                       // targets repo
    { getChannelMeta: () => ({ id: 'ch1', username: 'chan' }) } as any,        // channel config
    { publish: async (p: string, payload: any) => { published.push({ platform: p, imageUrl: payload.imageUrl }); return 'mid'; } } as any, // dispatcher
    { tryLock: () => true, recordPublish: () => {}, releaseLock: () => {} } as any, // throttle
    { metaCooldownMin: () => 0 } as any,                                       // settings
    { get: () => 'token' } as any,                                             // config
  );
  return { svc, published };
}

test('imageless mirror: instagram skipped, threads/facebook still publish', async () => {
  const { svc, published } = build([target('instagram'), target('threads'), target('facebook')]);
  await svc.afterPublish({ channelKey: '@c', messageId: 1, mirror: { text: 'hello', tags: [] } });
  assert.deepEqual(published.map(p => p.platform).sort(), ['facebook', 'threads']);
});

test('mirror WITH image: instagram publishes', async () => {
  const { svc, published } = build([target('instagram')]);
  await svc.afterPublish({ channelKey: '@c', messageId: 1, mirror: { text: 'hello', tags: [], imageUrl: 'https://x/i.jpg' } });
  assert.deepEqual(published.map(p => p.platform), ['instagram']);
  assert.equal(published[0].imageUrl, 'https://x/i.jpg');
});

test('imageless teaser: instagram skipped, facebook publishes', async () => {
  const { svc, published } = build([target('instagram', 'teaser'), target('facebook', 'teaser')]);
  await svc.afterPublish({ channelKey: '@c', messageId: 1, teaser: { lines: ['a', 'b'] } });
  assert.deepEqual(published.map(p => p.platform), ['facebook']);
});
```

NOTE: the constructor fakes are positional and must match the real constructor order `(targets, channels, dispatcher, throttle, settings, config)` — verify against `cross-post.service.ts:30–37` and adjust positions if they differ.

- [ ] **Step 2: Run the test, verify the FIRST and THIRD tests FAIL**

Run: `cd apps/automation && npx tsx --test src/publishers/cross-post.service.test.ts`
Expected: tests 1 and 3 fail (instagram currently publishes / IG publisher path is attempted); test 2 passes.

- [ ] **Step 3: Add the skip rule**

In `apps/automation/src/publishers/cross-post.service.ts`, inside the per-target loop of `afterPublish`, immediately AFTER the mode-content selection block (the `if (t.mode === 'teaser') {...} else {...}` that sets `text`/`imageUrl`) and BEFORE the cooldown block, insert:

```typescript
      // Instagram requires a public image; skip imageless content quietly
      // instead of letting the IG publisher throw (text-only strategies with
      // an IG target attached stay clean in the logs).
      if (t.platform === 'instagram' && !imageUrl) {
        this.logger.debug('crosspost skip instagram: no image');
        continue;
      }
```

- [ ] **Step 4: Run the test, verify all 3 PASS**

Run: `cd apps/automation && npx tsx --test src/publishers/cross-post.service.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Type-check + commit**

```bash
cd apps/automation && npx tsc --noEmit
git add apps/automation/src/publishers/cross-post.service.ts apps/automation/src/publishers/cross-post.service.test.ts
git commit -m "feat(crosspost): skip imageless Instagram targets + service tests"
```

---

## Task 2: recipes — add mirror payload (enables Instagram)

**Files:**
- Modify: `apps/automation/src/strategies/recipes/recipes.strategy.ts` (the afterPublish call, ~line 117)
- Modify: `apps/automation/src/strategies/recipes/recipes.strategy.test.ts`

- [ ] **Step 1: Extend the test** — in `recipes.strategy.test.ts`, the `build()` helper has `const crossPost = { afterPublish: async () => {} };`. Change it to capture calls:

```typescript
  const crossPost = { afterPublish: async (i: any) => { calls.crossPost = i; } };
```
and add `crossPost: null as any,` to the `calls` object literal. Then in the existing test `'untranslated row: translates once, caches, publishes, marks posted'`, append assertions at the end:

```typescript
  assert.ok(calls.crossPost.teaser, 'teaser payload present');
  assert.ok(calls.crossPost.mirror, 'mirror payload present (enables Instagram)');
  assert.equal(calls.crossPost.mirror.imageUrl, 'https://x/i.jpg');
  assert.ok(calls.crossPost.mirror.text.length > 0);
```
(Adjust the property name for the calls container to match the file's existing style if it differs.)

- [ ] **Step 2: Run to verify the new assertions FAIL**

Run: `cd apps/automation && npx tsx --test src/strategies/recipes/recipes.strategy.test.ts`
Expected: FAIL on `mirror payload present`.

- [ ] **Step 3: Add the mirror payload** — in `recipes.strategy.ts`, replace the existing call:

```typescript
  await this.crossPost.afterPublish({
    channelKey: channelId,
    messageId,
    teaser: { lines: [uk.titleUk, this.nutritionLine(row)], imageUrl: row.image_url },
  });
```
with:
```typescript
  // mirror (full caption + dish photo) enables Instagram targets (IG is
  // mirror-only and needs an image); teaser remains for FB/Threads.
  await this.crossPost.afterPublish({
    channelKey: channelId,
    messageId,
    mirror: { text: caption, tags: row.category ? [row.category] : [], imageUrl: row.image_url },
    teaser: { lines: [uk.titleUk, this.nutritionLine(row)], imageUrl: row.image_url },
  });
```
(`caption` is the TG caption already in scope in that try block.)

- [ ] **Step 4: Run tests → PASS; commit**

```bash
cd apps/automation && npx tsx --test src/strategies/recipes/recipes.strategy.test.ts && npx tsc --noEmit
git add apps/automation/src/strategies/recipes
git commit -m "feat(crosspost): recipes supplies mirror payload — Instagram enabled"
```

---

## Task 3: ai0-prompts + curated-prompts wiring

**Files:**
- Modify: `apps/automation/src/strategies/ai0-prompts/ai0-prompts.strategy.ts`
- Modify: `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts`
- Modify: `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.test.ts`

- [ ] **Step 1: ai0-prompts** — add the import and append `private readonly crossPost: CrossPostService,` to the constructor (after `publications`). Then in the success try block, after `publications.insert({...})` and before `this.logger.debug('Published prompt to ...')`, insert:

```typescript
      // row.id IS the PromptHero image URL (the TG image above is downloaded
      // from it) — Meta fetches it directly; failures are isolated.
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text: message.caption, tags: [category], imageUrl: row.id },
      });
```
VERIFY at the call site that the image download a few lines above is `axios.get(row.id, ...)` (it is, ~line 111) — if the download URL is a different variable, use THAT variable as `imageUrl` and report it.

- [ ] **Step 2: curated-prompts** — add the import and append `private readonly crossPost: CrossPostService,` to the constructor (after `publications`). In the success try block after `publications.insert({...})`, insert:

```typescript
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: {
          text: caption,
          tags: row.category ? [row.category] : [],
          // video rows cross-post as text; imageless Instagram is skipped.
          imageUrl: row.media_type === 'image' ? row.media_url : undefined,
        },
      });
```

- [ ] **Step 3: Fix the curated-prompts test** — in `curated-prompts.strategy.test.ts`, the construction is `new CuratedPromptsStrategy(registry as any, publisher as any, repo as any, notifier as any, publications as any)`. Add a fake and pass it as the new last arg:

```typescript
const crossPost = { afterPublish: async () => {} };
const s = new CuratedPromptsStrategy(registry as any, publisher as any, repo as any, notifier as any, publications as any, crossPost as any);
```
(Apply to every construction site in the file.)

- [ ] **Step 4: Run tests + type-check; commit**

```bash
cd apps/automation && npx tsx --test src/strategies/curated-prompts/curated-prompts.strategy.test.ts && npx tsc --noEmit
git add apps/automation/src/strategies/ai0-prompts apps/automation/src/strategies/curated-prompts
git commit -m "feat(crosspost): wire ai0-prompts + curated-prompts (mirror)"
```

---

## Task 4: ua-news, quotes, facts wiring

**Files:**
- Modify: `apps/automation/src/strategies/ua-news/ua-news.strategy.ts`
- Modify: `apps/automation/src/strategies/quotes/quotes.strategy.ts`
- Modify: `apps/automation/src/strategies/facts/facts.strategy.ts`

Each file: add the import + append `private readonly crossPost: CrossPostService,` as the last constructor param.

- [ ] **Step 1: ua-news** — in the success try block, right after `this.logger.debug(\`Published to ${channelId}: ${item.title}\`);` and BEFORE the topic-routing block, insert:

```typescript
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text: payload.text, tags: item.tags ?? [], imageUrl: item.image ?? undefined },
      });
```

- [ ] **Step 2: quotes** — after `publications.insert({...})`, insert:

```typescript
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: quote.category ? [quote.category] : [] },
      });
```
(No image — quotes are text-only; Instagram targets are skipped by Task 1's rule.)

- [ ] **Step 3: facts** — after `publications.insert({...})`, insert:

```typescript
      // tags stay empty: the post text already ends with '#факти' — passing
      // ['факти'] would duplicate the hashtag in the Meta caption.
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: [], imageUrl: fact.image_url ?? undefined },
      });
```

- [ ] **Step 4: Type-check + commit**

```bash
cd apps/automation && npx tsc --noEmit
git add apps/automation/src/strategies/ua-news apps/automation/src/strategies/quotes apps/automation/src/strategies/facts
git commit -m "feat(crosspost): wire ua-news, quotes, facts (mirror)"
```

---

## Task 5: game-channel, pdr-quiz, assets, motivation-biography wiring

**Files:**
- Modify: `apps/automation/src/strategies/game-channel/game-channel.strategy.ts`
- Modify: `apps/automation/src/strategies/pdr-quiz/pdr-quiz.strategy.ts`
- Modify: `apps/automation/src/strategies/assets/assets.strategy.ts`
- Modify: `apps/automation/src/strategies/motivation-biography/motivation-biography.strategy.ts`

Each file: add the import + append `private readonly crossPost: CrossPostService,` as the last constructor param.

- [ ] **Step 1: game-channel** — after `publications.insert({...})` in the success try block, insert:

```typescript
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: [item.type], imageUrl: item.imageUrl ?? undefined },
      });
```

- [ ] **Step 2: pdr-quiz** — after `publications.insert({...})` (the block using `pollMessageId`), insert:

```typescript
    // Mirror only the question (+ optional image): the TG poll is interactive,
    // option buttons don't translate to Meta — answers are deliberately omitted.
    await this.crossPost.afterPublish({
      channelKey: channelId,
      messageId: pollMessageId,
      mirror: { text: q.text, tags: [], imageUrl: q.image_url ?? undefined },
    });
```
VERIFY the question-text variable: the row interface has `text` (`q.text`); if the local variable differs at that point, use the actual published question text variable and report it.

- [ ] **Step 3: assets** — after `publications.insert({...})`, insert:

```typescript
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: [dataSource], imageUrl: posterUrl ?? undefined },
      });
```

- [ ] **Step 4: motivation-biography** — after `publications.insert({...})`, insert:

```typescript
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: [], imageUrl: wiki.imageUrl ?? undefined },
      });
```

- [ ] **Step 5: Type-check + commit**

```bash
cd apps/automation && npx tsc --noEmit
git add apps/automation/src/strategies/game-channel apps/automation/src/strategies/pdr-quiz apps/automation/src/strategies/assets apps/automation/src/strategies/motivation-biography
git commit -m "feat(crosspost): wire game-channel, pdr-quiz, assets, motivation-biography (mirror)"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite + build**

Run: `cd apps/automation && npx tsx --test 'src/**/*.test.ts' && npx tsc --noEmit && npm run build`
Expected: ALL tests pass (149+: prior 146 + 3 new cross-post tests), tsc clean, nest build OK.

- [ ] **Step 2: Sanity grep — every strategy now calls afterPublish**

Run: `grep -rln "crossPost.afterPublish" apps/automation/src/strategies | sort`
Expected: 11 strategy files (recipes, ai0-news, ai0-prompts, curated-prompts, ua-news, quotes, facts, game-channel, pdr-quiz, assets, motivation-biography). Generic-path strategies (daily-photo, on-this-day, movies, space) are covered by the runner — confirm with `grep -n "afterPublish" apps/automation/src/common/content-strategy/content-strategy.runner.ts`.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "chore(crosspost): verification fixups" || echo "nothing to commit"
```

---

## Notes for the implementer

- **Cost guard (CRITICAL):** do NOT restart automation, trigger publishing, or call the Claude API. Build + tsx tests + tsc only. Real cross-posting is the user's manual smoke step after deploy.
- A strategy whose channel has no `meta_crosspost_targets` rows: `afterPublish` returns immediately — zero behavior change.
- The live Telegram publish path is untouched: every insertion is after the TG publish already succeeded, and `afterPublish` never throws.
- After deploy, the operator attaches targets in the dashboard (channel page → Meta cross-posting): recipes channel → IG/FB/Threads, prompt channels → IG/FB/Threads, @ai0_global → Threads.
