# 025: MANAGER: binding directives vs optional advice, and code executors for directive kinds

**Status:** BUILDING (T1–T5 done; T6–T7 open) · **Depends on:** 020, 021, 022 · **Supersedes/extends:** extends 021 (FR-004, FR-006, FR-007, FR-008, FR-009); replaces `applyAccepted` auto-flip ·
**Migration:** `065_directive_binding.sql`

**Owner comments addressed:** #7

## Why
Owner comment #7: «менеджер або може дати директиву - це більш приорітетна команда, або пораду - це те чому агент або буде
слідувати або може відхиляти». Today every MANAGER message is a "directive" that the orchestrator may reject for any listed
reason, so nothing carries real priority and nothing is marked optional. Worse, "applied" is often untrue: only `cross_promo`
and `repost` have code behind them, and the evaluator scores effects of changes that may never have happened.

This spec splits MANAGER output into two binding levels:
- **directive**: a command the orchestrator must carry out, unless a higher layer forbids it;
- **advice**: optional; the orchestrator follows it or declines it.

Every kind gets a deterministic executor: `applied` means the change exists, `verified` means it was observed in plans and
publishing (constitution I and IX).

## Current state (as-is)
- `agent_directives` (`053_directives.sql`) has a `kind` but no binding level. `advice` and `task` are only exempt from `expected` (`BR-AGT-93`).
- `reject_directive` (`apps/automation/src/editor/manager/directive-tools.ts`) accepts any of `owner_rule|playbook|capability|health|data`, closes the directive silently and starts a 48 h cooldown (`BR-AGT-79`, `BR-AGT-93`).
- `ManagerRunner.afterOrchestration` → `applyAccepted(orch, ['cross_promo','repost'])` flips every other accepted kind to `applied` after any run, unchecked; `pause_resource` pauses nothing (BRD 04 §3.12). Only `PromoPlanner.schedule` (022) executes anything (`BR-AGT-80`).
- Precedence is code-checked only on accept (`conflicting_rule_ids`, 021 FR-008); the prompt says "owner rule > directive > own judgment" (`network-prompts.ts:44`), with no place for safety, playbook or advice.
- Unanswered directives expire after 24 or 48 h without notice (`BR-AGT-96`; open question in BRD §3.10).
- `components/agents/Directives.tsx` has `structural`/`shadow`/outcome badges and Open/All only; `directive_structural` Inbox entries have no link (BRD §3.13).
- Reusable mechanics: `network/playbook.ts` (`per_day`, `formats`, `series[].active`, `classifyPlaybookChange`), `validateNetworkPlan`, `editor_slots.is_experiment`, `ResourceHealthService.usable`.

## Precedence (normative)
1. **Owner rules** (`editor_memory`/`agent_memory` with `created_by='owner'`, owner-locked skills).
2. **Safety**: code guards (quiet hours, budgets, kill switch, lint, API caps, resource health) and constitution VIII.
3. **MANAGER directives** (binding).
4. **The active playbook.**
5. **MANAGER advice.**
6. **The orchestrator's own preferences.**

