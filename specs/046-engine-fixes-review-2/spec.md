# 046 Engine fixes from review 2

**Epic:** AI0-178 · **Priority:** P0 · **Depends on:** 040, 042, 045 · **Source:** [agent review 2](../../docs/reviews/2026-10-17-agent-review-2.md) §2–§4, §7

## Why

Review 2 (dev stage, 2026-10-15 → 10-17) found the engine paying for work that buys nothing and the manager working half-blind:

- After the switch to the Anthropic workspace a published post cost about $1.21, against about $0.06 on GLM. The Opus manager spent a third of the money and filed nothing in its last 4 runs. 43% of slot spend bought no post.
- `get_kpi_digest` failed 8/8: the render sliced the JSON at 20k characters. The prompt digest lost every section after `resources`.
- The `submit_review` gate cost two extra Opus turns per run, on resources the manager could not even see.
- An accepted task blocked new directives. Advice counted as "applied" on the orchestrator's word. A directive patch ignored the pending owner draft.
- Budget-stopped slots failed for good, even after the owner raised the cap.

## Owner decision (2026-10-17)

«почни з 046 і бюджет $3 на день»: the agents' production spend (`editor.*` without owner chats) targets **$3/day**.

Every change here serves that target:

- per-role models in the Anthropic workspace;
- a writer reserve in the agents' cap;
- a headroom check before a slot run;
- fewer manager runs;
- a shorter rewrite chain.

The cap itself stays the owner's llm_budgets row (Settings → Budgets). On the dev stage the owner sets it to $3 after deploy.

## Requirements

### FR-001 Digest is always valid JSON (T1, AI0-182)

- `digestView(d, limit)` renders the digest under `limit` and never cuts a string.
- The head comes before `resources`, in this order: budget, config_conflicts, directives, agents, compliance.
- Slimming steps, each applied only if the previous one is still over `limit`:
  1. Quiet resources lose their samples.
  2. Flagged resources keep one short sample.
  3. Quiet resources become stubs.
  4. Flagged blocks lose their long parts, and head texts are shortened.
  5. Quality shrinks to flags and numbers; quiet resources become a `quiet: [refs]` list.
  6. The least anomalous resources are left out (`resources_omitted` plus a hint).
  7. The head keeps ids only.
- The result also returns the set of resources whose quality block is visible (`detailed`).
- `get_kpi_digest({resource?})` returns the parsed digest, or one resource in full with its open directives.

### FR-002 Review gate asks only for what the manager can see (T2, AI0-183)

- `requiredQualityRefs(dg)` lists the resources that need a quality check. A resource qualifies when all of these hold:
  - it has an agent;
  - it has activity;
  - it is not young, meaning it has 5 or more posts in the window or has a flag;
  - its block is in `detailed`.
- The manager prompt lists these refs.
- An agentless resource is never held to its flags.
- `checkQualityReview` returns every problem at once (`problems[]`). `error` is the first problem's code.

### FR-003 Directive lifecycle (T3, AI0-184)

- `accepted` no longer blocks a new directive of the same kind. Like `applied`, it is replaceable through `supersedes` and is then closed as `superseded`.
- The `directive_open` error names the remedy (wait for the orchestrator or the owner) and warns against switching kind to get around it.
- A directive's playbook patch is also applied in place to the pending owner draft. Approving the draft later keeps the change.
- Advice is verified, not taken on trust. `adviceVerifier` marks it `followed` when the orchestrator wrote a playbook version after the advice was filed. Otherwise it is `not_followed` after 48 hours.
- Planners (network and single-channel) get a "Чинні поради й директиви менеджера" block: the accepted or applied items with the orchestrator's plan.

### FR-004 Manager schedule and cost (T4, AI0-185)

- Due keys are stored in the DB, so a restart never re-runs the same due time.
- The KPI baseline counts only days since the resource's first post, never pre-launch days.
- The review signature uses anomalies and uncovered flags, not per-post quality noise.
- Default schedule: one run a day plus one forced run when the signature changes.
- The manager yields to the writer reserve (FR-005).

### FR-005 Budget reserve and slot retry (T5, AI0-186)

- The manager, orchestrators, idea reviewers and weekly reviewers stop at 60% of the agents' cap (`EDITOR_WRITER_RESERVE_PCT`, default 40). The writer, critic and planner may use all of it.
- A slot or ladder step starts only when a whole run fits (`EDITOR_RUN_HEADROOM_USD`, default $0.15).
- A slot the budget cannot afford goes back to `planned` with `retry_at` +1 hour and its attempt returned. It is skipped with the budget reason after 6 hours late or in quiet hours.
- The digest budget block shows the 7-day spend per post that went out.

### FR-006 Rewrite chain (T6, AI0-187)

- At most 3 critic passes per slot across the whole ladder.
- No evergreen fallback on live (news) slots.
- A critic-rejected sole source kills its idea.
- The slot's fallback trace shows attempts and their cost.

### FR-007 Ideas pipeline (T7, AI0-188)

- An orchestrator adds about slots + 1 ideas per run.
- No idle wake-ups.
- A second review batch runs when the backlog is over 15.
- A factual news idea needs 2 sources.
- The orchestrator's `schedule.times` is honoured or removed from its UI.

### FR-008 Tool hints (T8, AI0-189)

- SQL `42703` returns the table's real columns.
- `query_data` lists its valid fields.
- The "title/body" wording is removed.
- `get_playbook(handle)` is read-only for the manager.

### FR-009 Loop details (T9, AI0-190)

- A feed host is blocked per misuse, not per host.
- Oversized feeds are remembered.
- The onboarder accepts JSON-string args.
- The sweeper sums step costs.
- Stale playbook platforms no longer block `update_series`.
- `hashtags_disabled` is renamed to `hashtag_while_off`.
- `number_not_in_sources` stops flagging thousands separators and ranges.

### FR-010 Models per role (T10, AI0-191)

- Without the owner's default, the Anthropic workspace picks a built-in model per role (`ANTHROPIC_ROLE_MODELS`):
  - Sonnet for the writer, critic, manager, weekly reviewer, chats, builder and onboarder;
  - Haiku for the planner, orchestrator and idea reviewer.
- The owner's default still wins for every role.
- The Models page shows the per-role defaults, and the switch dialog warns about the cost.

## Estimate at the review-2 volume (≈ 7 posts/day)

| Role | Before (10-17) | After |
|---|---|---|
| executor (Sonnet) | $2.04 | ≈ $1.2: shorter ladder, no evergreen on news |
| checker | $1.18 (Opus) | ≈ $0.45 (Sonnet, ≤ 3 passes per slot) |
| manager | $1.67 (Opus) | ≈ $0.3 (Sonnet, 1–2 runs, skip, reserve) |
| orchestrator, ideas, planner | ≈ $1.6 | ≈ $0.15 (Haiku) |
| **total** | **≈ $6.5** | **≈ $2.1–2.6** under a $3 cap |

## Owner actions after deploy

These are data changes, so the owner makes them in the UI:

- **Models:**
  - remove the Opus agent models of @manager and the 3 weekly reviewers;
  - clear the Anthropic critic model, so the built-in Sonnet applies;
  - leave the Anthropic default empty, so per-role models apply.
- **Budgets:** set the agents cap to $3.

## Out of scope

- Content quality: the language gate and risk-routed critic belong to 041.
- Owner chat: 047.
- Artifacts: 048.
