# 012: Owner control bot: see, stop, resume, take over and approve from Telegram

**Status:** SPEC · **Depends on:** 011 · **Used by:** 011, 013, 014, 015, and the editor (005) alerts

## Why
The owner wants to know **every time** the agent account starts a personal conversation, to be warned when a conversation
goes off the rails, and to **stop** it from Telegram. History must be kept and resumable. Approvals in phases 0–2 must be one
tap. Today `TelegramNotifier` only sends plain text, one way.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **A two-way control bot.** The existing admin bot token (or a dedicated `CONTROL_BOT_TOKEN`) gets an updates consumer. It uses long polling by default (`getUpdates`, offset persisted in `app_settings`), or a webhook when `CONTROL_BOT_WEBHOOK_URL` is set (behind `/api/control-bot/webhook` with a secret token header). There is one consumer per process (single instance). |
| FR-002 | **Owner-only.** Every update is processed only if `from.id` is in `TRACKING_ALLOWED_TG_USER_IDS` (fail-closed, 001) **and** the chat is private. All other updates are ignored silently and counted. Each callback payload is an opaque id that maps to a `control_actions` row; actions are never encoded in callback data. Payloads expire after 7 days. |
| FR-003 | **Cards.** These events produce a card with inline buttons. **new_conversation:** peer, topic guess, first message excerpt → `[⏸ Зупинити] [🙋 Перехопити] [📂 Відкрити]`. **escalation:** reason, severity, last 3 messages → `[⏸ Залишити на паузі] [▶️ Дозволити продовжити] [🙋 Відповім сам]`, plus rule-specific buttons (011 scenarios, e.g. `[Дозволити «я асистент власника»]`). **approval:** the draft message, quote, discount, invoice, ВП acceptance or group post → `[✅ Надіслати] [✏️ Редагувати] [❌ Відхилити]`. **takeover_detected** → `[↩️ Повернути агенту]`. **deal milestones** (paid, scheduled, published, reported) → notify only. **account_health** (flood, restricted, new authorization) → `[⏸ Зупинити все]`. |
| FR-004 | **Edit-and-send.** `✏️` puts the bot into "waiting for your text" for that approval for 10 min. The owner's next message replaces the draft, and the speech gate runs again; if the gate blocks it, the owner sees why and can force it with `[Все одно надіслати]`, except for hard blocks (links and PII). |
| FR-005 | **Commands.** <br>• `/status`: active conversations by state, paused ones, today's sends, spend <br>• `/paused` <br>• `/pause_all`, `/resume_all` (global agent kill switch, stored in `deal_policy.active`) <br>• `/chat @user`: the last 10 messages, plus control buttons <br>• `/reply @user <text>`: relay through the agent account as an owner message, which sets `control='owner'` <br>• `/mode shadow\|approve\|partial\|auto`: the rollout phase. Moving to `auto` requires typing `/mode auto CONFIRM`. |
| FR-006 | **Idempotency and races.** <br>• Pressing a button twice has no effect. <br>• Approving a draft after the conversation was paused or taken over is rejected with an explanation. <br>• Approving a stale draft is rejected with "діалог змінився" when new inbound messages arrived after the draft was made. <br>• Optimistic version check on `deal_conversations.updated_at`. |
| FR-007 | **Notification policy.** <br>• Quiet hours for non-critical cards: they are batched into a digest at the start of working hours. <br>• Critical cards (money, impersonation, account health) are always sent immediately. <br>• Rate limit: ≤ 30 cards/hour; overflow goes into "N нових подій — /status". |
| FR-008 | **Audit.** Every button and command is written to `deal_events` with the actor and timestamp. The dashboard `/app/deals` shows the same controls (web parity) for when Telegram is unavailable. |
| FR-009 | **Resume semantics** (011 §10). Paused conversations keep ingesting messages. On resume the agent gets the gap, and the first reply must address the latest inbound message. A resume more than 12 h after the pause adds a natural re-greeting. |

## Data
`control_actions(id uuid, kind, conversation_id, payload jsonb, status CHECK (status IN ('open','done','expired','rejected')), message_id bigint, created_at, resolved_at, resolved_by)`
and `control_bot_state(key, value)`, which can live in `app_settings`.

## Corner cases
- **The bot is blocked by the owner, or its token is revoked.** Fall back to the dashboard. The health check alerts by email or on
  `/app` (banner).
- **Telegram API down.** Cards queue in `control_actions` and are sent later. Approvals don't expire while the API is down.
- **Two owners or admins.** Supported through the allowlist, and every card shows who acted.
- **Long messages.** Excerpts are capped at 600 chars, with a "📂 Відкрити" deep link to `/app/deals/<id>`.

## Success criteria
- Unit tests:
  - the allowlist;
  - callback idempotency and expiry;
  - the stale approval check;
  - edit-and-send through the gate;
  - command parsing;
  - digest batching.
- E2E: a fake Bot API plus a fake MTProto client, covering a new conversation card, stop, an inbound message while paused,
  resume, and the reply referencing the gap.
