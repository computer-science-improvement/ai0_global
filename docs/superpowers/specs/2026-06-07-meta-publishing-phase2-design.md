# Meta Publishing (Phase 2) — Design

**Goal:** Let a strategy publish to a Meta account (Facebook / Instagram / Threads), reusing the strategy's generated text adapted per platform. Builds on Phase 1 connections.

## Key finding — two publish paths

- **Generic runner path** (`ContentStrategyRunner.run`): strategies WITHOUT a custom `execute()` (daily-photo, on-this-day, movies, space) go fetch → generate → `telegram.publish()` *in the runner*. Routing these to Meta = a dispatcher swap in one place. **Low risk.**
- **Custom `execute()` path**: ~10 strategies (ua-news, recipes, quotes, facts, ai0-news, ai0-prompts, curated-prompts, game-channel, pdr-quiz, assets, motivation-biography) publish to Telegram *inside their own `execute()`*. Routing these to Meta requires refactoring each strategy's internal publish calls — and that edits the **live Telegram publish path** (cost-sensitive).

### Internal decomposition
- **Phase 2a (this spec, safe/additive):** Meta publishers + content adapter + dispatcher + `strategy_bindings` targeting + strategy form + route the **generic path** by platform. Telegram path untouched.
- **Phase 2b (later):** refactor custom-`execute()` strategies to publish via the dispatcher. Touches live Telegram code → done carefully, separately, with the cost guard.

## Data model — migration `017`

```sql
ALTER TABLE strategy_bindings
  ADD COLUMN platform        TEXT NOT NULL DEFAULT 'telegram'
    CHECK (platform IN ('telegram','facebook','instagram','threads')),
  ADD COLUMN meta_account_id UUID REFERENCES meta_accounts(id) ON DELETE SET NULL,
  ALTER COLUMN channel_id DROP NOT NULL;
```
Invariant (controller-enforced): `telegram` → `channel_id` set; meta platforms → `meta_account_id` set.

## Components

### Content adapter — `publishers/meta-content.ts` (pure, unit-tested)
- `htmlToPlainText(html)` — strip Telegram HTML, keep link text, decode entities.
- `buildCaption(text, tags, { maxLen, maxTags })` — plain text + appended `#hashtags`, hard length cap. Caps: IG 2200/30, Threads 500/0, FB 60000/0.

### Publishers (implement the existing skeletons; read token+target from `PublishTarget`)
`PublishTarget` gains optional `token?: string`. The dispatcher resolves the meta-account's token (via `token_env`) and `target_id` and passes them in.
- **FacebookPublisher** — image URL → `POST {graph}/{id}/photos {url,caption}`; else `POST {id}/feed {message}`. Returns post id.
- **InstagramPublisher** — requires public `imageUrl` (else throws `Instagram needs a public image URL`). 2-step: `POST {id}/media {image_url,caption}` → `POST {id}/media_publish {creation_id}`.
- **ThreadsPublisher** — base `graph.threads.net`. `POST {id}/threads {media_type, text, image_url?}` → `POST {id}/threads_publish {creation_id}`. Text capped 500.
- Graph version `META_GRAPH_VERSION` (default `v21.0`); timeout `FETCH_TIMEOUT`. Errors redact the token.

### Dispatcher — `publishers/publisher-dispatcher.service.ts`
`publish(platform, payload, destination)`:
- `telegram` → existing `TelegramPublisher` with `{id: channelId}` (unchanged).
- meta → resolve `meta_account` (active else throw), read token via `ConfigService.get(token_env)` (missing → throw), pick the platform publisher, call `publish(adaptedPayload, {id: target_id, token})`.
- Applies posting throttle keyed by destination id; respects `meta_account.active`.

### Targeting plumbing
- `MetaAccountsRepository` already exported. `StrategyBindingsRepository` + the config-cache binding model gain `platform` + `metaAccountId`.
- `strategies` DTO/controller accept `platform` + `metaAccountId`; validate destination; list returns platform + destination label.
- Scheduler passes `platform` + destination to the runner; runner dispatches by platform (generic path only in 2a).

### Frontend
- Add/Edit strategy modals: platform selector; meta platforms swap the channel dropdown for an active+verified meta-account dropdown (`/api/meta-accounts`).
- Strategies table shows platform + destination.

### Logs
Meta runs already flow through `strategy_runs`; extend the activity label-join to resolve the meta-account name.

## Task breakdown (bite-sized)

1. `publishers/meta-content.ts` + `meta-content.test.ts` (pure). **[isolated]**
2. Implement Facebook/Instagram/Threads publishers + `PublishTarget.token`. **[isolated]**
3. Migration `017` + `StrategyBindingsRepository`/config-cache binding model (`platform`, `metaAccountId`).
4. `PublisherDispatcher` service (+ register in publishers module; import config for MetaAccountsRepository).
5. Strategy DTO/controller: accept + validate `platform`/`metaAccountId`; list label.
6. Scheduler + generic runner path: dispatch by platform.
7. Frontend: strategy modals platform/account selector; table column; api/types.
8. Logs activity label-join resolves meta-account name.
9. Verify (tsc + builds + node tests). Smoke test (real posting) = user's manual step.

## Out of scope (Phase 2)
Image hosting (IG buffer posts), composer previews (Phase 3), custom-`execute()` strategy routing (Phase 2b), multi-destination fan-out.

## Cost/safety
Build + verify only. Real posting hits live Meta accounts (user's manual smoke step). No automation restart, no Claude calls, no edits to the live Telegram publish path in 2a.
