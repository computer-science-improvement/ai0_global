# Native Meta Publishing (Instagram pilot) — Design

**Status:** approved (brainstorming) — 2026-06-12
**Branch:** `feat/native-meta-publishing` (off `feat/crosspost-all-strategies`)

## Goal

Let a content strategy publish **natively** to a Meta platform (Instagram first) as a
**first-class destination with its own cron schedule**, drawing from the **same content
pool** it uses for Telegram. This is *not* the mirror-after-Telegram cross-post model
(already shipped) — a Meta binding fires on its own schedule and publishes directly,
independent of any Telegram post.

**Pilot scope:** `recipes`, `ai0-prompts`, `curated-prompts` → **Instagram**
(account `ai0.global.info`, target id `17841480657952058`).

## Why this approach

A `strategy_binding` today resolves to a single **Telegram** destination (`channel_id` +
cron). We extend the binding so its destination can instead be a **Meta account**
(`platform` + `meta_account_id`), reviving the deferred Phase-2 model. The scheduler
resolves each binding to a `PublishDestination`, and the runner passes it to the
strategy's `execute()`. The three pilot strategies branch on the destination: the
Telegram path is unchanged; the Meta path builds the same content, publishes via the
existing `PublisherDispatcher` → `InstagramPublisher`, and dedups independently.

Rejected alternatives:
- **Separate "republish-to-Meta" strategies** — duplicates caption/dedup logic, less reuse.
- **Full platform-agnostic refactor of all 15 strategies** — weeks of work, risks the live
  Telegram path. Out of scope; the other 12 strategies follow later on this same seam.

## Data model — migration `020_strategy_binding_destination.sql`

```sql
ALTER TABLE strategy_bindings
  ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'
    CHECK (platform IN ('telegram','instagram','facebook','threads')),
  ADD COLUMN meta_account_id UUID REFERENCES meta_accounts(id);

-- A meta binding does not need a Telegram channel.
ALTER TABLE strategy_bindings ALTER COLUMN channel_id DROP NOT NULL;

-- Exactly one destination kind per binding.
ALTER TABLE strategy_bindings
  ADD CONSTRAINT strategy_binding_destination_chk CHECK (
       (platform =  'telegram' AND channel_id     IS NOT NULL AND meta_account_id IS NULL)
    OR (platform <> 'telegram' AND meta_account_id IS NOT NULL)
  );
```

All existing rows default to `platform='telegram'` and keep their `channel_id` — no behavior
change for current bindings.

## Independent dedup — the crux

Strategies mark content posted in a `posted` JSONB column keyed `'TELEGRAM'`
(`NOT (posted ? 'TELEGRAM')`). To let Instagram post its **own** sequence (and let one
recipe appear on both TG and IG independently), `getNext()` / `markPosted()` take a
**destination key**:

- Telegram → `'TELEGRAM'` (unchanged default)
- Instagram → `'IG:<meta_account_id>'` (per-account, so two IG accounts dedup separately)

Facebook → `'FB:<id>'`, Threads → `'TH:<id>'` (same mechanism, not in the pilot).

## `PublishDestination` + `DestinationResolver`

```ts
export type DestinationPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads';

export interface PublishDestination {
  platform:      DestinationPlatform;
  targetId:      string;          // TG channel_key | meta target_id
  token?:        string;          // resolved access token (meta only)
  metaAccountId: string | null;
  postedKey:     string;          // 'TELEGRAM' | 'IG:<uuid>' | ...
  throttleKey:   string;          // channelId | 'meta:<uuid>'
}
```

`DestinationResolver.resolve(binding)` builds it: Telegram is a pure mapping; Meta loads the
`meta_accounts` row, resolves the token via `ConfigService.get(token_env)` (the same pattern
`CrossPostService` uses), and throws if the account is missing/inactive or the token env is
unset. The scheduler resolves the destination per tick and passes it to
`runner.run(strategy, channelId, params, id, dest)`.

## Plumbing

