# TikTok Destination Routing + Strategy Capability Map (sub-project 5c) — Design

**Status:** approved (brainstorming) — 2026-06-15
**Branch:** `feat/tiktok-strategy` (off `feat/tiktok-publisher`, which carries 5a + 5b)
**Parent feature:** recipe image-carousel for IG / FB / Threads / **TikTok**. This is **5c**
of the TikTok integration. 5a (accounts + tokens) and 5b (content client + carousel
publisher) are done. 5c wires TikTok into the destination/binding model and routes the
recipe-carousel strategy to TikTok at 9:16. It also adds a backend **strategy → supported
platforms** capability map (powers a stronger binding-API invariant + the 5d dashboard's
filtered Type dropdown).

## Goal

Make `platform='tiktok'` a first-class binding destination: a binding can target a TikTok
account, the scheduler resolves it, and the recipe-carousel strategy renders 9:16 slides,
hosts them, and publishes via `TikTokCarouselPublisher` (5b) with per-destination dedup.
Plus: declare which strategies support which platforms, expose it, and enforce it in the
binding API.

## Non-goals

The dashboard binding form (Destination→Type reorder + platform-filtered Type dropdown +
TikTok account selector) and the web OAuth round-trip — **5d**. Real publishing remains
gated by TikTok app review + PULL_FROM_URL domain verification (external).

## Approach

Mirror the existing Meta destination plumbing for `tiktok` (rejected alternatives: a
generic "non-telegram account" abstraction — YAGNI; a separate tiktok-binding table —
diverges from the unified binding model). TikTok differs from Meta in two ways the design
accounts for: its account lives in `tiktok_accounts` (not `meta_accounts`), and its token
is resolved at publish time by `TikTokTokenService` (not upfront in the destination).

## Components

### 1. Migration — `database/migrations/024_strategy_binding_tiktok.sql`

```sql
-- 024_strategy_binding_tiktok.sql — TikTok as a first-class binding destination.
ALTER TABLE strategy_bindings
  ADD COLUMN IF NOT EXISTS tiktok_account_id UUID REFERENCES tiktok_accounts(id);

-- Widen the platform CHECK to include 'tiktok'. The 020 CHECK was added unnamed,
-- so drop it by introspection (no name guessing), then re-add.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'strategy_bindings'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%platform%' AND pg_get_constraintdef(oid) ILIKE '%telegram%'
     AND pg_get_constraintdef(oid) NOT ILIKE '%channel_id%';  -- the platform-IN check, not the destination check
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

(The `DO` block targets the platform-IN check specifically — it matches `platform` +
`telegram` but excludes the destination check, which references `channel_id`.)

### 2. `StrategyBindingsRepository`

Add `tiktok_account_id: string | null` to `StrategyBindingRow` + `StrategyBindingInsertInput`,
widen `platform` to include `'tiktok'`, add the column to the `SELECT` lists and to the
`insert()` write (mirroring `meta_account_id`).

### 3. `publish-destination.ts`

`DestinationPlatform = 'telegram' | MetaPlatform | 'tiktok'`. `PublishDestination` is
unchanged in shape — for TikTok, `targetId` carries the `tiktok_accounts.id` (the publisher
resolves the token from it), `token`/`metaAccountId` are undefined/null, `postedKey =
'TT:<id>'`, `throttleKey = 'tiktok:<id>'`.

### 4. `channel-config` — `ResolvedStrategyBinding`

Add `tiktokAccountId: string | null`; `resolveStrategyBindings()` maps `b.tiktok_account_id`.

### 5. `DestinationResolver` — TikTok branch

Inject `TikTokAccountsRepository`. New branch:

```ts
if (b.platform === 'tiktok') {
  if (!b.tiktokAccountId) throw new Error(`binding ${b.id}: platform tiktok requires a tiktok_account_id`);
  const acct = await this.tiktok.findById(b.tiktokAccountId);
  if (!acct) throw new Error(`binding ${b.id}: tiktok account ${b.tiktokAccountId} not found`);
  if (!acct.active) throw new Error(`binding ${b.id}: tiktok account ${acct.id} is inactive`);
  return {
    platform: 'tiktok',
    targetId: acct.id,            // the publisher resolves the token via getValidAccessToken(id)
    metaAccountId: null,
    postedKey: `TT:${acct.id}`,
    throttleKey: `tiktok:${acct.id}`,
    // token omitted — TikTok tokens rotate; resolved at publish time
  };
}
```

### 6. recipe-carousel strategy — TikTok branch

Inject `TikTokCarouselPublisher`. `execute(channelId, params, dest)` gains a tiktok branch
alongside the meta branch (the existing meta branch is unchanged):

```ts
if (dest.platform === 'tiktok') {
  const row = await this.repo.getNextForCarousel(dest.postedKey);
  if (!row) return;
  const recipe = toCarouselRecipe(row);
  const caption = buildCarouselCaption(row);
  const imageBuffer = await this.images.download(row.image_url);
  if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);
  const slides = await this.renderer.render(recipe, imageBuffer, { width: 1080, height: 1920 }); // 9:16
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
```

The strategy's execute becomes: telegram → return; **tiktok → this branch (9:16)**; meta →
existing branch (4:5). To avoid two near-identical bodies, the shared steps (select →
map → caption → download → render → host → publish → markPosted → delete) are factored into
a private helper parameterized by `{ renderOpts, keyPrefix, publish: () => Promise<string> }`,
with the meta and tiktok branches supplying their differences. (Meta has no
`isPermanentMetaMediaError` analog on TikTok — TikTok failures are treated as transient: no
markPosted, retried next tick.)

`recipe-carousel` declares `supportedPlatforms = ['instagram','facebook','threads','tiktok']`.

### 7. Strategy capability map — `supportedPlatforms`

`ContentStrategy` gains an **optional** `readonly supportedPlatforms?: DestinationPlatform[]`.
Absent → defaults to `['telegram']`. Declared only by the multi-platform strategies:

| Strategy | supportedPlatforms |
| --- | --- |
| `recipe-carousel` | `['instagram','facebook','threads','tiktok']` |
| `recipes` | `['telegram','instagram','facebook','threads']` |
| `ai0-prompts` | `['telegram','instagram','facebook','threads']` |
| `curated-prompts` | `['telegram','instagram','facebook','threads']` |
| all others | (omit → `['telegram']`) |

`ContentStrategyRegistry` gains `supportedPlatforms(type): DestinationPlatform[]` (returns
the strategy's declared list or `['telegram']`).

### 8. Strategies API + DTO

- **New** `GET /api/strategies/types` → `[{ type, supportedPlatforms }]` (from the registry),
  for the 5d dashboard's filtered Type dropdown.
- **POST/PUT binding DTO**: accept `platform='tiktok'` + `tiktok_account_id`. Invariant
  (controller): exactly one destination kind; `tiktok` requires a `tiktok_account_id` that
  exists (`TikTokAccountsRepository.findById`) and forbids `meta_account_id`/`channel_id`;
  **and** the chosen `platform` must be in `registry.supportedPlatforms(type)` (else 400,
  e.g. "strategy ai0-news does not support platform tiktok").

## Data flow

```
binding(platform=tiktok, tiktok_account_id) → DestinationResolver
   → PublishDestination{ platform:tiktok, targetId:<tiktok id>, postedKey:TT:<id> }
   → recipe-carousel.execute → getNextForCarousel(TT:<id>) → render 9:16 → host
   → TikTokCarouselPublisher.publishCarousel(targetId, urls, caption)  [5b: token→init→poll]
   → markPosted(TT:<id>)   (finally: hosting.delete)
