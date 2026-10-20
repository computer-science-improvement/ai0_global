# 055 tasks

Linear epic: AI0-247.

- [ ] T1 FR-001: `skills/skills-audit.ts` lifted from the test, `audit/checks/*` (skills, memory, rules, tools, prompt) pure and tested, `audit-queries.ts` with a PG test.
- [ ] T2 FR-002: role `auditor` wiring (types, model registry, features, skill roles), @sysadmin via registry sync, the `auditor-workflow` builtin skill, the runner with `submit_audit` and code validation (fake LLM tests only).
- [ ] T3 FR-003: migration `088_audit_reports.sql`, repository, `AuditService` (run, apply, dismiss), controller, the `audit` artifact type and adapter, dashboard `AuditBody`, chip, `/audit`, mocks, browser check.
- [ ] T4 FR-004: settings, the weekly tick with the ISO-week claim, the inbox note, the manager digest line.
- [ ] T5: runbook section, specs README row, spec status.
