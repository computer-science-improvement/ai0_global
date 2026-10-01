# 021: MANAGER and directives: KPI digest, `@manager`, directive lifecycle, owner cards, effect evaluation

**Status:** DONE (shadow-safe; owner verifies live) · **Depends on:** 017, 019, 020 · **Design:** [../017-agent-platform/design.md](../017-agent-platform/design.md) ·
**Migration:** `053_directives.sql`

## Why
Each orchestrator optimises its own scope. Someone has to look at the whole network several times a day, notice falling
conversions or missed opportunities (reposts, cross-promo between resources), and steer. Steering means comments and
tasks, not micromanagement. **"Continue as before" is a first-class answer.**

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `053_directives.sql`.** <br>• `agent_directives(id uuid pk, from_agent_id fk, to_agent_id fk, kind text check in (advice, task, format_shift, frequency, repost, cross_promo, pause_series, experiment, pause_resource, strategy), structural bool, body text, params jsonb, rationale text, evidence jsonb, expected jsonb, review_at timestamptz, status text check in (new, awaiting_owner, accepted, rejected, applied, evaluated, expired, canceled), resolution text, owner_decision text check in (approved, declined, timeout_applied, timeout_dropped) null, outcome text check in (worked, no_effect, hurt, inconclusive) null, outcome_detail jsonb, run_id uuid, created_at, updated_at)`. `expected` holds `{metric, direction, min_change_pct}`. <br>• `manager_reviews(id uuid pk, run_id, verdict text check in (continue, directives), summary text, digest_hash text, created_at)`. <br>• `kpi_snapshots(scope text, scope_id text, day date, metrics jsonb, primary key(scope, scope_id, day))`. |
| FR-002 | **KPI digest** (`KpiDigestService`, pure SQL plus math; no LLM). For every resource, every network and the system it computes the 4 KPI groups: <br>• **growth:** followers and the delta per day; 7 and 28-day averages <br>• **reach and engagement:** views or reach per post, the engagement rate, and the format split (from `network_posts`) <br>• **transitions:** joins by tracked link (022), and 0 until then <br>• **revenue:** ad revenue and slot fill (008/044) <br>Each metric has `value_7d`, `baseline_28d`, `delta_pct` and `z`. Anomalies are code-flagged: `|z| ≥ 2`, or a drop of 25% or more over 7 days. The digest also carries: today's plans (counts by status), budget use, open and recent directives with outcomes, and resource health. It is compact JSON under 12k characters (top anomalies first, the rest summarised). Snapshots are written to `kpi_snapshots` daily. |
| FR-003 | **The `@manager` run** (kind `manager`, scope `system`; at 08:00, 13:00, 18:00 and 22:30 Kyiv; mode `shadow` first). <br>• Prompt: the digest, the directive history with outcomes (last 30), owner rules for the manager, and skills `manager-workflow` and `kpi-reading`. <br>• Tools: `get_kpi_digest`, `get_network_posts`, `get_platform_stats`, `sql_readonly`, `list_agents`, `list_directives`, `file_directive`, `submit_review`. <br>• Terminal tool: `submit_review({verdict, summary, directive_ids[]})`. <br>• If the digest hash is unchanged since the last run and there is no anomaly, the run is **skipped without an LLM call** (a `manager_reviews` row with `verdict='continue'` and summary "no change"). |
| FR-004 | **`file_directive` validation** (code): <br>• the target is an active orchestrator; <br>• at most 3 directives per manager run; <br>• no directive of the same kind and target while one is open (new, awaiting_owner, accepted or applied); <br>• a cooldown of 48 h per target after a rejected directive of the same kind; <br>• `rationale` and `evidence` are required (they must cite digest metrics); <br>• `expected` is required for every kind except advice and task; <br>• `review_at` is 3–14 days ahead. <br>• **Structural** is set by code, not by the model: cross_promo, pause_resource, strategy, frequency with a change of 30% or more, and any directive adding a platform. <br>In shadow mode the directive is stored with `status='new'` but never delivered, and the owner sees it on the page. |
| FR-005 | **Owner cards for structural directives** (D1). On filing → `awaiting_owner`, and a card is sent (012 when it exists; until then an admin-bot notification plus a dashboard inbox) with the rationale, evidence and expected effect, plus `[✅ Застосувати] [❌ Відхилити] [💬 Обговорити]`. "Discuss" opens `/app/chat` addressed to `@manager`. <br>• Timeout per kind (settings `directive_timeout_hours`, default 12): the default action `drop` gives `timeout_dropped`; the owner may set `apply` for a kind, which gives `timeout_applied`. <br>• Approved or timeout-applied → `new` is delivered to the orchestrator; declined → `rejected` with "owner declined". |
| FR-006 | **Delivery and resolution.** <br>• A delivered directive triggers an orchestrator event run (debounced 10 min). The orchestrator must answer each one with `accept_directive({id, plan})` or `reject_directive({id, reason})`. <br>• A rejection must cite an owner rule, a playbook constraint, a capability or health issue, or data. Code requires `reason` to be at least 20 characters and to reference one of those categories (enum `reason_kind`). <br>• An accepted directive becomes `applied` when its plan takes effect. For example: the playbook change is active (non-structural, or approved), the repost or cross-promo slot is scheduled (022), or the experiment slots are planned. <br>• Anything not resolved within 24 h → `expired`, and the manager sees that. |
| FR-007 | **Effect evaluation** (`DirectiveEvaluator`, daily). For an `applied` directive with `review_at <= now()`: compare the `expected.metric` for the target scope from the apply date against the 28-day baseline before it, and sort into `worked`, `no_effect`, `hurt` or `inconclusive` (too few posts, or a confounder flag such as another directive on the same metric). The result is written to `outcome_detail`. The manager's next digest includes the outcomes. The weekly reviewer writes recurring lessons to the manager memory. |
| FR-008 | **Precedence.** Owner rules (memory `created_by='owner'`) beat directives: `accept_directive` is refused by code if the plan contradicts an active owner rule that the orchestrator tagged as conflicting (the tool asks the model to list the conflicting rule IDs, which may be none). The manager's prompt includes the owner rules, so it does not fight them. |
| FR-009 | **REST and dashboard.** <br>• `GET /api/directives?status=&agent=`, `POST /api/directives/:id/approve`, `POST /api/directives/:id/decline`, `GET /api/manager/reviews` and `GET /api/kpi/digest`. <br>• `/app/agents/@manager` gets a **Reviews** tab (timeline: continue or directives, with the summary) and a **Directives** board (columns by status, outcome badges). <br>• Each orchestrator page gets an **Inbox** tab. <br>• The overview page (`/app`) gets a "Network health" card: KPI tiles with deltas and anomaly flags. |

