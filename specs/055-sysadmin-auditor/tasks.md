# 055 tasks

Linear epic: AI0-247.

- [x] T1 FR-001: `skills/skills-audit.ts` lifted from the test, `sysadmin/checks/*` (skills, memory, rules, tools, prompt) pure and tested, `sysadmin/audit-queries.ts` with a PG test.
- [x] T2 FR-002: role `auditor` wiring (types, model registry, features, skill roles), @sysadmin via registry sync, the `auditor-workflow` builtin skill, the runner with `submit_audit` and code validation (fake LLM tests only).
- [x] T3 FR-003: migration `088_audit_reports.sql`, repository, `AuditService` (run, apply, dismiss), controller, the `audit` artifact type and adapter, dashboard `AuditBody`, chip, `/audit`, mocks, browser check.
- [x] T4 FR-004: settings, the weekly tick with the ISO-week claim, the inbox note, the manager digest line.
- [x] T5: runbook §14, specs README row (DONE, migration 088 landed), spec status done.

## Status

- T1: done — the checks are pure functions over `AuditFacts` (`sysadmin/audit.types.ts`); `AuditQueries` loads the facts; 19 unit tests on fixtures and 3 PG tests on a throwaway database (init.sql + every migration).
- T2: done — role `auditor` through types, model registry (Haiku on the Anthropic workspace, low effort), features, budget reserve, skill lint and read tools; @sysadmin (kind `auditor`, system scope, live) is created by the registry sync; `auditor-workflow` builtin skill; `AuditorRunner` (code checks, then one model pass with `submit_audit`, every key and id checked in code); 4 + 5 + 3 unit tests with a fake LLM.
- T3: done — migration 088 (two tables, `agents_kind_check` widened, down file; applied twice in a PG test), `AuditRepository` (weekly claim by the unique insert, dead runs closed after 30 minutes, row-locked finding updates), `AuditService` (begin / execute / run / runInBackground, apply, dismiss, delta), controller `/api/audits`, artifact type `audit`, `/audit` slash command, dashboard `AuditBody` with compact finding cards, apply/dismiss dialogs and the handled list; looked at in the browser against a throwaway mock API (list, report, running, failed, no-model note, refused fix, dismiss).
- T4: done — five `AUDITOR_*` settings (group editor, live); `sysadmin/audit-schedule.ts` (`auditDue`, `auditInboxItem`, `AuditTick`) and `AuditWorker` (a tick a minute, registered in the editor module); the audit's loop is now `ownerStartedLoop` (runs without `EDITOR_ENABLED`, needs only a model key); the inbox note by `postOnce`; the `audit` line of the manager digest (`auditLineOf`); the dashboard Inbox links the note to the report. 10 unit tests, 2 PG tests (week claimed once across two tick objects, one inbox note, digest line).
- T5: done — `docs/runbooks/agent-platform.md` §14 (needs, settings, checks, the report and its fixes, the owner note and the digest line, how to check); the specs README row is DONE and 088 moves to landed; the spec's Status is done.

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
- **Tools of the audit pass.** `get_channel_memory` / `get_channel_card` need a run channel, which the audit has not; the auditor gets `inspect_channel_memory` and `inspect_channel_card` (by channel key) instead. `load_skill` / `list_skills` serve every skill of the database (a source built from the facts), not one agent's view.
- **The model may not fail the report.** Off (`AUDITOR_LLM=off`, agent off or missing, no key), over budget (`maxCostUsd` = `AUDITOR_BUDGET_USD`, default $0.15) or no `submit_audit`: the report is the code's findings with a note (`llm.status`, `llm.note`, English: it is shown in the panel).
- **Model findings** carry check `llm_judgement`, never a fix; at most 8; the subject must be an id the model was shown (flagged texts and the ten largest skills and rules).
- **@sysadmin starts `live`**: it only audits and proposes, so the mode decides nothing but whether the model pass runs. The `agents_kind_check` widening is migration 088 (T3); until then the registry sync logs that @sysadmin was not created.
- **Chat.** @sysadmin has no chat turn: a message to it gets a fixed answer pointing to the Audits artifact and `/audit`; it is left out of multi-agent addressing and of the channel-agent slash scope.
- **Run is asynchronous.** `POST /api/audits/run` answers at once with the `running` report (the pass goes on in the background); the panel and the list poll while a report runs. `AuditService.run` (begin + execute) stays synchronous for the weekly tick and the tests.
- **A refused owner run is 409** `already_running`; a scheduled run of a taken week is `week_taken`. A run left `running` for over 30 minutes (a restart) is closed as failed and no longer blocks.
- **`memory_retire` uses `retireByReviewer`**, so an owner row is refused by the query itself, not only by the check that never offers the fix.
- **`conflicts_resolve` calls `ConfigConflictsService.apply`** (the conflict fixes), not `resolve`, which would also approve a pending playbook and retire junk rules: those are the owner's decisions on their own cards.
- **A fix that finds nothing to do is a refusal** (`nothing_to_retire`, `nothing_to_apply`): the finding turns `failed` with the reason, and may be tried again.
- **Dismissed keys** are dropped when a report is made; a dismissal lasts 1–365 days (default 30), keyed by finding key alone.
- **The slash command answers with the running report as a chip**; `SlashDeps.audit` is optional so other suites that build the deps are untouched.
- **Dashboard:** findings are `CompactCard`s (the compact-card rule) rather than table rows; Apply asks first with the fix text; the artifact list and filters need no change (`done` is "in use", `failed` is "closed"). There is no separate mocks folder in the dashboard: the browser check used a throwaway API outside the repo.
- **Inbox note key.** The note is `kind audit_report`, `ref_type audit`, `ref_id <report id>` (not `audit:<week>`): a week has one scheduled report, so `postOnce` still posts at most one note a week, and the dashboard link needs the report id. The link is the artifact panel (`/app/artifacts?type=audit&open=audit:<id>`), the route the other artifact links use.
- **Note text.** Stored title and body are English (the Inbox page shows them); the Telegram alert is Ukrainian: «Аудит системи: N знахідок (E помилок), F можна виправити одним кліком», with the first line of the summary as the body. Only a scheduled run posts a note; the owner's own Run does not (the owner is looking at it).
- **Week marker.** The tick keeps the handled week in memory so the table is hit once a week per process; the unique insert is the real claim, so a restart or a second instance gets `week_taken`. A failed scheduled run is not retried that week (the owner can press Run again); `already_running` is retried the next minute.
- **Digest line** is read by SQL in `KpiDigestService.build` (`auditLineOf`, the newest finished report with at least one open finding; a missing table gives no line) and stays in the head at every slimming level. It is not part of the digest hash: a new audit does not by itself wake the MANAGER.
- **Weekday setting** is a number 1–7 (Mon–Sun), as the spec says, and `AUDITOR_AT` is `HH:MM`, both Kyiv time.
