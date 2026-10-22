# 060 tasks

- [ ] T1 Migration 093 (+ down) `series_pauses`; streak counter over closed slots using `skip-reasons.ts` classes; pause on threshold (`SERIES_SKIP_STREAK` in the settings catalog); planner filter and `series_paused` skips; last-3 skip reasons + paused series in the planner input/prompt; unit + PG tests.
- [ ] T2 Owner notes: merge series_missed + dark_day per resource/day, re-fire only on change or every `OWNER_NOTE_REPEAT_DAYS`, critical health same rule; a newer card closes older open cards of the same (kind, subject); tests.
- [ ] T3 Card actions: Відновити / Залишити на паузі on series-paused cards, Пауза серії on silent-day cards, Заглушити на 7 днів on health cards (existing dismiss path); dashboard: paused series with Resume on the agent Overview (English), API `GET/POST /api/agents/:handle/series-pauses`; tests.
- [ ] T4 Manager: adherence + age in the digest and open list, signature does not count not_followed / overdue accepted, forced review triggers, prompt lines, unmeasurable expected metric rejected, memory line for not_followed / inconclusive; tests; docs (runbook §, specs README row 060 DONE, spec status done).