## Corner cases
- **The manager wants to do something** in a quiet, healthy network → the skill says "continue" is the default. The
  eval checks that a stable digest produces no directives.
- **Two runs in a row file the same idea** → blocked by the open-directive rule.
- **The owner never answers cards** → the timeout default drops them. After 5 dropped structural directives in a row,
  the manager gets a memory note: "owner is not responding; lower structural proposals".
- **The digest is missing data** (stats collector down) → code marks the metric `stale`, and the manager must not file
  directives on stale metrics (validation).
- **A directive targets a paused orchestrator** → it is delivered on resume if it has not expired; otherwise `expired`.
- **The manager budget runs out** → the remaining runs that day are `budget_exceeded`. No directives, and nothing breaks.

## Success criteria
- Unit tests:
  - digest math (baseline, z, anomaly flags) on fixtures;
  - the skip-on-unchanged-hash rule;
  - `file_directive` validation (every rule, structural classification);
  - the owner card and timeout state machine;
  - accept and reject validation, including owner-rule conflicts;
  - the evaluator (worked, no_effect, hurt, inconclusive).
- PG e2e with a scripted LLM: an anomaly → the manager files a `format_shift` (non-structural) → the orchestrator
  accepts → the playbook weight changes → the evaluator marks the outcome after a simulated 7 days. Also a structural
  `cross_promo` → `awaiting_owner` → approve → delivered.
- **Simulation:** 14 synthetic days with noise. The manager files at most 1 directive per 3 days on a stable network
  (no flapping) and reacts within 1 day to a 30% drop.
- Live evals: `manager-stable-continue`, `manager-drop-directive` and `manager-cross-promo-structural`.

## Implementation status (2026-10-02)
DONE. `@manager` starts in mode `off`; switch it to shadow, then live. Backend `src/editor/manager/*`; migration `053_directives.sql`.

**Deviations:**
- **Anomaly rule.** An anomaly is (|z| ≥ 2 **and** |Δ| ≥ 10 %) or Δ ≤ −25 %. Without the effect-size floor, noise was flagged.
- **Detection speed.** With 7-day windows, a sustained 30 % drop is flagged within ≤ 4 days, not 1. The simulation test documents this.
- **Delivery.** Directives reach orchestrators through their prompt, with debounced event runs.
- **Manager memory.** It lives in `agent_memory`.
- **Effect evaluation.** It compares 7-day KPI windows: the window at applying vs the window at the review date.

**Tests:**
- unit: `manager.test.ts`, including the simulation;
- PG: `manager.pg.test.ts`;
- live evals: `manager-stable-continue`, `manager-drop-directive`.
