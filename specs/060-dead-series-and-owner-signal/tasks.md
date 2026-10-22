# 060 tasks

- [x] T1 Migration 093 (+ down) `series_pauses`; streak counter over closed slots using `skip-reasons.ts` classes; pause on threshold (`SERIES_SKIP_STREAK` in the settings catalog); planner filter and `series_paused` skips; last-3 skip reasons + paused series in the planner input/prompt; unit + PG tests.
- [ ] T2 Owner notes: merge series_missed + dark_day per resource/day, re-fire only on change or every `OWNER_NOTE_REPEAT_DAYS`, critical health same rule; a newer card closes older open cards of the same (kind, subject); tests.
- [ ] T3 Card actions: Відновити / Залишити на паузі on series-paused cards, Пауза серії on silent-day cards, Заглушити на 7 днів on health cards (existing dismiss path); dashboard: paused series with Resume on the agent Overview (English), API `GET/POST /api/agents/:handle/series-pauses`; tests.
- [ ] T4 Manager: adherence + age in the digest and open list, signature does not count not_followed / overdue accepted, forced review triggers, prompt lines, unmeasurable expected metric rejected, memory line for not_followed / inconclusive; tests; docs (runbook §, specs README row 060 DONE, spec status done).

## Status

In progress. One commit per task:

- T1 — migration 093 `series_pauses`, `series-pause/` (cause classes, streak counter, repository, breaker, planner view), scheduler hook, planner context and prompt lines, `SERIES_SKIP_STREAK`, unit and PG tests.

## Deltas from the spec

- **When the streak is counted:** the spec says "after a slot ends skipped". The breaker runs from the scheduler tick (every 2 minutes at most, before slots are claimed) over the closed slots of the last 14 days, not from the slot's close path: the executor, the pre-flight (061), the scheduler and the derived-slot path all close slots, and one place that reads the result is safer than a hook in each. The effect is the same, one tick later.
- **Series key.** Same series = `series_name`, else `schedule_rule_id`, else the resource (`resource:<ref>`, the channel itself for a plain slot); stored as `series_pauses.series_key` (`series:<name>` / `rule:<id>` / `resource:<ref>`). The table also has `id` and `label` (what the owner reads), and `cause` allows `owner` (a pause made from a card, T3).
- **Plain slots (no series, no pin).** Pausing a whole resource is heavy, so a streak of plain slots must span at least 20 hours (a quiet evening of "nothing fresh" is not a dead channel). A paused plain resource is not planned (the scheduler skips `maybePlan` for it, like a held channel) and its planned slots are skipped; the channel's mode and `resource_pauses` stay untouched.
- **Cause classes for free text.** An executor's own `skip_slot` is free text (`skipped by agent: …`), so `no_material` and `source_unreachable` are recognised there by word patterns (Ukrainian and English) on top of the stable codes. `series-pause/skip-cause.ts` owns the patterns. Codes `preflight_*` (spec 061) are classified by prefix: `source_used` and `stale` count as `no_material`, `host_blocked` as `source_unreachable`, anything else (`format_unavailable`) is ignored. `silent/skip-reasons.ts` only gets `series_paused` as a "not a miss" code (no `series_missed` for a slot the breaker skipped).
- **Owner decisions, budget waits, `series_paused`, expired approvals and infra skips are transparent**, not breakers: they neither count nor end a streak. A published, shadowed, approved or awaiting-approval slot ends it. Another cause, or an unclassified skip (a lint failure), ends it.
- **After a resume** only slots closed after `resumed_at` count, so the old skips do not pause the series again.
- **Planner input (FR-002)** is added to the existing schedule block (`scheduleBlock`, so both planners read it) instead of a new prompt section: a line per paused series and a line with the last 3 skip reasons per series whose latest slot was a skip. The same context makes a slot of a paused series a plan error (the planner fixes the plan) and removes a paused series from the "due series" it must plan or skip. The lines are printed once (for today), not for tomorrow again.
- **The Inbox note** is stored in English (the dashboard rule) with the Ukrainian wording in the Telegram `alert`; the card with the three buttons comes in T3.
