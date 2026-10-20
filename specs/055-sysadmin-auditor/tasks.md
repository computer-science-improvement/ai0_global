# 055 tasks

Linear epic: AI0-247.

- [x] T1 FR-001: `skills/skills-audit.ts` lifted from the test, `sysadmin/checks/*` (skills, memory, rules, tools, prompt) pure and tested, `sysadmin/audit-queries.ts` with a PG test.
- [ ] T2 FR-002: role `auditor` wiring (types, model registry, features, skill roles), @sysadmin via registry sync, the `auditor-workflow` builtin skill, the runner with `submit_audit` and code validation (fake LLM tests only).
- [ ] T3 FR-003: migration `088_audit_reports.sql`, repository, `AuditService` (run, apply, dismiss), controller, the `audit` artifact type and adapter, dashboard `AuditBody`, chip, `/audit`, mocks, browser check.
- [ ] T4 FR-004: settings, the weekly tick with the ISO-week claim, the inbox note, the manager digest line.
- [ ] T5: runbook section, specs README row, spec status.

## Status

- T1: done — the checks are pure functions over `AuditFacts` (`sysadmin/audit.types.ts`); `AuditQueries` loads the facts; 19 unit tests on fixtures and 3 PG tests on a throwaway database (init.sql + every migration).

## Deltas from the spec

- **Folder.** The new code lives in `apps/automation/src/editor/sysadmin/` (checks in `sysadmin/checks/`), not in `editor/audit/`: that folder already holds the post audit (spec 034/037) and the two would be mixed.
- **Finding has a `check` field** (the code of the check, e.g. `skill_lint`). The key still hashes area + check + subject; the field lets the report group and the tests name findings.
- **Agents audited are the top-level ones** (orchestrators, manager, builder, auditor). A role child (planner, executor, reviewer, idea reviewer) inherits its orchestrator's skills and toggles, so its runs and `load_skill` calls are folded into the orchestrator's; a fix targets the orchestrator.
- **Unused skills** skip what the code puts in a prompt itself (workflow skills, safety and voice skills) and skills that apply to no role the agent ran in during the window; severity `info`.
- **Duplicate skills** need 20 words in each body; two shared (builtin or global) skills are reported once, without a per-agent fix.
- **Duplicate memory rows.** Rows are ranked as the prompt ranks them (owner first, then newest). The row that repeats an earlier-ranked one is the duplicate: an older reviewer row, or a reviewer row repeating an owner rule, gets the retire fix; a duplicate owner row has none.
- **"Confirmed" insight** (stale check) means a later row of the channel shares at least 40% of the insight's words.
- **Memory overflow.** `warn` when more than 30 rows are active (rows no prompt reads), `info` between 16 and 30 (rows the writer does not show). Owner preferences learnt on approval are not counted: the prompts show them in their own section.
- **One finding per agent for config conflicts** (not one per conflict): the fix is the resolver for the agent, so the findings would all share it.
- **A check never fills the report**: past 25 findings of one check the rest become one `<check>_more` info line.
- **Tool registry at run time** comes from the `ToolRegistry` (the sources are not shipped); `toolRegistryFromSource` stays for tests.