A lower layer never overrides a higher one: a directive that changes the playbook wins (its executor writes the new version);
advice that conflicts with the playbook may simply be declined.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `065_directive_binding.sql`** (idempotent, non-destructive). <br>• `agent_directives`: add `binding TEXT NOT NULL DEFAULT 'directive' CHECK (binding IN ('directive','advice'))` and backfill `kind='advice'` → `'advice'`. Add `change JSONB` (executor diff), `exec_attempts SMALLINT NOT NULL DEFAULT 0`, `exec_error TEXT`, `verification JSONB`, `verified_at`, `contested_at TIMESTAMPTZ`. <br>• Widen CHECKs (look up names in `pg_constraint`, drop and re-add; no data changes): `status` + `contested`, `declined`, `failed`; `owner_decision` + `upheld`, `refusal_accepted`. <br>• `playbooks`: add `directive_id UUID NULL REFERENCES agent_directives(id) ON DELETE SET NULL`; `created_by` CHECK gains `'directive'`. <br>• New `resource_pauses(id BIGSERIAL PK, resource_ref TEXT NOT NULL, agent_id UUID, directive_id UUID, reason TEXT NOT NULL, starts_at, until TIMESTAMPTZ NOT NULL, lifted_at, lifted_by TEXT CHECK (lifted_by IN ('schedule','owner')), created_at)`; unique partial index `(resource_ref) WHERE lifted_at IS NULL`. <br>• `GRANT SELECT … TO editor_ro` as in 053. |
| FR-002 | **Kind × binding matrix** (`directive-kinds.ts`, code only). <br>• `advice`: advice only. <br>• `task`, `format_shift`, `pause_series`, `experiment`, `repost`: either level. <br>• `frequency`: either level below \|change_pct\| 30; at 30 or above it is structural and must be a directive. <br>• `cross_promo`, `pause_resource`, `strategy`: directive only, always structural. <br>`file_directive` gains a required `binding: 'directive' \| 'advice'`. Structural advice → error `structural_must_be_directive`. `advice` filed as a directive → error `advice_kind_is_advice`. |
| FR-003 | **Directive admission rules** (`fileDirective`), on top of 021 FR-004. A non-structural `binding='directive'` requires that `expected.metric` is flagged `anomaly` for the target scope in the digest, **or** that advice of the same kind to the same target was declined in the last 14 days and the metric has since moved further against `expected` (escalation). Otherwise → error `directive_needs_anomaly`, which tells the MANAGER to file it as advice. At most 2 open binding directives per target. |
| FR-004 | **Executor dry-run at filing.** Every kind with an executor (FR-010…FR-015) runs `plan(dir, ctx)` before insert. <br>• Invalid params (unknown series, a format outside `implementedFormats(platform)`, a resource outside the network, `per_day.max` above `dailyApiCap`) → error `not_executable`, so impossible directives are never filed. <br>• For playbook kinds the dry-run diff goes through `classifyPlaybookChange`. If it is structural (a format added, per_day ≥ ±30 %), it becomes `structural` and must be a directive. This replaces the param-only `isStructural`. |
| FR-005 | **Orchestrator response tools** (role `orchestrator`; `reject_directive` is removed from the registry). <br>• `accept_directive({id, plan, conflicting_rule_ids})`: unchanged, both levels; the owner-rule check stays (021 FR-008). <br>• `decline_advice({id, reason ≥ 10 chars, reason_kind: owner_rule\|playbook\|data\|capability\|health\|preference})`: advice only, otherwise error `binding_directive_use_contest`. Status becomes `declined`. No Inbox entry and no cooldown. <br>• `contest_directive({id, reason_kind: owner_rule\|safety\|capability\|health, reason ≥ 20 chars, rule_ids?: int[], resource_ref?: string})`: directives only. After FR-006 checks: `contested` plus an owner card (FR-008). Playbook/data/preference reasons → error `directive_is_binding`. |
| FR-006 | **Contest checks** (deterministic): `owner_rule` → every `rule_ids` entry is an active owner rule of the orchestrator; `health` → `resource_ref` is in scope and `ResourceHealthService.usable(ref)` is false now; `capability` → re-running the executor's `plan()` fails now; `safety` → accepted but flagged `unverified` on the card. A failed check → `reason_not_verified` (accept, or cite a reason that holds). The result goes to `verification.contest`. |
| FR-007 | **Non-response.** <br>• A binding directive delivered 24 h ago with no answer, whose target is active and not paused: the code runs its executor (`resolution='auto-applied: no response'`) and posts an Inbox entry `directive_auto_applied` (info). Kinds without an executor (`task`) → `expired` plus an Inbox entry `directive_ignored` (action). <br>• Unanswered advice → `expired` silently, as today. <br>• A target that is paused or `off` → `expired` as today, now with an Inbox entry (info). This answers the BRD §3.10 question. |
| FR-008 | **Contested card and owner decision.** The Inbox entry is `directive_contested` (severity action, `refType='directive'`). It shows the directive, the refusal, the check result and the precedence layer cited. <br>• `POST /api/directives/:id/uphold`: `owner_decision='upheld'`, then the executor runs. The owner-rule conflict check is skipped because the owner has decided, but health and capability guards still apply (→ `409 not_executable`). <br>• `POST /api/directives/:id/accept-refusal`: `rejected`, `owner_decision='refusal_accepted'`, and the 48 h cooldown starts. <br>• No answer within `DIRECTIVE_CONTEST_TIMEOUT_HOURS` (default 24): the refusal stands (`rejected`, `timeout_dropped`). <br>• A repeat decision → `409 not_contested`. |
| FR-009 | **Executor framework** (`manager/executors/*.ts`, interface `{plan(dir, ctx): Change \| {error}; apply(change): Promise<Applied>; verify(dir): Promise<{verified: boolean; detail}>}`). <br>• Replaces `applyAccepted`: `afterOrchestration` runs `apply` for every `accepted` row, followed advice included. Success → `applied`, `applied_at`, `change`, baseline (021). Error → `exec_attempts+1`, retried hourly; after 3 → `failed` + Inbox `directive_failed` (action for directives, info for advice). <br>• Hourly housekeeping runs `verify()` on `applied` rows without `verified_at`. <br>• Playbook kinds insert a new active version transactionally (`created_by='directive'`, `directive_id`), keeping any pending owner draft. Single-channel orchestrators without a playbook get `editor_channels.posts_per_day_min/max` / `formats` edited instead. |
| FR-010 | **`frequency`** (`{resource_ref, change_pct ∈ [-60, 100]}`). Scale `per_day.min/max` (round, clamp 0–24, `min ≤ max`, `max ≥ 1`, platform `dailyApiCap`).  **Applied:** the version is active and re-read. **Verified:** the first plan after `applied_at` for that resource is within the new range; otherwise `adherence='violated'`. |
| FR-011 | **`format_shift`** (`{resource_ref?, format, weight_delta ∈ [-0.3, 0.3]}`; `resource_ref` defaults to the Telegram anchor). Clamp 0–1, keep one format above 0. **Verified:** over the next 3 plan days the format's share moved in the delta's direction (positive delta: ≥ 1 slot used it); otherwise `adherence='not_followed'`. |
| FR-012 | **`pause_series`** (`{series, resume_on?: YYYY-MM-DD Kyiv, ≤ 28 days, default 14}`). Set `series.active=false`; housekeeping writes a version with `active=true` on `resume_on`. **Verified:** no `series:<name>` slot planned after `applied_at` (`validateNetworkPlan` already refuses inactive series). |
| FR-013 | **`pause_resource`** (structural; `{resource_ref, days 1–14, default 7, reason}`). Insert a `resource_pauses` row. While a pause is active: <br>• `networkContext` leaves the resource out, and a paused Telegram anchor is not added back; <br>• single-channel `maybePlan` and `maybeOrchestrate` skip the channel; <br>• `EditorScheduler.tick` sets claimed content slots on that resource to `skipped` with `error='resource_paused'`; <br>• `PromoPlanner.schedule` refuses (`resource_paused`), and `ReservedDispatcher` skips promo slots there; <br>• paid ad slots (`SponsoredPublisher`) are **not** skipped (contractual). <br>Auto-lift at `until`; Inbox `resource_paused` / `resource_resumed` (info); `POST /api/resources/:ref/pause/lift` lifts early. **Verified:** no content slot on the resource published or shadowed in the window. |
| FR-014 | **`experiment`** (`{resource_ref, angle 10–300, format?, slots 1–3, within_days 1–7}`). <br>• `NetworkSlotInput` and the single-channel plan input gain an optional `directive_id`. <br>• While the quota is open, `validateNetworkPlan` / `validatePlan` require at least 1 slot per plan day with `directive_id` on that resource, provided it has capacity. These slots are stored with `is_experiment=true` and hint `directive:<id>`. Experiment slots from a directive do not count against `explore_ratio`. <br>• **Applied:** the first such slot is planned. **Verified:** `slots` of them are published or shadowed. At `within_days` with a quota still open → `failed`. |
| FR-015 | **`strategy`** (structural). Run `runPlaybookBuild(card, brief = directive body)`. The resulting `pending_owner` version carries `directive_id`. **Applied** when the owner activates that version. If the owner rejects the version → `rejected`, `owner_decision='declined'`. <br>**`task`**: there is no executor. The new tool `report_directive_done({id, ref_type: idea\|slot\|playbook\|skill, ref_id})` checks that the referenced row exists, belongs to the orchestrator and was created after `delivered_at`. That makes it **applied and verified**. <br>**`repost` / `cross_promo`**: unchanged (`PromoPlanner`). **Verified** when the promo slot is `published` or `shadowed`. <br>**`advice`** (free text): an accepted advice becomes `applied` with `verification={kind:'self_reported'}` and is never evaluated. |
| FR-016 | **Evaluation** (021 FR-007, changed). Only `verified` directives get `worked/no_effect/hurt`. An `applied` directive that is not verified by `review_at` → `inconclusive` with `outcome_detail.reason='not_verified'`, and its `adherence` is copied into the result. |
| FR-017 | **MANAGER inputs.** <br>• The digest gains `compliance` per orchestrator over 30 days: advice followed and declined, the last 3 decline reasons, directives contested and auto-applied. <br>• `list_directives` returns `binding`, `verification` and `adherence`. <br>• Skill `manager-workflow` gets a section "порада чи директива": advice is the default; a directive only on an anomaly or an escalation; structural kinds are always directives. <br>• Skill `editor-orchestrator-workflow` and `orchestratorSystemPrompt` get the 6-layer precedence and the rule "a directive is answered with accept or contest; advice with accept or decline". <br>• Delivered text marks each item `ДИРЕКТИВА (обовʼязково)` or `порада (на твій розсуд)`. |
| FR-018 | **REST.** `GET /api/directives` gains filters `binding=`, `kind=` (csv) and `verified=true\|false`, plus the fields `binding`, `change`, `verification`, `verifiedAt`, `execError` and `contestedAt`. New: `POST …/:id/uphold`, `POST …/:id/accept-refusal`, `GET /api/resources/pauses`, `POST /api/resources/:ref/pause/lift`. |
| FR-019 | **Dashboard.** <br>• `Directives.tsx`: a binding badge (`DIRECTIVE` with the warning tone, `advice` neutral), badges `contested`, `declined`, `failed`, and a verification chip (`applied · checking`, `verified ✓`, `not followed`, `self-reported`). There is a binding filter (All / Directives / Advice) and a kind multi-select on both the @manager board and the orchestrator Inbox tab. "Awaiting you" holds `awaiting_owner` and `contested`; `declined` and `failed` go to the closed column. <br>• A contested card has the buttons **Uphold**, **Accept refusal** and **Discuss** (opens `/app/chat` with `@manager`). <br>• `/app/agents/inbox`: `directive_*` / `resource_*` kinds get "Open directive →" (`/app/agents/manager?tab=directives&d=<id>`), closing the BRD §3.13 `refType='directive'` gap. <br>• Orchestrator Overview: **Active effects** (paused resources/series with end dates and Lift, experiment quota progress, directive-made playbook versions). |
| FR-020 | **Shadow.** Shadow MANAGER directives are never delivered, executed or contested (unchanged). A live directive to an orchestrator in shadow mode **is** executed: its config changes are real but publishing stays shadowed. Verification counts `shadowed` slots. |