```

## Error handling

| Situation | Behavior |
| --- | --- |
| tiktok binding without `tiktok_account_id` | resolver throws (DB CHECK also forbids) |
| tiktok account missing / inactive | resolver throws → scheduler records error |
| image download fails | strategy throws (transient; retried) |
| TikTok publish fails (init/FAILED/timeout from 5b) | strategy rethrows; no markPosted (transient); slides deleted in finally |
| binding API: incompatible platform+strategy | 400 from the DTO invariant |

## Testing

`node:test` via `cd apps/automation && npm test`. **No live network** (cost guard); all
collaborators mocked.

- **DestinationResolver** — tiktok branch: resolves active account → `TT:<id>` postedKey +
  `targetId=id`, no token; throws on missing id / not-found / inactive.
- **recipe-carousel strategy** — tiktok branch (fake repo/renderer/hosting/tiktokPublisher):
  renders with `{width:1080,height:1920}`, hosts under `carousel/tiktok/<id>/<recipe>`,
  calls `tiktokPublisher.publishCarousel(targetId, urls, caption)`, `markPosted('TT:<id>')`,
  `delete` in finally; transient publish error → no markPosted, delete still runs, throws.
  The existing meta-branch tests still pass unchanged.
- **Registry** — `supportedPlatforms('recipe-carousel')` → the 4-platform list;
  `supportedPlatforms('ai0-news')` → `['telegram']` (default).
- **Controller DTO** — `GET /types` shape; tiktok binding requires an existing
  tiktok_account_id; rejects a platform not in the strategy's `supportedPlatforms`.
- **Repository** — `tiktok_account_id` round-trips in row/insert (fake pool).
- Migration applies on boot (the user's restart, not ours).

## Cost / safety guard (standing)

Build + `tsc` + unit tests only (`cd apps/automation && npm test`). No service restart, no
live TikTok/Supabase calls, no publishing. No new dependency. The migration runs on next
boot. The Telegram + Meta paths are unchanged (additive branches/columns/fields).

## Deferred — 5d

Dashboard binding form: **Destination-first → Type** ordering, the Type dropdown filtered to
`registry.supportedPlatforms`, a TikTok account selector, the TikTok accounts page, and the
web OAuth authorize→callback round-trip.
