# 012 Owner control bot

**Epic:** AI0-219 (T1–T4 = AI0-237…240) · **Priority:** P1 · **Depends on:** 017–022, 031, 042, 045, 048, 049 (part A); 011 (part B) · **Status:** part A done (2026-10-19; the owner said "just do it": the design below is my call from the AI0-219 outline; deltas in tasks.md); part B waits for 011

## Why

Review 2 (gap analysis §8, gap 4) rated the owner interface 2/5:

- The owner hears about the network through one-way plain alerts. `OwnerInbox` (`editor/agents/owner-inbox.ts:44`) says "the 012 owner bot will later replace the alert with a card". `ApprovalAlerts` says "v1 does not approve from Telegram".
- Every decision needs the dashboard: a post to approve, a directive, an agent's card, a ready setup or steering set. The owner's data actions from review 1 sat undone for days, while a card in Telegram would have closed them in one tap.
- Nothing tells the owner how the day or the week went. There is no daily or weekly report.

The first version of this spec (2026-10-01) was written for the 011 deal agent and was blocked behind it. **Part A** takes the parts the network needs now and drops the 011 dependency. **Part B** keeps the deal-conversation controls for when 011 is built.

## Terms

- **Card**: a Telegram message to the owner about one thing that waits for them, with inline buttons. A tap does what the same button does in the dashboard.
- **Source**: one kind of waiting item that can become a card (a post to approve, a directive…).
- **Critical card**: a card that is never held back by quiet hours or the hourly limit.

## Part A: network owner bot

### FR-001 The bot (T1, AI0-237)

- One update consumer per bot token. The bot is the existing admin bot (`TELEGRAM_BOT_TOKEN`, `AdminBotService` long polling). It keeps its `chat_member` path (spec 022) and its `/analyze` command. There is no second consumer and no webhook in part A.
- The `getUpdates` offset is stored in `app_settings` (`owner_bot.offset`), so a restart does not replay or drop updates.
- **Owner only.** A message or a button counts only in a private chat, from the owner: `TELEGRAM_OWNER_ID`, or an id in `TRACKING_ALLOWED_TG_USER_IDS`. Anything else is ignored. A button from someone else gets a "not allowed" toast and does nothing.
- Cards go to the `TELEGRAM_OWNER_ID` chat, the same chat the alerts use.
- Callback data is `oc:<card id>:<button>` (+ `:y` for a confirmed tap). It never carries the action itself: the card row says what a button does.
- Telegram text is Ukrainian, as the owner's alerts already are. The dashboard stays English.

### FR-002 Cards (T1)

The sources and their buttons. Each button calls the same service method as the dashboard button:

| Source | When | Buttons |
|---|---|---|
| Post to approve (031) | `editor_slots.status = 'awaiting_approval'` in a batch whose approval alert went out (`approval_alerts`), so a card never comes while the batch is still being written | ✅ Опублікувати · ❌ Відхилити · Відкрити |
| Directive (021/025) | `awaiting_owner` | ✅ Схвалити · ❌ Відхилити · Відкрити |
| Contested directive | `contested` | Наполягти · Прийняти відмову · Відкрити |
| Agent card (018, 048) | a pending action made outside a chat (`chat_id IS NULL`); a card in a chat is answered in the chat | ✅ Застосувати · Відхилити · Відкрити; kinds that need the owner's choices on the card (`content_examples`) get Відкрити only |
| Steering set (045) | `ready` | Активувати · Відхилити · Відкрити |
| Setup from history (042) | `ready` | Застосувати все (asks to confirm) · Відхилити · Відкрити |
| Playbook (020) | `pending_owner` | ✅ Схвалити · ❌ Відхилити · Відкрити |
| Inbox note (017, 049) | an unread `agent_inbox` note of severity critical or action whose subject has no card of its own (not a directive) | ✓ Прочитано · Відкрити |