## Corner cases
- **Directive vs owner rule.** `accept_directive` is refused (021); the orchestrator must contest with `owner_rule`. If the owner upholds, the executor runs and the card suggests editing the rule.
- **Two playbook directives at once.** Each executor writes on top of the current active version in the playbook transaction; the evaluator already flags overlaps on the same metric.
- **The orchestrator reverts an executor's change** with `submit_playbook` before `review_at` → refused with `directive_lock` and the directive id. Advice changes are not locked.
- **The owner edits the playbook by hand** after a directive: allowed; evaluation gives `inconclusive (owner_override)`.
- **A pause overlaps a paid ad order.** The ad still runs; the pause card says so.
- **Escalation loop.** Advice declined → directive by escalation → contested → owner accepts the refusal: the 48 h cooldown applies and MANAGER memory gets "owner sided with @x on <kind>".
- **Restart between apply and status update.** Executors are idempotent: re-applying is a no-op when the active version already contains `change.after`.

## Non-goals
- Automatic revert of a `hurt` directive. The Inbox card says "hurt" and the owner or the next MANAGER run decides.
- New directive kinds, or directives from orchestrators to the MANAGER.
- Changing how the KPI digest computes metrics, or the 022 promo limits.
- Moving schedule or frequency ownership out of the playbook. If a later spec moves it, only the `frequency` executor's `apply` changes.

