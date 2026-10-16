# 042 tasks

Linear epic: AI0-140 (T1–T8: AI0-141 … AI0-148).

- [ ] T1 (AI0-141) FR-005 Migration `080_channel_setup.sql` (`channel_setup_proposals`, `editor.onboarder` usage feature) + repository.
- [ ] T2 (AI0-142) FR-001 Post collection: last 20 from `tracked_posts`, `getHistory` top-up with upsert, `no_access` vs no posts, `too_few_posts`, flood handling.
- [ ] T3 (AI0-143) FR-002 Metrics in code: cadence, peak/quiet hours, format mix, length, emoji/hashtags/links/CTA/signature, address, engagement top, rubric candidates.
- [ ] T4 (AI0-144) FR-003 + FR-004 Analysis: role `onboarder`, prompt, terminal `submit_channel_setup` (six sections + evidence), checks with a checklist, locks.
- [ ] T5 (AI0-145) FR-006 Apply: per-section writers in one transaction, new channel → card + agent `off`, playbook version without the brief rebuild, voice skill, drift check, discard.
- [ ] T6 (AI0-146) FR-007 API + BullMQ `channel-setup` queue (concurrency 1), overview with cost estimate, @ai0 `analyze_channel_history`.
- [ ] T7 (AI0-147) FR-008 Dashboard: `/app/setup` table + batch run, agent page button/badge, proposal dialog.
- [ ] T8 (AI0-148) Verification: FakeLlm replay, PG tests, dashboard tests, browser check on mocks, runbook section, README row.
