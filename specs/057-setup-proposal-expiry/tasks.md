# 057 tasks

- [x] T1 Migration 090 (+ down) adding `expired`; repository `expireStale(now, ttlDays)` returning the expired rows (pending sections → skipped); PG test.
- [x] T2 Service sweep (hourly throttle) in the `channel-setup-tick` cron, setting `SETUP_PROPOSAL_TTL_DAYS`, owner Inbox note; `expired` treated as closed in apply/discard and in the backend consumers (artifacts, steering, launch, owner bot); unit tests.
- [x] T3 Dashboard: `expired` status everywhere setup statuses are mapped, neutral badge, dialog text and Analyze again; tests.
- [x] T4 Docs: runbook §9 Expiry paragraph, specs README row 057 DONE, spec status done.

## Status

Done 2026-10-21. One commit per task:

- T1 `82a21e1b` — migration 090 (+ down), `ChannelSetupRepository.expireStale`, Postgres test.
- T2 `f62bf924` — `setup-expiry.ts` (TTL parsing, hourly sweep, Inbox note), the sweep in the channel-setup tick, `SETUP_PROPOSAL_TTL_DAYS` in the settings catalog, `expired` closed for apply / discard / artifacts / owner-bot cards, unit tests.
- T3 `4526f447` — dashboard `expired` status (badge, Artifacts views, dialog line, Analyze again), tests.
- T4 — runbook §9 Expiry paragraph, specs README row 057 DONE, spec status done (the last commit).

Verified: automation `npm test` (2896 pass, 309 skipped without a database, 0 fail) and `npm run build` on Node 20; the PG test `setup.057.pg.test.ts` (3 tests) on the scratch server in its own throwaway database; dashboard `npx tsc --noEmit`, `npm test` (266 tests) and `npm run build` (run with `VITE_ALLOW_DEV_AUTH=true`, the build refuses a production bundle without a sign-in method). No browser check (the lead does it): the Expired badge in Artifacts, the dialog line and Analyze again.

## Deltas from the spec

- **Where a new analysis starts.** `/app/setup` is only a redirect to Artifacts now (spec 048), so the Inbox note and the dialog point to "Set up from history" on the agent page and `/setup @channel` in the chat, not to `/app/setup`.
- **Inbox note language.** The stored item (dashboard Inbox) is English and the Telegram alert (`alert`, also what the owner bot's inbox card shows) is Ukrainian — the split `OwnerInbox` already supports (AI0-79). The existing silent-day notes are English only. Drop `alert` in `expiryNote` if the Inbox should be Ukrainian too.
- **Note dedup** is `postOnce` with ref type `setup_proposals` and a hash of the sorted proposal ids (the ids themselves would make a long ref). No unique index backs it (unlike the resource-day notes), so it is a best-effort dedup; the sweep itself never repeats a proposal.
- **`reason` is overwritten** on expiry with "expired: closed after N days without an apply"; the dialog reads N from it (the dashboard does not know the TTL). A `ready` proposal's earlier `insufficient_span` reason is lost, which no longer matters once it is closed. `updated_at` is set to the sweep time. This `reason` tweak landed in the T3 commit, not T1.
- **Files named in the spec that needed no change.** `lib/steering.ts` / `api/steering.ts` and the backend steering / launch code only list the *steering set* and *launch* statuses (`too_few_posts` is theirs too); neither reads setup proposals. The setup consumers are the artifact adapter (`SETUP_LABEL`; an expired row offers no action), the owner bot's setup card source (it waits only for `ready`, so it never listed `partially_applied` or `expired`; a new `expired()` makes the closing card say «Минув термін» instead of «Вирішено в дашборді»), `lib/artifacts.ts` (neutral tone, closed view), `lib/channel-setup.ts`, `api/channel-setup.ts` and the dialog.
- **Owner-bot buttons.** A tap on a card of an expired proposal that is still open in Telegram goes the way a discarded one does: the service answers 409 `not_open` and the bot shows «Не вдалося: the proposal is expired». The card is closed by the next sync.
- **Runbook.** The Expiry text is a paragraph (plus a status-table row and the migration in "Needs") inside §9, as the spec says, not a new section.
- **PG test.** It uses `createMigratedDb` (a fresh database with `init.sql` and every migration, dropped at the end) instead of the shared URL, so it also proves 090 runs after 080–089 and that its down file restores the old list.
