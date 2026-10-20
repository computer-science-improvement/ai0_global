# 057 — Setup proposals expire

Status: in progress · Follow-up of [042](../042-channel-setup-from-history/spec.md) · Migration 090

## Why

A channel-setup proposal (spec 042) stays `ready` or `partially_applied` until the owner applies or discards it. In practice
some are forgotten: they keep a channel's "open proposal" slot (the unique index `uq_channel_setup_proposals_open` covers
`queued … ready`), show up in `/app/setup`, the chat artifacts panel, steering and the owner bot as something waiting, and
their analysis gets older every day (the posts, the profile and the rules move on). An old proposal applied weeks later can
overwrite newer changes. The owner wants them to close by themselves.

## What

1. **Expiry.** A proposal whose status is `ready` or `partially_applied` and whose `updated_at` is older than
   `SETUP_PROPOSAL_TTL_DAYS` days (setting, default 14; `0` = never expire) becomes `expired`.
   - Its sections that are still `pending` become `skipped` (exactly as `discard` does); applied sections stay applied.
   - `queued`/`collecting`/`analyzing` are not touched (the worker's own stuck handling covers them);
     `failed`, `no_access`, `too_few_posts` are not touched either (they are not waiting for an apply).
2. **New status `expired`** (migration 090 adds it to `channel_setup_proposals_status_check`; down file restores the old list).
   `expired` is final like `discarded`: apply → 409 `not_open`, discard → 409 `not_open`. A new analysis of the channel works
   as after a discard.
3. **When.** The sweep runs from the existing `channel-setup-tick` minute cron, at most once per hour (in-memory throttle;
   the SQL is idempotent anyway). It is code only — no LLM.
4. **Owner note.** One owner Inbox note per sweep that expired at least one proposal (Ukrainian, like the other owner notes):
   which channels, that applied sections stay, and that a new analysis can be run from `/app/setup`. Use the same Inbox
   mechanism the silent-day notes (spec 037 FR-010, `editor/silent/`) use; dedup by the proposal ids.
5. **Dashboard.** `expired` is a known status everywhere setup statuses are mapped (`api/channel-setup.ts`,
   `lib/channel-setup.ts`, `lib/artifacts.ts`, `lib/steering.ts`, `SetupProposalDialog.tsx`): badge tone `neutral`, label
   "Expired"; the dialog says "Closed after N days without an apply. Applied sections stay — analyze again for a fresh
   proposal." with the Analyze again action where Discard/Apply were. Not counted as waiting anywhere (setup page counters,
   artifacts "waiting" chips, steering, owner bot `/waiting`). English UI text only.
6. **Backend consumers.** Every place that lists open/waiting proposals (artifact adapters, steering source, launch,
   owner bot cards) treats `expired` like `discarded`. An owner-bot setup card for an expired proposal answers its buttons
   with the same "already closed" path a discarded one uses.
7. **Setting.** `SETUP_PROPOSAL_TTL_DAYS` in the settings catalog (spec 039 Settings → Configuration), integer 0–365,
   default 14, group next to the other setup/agent settings, with an English description.

## Not in scope

Expiring `steering` or other proposal kinds; changing how a proposal is applied; any LLM call.

## Acceptance

- Unit tests: the sweep picks only `ready`/`partially_applied` older than the TTL, skips pending sections, keeps applied
  ones, TTL 0 does nothing, the throttle runs it once per hour, one note per sweep listing the channels.
- A PG test (own throwaway database) for the repository SQL and the migration (status check accepts `expired`).
- Dashboard: tsc, tests, build green; `expired` renders with a neutral badge and the dialog text.
- Runbook §9 (channel setup) gets an "Expiry" paragraph; specs README row 057 DONE.
