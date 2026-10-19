# 012 Owner control bot — tasks (part A)

Order: T1 → T2 → T3 → T4. Each stage ends with tests and a commit.

- [x] T1 (AI0-237) The bot and cards: migration 085, owner-only routing on the admin bot, stored offset, card sources and buttons, the sweep (quiet hours, hourly limit, backlog rule, closing cards decided elsewhere), `/status`, `/waiting`, `/help`, inbox alerts become cards, settings.
- [x] T2 (AI0-238) Daily summary at 21:00 Kyiv and `/today`.
- [x] T3 (AI0-239) Weekly report on Monday 09:00 Kyiv and `/week`.
- [ ] T4 (AI0-240) The Owner bot section on `/app/health` (status, test card, send reports), runbook, specs/README.

## Decisions (2026-10-19)

The owner said "just do it" (no questions), so these are my calls:

- Part A drops the 011 dependency. The deal-conversation controls stay as part B.
- The bot is the existing admin bot (one consumer per token), not a second token.
- Telegram text is in Ukrainian, like the owner's existing alerts.
- Cards are on by default. Items that were already waiting before the switch do not become cards by themselves; `/waiting` shows them.
- No post editing from Telegram in part A.

## Deltas from the spec

- T1: the approval batch alert (031) still goes out as it did; the post cards follow it within a minute, since a card only comes for a batch whose alert went out.
- T1: an inbox note about a directive or a playbook is not sent at all while cards are on: the directive or playbook card covers it.
- T1: a card the bot could not send 5 times is `failed`; `/waiting` puts failed and closed cards whose item still waits back in the queue.
- T1: switching `OWNER_BOT_CARDS` off and on again starts a new backlog line (`owner_bot.cards_since` is cleared while off).
- T1: `/status` lists what waits by kind and the card counts; posts, spend and health come with the daily summary data in T2.
- T2: a channel line counts the posts scheduled in the Kyiv day by their final status; skips the owner or the system chose (a superseded plan, a mode change) are not counted, the owner's rejections count with the reason "ваше рішення". Posts waiting for approval are counted whatever their date. Instagram / Threads / Facebook slots of a channel get their own line ("Канал · instagram").
- T2: spend shows two lines, the agents cap (`editor.*`) and the whole account (global), as Settings → Spend has them.
- T2: a report that is due is sent the first minute from its time until the end of that Kyiv day (a restart after 21:00 still sends it, once); a failed send is retried each minute, 5 times.
- T2: `/status` gets today's posts, spend and the health problem count from the same data.
- T3: the week is the last 7 days up to the send time (not a calendar week); the period claimed is the ISO week of the Kyiv date.
- T3: "memory lines added" counts the agents' channel and agent memory lines (not the owner's); "owner rules added" counts the owner's channel memory lines that are not approval preferences; spend is all LLM spend in `llm_usage` for the 7 days.
- T3: "outcomes that were measured" counts directives whose outcome (worked / no effect / hurt / inconclusive) was set in the week.
