# 052 tasks

Linear epic: AI0-220 (T1–T5 = AI0-241…245; T6 rides with T5).

- [x] T1 (AI0-241) FR-001: migration `086_channel_launches.sql` and its repository, `/launch` parsing, `LaunchService.create` (refusals), the preparation worker (card + agent in `off`, steering sets with the launch gate, launch analysis `submit_channel_launch` with code checks, `ready` / `failed`, Redo, Discard), the `launch` artifact type and adapter, the chat chip, and the @ai0 tool `launch_channel`.
- [x] T2 (AI0-242) FR-002: the checklist (bot admin check with the default-bot resolver, tracking as ours on proof, references, plan, start, first posts, platforms), Start (writers, steering activation, first-week ideas, mode `approve`, plan today and tomorrow), start-requested auto start, the owner-bot card kind `launch` (bot and start), and the API (`GET /api/launches/:id`, `POST …/start|redo|discard|check`).
- [x] T3 (AI0-243) FR-003: graduation criteria, the hourly check, `LAUNCH_GRADUATION` propose / auto / off and the other settings, the "Ready to go live" card (Go live → autonomy switch, Not yet → snooze), and live-elsewhere detection.
- [x] T4 (AI0-244) FR-004: cross-promo after the first 3 posts (source pick by relevance, owner-approved accepted directives, PromoPlanner), the promo step, and subscribers and joins since Start.
- [x] T5 (AI0-245) FR-005: dashboard launch panel (checklist, plan, progress, buttons), slash menu and `/help`, artifacts meta, owner-bot kind text, and a browser check on mocks.
- [x] T6: runbook section, specs README row, spec status, memory.

## Status

Done 2026-10-20: T1 04371a6a, T2 fe46029c, T3 815805bd, T4 ce9c2c13, T5 b0683937, T6 with the docs.

## Deltas from the spec

- The launch has one more status, `analyzing` (the onboarder run), between `preparing` (references being read) and `ready`; a launch stuck in it for 15 minutes goes back to `preparing`.
- The references are stored in the column `refs` (`references` is a reserved word).
- A launch reference set passes steering's own-channel gate through the open launch (the new channel is not tracked as ours yet); launch sets make no steering cards of their own, because Start activates them.
- The owner bot shows the bot's state on the "Launch plan ready" card (with **Перевірити бота** while it is not an admin) instead of a separate "Add the bot" card before Start; the `<id>:bot` card comes only after Start was pressed and waits for the bot.
- Start plans today in the background; tomorrow is planned by the approval-mode evening run (20:00), as for every approval channel.
- `auto` graduation files an inbox note of kind `launch_graduated` (severity `action`); a channel switched to live elsewhere is recorded as `by: owner_elsewhere`.
- Settings are read live (`apply: live`): `LAUNCH_GRADUATION`, `LAUNCH_GRADUATE_MIN_DAYS`, `LAUNCH_GRADUATE_MIN_APPROVED`, `LAUNCH_GRADUATE_MIN_CLEAN_PCT`, `LAUNCH_GRADUATE_MIN_CRITIC_PCT` (Settings → Editor).
- `TrackingModule` exports `TrackingService`, so the launch adds the channel to tracking the same way the dashboard does.