## Success criteria
- **Unit tests** (`node:test`): the kind × binding matrix and admission rules; dry-run `not_executable` and structural detection; each contest check (pass/fail); the contested state machine (uphold, accept-refusal, timeout) and auto-apply; each executor's `plan`/`apply`/`verify` incl. the single-channel fallback and idempotent re-apply; pause guards (networkContext, scheduler skip, PromoPlanner, paid ads untouched); the experiment quota in both validators; `directive_lock`; the evaluator's `not_verified` path.
- **PG e2e** (`manager.pg.test.ts`, scripted LLM): binding `format_shift` → accept → playbook version with `directive_id` → planner follows → `verified` → evaluated; advice → `decline_advice` → `declined`, no cooldown, no Inbox; binding `frequency` vs owner rule → `contest_directive` → Inbox → uphold → applied; approved `pause_resource` → slots skipped → auto-lift.
- **Live evals** (`evals/cases/agents.ts`): `orchestrator-directive-comply` (binding format_shift against playbook weights is accepted), `orchestrator-directive-owner-rule-contest` (contested with the right rule id), `orchestrator-advice-decline` (advice contradicting fresh data is declined with a data reason), `manager-advice-vs-directive` (mild trend → advice or nothing; anomaly → directive). Existing manager evals stay green.
- After 14 days live, every `applied` row has an executor `change` and a visible verification state.

## Open questions for the owner
All four were **decided on 2026-10-08**: the owner confirmed the defaults ("take the next scope").
1. **A binding directive the orchestrator ignores for 24 h: auto-apply or escalate?** Decided: auto-apply when there is an executor, plus an info Inbox entry (FR-007).
2. **Contest timeout outcome:** does the agent's refusal stand, or does the directive apply? Decided: the refusal stands after 24 h (`rejected`, `timeout_dropped`), because the higher layers (owner rule, safety) were cited.
3. **Should `repost` stay possible as advice?** Decided: yes. It is non-structural and cheap, and it only affects the anchor.
4. **Can an orchestrator revert directive-made playbook changes before review?** Decided: no for directives (`directive_lock`), yes for advice.

## Implementation notes (T1–T2)
Decisions where the spec left room; T3–T7 build on these.

- **Migration number.** 062–064 were taken, so the migration is `065_directive_binding.sql`. It drops every single-column CHECK on
  `status` / `owner_decision` / `binding` found in `pg_constraint` (053 created them inline, so names are not assumed) and re-adds named
  ones; a second run is a no-op. 063 re-asserts `playbooks_created_by_check` without `'directive'`: harmless for the ledger and for CI's
  re-run on an empty database, but re-running 063 by hand on a database that holds directive-made versions would fail.
- **Matrix and admission order** (`fileDirective`): target → run cap → open duplicate → cooldown → evidence → expected → stale → kind-only
  matrix rules → executor dry-run (`not_executable`) → structural = param rule ∨ dry-run → structural advice refused → admission. Error codes:
  `advice_kind_is_advice`, `structural_must_be_directive`, `directive_needs_anomaly`, `binding_limit` (the spec names no code for the
  "at most 2 open binding directives" rule), `not_executable`.
- **Admission details.** Open binding directives are `new | awaiting_owner | accepted | applied | contested`; the limit also covers
  structural directives. Shadow filings count only shadow rows. The anomaly must be on `expected.metric` in the target scope
  (`expected.resource_ref`, else every resource of the orchestrator), so a directive without `expected` (a `task`) needs an escalation or
  must be advice. Escalation: the latest advice of the same kind to the same target declined in the last 14 days, with the same
  `expected.metric`, whose value (stored at filing in `outcome_detail.at_filing`) has since moved at least 5 % (`ESCALATION_MIN_MOVE_PCT`)
  against `expected.direction`. An owner-approved chat card skips the admission rules (the owner is layer 1) but not the matrix.