- **A card shows** the kind, the channel or agent, a title and up to 600 characters of the item (a post's text, a directive's reason, a card's summary).
- **Відкрити** is a URL button to the item in the dashboard (`DASHBOARD_URL`).
- **Confirmation.** A button marked "asks to confirm" first swaps the keyboard to "Так, …" / "Скасувати".
- **After a tap,** the card's text gets the outcome line ("✅ Опубліковано · 14:05"), and its buttons go.
- **A failed action** (a lost race, "already decided", the 3-active steering limit, a setup section changed since the analysis) shows the reason as a toast and on the card. A tap on a card that was already decided is answered "already decided".
- **Decided elsewhere.** When an item stops waiting outside Telegram (decided in the dashboard, expired, superseded), the card is closed: its buttons go and it says "Вирішено в дашборді", or "Минув термін" for an expired card.
- **Critical cards.** Critical inbox notes (a broken connection) are critical cards. A card for a post whose time has come or will come within 2 hours is critical too.
- **Inbox alerts.** While cards are on, `OwnerInbox` no longer sends the plain alert:
  - a critical or action note becomes a card;
  - an info note goes to the daily summary;
  - a directive note is covered by the directive's own card.
- **Not changed:** the other plain alerts (budget thresholds, slot-failure streaks, shadow previews, published / failed posts, ad reports).

### FR-003 Delivery: quiet hours, the hourly limit, the backlog (T1)

- **The sweep.** A job runs every minute. It:
  - makes cards for new waiting items;
  - sends what may be sent;
  - closes cards whose item stopped waiting.
- **Order and the hourly limit.** Critical cards go first. At most 30 cards go out per hour (`OWNER_BOT_MAX_PER_HOUR`); the rest wait in the queue.
- **Quiet hours** (`OWNER_QUIET_HOURS`, default `23-8`, Kyiv time) hold non-critical cards. When quiet hours end, the queued cards go out after one line: "Поки ви відпочивали: N карток".
- **The backlog.** Items that were already waiting when cards were first switched on (`owner_bot.cards_since`) do not become cards by themselves. `/waiting` shows them.
- **Retries.** A send that fails is retried on the next sweep, up to 5 attempts. A card the owner deleted, or one Telegram refuses to edit, is closed quietly.
- **The switch.** `OWNER_BOT_CARDS` (on by default) switches cards off and brings back the plain inbox alerts.

### FR-004 Commands (T1–T3)

| Command | What it does |
|---|---|
| `/status` | Counts of what waits by kind, health problems, today's posts and spend |
| `/waiting` | Sends the waiting items as cards now (up to 10, oldest first), ignoring quiet hours, then says how many are left |
| `/today` | The daily summary now (FR-005) |
| `/week` | The weekly report now (FR-006) |
| `/help` | The commands |
| `/analyze` | Kept as it is |

### FR-005 Daily summary (T2, AI0-238)

Sent once a day at `OWNER_DAILY_REPORT_AT` (default `21:00` Kyiv; `off` turns it off). A restart never repeats it (`owner_reports` claim). It contains:

- **Per channel:**
  - posts published, skipped (the main reason group) and failed;
  - posts waiting for approval;
  - subscriber change over the day, when tracked.
- **Spend:** today's spend against the cap, for the agents and for the whole account.
- **Waiting for you:** posts, directives, cards, setups and steering, with the count of info notes since the last summary.
- **Health:** broken connections, troubled sources, stuck work (049), or "Все гаразд".
- **Buttons:** "Що чекає" (= `/waiting`) and "Відкрити дашборд".

### FR-006 Weekly report (T3, AI0-239)

Sent once a week at `OWNER_WEEKLY_REPORT_AT` (default `Mon 09:00` Kyiv; `off` turns it off). It covers the last 7 days:

- **Per channel:** posts published, skipped and failed, subscriber growth, average views per post when tracked.
- **Spend:** the total for 7 days and per published post.
- **What the manager did:**
  - directives filed, applied, declined, and the ones still open;
  - outcomes that were measured.
- **What the agents learnt:** memory lines added, skill versions written, steering sets activated, owner rules added.
- **Health:** the 049 network-health section.
- **Targets vs actual:** "Цілей ще немає" until spec 050 adds numeric targets.

### FR-007 Dashboard (T4, AI0-240)

On `/app/health`, an "Owner bot" section shows:

- whether the bot is on and polling, and the last update it took;
- cards open, queued and sent today;
- when the daily summary and the weekly report last went out.

Actions:

- **Send a test card**: a card with one "Працює" button that closes it.
- **Send today's summary** and **Send the weekly report** now.

The settings (`OWNER_BOT_CARDS`, `OWNER_QUIET_HOURS`, `OWNER_BOT_MAX_PER_HOUR`, `OWNER_DAILY_REPORT_AT`, `OWNER_WEEKLY_REPORT_AT`) live in Settings → Configuration → Telegram and apply live.

### Data (migration 085)

- `owner_cards`
  - Columns: `id bigserial`, `kind`, `ref_id`, `status` (`queued`, `open`, `done`, `closed`, `failed`), `critical`, `title`, `body`, `buttons jsonb`, `link`, `chat_id`, `message_id`, `outcome`, `resolved_by`, `attempts`, `last_error`, `created_at`, `sent_at`, `resolved_at`.
  - Unique on (`kind`, `ref_id`). `ref_id` includes the state when one item can wait twice (a directive that becomes contested).
- `owner_reports`
  - Columns: `kind` (`daily` | `weekly`), `period` (the Kyiv date or the ISO week), `sent_at`.
  - The primary key is (`kind`, `period`).

### Out of scope (part A)

- Editing a post's text from Telegram. "Відкрити" takes the owner to the dashboard editor.
- Pause buttons for a whole resource. Slots of a broken connection are already skipped (049).
- A webhook, a dedicated control-bot token, several owner chats.
- Cards for DM actions (`agent_actions`) and ideas. They come with 011 / part B.
- Targets (050).

### Acceptance

- Unit tests:
  - owner-only routing (private chat, allowlist);
  - callback parsing and the confirm step;
  - idempotent and stale taps;
  - each source's buttons and actions against fakes;
  - quiet hours and the hourly limit;
  - the backlog rule;
  - closing a card decided elsewhere;
  - report texts;
  - the report claim.
- A PG test covers the card repository and the sources' queries.
- In the browser, against a mocked API: the Owner bot section on `/app/health`.
- Nothing is sent to real Telegram during development.

## Part B: deal conversations (with 011)

Kept from the first version, for when the 011 deal agent exists. It builds on the part A bot, cards and delivery.

- **Cards for deal conversations:**
  - new conversation: Зупинити / Перехопити / Відкрити;
  - escalation: Залишити на паузі / Дозволити / Відповім сам;
  - deal approvals: Надіслати / Редагувати / Відхилити;
  - takeover detected: Повернути агенту;
  - `peer_stopped`: always its own message, never batched, even in quiet hours;
  - `peer_returned`;
  - deal milestones;
  - account health: Зупинити все.
- **Edit and send:** ✏️ waits 10 minutes for the owner's text, then runs the speech gate again. The owner can force it, except for hard blocks (links and PII).
- **Commands:** `/paused`, `/pause_all`, `/resume_all`, `/chat @user`, `/reply @user <text>`, `/mode shadow|approve|partial|auto` (`auto` needs `CONFIRM`).
- **Races:** a draft is refused after a pause or a takeover, or when new inbound messages arrived after it was made (optimistic check on `deal_conversations.updated_at`).
- **Audit and web parity:** every tap and command goes to `deal_events`; `/app/deals` has the same controls.
- **Resume semantics** (011 §10): the agent gets the gap, and a resume after 12 h adds a natural re-greeting.
