# Multi-platform Strategies (sub-project A) — Design

**Goal:** A strategy can publish to multiple platforms (Telegram + Instagram/Facebook/Threads), each target on its **own schedule**, with **per-account cooldown** so strategies don't flood an account. Strategy rows show **platform-capability icons**; the header platform filter scopes the list. Meta publishing is enabled for the **generic-path** strategies first.

**Supersedes:** the Phase 2 targeting approach in `2026-06-07-meta-publishing-phase2-design.md` (which planned to `ALTER strategy_bindings` with `platform`/`meta_account_id`). That ALTER is dropped; instead `strategy_bindings` is left untouched and Meta destinations live in a new `strategy_targets` table. The Phase 2 **publishers + content adapter** (already built/committed) are reused as-is.

**Decisions (locked via brainstorming):**
- One strategy → many targets (`strategy_targets`).
- Auto-derived per-type **capability map** (drives icons + allowed targets).
- **Per-account cooldown**, configurable per platform.
- Meta enabled for the 4 generic-path strategies now (daily-photo, on-this-day, movies, space); custom-`execute()` strategies stay Telegram-only until a later refactor.

## Data model — migration `017_strategy_targets.sql`

```sql
CREATE TABLE strategy_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id      UUID NOT NULL REFERENCES strategy_bindings(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
  meta_account_id UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  schedule        TEXT NOT NULL,                    -- cron, independent per target
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (binding_id, meta_account_id)
);
CREATE INDEX idx_strategy_targets_binding ON strategy_targets (binding_id);
```
- `strategy_bindings` is **unchanged** = the Telegram schedule (type + params + channel + cron). Zero risk to live Telegram publishing.
- A "strategy" in the UI = one binding + its Meta targets. Telegram lives on the binding; each Meta target carries its own `schedule`.

## Capability map — `common/content-strategy/strategy-platforms.ts`

Static per-type map → `{ instagram, facebook, threads }` (telegram always true). Pure + unit-tested.
- **daily-photo, movies, space** → instagram + facebook + threads (image-producing).
- **on-this-day** → facebook + threads (text; instagram off — no guaranteed image).
- All **custom-`execute()`** types (ua-news, recipes, quotes, facts, ai0-news, ai0-prompts, curated-prompts, game-channel, pdr-quiz, assets, motivation-biography) → telegram only this phase.
Drives: strategy icons, header-filtered list, and which platforms the Add-target UI offers.

## Publishing — finish the Phase 2 dispatcher

- `PublisherDispatcher` (publishers module): `publish(platform, payload, dest)`.
  - telegram → existing `TelegramPublisher` (unchanged).
  - meta → resolve `meta_account` (must be `active`; else throw), read token via `ConfigService.get(token_env)` (missing → throw), pick the platform publisher (FB/IG/Threads, already built), call `publish(payload, { id: target_id, token })`.
- **Per-account cooldown:** `PostingThrottleService` is generalized from "channelId" to an opaque **destination key** (`tg:<channelId>` / `meta:<metaAccountId>`); the cooldown window is supplied per platform by the caller. Windows configurable in Settings: `POSTING_COOLDOWN_MIN` (telegram, existing) + `INSTAGRAM_COOLDOWN_MIN` / `FACEBOOK_COOLDOWN_MIN` / `THREADS_COOLDOWN_MIN` (new, via the existing DB-override SettingsService). Defaults: TG 2, IG 30, FB 15, Threads 10.

## Runner / scheduler

- `ContentStrategyRunner.run(strategy, destination, params, strategyId)` where `destination` is `{ kind:'telegram', channelId }` or `{ kind:'meta', platform, metaAccountId, targetId, token }`.
  - **Generic path** (no `strategy.execute`): fetch → dedup (keyed by destination) → generate → dispatch to `destination` via the dispatcher. Telegram destination uses the existing publish calls verbatim.
  - **Custom-`execute()` path**: only ever receives a telegram destination (capability map guarantees it) → unchanged.
- Scheduler registers a cron per enabled `strategy_target` (in addition to the binding's Telegram cron). On fire it re-resolves the target + binding, runs the strategy for that destination, logs to `strategy_runs` (so Meta runs appear on the Logs page).
- **Dedup** keyed by destination id, so the same item isn't reposted to the same account.

## Backend API

- `StrategyTargetsRepository` (list-by-binding, insert, update schedule/enabled, delete).
- Endpoints under `/api/strategies/:id/targets` (TrackingAuthGuard): `GET` list, `POST` `{platform, metaAccountId, schedule}` (validate platform ∈ capability(type) and account exists+verified), `PATCH /:targetId` `{schedule?, enabled?}`, `DELETE /:targetId`. Publishes `config:changed` so the scheduler hot-reloads.
- `GET /api/strategies` list gains `platforms: string[]` (capability) + `targets` summary per row.

## Frontend

- **Capability icons** on each strategy row (Telegram + IG/FB/Threads from the map). Shown when the header platform filter = **All**.
- **Header filter = Meta** → strategies list filtered to Meta-capable strategies; a Telegram filter shows all. **Enable the Meta chip** in the header (`usePlatform` ACTIVE_PLATFORMS += 'meta').
- **Edit-strategy modal** gains a **Targets** section: list Meta targets (platform + account + schedule + enabled), add a target (platform limited to capability, account dropdown of active+verified meta accounts of that platform, own SchedulePicker), edit/remove with confirm dialogs.

## Out of scope (separate sub-projects)
- **D — Meta account stats/tracking** (collect IG/FB/Threads insights + per-account stats pages): its own large spec.
- Refactoring custom-`execute()` strategies to the produce/publish split (so they too can target Meta).
- Image hosting for IG buffer posts; composer previews.

## Task breakdown
1. Migration `017_strategy_targets` + `StrategyTargetsRepository`.
2. `strategy-platforms.ts` capability map (+ unit test).
3. `PublisherDispatcher` + generalize `PostingThrottleService` to destination keys + per-platform cooldown (Settings keys).
4. `ContentStrategyRunner` destination-aware (generic path dispatches by platform; Telegram unchanged); dedup by destination.
5. Scheduler registers crons per `strategy_target`; hot-reload on `config:changed`.
6. Targets API (`/api/strategies/:id/targets`) + DTOs + capability validation; list endpoint exposes `platforms` + targets.
7. Frontend: header Meta chip enable; strategy capability icons; header-filtered list; Edit-modal Targets section + api/types.
8. Logs activity label-join resolves meta-account name (Meta runs already logged via strategy_runs).
9. Verify (tsc + builds + node tests). Real posting = user's manual smoke step.

## Cost/safety
Build + verify only. Telegram publish path unchanged. Real Meta posting is the user's manual step; no automation restart, no Claude calls, no extra AI copy (Meta reuses the strategy's generated text adapted per platform).
