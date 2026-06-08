# Content Runway — Design

**Goal:** For each finite-pool ("predefined content") strategy, show how many posts of content remain unpublished, and flag the strategy when that supply drops below a per-strategy threshold (default 100). Surface the number on the channel-detail page and a warning marker on both the channels table and the channel-detail page.

## Scope

This is sub-project 1 of two. Sub-project 2 (translate the whole dashboard UI to English) is a separate spec/plan.

**In scope:** counting remaining unpublished content per finite-pool strategy; a per-strategy configurable low-content threshold; displaying the count + a low-content marker in the dashboard.

**Out of scope:** days-of-runway / cron-rate math (we show a raw post count, not days); the standalone `apps/pipeline/src/calculator` tool (left untouched); moving the default threshold into the Settings page; caching the counts.

## Which strategies have a runway

Only the 8 **finite-pool** strategy types, which draw the next item from a pre-loaded Postgres table:

| Type | Repository | Eligible predicate (mirror `getNext` exactly) |
|---|---|---|
| `recipes` | `RecipesRepository` | `NOT (posted ? 'TELEGRAM') AND title_uk IS DISTINCT FROM '' AND kcal IS NOT NULL` |
| `quotes` | `QuotesRepository` | `NOT (posted ? <channelKey>)` (+ optional `category` filter from params) |
| `facts` | `FactsRepository` | `NOT (posted ? <channelKey>)` |
| `curated-prompts` | `CuratedPromptsRepository` | `provider <> 'prompthero' AND prompt_text IS NOT NULL AND NOT (posted ? 'TELEGRAM') AND status IS DISTINCT FROM 'ERROR'` |
| `ai0-prompts` | `PromptsRepository` | `category = <params.category> AND provider = 'prompthero' AND status IS NULL AND NOT (posted ? 'TELEGRAM')` |
| `pdr-quiz` | `PdrQuizRepository` | `NOT (posted ? <channelKey>)` |
| `motivation-biography` | `MotivationBiographyRepository` | `NOT (posted ? <channelKey>)` — **count ignores the today-only month/day filter** (see note) |
| `assets` | `AssetsRepository` | `data_source = <params.dataSource> AND NOT (posted ? <channelKey>)` |

The other 7 types (`ua-news`, `ai0-news`, `daily-photo`, `on-this-day`, `movies`, `space-news`, `game-channel`) pull from live feeds/APIs ("RSA"). They return `contentRemaining: null` → no number, no marker, no threshold input.

### Two correctness notes the plan MUST pin against the real `getNext` call sites
1. **The `posted` JSONB key.** Some strategies mark `posted` under the literal `'TELEGRAM'`; others under a channel-specific key. `countEligible` must use the **identical** key its `getNext` uses, or the count is wrong. The plan task for each repo reads that strategy's `getNext` invocation and reuses the exact key/param derivation.
2. **`motivation-biography` is calendar-gated** (`getNext` filters to today's month+day). Counting only today's eligible birthdays would almost always read 0–1 and fire a false "low" warning. The runway count for this type counts **all** not-yet-posted-to-this-channel birthday rows (the total future supply), not just today's. This divergence from `getNext` is intentional and documented in the count method.

## Backend

### Migration `019_strategy_low_content_threshold.sql`
```sql
ALTER TABLE strategy_bindings
  ADD COLUMN low_content_threshold INTEGER;   -- NULL = use default (100)

INSERT INTO schema_migrations (version) VALUES ('019_strategy_low_content_threshold')
  ON CONFLICT (version) DO NOTHING;
```
Nullable; `NULL` means "use the default constant". No backfill. Also mirror the column into `database/init.sql` for fresh installs.

### `countEligible` per repo
Each of the 8 finite-pool repositories gains `countEligible(args): Promise<number>` returning `SELECT count(*)` over the **same** WHERE clause as its `getNext`, taking the same arguments (`channelKey`/`posted`-key + relevant params). Pure SQL; no writes.

### `ContentRunwayService` (new, in the content-strategy area)
- Holds a registry `Map<strategyType, (binding) => Promise<number>>` for the 8 finite-pool types. The lambda extracts the same args `getNext` needs from the binding (channel key + `params`) and calls the repo's `countEligible`.
- `remainingFor(binding): Promise<number | null>` → `null` if the type is not in the registry (RSA types).
- `LOW_CONTENT_DEFAULT = 100` exported constant.
- `effectiveThreshold(binding) = binding.lowContentThreshold ?? LOW_CONTENT_DEFAULT`.

### API changes — `GET /api/strategies`
Each strategy row gains:
- `contentRemaining: number | null` — unpublished supply, or `null` for RSA types.
- `lowContentThreshold: number` — effective threshold (column value, else 100).

The controller computes these per binding via `ContentRunwayService`. Counts run inline on each list call (a handful of indexed `COUNT(*)` queries — acceptable; caching is out of scope). The frontend derives `lowContent = contentRemaining != null && contentRemaining < lowContentThreshold`.

### API changes — strategies `PATCH`
The update DTO/controller accept an optional `lowContentThreshold`:
- a non-negative integer → sets the column;
- `null` → resets to default (column `NULL`).
Validated with `class-validator` (`@IsInt() @Min(0)`, optional/nullable). On success, publishes the existing `config:changed` event as today (no behavior change to scheduling).

## Frontend

### Types (`api/types.ts`)
`Strategy` gains `contentRemaining: number | null` and `lowContentThreshold: number`. Add a derived helper `isLowContent(s)` (pure) for reuse.

### Channel-detail `StrategiesPanel` table (`routes/channels_.$id.tsx`)
New **"Content"** cell per strategy row:
- RSA type → `—` (muted).
- Finite-pool, healthy → `847` posts (muted number, e.g. with a "posts" suffix or tooltip).
- Finite-pool, low → an amber/red **badge** `Low: 47 / 100` (remaining / threshold).

### Channels table `ChannelRow` (`components/ChannelRow.tsx`)
The channels page (`routes/channels.tsx`) already renders lightweight strategy refs without counts. The page will call `useStrategies()` (globally cached, 30 s refetch — already used elsewhere), build a `Set<string>` of low-content strategy ids, and pass it to each `ChannelRow`. In the strategy-chip footer, any chip whose id is in that set gets a small ⚠ marker (no number in the table). No backend change to the channels endpoint.

### `EditStrategyModal`
For finite-pool types only, add a **"Low-content alert (posts)"** number input, prefilled with the effective threshold. Saving sends `lowContentThreshold` in the PATCH. A "reset to default" affordance sends `null`. Hidden entirely for RSA types.

## Testing

- **Per-repo `countEligible`** unit tests: seed one eligible + one ineligible row (already-posted / failing predicate / wrong param) and assert the count. Mirror existing repo test patterns. Cover the `recipes` extra predicates (`kcal`, `title_uk`) and `assets`/`ai0-prompts` param filters.
- **`ContentRunwayService`**: returns `null` for an RSA type, a number for a finite-pool type; `effectiveThreshold` honors column-vs-default.
- **`isLowContent` pure helper**: true only when `contentRemaining != null && < threshold`.
- **Verify**: `tsc --noEmit` + `nest build` (automation), `tsc` + `vite build` (dashboard), node tests green.

## Cost / safety

Read-only `COUNT(*)` queries plus one additive nullable column. No posting, no Claude API calls, no scheduler restart, no change to the live publish path. Honors the standing cost guard (the user runs any restart / smoke test).
