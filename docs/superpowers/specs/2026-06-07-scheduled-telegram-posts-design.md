# Scheduled Telegram posts — design

## Summary

Add an operator-composed **scheduled post** feature, Telegram-only for now. The
dead **«Новий пост»** header button opens a composer (rich text + media-by-URL +
inline buttons + live Telegram-style preview); the operator picks a channel, a
sender (bot or MTProto-user), and a fire time. A background poller publishes each
post at its scheduled time, **bypassing the strategy cooldown** but still
respecting the per-channel **Pause** kill-switch. A «Заплановані» list lets the
operator view, cancel, and edit pending posts.

Out of scope (MVP cuts): recurrence, media albums, video/photo together, file
upload (URL only), callback/switch-inline buttons, non-Telegram platforms.

## Why this shape

- **DB row + minute poller, not a BullMQ delayed job.** The operator needs to
  list / cancel / edit scheduled posts. A first-class `scheduled_publications`
  row is trivially queryable and editable; a buried Redis delayed job is not.
  It also survives a Redis flush and reuses the existing `@nestjs/schedule`.
- **Direct publish path, not the strategy runner.** Cooldown (`tryLock`) lives in
  the cron strategy runner, not inside `publish()`. A dedicated `publishComposed()`
  path bypasses cooldown by construction, and we choose explicitly whether to
  bump it (we don't).
- **Reuse the publisher's bot + MTProto-user clients**, extend them minimally for
  video, inline buttons, link-preview placement, and MTProto-user text send.

## Telegram platform constraints (drive the guardrails)

These are platform limits, not product choices:

1. **Inline keyboard buttons can only be sent by a bot.** A user account
   (MTProto-user path) cannot attach `reply_markup`. → buttons ⇒ sender forced to **bot**.
2. **Caption limits:** bot photo/video caption ≤ **1024**; MTProto-user (premium)
   caption ≤ **2048**; bot *text message* ≤ **4096**.
3. Therefore **buttons + image + caption > 1024 is impossible in one message.**
   The composer blocks this combo.
4. **Media placement:**
   - `above` — native `sendPhoto`/`sendVideo` with caption underneath (reliable
     inline media; caption ≤ 1024 bot / ≤ 2048 mtproto-user).
   - `below` — a text message with the media as a **link-preview**
     (`link_preview_options.show_above_text = false`, `prefer_large_media = true`).
     Gives text-above-media + buttons + up to 4096 chars in one bot message;
     media rendering depends on Telegram previewing the URL.

## Data model

Migration `014_scheduled_publications.sql` (+ mirror table DDL is migration-only,
not in `init.sql`, per repo convention).

```sql
CREATE TABLE IF NOT EXISTS scheduled_publications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL CHECK (sender IN ('bot','mtproto_user')),
  bot_id          UUID REFERENCES my_bots(id),          -- required when sender='bot'
  text            TEXT NOT NULL DEFAULT '',             -- Telegram HTML
  media_type      TEXT NOT NULL DEFAULT 'none' CHECK (media_type IN ('none','photo','video')),
  media_url       TEXT,
  media_placement TEXT NOT NULL DEFAULT 'above' CHECK (media_placement IN ('above','below')),
  buttons         JSONB NOT NULL DEFAULT '[]',          -- [[{label,url}, …], …] rows of url-buttons
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','canceled')),
  message_id      BIGINT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sched_pub_due ON scheduled_publications (scheduled_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_sched_pub_channel ON scheduled_publications (channel_id);
INSERT INTO schema_migrations (version) VALUES ('014_scheduled_publications') ON CONFLICT (version) DO NOTHING;
```

Validation invariant (enforced in the service/DTO, not just SQL):
`buttons` non-empty ⇒ `sender='bot'`; `media_type='photo'|'video' AND placement='above' AND visibleLen(text) > 1024` ⇒ `sender='mtproto_user' AND buttons=[]`.

## Backend

New module `apps/automation/src/scheduled-posts/` (mirrors `tracking/api` layout):

- **`scheduled-posts.repository.ts`** — CRUD over the table; `listDue(now)`,
  `markSent(id, messageId)`, `markFailed(id, error)`.
- **`scheduled-posts.service.ts`** — create/list/get/update(pending only)/cancel;
  `publishDue()` orchestration; validation of the guardrail invariants.
- **`scheduled-posts.controller.ts`** (`@Controller('scheduled-posts')`,
  `@UseGuards(TrackingAuthGuard)`):
  - `POST /scheduled-posts` — create (status=pending)
  - `GET  /scheduled-posts?status=` — list
  - `GET  /scheduled-posts/:id`
  - `PATCH /scheduled-posts/:id` — edit (only while pending)
  - `POST /scheduled-posts/:id/cancel` — cancel (pending → canceled)
  - `POST /scheduled-posts/preview` — optional: server-render the HTML the bot
    would send (kept simple; preview is primarily client-side)
- **`scheduled-posts.worker.ts`** — `@Cron('*/30 * * * * *')` (every 30s): load
  due pending rows, publish each, persist outcome. Skips if the MTProto-user
  client is required but not ready (marks `failed` with a clear reason).

Publisher extension — `apps/automation/src/publishers/`:
- **`publishComposed(input)`** on `TelegramPublisher` taking the explicit
  `{ channelId, sender, botId, text, media, placement, buttons }`. It:
  - resolves channel + bot token via `ConfigCacheService`,
  - throws `ChannelPausedError` if the channel is paused (worker → `failed`/skip),
  - **does not** call `PostingThrottleService.tryLock` and **does not**
    `recordPublish` (no cooldown gate, no cooldown bump),
  - bot path: `sendPhoto`/`sendVideo` (+caption+`reply_markup`) for placement
    `above`, or `sendMessage` (+`reply_markup`+`link_preview_options`) for
    `below` / text-only,
  - mtproto-user path: extend `TelegramStatsClient` with `sendMessage(text)` and
    `sendVideoWithCaption(...)` alongside the existing `sendPhotoWithCaption`.
    (No buttons — guarded upstream.)

Returns the Telegram message id, stored on the row.

## Frontend

- **`NewPostModal`** (opened from the AppShell «Новий пост» button): two-pane —
  left = form, right = live Telegram preview.
  - Channel picker (owned channels).
  - Sender toggle (Bot ▸ which bot / MTProto-user) with the guardrail logic:
    disable MTProto-user when buttons present; warn/auto-suggest when caption >1024.
  - Rich text field producing Telegram HTML (bold/italic/underline/strike/code/
    link; `@mentions`/`#tags` pass through as text). Lightweight — a small
    toolbar over a `contenteditable` or a markdown-ish textarea; preview renders
    the same HTML.
  - Media: type none/photo/video + URL + placement above/below.
  - Inline buttons: editable rows of `{label, url}`.
  - Schedule time: datetime picker; timezone shown explicitly (server/UTC).
  - Char counter that reflects the active limit (1024/2048/4096) per sender/media.
- **Live preview** — a Telegram-bubble component: media in chosen position,
  formatted text, button grid.
- **«Заплановані» page** (`/scheduled`, in the Calendar nav slot): list with
  status chips (pending/sent/failed/canceled), time, channel, snippet; cancel
  pending; edit pending (reopens `NewPostModal` prefilled).
- API client `apps/dashboard/src/api/scheduled-posts.ts` + types; React Query hooks.

## Error handling

- Validation errors (guardrail violations, missing channel/time, bad URL) → 400
  from the DTO/service, surfaced inline in the composer.
- Publish-time failures (Telegram API error, paused channel, MTProto not ready) →
  row marked `failed` with the error text; visible in the list. No retry in MVP
  (operator edits + reschedules). Channel-paused is recorded distinctly.
- Worker is idempotent per row via status transition `pending → sent|failed`
  (a row is only picked while `pending`; the worker flips it before/at publish to
  avoid double-send on overlapping ticks — claim with `UPDATE … SET status='...'
  WHERE id=$1 AND status='pending' RETURNING` or an in-flight set).

## Testing

- Unit: guardrail validation (buttons⇒bot; caption-limit/placement matrix),
  `listDue` boundary, status-transition claim (no double-send).
- Unit: `publishComposed` builds the right Telegram call per (sender, media,
  placement, buttons) combination (mock the HTTP/gramjs clients).
- Manual smoke (cost-safe, dev-stage): schedule a text post +1 min to a test
  channel via bot; schedule an image+caption>1024 via MTProto-user; schedule one
  with buttons; verify cooldown bypass (schedule while channel in cooldown) and
  Pause respect (paused channel → failed).

## Rollout

- Migration auto-applies via `database/migrate.sh` (already wired into CI).
- Backend + dashboard ship through the existing dev/prod pipelines.
- Cost note: the worker publishes real posts; it does **not** call Claude (content
  is operator-authored). Test against a dev channel.