- **Dry-run.** Runs for kinds with an executor (frequency, format_shift, pause_series). Validation errors the change *introduces*
  (`validatePlaybook` after minus before) make it `not_executable`; pre-existing playbook errors do not. The classification uses the
  resource's effective mode, so in approval mode a `pause_series` is structural (031: every schedule change goes to the owner). The
  dry-run result is stored in `outcome_detail.dry_run`, and its diff is shown on the owner card.
- **Executors.** `frequency` clamps as FR-010 says instead of refusing above `dailyApiCap`; a scale that changes nothing after rounding is
  `not_executable`. `resource_ref` defaults to the Telegram anchor for both frequency and format_shift. A Telegram format_shift is limited
  to the card's active formats (the same rule an orchestrator's own playbook edit has). A directive cannot pause an owner-locked series
  (`not_executable`). Without an active playbook only the Telegram anchor is editable (its card), and `pause_series` is not executable.
- **Apply.** The planned change is stored in `change` *before* it is applied; a retry or a restart reuses it, and `apply` is a no-op when
  the active version (or card) already holds `change.after`. Accepted rows untouched for 50 min are retried by the hourly housekeeping
  (this also covers a run that died before `afterOrchestration`). On `resume_on` housekeeping writes a version with the series active
  again (same `directive_id`) and stamps `change.resumed_at`; if the series was removed or edited by hand it records `resume_error` and stops.
- **Verify.** The verdict goes to `verification` (`{kind: 'observed', adherence, detail}`); `verified_at` is set only when followed. Rows
  with a verdict are not checked again. frequency and pause_series read the first active plan created after `applied_at`; format_shift
  reads the next 3 plan days (a positive delta is verified as soon as one slot uses the format; a negative one compares the share with the
  3 plan days before, or needs a share of 0 when there are none).
- **Kinds without an executor yet.** `advice` (free text) becomes `applied` with `verification = {kind: 'self_reported'}` (FR-015). Until
  T4/T5 add their executors, `task`, `experiment`, `strategy` and `pause_resource` keep the pre-025 behaviour but say so: `applied` with
  `verification = {kind: 'unverified'}` (`PENDING_EXECUTOR_KINDS` in `manager/executors/index.ts`; T4/T5 remove them from that list).
  `cross_promo` / `repost` stay with PromoPlanner.
- **directive_lock.** Checked in `submitPlaybookVersion`, so it covers `submit_playbook` and the five series tools. A body is a revert when
  it goes back toward `before`; moving further in the directive's direction, or dropping a paused series, is allowed. Only rows with
  `binding = 'directive'`, `status = 'applied'`, `review_at > now` and a playbook change lock; advice and card changes do not. Owner edits
  are never locked.
- **Left for T3+.** `reject_directive` is still registered and the orchestrator prompt still has the 3-layer precedence (T3 replaces them
  with `decline_advice` / `contest_directive` — done, see T3 notes). No dashboard changes (T6). The digest `compliance` block is T5.

