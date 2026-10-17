# 046 Engine fixes from review 2 — tasks

- [x] T1 (AI0-182) `digestView`: always-valid JSON, head first, staged slimming, `resources_omitted`; `get_kpi_digest({resource})`; tests on 1–120 resources × 3 limits
- [x] T2 (AI0-183) `requiredQualityRefs` (agent, active, not young, visible in the render) in the gate and the manager prompt; agentless never held to flags; all problems at once
- [x] T3 (AI0-184) `accepted` replaceable via supersedes; remedy in `directive_open`; directive patch rebased onto the pending owner draft; `adviceVerifier` (playbook change or not_followed after 48 h); planners' "in force" block; PG test
- [ ] T4 (AI0-185) Manager: due keys in the DB, lifetime baseline, signature without per-post noise, 1 run/day + forced on change
- [x] T5 (AI0-186) Writer reserve (40% of the agents cap) for manager / orchestrator / reviewers; run headroom; budget-blocked slot → planned + retry_at (attempt back, skipped > 6 h late or in quiet hours); 7-day cost per post in the digest
- [ ] T6 (AI0-187) ≤ 3 critic passes per slot; no evergreen on live slots; rejected sole source kills the idea; attempts + cost in the trace
- [ ] T7 (AI0-188) Ideas ≈ slots + 1 per run; no idle wake-ups; second review batch > 15; 2 sources for factual news; orchestrator `schedule.times`
- [ ] T8 (AI0-189) SQL 42703 column hint; `query_data` valid fields; wording; `get_playbook(handle)` for the manager
- [ ] T9 (AI0-190) Feed host block per misuse; oversized feeds remembered; onboarder JSON-string args; sweeper cost; stale playbook platforms; `hashtag_while_off`; `number_not_in_sources` false positives
- [x] T10 (AI0-191) Anthropic per-role built-in models (Sonnet writer/critic/manager/chats, Haiku planner/orchestrator/ideas); Models page shows them; cost warning on switching
