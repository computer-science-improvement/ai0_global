# 055 Sysadmin: the auditor agent

**Epic:** AI0-247 · **Priority:** P1 · **Depends on:** 017, 021, 040, 041, 045, 047, 048, 053 · **Status:** done · **Migration:** 088

## Why

The network has accumulated a lot of material that shapes how agents behave: skills, memory rows, owner rules, steering sets, playbooks and channel settings. Some of it is wrong, duplicated, contradictory or never used.

There are checks for parts of this: skill lint, the skills audit test, playbook validation, owner-rule lint and config conflicts. But they run at write time or only in tests. Nobody looks at the whole picture regularly.

The owner asked (2026-10-20) for a "system administrator" agent. It should validate the tools, skills, memory and rules, judge whether each is needed and works right, and give comments. The owner skipped the brainstorm; each decision marked **my call** is mine.

## Design in one paragraph

A system agent **@sysadmin** (role `auditor`) runs once a week and on demand.

1. **Deterministic checks** (free, code) produce findings with evidence.
2. **One bounded LLM pass** (cheap model, ≤ $0.15) comments on the findings. It can add judgement findings about skills and rules that look useless or contradictory, using only the material it was given.
3. The result is an **audit report**: a new artifact type `audit`.
   - Each finding has a one-click **fix** that the owner applies, or **Dismiss**.
   - The sysadmin never changes anything itself (**my call**: it audits other agents' material, so the owner stays the one who changes it).

## Requirements

### FR-001 Deterministic checks (T1)

`audit/checks/*.ts` are pure functions over loaded facts. They return `Finding[]`:

```
Finding = { key, area: 'skills'|'memory'|'rules'|'tools'|'prompt', severity: 'info'|'warn'|'error',
            subject: { type: 'skill'|'memory'|'rule'|'steering'|'playbook'|'agent'|'tool'|'channel', id, label, agent?: handle, channel?: key },
            title, detail, evidence: Record<string, unknown>, fix?: Fix }
```

The `key` is a stable hash of area + check + subject, so the same problem has the same key every week.

**Skills.**
- Run `lintSkill` over every DB skill (builtin, global, agent): errors → `error`, warnings → `warn`.
- Unknown tool names in skill bodies: lift `auditSkills` and its helpers out of `skills/skills-audit.test.ts` into `skills/skills-audit.ts`. Keep the test using it.
- Enabled, non-inline skills never loaded (`load_skill` steps) in 30 days by an agent that ran at least 10 times. Fix: disable for that agent.
- Two skills on the same agent chain with near-identical bodies: token Jaccard ≥ 0.85. Fix: disable the newer.
- A skill rolled back 2 or more times in 60 days (`skill_versions.outcome = 'rolled_back'`). `info`.

**Memory** (`editor_channel_memory`, active rows).
- More active rows than the prompt shows (`listActive` cap 30; the writer sees 15). Say how many never reach the prompt. `warn`.
- Near-duplicate rows on the same channel: token Jaccard ≥ 0.8 after normalising case and punctuation. Fix: retire the older. Owner rows are never retired by a fix; a duplicate owner row is reported with no fix.
- Reviewer insights older than 90 days that no later row confirms. Fix: retire. `info`.

**Rules.**
- `lintOwnerRule` on every owner rule (codes `pointer_only`, `too_vague`, `meta_request`, `unknown_skill`, `unknown_agent`). No auto-fix; the finding links to the Rules artifact.
- `ConfigConflictsService.forAgent` for each orchestrator. The fix is that service's own resolve and apply, through the existing pending action.
- `validatePlaybook` and `playbookWarnings` on each active playbook.
- Steering: active sets with 0 rules, and sets whose channel is gone.

**Tools** (last 7 days, `editor_run_steps`).
- Per tool: an error rate ≥ 20 % with at least 5 calls. `warn`, with the 3 most common error texts clipped to 120 chars.
- Runs by role ending `no_terminal` or `max_steps` at ≥ 15 % with at least 5 runs. `warn`.

**Prompt.**
- Per agent: the sum of inline skill bodies over the inline budget (8000), so some are silently dropped. `warn`. Fix: turn inline off for the largest non-workflow skill.

Every check has unit tests on fixtures. The facts are loaded by `audit-queries.ts`, which has a PG test on the scratch DB.

### FR-002 The LLM pass (T2)

- **Role and model.** Add `auditor` to the `EditorRole` union and to `EDITOR_ROLES` (`llm/model-registry.ts`). That brings the `EDITOR_MODEL_AUDITOR` / `EDITOR_ANTHROPIC_MODEL_AUDITOR` / `EDITOR_REASONING_AUDITOR` settings with it. Also add it to `ANTHROPIC_ROLE_MODELS` (a Haiku-class model), `ROLE_DEFAULTS`, `EDITOR_FEATURE_ROLES` and `RESERVE_YIELDING_FEATURES`. Add it to `SKILL_ROLES` so an `auditor-workflow` builtin skill can carry its instructions.
- **The agent.** Registry sync creates **@sysadmin**:
  - kind `auditor`, scope `system`, name "Sysadmin", emoji 🛠️;
  - a description that says it audits and proposes, never changes.
- **The run.** It goes through the harness loop like the manager runner.
  - Read tools: `load_skill`, `list_skills`, `get_channel_memory`, `get_channel_card`.
  - The terminal tool `submit_audit`.
  - Limits: `maxSteps` 8, cost cap from `AUDITOR_BUDGET_USD` (default 0.15).
- **Input.** The findings (compact) plus, per area, the texts of the flagged items and of the 10 largest skills and rules. Clipped: 600 chars per item, 24 000 chars in total.
- **`submit_audit` input:**
  - `summary` (≤ 600 chars, Ukrainian, because it reaches the owner bot);
  - `comments: [{ key, comment }]`, only for keys that exist;
  - `extra: [{ subject (an id from the input), area, severity, title, detail }]`, at most 8. These are judgement findings: useless, contradictory, harmful or outdated.
  - Code validation drops unknown keys and ids, and clips the text. Extras get no fix (**my call**: only code-backed findings are applied in one click).
- The LLM pass is skipped when `AUDITOR_LLM=off`, when there is no API key, or when the budget refuses. The report is still made from the checks, with a note saying so.
- **Language.** Comments and the summary are in Ukrainian; the agent and owner-bot texts are Ukrainian. The dashboard chrome stays English. Comments are content and are shown as written.

### FR-003 Report, fixes, dismissals (T3)

- **Migration `088_audit_reports.sql`:**
  - `audit_reports(id UUID PK, week TEXT, trigger TEXT CHECK IN ('schedule','owner'), status TEXT CHECK IN ('running','done','failed'), findings JSONB, summary TEXT, llm JSONB, cost_usd NUMERIC, error TEXT, started_at, finished_at)`.
    - Unique `(week) WHERE trigger='schedule'`, so the weekly claim cannot run twice.
  - `audit_dismissals(finding_key TEXT PK, until TIMESTAMPTZ, by TEXT, at TIMESTAMPTZ)`.
- **The report.** `AuditService.run(trigger)`:
  - loads facts;
  - runs the checks;
  - drops dismissed keys (until > now);
  - runs the LLM pass;
  - stores the report;
  - marks every finding `open`.
- **Status per finding:** `open | applied | dismissed | failed`, stored inside `findings`.
- **Fixes** are a closed list. Each maps to an existing service call:

  | Fix kind | What it does |
  |---|---|
  | `skill_disable` | `agentsSvc.patchSkill(handle, name, {enabled:false})` |
  | `skill_inline_off` | `patchSkill(…, {inline:false})` |
  | `memory_retire` | `retireByOwner(channel, id)`; refused for owner rows |
  | `conflicts_resolve` | the config-conflicts resolver's apply |

- **Apply.** `POST /api/audits/:id/findings/:key/apply` runs the fix, marks the finding, and returns the new report. A failure marks it `failed` with the error.
- **Dismiss.** `POST …/dismiss` with `{ days?: 30 }` writes the dismissal and marks the finding.
- **Other endpoints:**
  - `POST /api/audits/run` (owner trigger). Refused while a run is `running`.
  - `GET /api/audits` lists the reports.
  - `GET /api/audits/:id` returns one report.
- **Artifact type `audit`** (spec 048): list = reports, newest first; get = the report; actions = Run again. Not own-versioned: a report is its own version. Add the chip regex, the meta, the `[[audit:id]]` mentions and the `/audit` slash command (which runs it).
- **Dashboard `AuditBody`** in the artifact panel:
  - the summary;
  - counts by severity;
  - findings grouped by area as compact rows: a severity badge, the title, the subject, the comment;
  - clicking a row opens a dialog with the detail, the evidence, the LLM comment, and **Apply fix** / **Dismiss 30 days** buttons;
  - applied and dismissed findings collapsed at the bottom.
- English UI; comments are shown as written.

### FR-004 Schedule and owner bot (T4)

- **Settings** (group editor, live):
  - `AUDITOR_ENABLED`, default `true`;
  - `AUDITOR_LLM` (`on|off`), default `on`;
  - `AUDITOR_WEEKDAY`, default `1` (Monday);
  - `AUDITOR_AT`, default `06:30` (Kyiv);
  - `AUDITOR_BUDGET_USD`, default `0.15`.
- **The weekly run** is claimed by ISO week in an every-minute tick, using the same pattern as the owner weekly report (`owner-reports.ts` `weeklyDue` and its claim). It runs without `EDITOR_ENABLED`, like `ownerStartedLoop`, because it publishes nothing. It needs an API key only for the LLM pass.
- **Owner bot.** After a run with at least 1 open finding, post an inbox note with `postOnce`:
  - key `audit:<week>`, kind `audit_report`;
  - severity `action` if any finding is `error`, else `info`;
  - text: «Аудит системи: N знахідок (E помилок), F можна виправити одним кліком» plus the summary's first line;
  - link `/app/artifacts?type=audit&id=<id>`.
- **Manager digest.** One line, `audit`: the open findings by severity, and the newest report id. No new directive kind.

## Non-goals

- The sysadmin changing anything by itself.
- Auditing code, infrastructure or connections. `/app/health` and the connection keeper already cover those.
- Per-tool loadout analysis. Spec 054 owns tool usage per agent. When both are merged, the audit can link to the Loadout tab.
- Running evals or any paid call besides the one bounded pass.

## Tasks

- T1 FR-001: lift `auditSkills`; the checks (pure, tested) and `audit-queries.ts` (PG test).
- T2 FR-002: the `auditor` role wiring, the @sysadmin agent, the `auditor-workflow` builtin skill, the runner with `submit_audit` and its validation (tested with a fake LLM, no paid calls).
- T3 FR-003: migration 088, the repository, `AuditService`, fixes, apply and dismiss, the controller, the artifact type and adapter, and the dashboard `AuditBody`, chip, slash command, mocks and a browser check.
- T4 FR-004: settings, the weekly tick and claim, the inbox note, the digest line, and the docs (runbook section).

Each task ends green:
- automation: `npm test` and `npm run build` on Node 20;
- dashboard: `npx tsc --noEmit`, `npm test` and `npm run build`.