## Implementation notes (T3)
- **No migration.** Every status, owner decision and column T3 needs came with 065; Inbox kinds are free text. (068 stays unused.)
- **Tools.** `reject_directive` is gone from the registry. `decline_advice` (advice only → `binding_directive_use_contest`) closes the
  row as `declined` without an Inbox entry; the cooldown query only reads `rejected`, so a declined advice never starts one.
  `contest_directive` accepts the seven reason kinds in its schema so that `playbook` / `data` / `preference` get the spec's
  `directive_is_binding` error instead of a schema error; advice → `advice_use_decline`. A failed FR-006 check → `reason_not_verified`.
  The transition to `contested` is guarded (`status = 'new' AND binding = 'directive'`), so a repeat call gets `not_open` and the card is
  posted once. `accept_directive` now points to contest (directive) or decline (advice) when it refuses an owner-rule conflict; a
  directive about an owner-locked series is contested with `capability` (the executor's plan refuses locked series).
- **Contest checks** (`checkContest`). `owner_rule` reads the orchestrator's channel memory (`created_by = 'owner'`, active) like
  `accept_directive`; an empty `rule_ids` fails. `health`: the scope is the anchor plus every group resource (usable or not), then
  `usable(ref)` must be false. `capability`: the executor's dry-run must fail now; kinds without an executor cannot be checked → not
  verified. `safety`: `verified: 'unverified'`. The result (with `checked_at`) goes to `verification.contest`.
- **Owner decision.** `ManagerRunner.uphold` re-runs the dry-run (capability) and `usable()` on every resource the params name
  (`resource_ref`, `source_ref`, `target_ref`, `to_ref`) → `409 not_executable`, the row stays `contested`; otherwise `accepted` +
  `owner_decision = 'upheld'`, and the executor runs at once (promo kinds wait for PromoPlanner after the next orchestrator run).
  `acceptRefusal` → `rejected` + `refusal_accepted` (the 48 h cooldown follows from `rejected`) and a MANAGER memory insight "owner sided
  with @x on <kind>". Repeats → `409 not_contested`; unknown id → 404. Contest timeout: `DIRECTIVE_CONTEST_TIMEOUT_HOURS` (24) from
  `contested_at` → `rejected` + `timeout_dropped`; the contest reason stays in `resolution`.
- **Non-response** (`resolveUnanswered`, hourly, replaces `expireUnresolved`). Same window as before (delivered 24 h ago, or never
  delivered for 48 h). Advice → `expired` silently. A binding directive whose target is off or paused, or that was never delivered →
  `expired` + `directive_expired` (info). One with an executor (or a promo kind) → `accepted` with `resolution = 'auto-applied: no
  response'`, executed at once (promo: scheduled after the next run) + `directive_auto_applied` (info). Kinds without one (`task`, and
  `pause_resource` until T4) → `expired` + `directive_ignored` (action). Shadow rows still expire silently.
- **Precedence.** `PRECEDENCE_LINES` in `network-prompts.ts` (the 6 layers and "a directive: accept or contest; advice: accept or
  decline") replace the 3-layer line in `orchestratorSystemPrompt`; the daily prompt and the `editor-orchestrator-workflow` skill say the same.

## Implementation notes (T5)
- **No migration.** The quota lives in the directive's `change` (`op: 'experiment'`, `channel_key`, `resource_ref`, `angle`, `format`,
  `slots`, `within_days`, `deadline`); its slots are found by the hint `directive:<id>` (the same hint PromoPlanner writes).
- **Interfaces.** `DirectiveExecutor<C>` is generic; `AnyChange = Change | ExperimentChange | StrategyChange`. `Applied` gains `pending`
  (the directive stays `accepted` with its change; hourly re-check through the idle retry, no attempt counted) and `ownerRejected`.
  `DirectiveExecution` takes `verifiers` (verify-only kinds) and `quotas`. `PENDING_EXECUTOR_KINDS` is now `['pause_resource']` (T4).
- **experiment** (FR-014). `plan()`: `angle` 10–300, `slots` 1–3 (default 1), `within_days` 1–7 (default 3), `resource_ref` defaults to
  the Telegram anchor and must be in the usable network; a non-anchor resource needs an independent network with a playbook (only that
  planner plans it); `format` must be implemented on the platform (it need not be in the playbook — that is the experiment; the slot
  carrying the directive id may use it); the resource needs `per_day.max ≥ 1`. The deadline is acceptance + `within_days`. `apply()` is
  `pending` until a slot with the hint is planned, then `applied`. `verify()`: `slots` slots `published`/`shadowed` → verified; 24 h after
  the deadline without that → `not_followed`. `closeQuotas()` (hourly): deadline passed with fewer than `slots` planned → `failed` +
  `directive_failed` (works from `accepted` and `applied`).
- **Quota rule** (`experiment-quota.ts`, shared by `validatePlan` and `validateNetworkPlan`). Open quota = an accepted/applied experiment
  of this anchor before its deadline with slots left; the count leaves out the replaceable slots of the plan day being submitted (a
  re-plan must include the slot again). Every open quota whose resource has room that day (per_day.max above the reserved slots and a
  non-quiet hour still ahead) needs ≥ 1 slot with its `directive_id`, and no more than it has left; an unknown id, the wrong resource or
  format is an error. The error names the directive in Ukrainian. Directive slots are stored with `is_experiment = true` and
  `directive:<id>` first in the hints, do not count against `explore_ratio`, and need no `idea_id` / `series` in a network plan (they
  must be `unique`). A single-channel plan only carries quotas on its own channel. Both planner prompts list the open quotas.
- **strategy** (FR-015). `plan()` takes the brief from `params.brief` or the directive body (≥ 10 chars). `apply()` runs the build once
  through `PlaybookBuildPort` (bound in the module to `NetworkRunner.runPlaybookBuild(card, brief, {directiveId})`; the MANAGER is built
  before the runner). `submitPlaybookVersion` forces `pending_owner` and stores `directive_id` when the run carries `directiveId`. The
  version's state decides: pending → `pending`; active (or `change.activated_at`) → applied, and verified on the next hourly pass;
  rejected → the directive is `rejected` with `owner_decision = 'declined'`; superseded before a decision → an executor error (retried,
  then `failed`). `NetworkService.decide` calls `DirectiveExecution.onPlaybookDecided`, so the owner's click settles it at once.
- **task** (FR-015). `execute()` leaves it alone (it is no longer marked unverified-applied) and the executor queries skip it.
  `report_directive_done({id, ref_type, ref_id})` works from `new` or `accepted`; `taskRefCheck` compares in SQL: the idea / playbook /
  skill belongs to the orchestrator (`agent_id`), the slot to its anchor channel, and was created after `delivered_at` (a skill: created
  or changed after it — skill edits keep their id). Then `applied` with `verification = {kind: 'reported', adherence: 'followed', ref_*}`
  and `verified_at`. An accepted task without a report by `review_at` → `expired` (+ `directive_ignored`, action, for directives).
- **Promo** (FR-015). `promoVerifier` reads `editor_slots.promo->>'directive_id'`: published/shadowed → verified; all skipped/failed →
  `not_followed`; no slot that ran within 9 days of `applied_at` → `not_followed`. PromoPlanner itself is unchanged.
- **Evaluation** (FR-016). Self-reported advice is closed at its review date with `outcome` left empty and `outcome_detail.reason =
  'self_reported'` (never scored). An unverified row → `inconclusive` with `reason: 'not_verified'`, its `adherence` and verification kind
  copied; no MANAGER lesson. An experiment is not judged before its deadline unless verified.
- **Digest** (FR-017). `compliance` (30 days, per orchestrator, shadow rows excluded): `advice_followed` (advice accepted/applied/
  evaluated), `advice_declined`, `decline_reasons` (last 3: kind + reason), `contested` (`contested_at` set), `auto_applied` (resolution
  `auto-applied:`). It is not part of the digest hash (the manager's skip rule stays on KPIs and open directives).

## Implementation notes (T4)
`pause_resource` pauses for real. No migration: `resource_pauses` from 065 is enough. Status for this task: BUILDING (T4 done).

- **Service.** `editor/pauses/resource-pauses.ts` → `ResourcePauseService`. A pause is active while `lifted_at IS NULL AND
  starts_at <= now < until`, so it ends exactly at `until` even before anything stamps it. Every scheduler tick runs `liftDue`, which
  stamps the pause `lifted_at = until`, `lifted_by = 'schedule'` and posts `resource_resumed`. That runs once per pause. `pause()` is
  idempotent per directive: the directive's own row is returned as a no-op, even after a lift, so a retry never pauses again. Another
  active pause on the same resource returns `already_paused`. A run-out row that was never stamped is closed first, so the unique
  index never blocks a new pause.
- **Executor** (`manager/executors/pause-resource.ts`, registered next to the playbook executors; removed from
  `PENDING_EXECUTOR_KINDS`). Params are `{resource_ref (required), days 1–14 (integer, default 7), reason (≥ 5 chars)}`. `plan` refuses
  (`not_executable`) a resource outside the orchestrator's network (or unusable now) and a resource that is already paused. To check the
  second case, `ExecContext.pauses` is filled by `executionContextOf({ pauses })`; the exec context itself is *not* pause-filtered. The
  change is `{op: 'pause_resource', target: 'resource', resource_ref, days, until, reason}`, always structural. `until` is computed
  when the directive is accepted and executed, not when it is filed. `apply` writes the row and posts the Inbox `resource_paused`
  entry, with a note about reserved/ad slots still due in the window. Re-applying is a no-op. A pause held by someone else fails the
  attempt (retry path → `failed`). `verify` reports `violated` at once if any content or promo slot on the resource is
  published/shadowed with `scheduled_at` in the window. Otherwise it stays `pending` until the pause ends (owner lift or `until`), then
  reports `followed`.
- **Guards.**
  - `networkContext` takes `paused?(ref)`. Only agent runs pass it: `NetworkRunner` (orchestrator, network planner, single-channel
    planner extras) and the repurpose tool's network. Owner surfaces (`NetworkService` view and playbook edit, schedule REST,
    migration, chat) do not, so the owner can still edit a paused resource's playbook section.
  - Scheduler: `pauses: {liftDue, pausedRefs, held}`. `held` is `channelHeldBy`: a single channel or a `legacy_duplicate` group whose
    Telegram anchor is paused. An independent network is held only when every resource is paused; otherwise the orchestrator and the
    network planner keep running without the paused resource. A held channel skips `maybeOrchestrate`, `maybePlan` and the approval
    `maybePlanAhead`. The MANAGER's event wake-up (`orchestratorsToWake`) checks the same thing. Claimed content slots on a paused
    resource, including approval write-ahead claims, become `skipped` with `error='resource_paused'`, so no held or awaiting-approval
    post is produced.
  - `ApprovalPublisher` skips an approved post on a paused resource (`resource_paused`, platform post canceled).
  - `PromoExecutor.writeAhead` leaves paused promo slots planned. `ReservedDispatcher` skips due promo slots on a paused resource.
    Paid ads and the owner's scheduled chat posts go out unchanged.
  - `PromoPlanner` refuses `resource_paused` when either the source or the target is paused.
  - `EditorCrossPoster.pausedPlatforms`: the legacy auto-duplication sends no copy to a platform whose paused resource mirrors the
    channel (a group member or a crosspost target). The filter works per platform, because the mirror callbacks only know the
    platform.
- **Owner pins.** The owner's pinned slots on a paused resource are content slots, so they are skipped too, as the acceptance
  criterion says: nothing on the resource is published. The `resource_paused` card tells the owner that lifting the pause brings them
  back.
- **REST** (`pauses/resource-pauses.controller.ts`, its own controller so it does not touch `ManagerController`):
  - `GET /api/resources/pauses?active=true|false&limit=` returns `{pauses: [{id, resourceRef, agentId, agentHandle, directiveId,
    reason, startsAt, until, liftedAt, liftedBy, createdAt, active}]}`, active pauses first.
  - `POST /api/resources/:ref/pause/lift` (ref URL-encoded, e.g. `telegram%3A%40space`) returns `{pause}`. Errors: `400 invalid_ref`;
    `409 not_paused` when the resource has no active pause (one that has already run out counts).
  - Inbox entries carry `refType='directive'` (refId = directive id) when the pause came from a directive, else `refType='resource'`.
- **Left for others.**
  - T3 (FR-007 "target paused → expired with an Inbox entry") can call `ResourcePauseService.isPaused(ref)`.
  - T6 builds **Active effects** from `GET /api/resources/pauses?active=true`, with **Lift** wired to the lift endpoint.
  - The orchestrator prompt does not say why a resource left its network. Prompts are owned by T3.

## Task breakdown

### T1: Add binding levels and directive admission rules
**Scope:**
- Migration `065_directive_binding.sql` (FR-001).
- `directive-kinds.ts` matrix; `file_directive` gets `binding` and the admission rules (FR-002, FR-003).
- `binding` in the repository, the REST filters and fields (FR-018 read part), and the delivered prompt text.
- `manager-workflow` skill section "порада чи директива" (FR-017).

**Acceptance:**
- [x] The migration runs twice cleanly; existing `advice` rows are backfilled.
- [x] Unit tests cover every matrix cell and both admission paths.
- [x] `GET /api/directives?binding=advice` filters correctly.

**Size:** M · **Depends on:** 021

### T2: Build the executor framework with playbook executors
**Scope:**
- `manager/executors/` interface, registry and dry-run at filing (FR-004, FR-009).
- `frequency`, `format_shift` and `pause_series` executors, including the single-channel card fallback and auto-resume (FR-010–FR-012).
- Remove `applyAccepted`; add the retry/`failed` path and hourly `verify()`.
- Playbook `created_by='directive'` and `directive_id`; `directive_lock` in `submit_playbook`.

**Acceptance:**
- [x] An accepted `format_shift` creates an active playbook version linked to the directive, and its `change` holds before/after.
- [x] A directive whose plan cannot apply ends `failed` after 3 attempts with an Inbox entry.
- [x] Re-running `apply` is a no-op.

**Size:** L · **Depends on:** T1

### T3: Give orchestrators the response tools and owner escalation
**Scope:**
- `decline_advice`, `contest_directive` with the code checks, and removal of `reject_directive` (FR-005, FR-006).
- `contested` state, `uphold` / `accept-refusal` endpoints and the timeout (FR-008).
- Non-response handling: auto-apply, ignored or expired with Inbox entries (FR-007).
- 6-layer precedence in `orchestratorSystemPrompt` and the `editor-orchestrator-workflow` skill.

**Acceptance:**
- [x] A contest with an unknown rule id → `reason_not_verified`.
- [x] A valid contest creates exactly one `directive_contested` Inbox entry.
- [x] Uphold runs the executor; accept-refusal starts the cooldown; a declined advice does not.

**Size:** L · **Depends on:** T1, T2

### T4: Make `pause_resource` actually pause
**Scope:**
- `ResourcePauseService` over `resource_pauses` (FR-013).
- Guards in `networkContext`, single-channel planning, `EditorScheduler.tick`, `PromoPlanner` and `ReservedDispatcher`.
- Auto-lift, the lift endpoint, `GET /api/resources/pauses`, and the Inbox entries.

**Acceptance:**
- [x] With an active pause, no content or promo slot on the resource is published or shadowed, and paid ad slots still publish.
- [x] The pause lifts at `until` and the resource returns to planning the next day.

**Size:** M · **Depends on:** T2

### T5: Add experiment, strategy and task executors, and make evaluation verification-aware
**Scope:**
- `directive_id` in the plan inputs and the quota rule in both validators (FR-014).
- `strategy` → playbook build linked to the directive; `report_directive_done` for `task` (FR-015).
- Promo verification on publish or shadow; evaluator `not_verified` and adherence (FR-016).
- Digest `compliance` block (FR-017).

**Acceptance:**
- [x] A plan without the required experiment slot is refused with a Ukrainian error naming the directive.
- [x] An unverified applied directive is evaluated `inconclusive (not_verified)`.

**Size:** M · **Depends on:** T2

### T6: Show binding and verification in the dashboard
**Scope:**
- Badges, the binding and kind filters, and the column changes in `Directives.tsx` (FR-019).
- Contested card actions and the Discuss link.
- Inbox "Open directive →" links for `directive_*` and `resource_*` kinds.
- Orchestrator Overview **Active effects** with the Lift button.

**Acceptance:**
- [ ] `tsc` and the build are green.
- [ ] A contested directive can be upheld from the board and from the Inbox link target.
- [ ] Filters persist in the URL search params.

**Size:** M · **Depends on:** T1, T3, T4

### T7: Add evals and the PG end-to-end tests
**Scope:**
- The four live eval cases from Success criteria, registered in `run-evals.ts`.
- The PG e2e flows in `manager.pg.test.ts`.

**Acceptance:**
- [ ] The new evals pass 3 runs out of 3 on the default model.
- [ ] `pnpm --filter automation test` is green.

**Size:** S · **Depends on:** T3, T4, T5