- **`ContentStrategy.execute`** gains an optional 3rd arg: `execute?(channelId, params, dest?)`.
  Strategies that ignore it keep publishing to Telegram (back-compatible).
- **`ContentStrategyRunner.run`** gains a trailing `dest?: PublishDestination`; throttle is
  keyed by `dest?.throttleKey ?? channelId`; passes `dest` to `execute`. The generic
  (non-`execute`) pipeline stays Telegram-only and refuses a meta destination with a logged skip.
- **`SchedulerService`** resolves the destination after re-resolving the fresh binding and
  passes it through. A resolve failure logs and bails cleanly (no crash, no publish).

## Pilot strategies — destination-aware `execute`

Each of `recipes`, `ai0-prompts`, `curated-prompts`:
1. Resolves the destination (default Telegram when `dest` is undefined).
2. `getNext(dest.postedKey)` — same pool, per-destination dedup.
3. **Telegram branch:** existing code unchanged (Telegraph, `publishPrompt`, notifier,
   publications, `crossPost.afterPublish`, `markPosted(id)` → defaults `'TELEGRAM'`).
4. **Meta branch:** build the caption from the same content; publish via
   `dispatcher.publish(dest.platform, { text, imageUrl, source:'', tags }, { id: dest.targetId, token: dest.token })`;
   `markPosted(id, dest.postedKey)`. Skip Telegraph, notifier, publications, and
   `crossPost.afterPublish` (no double-post). The platform publisher applies the caption caps.
   - `recipes` Meta caption = title + ingredients + nutrition (no Telegraph link); image = `image_url`.
   - `ai0-prompts` Meta image = `row.id` (the PromptHero image URL); caption from the scraped meta.
   - `curated-prompts` Meta handles **image** rows only (`media_url`); video rows are skipped
     for IG (set `params.mediaType = 'image'` on an IG binding).

Instagram requires a public image URL — all three rows provide one.

## API + DTO

`CreateStrategyDto` gains optional `platform` + `meta_account_id`; `channel_id` becomes
optional. Controller invariant: `telegram` ⇒ `channel_id` required + must exist + `meta_account_id`
absent; meta ⇒ `meta_account_id` required + must exist (verified `meta_accounts` row) +
`channel_id` absent. `PatchStrategyDto` mirrors this for edits. Resolution
(`StrategyBindingRow`, `resolveStrategyBindings`, repo SELECT/INSERT/UPDATE) carries the two
new columns.

## Dashboard

`AddStrategyModal` gets a **Destination** toggle: *Telegram channel* (current picker) or
*Meta account* (dropdown of verified accounts from `GET /api/meta-accounts`). The submit
payload sends either `channel_id` or `platform`+`meta_account_id`. `EditStrategyModal` shows
the destination read-only (changing a binding's destination kind is a delete+recreate, not a
patch). Strategy types include the platform icon already wired in the table.

## Out of scope (later, on this seam)

- The other 12 strategies (news/quotes/facts/game/pdr/assets/motivation, the 4 generic).
- Facebook/Threads native bindings (mechanism already supports them; IG is the hard case
  because of the mandatory image).
- `pdr-quiz` polls (no Meta equivalent — separate design).
- Runway/analytics for Meta destinations.

## Testing

`node:test` via `npx tsx --test` (automation). Dashboard verified with `tsc` + `vite build`.
- `DestinationResolver`: telegram mapping; meta resolve (token from env); missing/inactive
  account and unset token throw.
- Repos: `getNext`/`markPosted` honor a passed dest key and default to `'TELEGRAM'`.
- Controller: invariant accepts/ rejects the four cases.
- A pilot strategy meta-branch unit with a mocked dispatcher: publishes to IG, marks the
  per-account key, skips notifier/publications/crosspost.

## Cost / safety guard (standing)

Build, `tsc`, and unit tests only. **No** automation restart, **no** live publishing, **no**
Claude API calls during implementation — the user performs restarts and real smoke tests.
