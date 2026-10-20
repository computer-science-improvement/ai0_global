# 057 tasks

- [x] T1 Migration 090 (+ down) adding `expired`; repository `expireStale(now, ttlDays)` returning the expired rows (pending sections → skipped); PG test.
- [x] T2 Service sweep (hourly throttle) in the `channel-setup-tick` cron, setting `SETUP_PROPOSAL_TTL_DAYS`, owner Inbox note; `expired` treated as closed in apply/discard and in the backend consumers (artifacts, steering, launch, owner bot); unit tests.
- [x] T3 Dashboard: `expired` status everywhere setup statuses are mapped, neutral badge, dialog text and Analyze again; tests.
- [ ] T4 Docs: runbook §9 Expiry paragraph, specs README row 057 DONE, spec status done.
