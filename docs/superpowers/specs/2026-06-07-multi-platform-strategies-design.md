# Meta Cross-posting (sub-project A) — Design

**Goal:** When a strategy publishes to its Telegram channel, automatically cross-post to attached Meta accounts — either **mirror** (same content) or **teaser** (e.g. recipes: dish name + БЖВ + link to that TG post). Strategy rows show platform icons; the header platform filter scopes the list; the Meta chip is enabled.

**Supersedes** the independent per-platform-schedule model in earlier drafts of this file and the `ALTER strategy_bindings` plan in `2026-06-07-meta-publishing-phase2-design.md`. The Phase 2 **publishers + `meta-content.ts` adapter** (already built/committed) are reused as-is.

**Decisions (locked via brainstorming):**
- One strategy → many cross-post targets.
- **Always cross-post after the Telegram publish** (no separate Meta schedules).
- Two content modes: **mirror** (same as TG) and **teaser** (strategy-supplied short promo + link to the TG post).
- Recipe teaser links to the **exact TG post** and fires after the TG publish.
- **Per-account cooldown**, configurable per platform.
- Wire **recipes (teaser → FB/Threads)** and **ai0-news (mirror → Threads)** now; generic-path strategies get mirror via a central hook; other custom-`execute()` strategies wired later (one call each).

## Data model — migration `017_meta_crosspost_targets.sql`

```sql
CREATE TABLE meta_crosspost_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id      UUID NOT NULL REFERENCES strategy_bindings(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
  meta_account_id UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('mirror','teaser')),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (binding_id, platform, meta_account_id)
);
CREATE INDEX idx_meta_crosspost_binding ON meta_crosspost_targets (binding_id);
```
`strategy_bindings` is **unchanged** = the Telegram schedule. Zero risk to live Telegram publishing.

## Cross-post flow

`CrossPostService.afterPublish(input)` where `input = { bindingId, channelUsername, messageId, mirror: PostPayload, teaser?: { lines: string[] } }`:
1. Load enabled `meta_crosspost_targets` for `bindingId`. If none, return.
2. Build the TG post link when the channel is public: `https://t.me/<channelUsername>/<messageId>` (private channel → no link; teaser then links to the channel root or is skipped per platform).
3. For each target:
   - resolve `meta_account` (must be `active`; skip+log otherwise), read token via `ConfigService.get(token_env)` (missing → skip+log);
   - **per-account cooldown** gate (key `meta:<metaAccountId>`, window per platform);
   - build content by `mode`:
     - **mirror** → `buildCaption(mirror.text, mirror.tags, caps[platform])` + optional `\n\n↗ <link>`; image = `mirror.imageUrl` (IG requires it);
     - **teaser** → `teaser.lines.join('\n')` + `\n\n<link>` (e.g. `["🍲 Дієтична каша", "БЖВ: 12/8/40"]`);
   - dispatch via the platform publisher (FB/IG/Threads).
4. Failures per target are caught + logged (a Meta failure must NEVER affect the TG publish or other targets). Each cross-post is recorded to `strategy_runs`-style logging so it shows on the Logs page (a lightweight `crosspost` activity row, or reuse the existing run log keyed to the binding).

`buildCrosspostContent(...)` is a **pure, unit-tested** helper (mirror/teaser → final caption + image + link).

## Trigger points

- **Generic-path strategies** (daily-photo, on-this-day, movies, space): `ContentStrategyRunner`, right after a successful `telegram.publish*`, calls `CrossPostService.afterPublish({ bindingId, channelUsername, messageId, mirror: payload })`. (Telegram publish code path itself unchanged; the call is appended after success.)
- **recipes** (custom-`execute()`): after its existing TG publish, call `afterPublish` with `teaser.lines = [dishName, "БЖВ: P/F/C"]` (recipes already has the dish + nutrition).
- **ai0-news** (custom-`execute()`): after its TG publish, call `afterPublish` with `mirror: payload`.
- The runner/strategies need `channelUsername` + `messageId` — both already available at publish (messageId returned by the publisher; channel resolved from config).

## Per-account cooldown

Generalize `PostingThrottleService` from "channelId" to an opaque **destination key** (`tg:<channelId>` / `meta:<metaAccountId>`); the cooldown window is supplied by the caller per platform. New Settings keys (DB-override `SettingsService` + Settings page, meta tab): `INSTAGRAM_COOLDOWN_MIN` / `FACEBOOK_COOLDOWN_MIN` / `THREADS_COOLDOWN_MIN` (defaults 30 / 15 / 10); Telegram keeps `POSTING_COOLDOWN_MIN`. The existing Telegram throttle call sites switch to the `tg:<channelId>` key with identical behaviour.

## Backend API

- `MetaCrosspostTargetsRepository` (list-by-binding, insert, setEnabled, delete).
- `/api/strategies/:id/crossposts` (TrackingAuthGuard): `GET` list, `POST` `{platform, metaAccountId, mode}` (validate account exists+verified; validate platform/mode combo — IG only `mirror`+image), `PATCH /:targetId {enabled}`, `DELETE /:targetId`. Publishes `config:changed` (kind `'strategy'`) so the scheduler hot-reloads the binding view.
- `GET /api/strategies` rows gain `platforms: string[]` (telegram + distinct cross-post platforms).

## Frontend

- **Capability icons** per strategy row: Telegram + each configured cross-post platform. Shown when header filter = **All**.
- Header = **Meta** → list filtered to strategies with ≥1 Meta cross-post target. **Enable Meta chip** (`usePlatform` ACTIVE_PLATFORMS += `'meta'`).
- **Edit-strategy modal → Cross-post section**: list targets (platform + account + mode + enabled), add target (platform; account = active+verified meta accounts of that platform; mode — IG forced `mirror`), toggle/remove with confirm dialogs.
- `api/strategy-crossposts.ts` + types.

## Instagram caveat

IG captions have **no clickable links** and IG **requires an image**. So IG supports **mirror with an image** only; the recipe **teaser-with-link** targets **Facebook + Threads**. The add-target UI offers IG only in `mirror` mode and only warns it needs an image.

## Out of scope (separate sub-project D)
Meta **statistics / per-account stats pages** (insights collection, follower trends, per-account dashboards) — its own large analytics build, parallel to the Telegram tracker.

## Task breakdown
1. Migration `017_meta_crosspost_targets` + `MetaCrosspostTargetsRepository`.
2. `crosspost-content.ts` (pure mirror/teaser caption+link builder) + unit tests.
3. `PublisherDispatcher` (resolve account token+target → FB/IG/Threads publisher) + generalize `PostingThrottleService` to destination keys + per-platform cooldown (Settings keys).
4. `CrossPostService.afterPublish` (load targets, cooldown, build, dispatch, isolate failures, log).
5. Hook generic runner path (mirror) after TG publish.
6. Wire recipes (teaser) + ai0-news (mirror) after their TG publish.
7. Crossposts API + DTOs + capability/mode validation; `GET /api/strategies` exposes `platforms`.
8. Frontend: header Meta chip; strategy icons; header-filtered list; Edit-modal Cross-post section + api/types.
9. Logs: cross-post attempts appear on the activity feed.
10. Verify (tsc + builds + node tests). Real posting = user's manual smoke step.

## Cost/safety
Build + verify only. Telegram publish path unchanged (cross-post is appended after a successful publish, failures isolated). No automation restart, no Claude calls, no extra AI copy (mirror reuses TG content; teaser is a formatted string from existing recipe fields).
