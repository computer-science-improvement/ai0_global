# 020: Playbook, series, idea pool, idea reviewer, network day planner

**Status:** SPEC · **Depends on:** 017, 019 · **Design:** [../017-agent-platform/design.md](../017-agent-platform/design.md) ·
**Migration:** `052_playbooks_ideas.sql`

## Why
An orchestrator must decide what goes where on its own:
- from the owner's brief, it builds a **playbook**;
- it keeps a reviewed **pool of ideas**;
- it plans the day across all the platforms of its network, with native variants per platform.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `052_playbooks_ideas.sql`.** <br>• `meta_account_groups.mode text check in (mirror, orchestrated) default 'mirror'` <br>• `playbooks(id uuid pk, agent_id fk, version int, status text check in (draft, pending_owner, active, superseded, rejected), brief text, body jsonb, review jsonb, rationale text, created_by text check in (orchestrator, owner), created_at, decided_at, unique(agent_id, version))` <br>• `content_ideas(id uuid pk, agent_id fk, title text, angle text, sources jsonb, variants jsonb, why text, evidence jsonb, origin text check in (orchestrator, series, directive, owner, trend), origin_ref text, expires_at, status text check in (new, accepted, needs_revision, rejected, planned, used, expired), review jsonb, reviewed_by uuid, created_at, updated_at)`. `variants` holds `[{resource_ref, format, note}]`. <br>• `network_plans(id uuid pk, agent_id fk, plan_date date, status check in (active, superseded), rationale, run_id, created_at)`, with a unique active plan per `(agent_id, plan_date)`. <br>• `editor_slots` gets `resource_ref text null`, `idea_id uuid null`, `network_plan_id uuid null` and `platform_spec jsonb null`. Telegram slots keep `channel_key`; for non-Telegram slots `channel_key` = the network's Telegram channel or the ResourceRef, so the existing indexes stay valid. |
| FR-002 | **Playbook body** (zod `Playbook`). <br>• `platforms[]`, one per resource: <br>&nbsp;&nbsp;– `resource_ref` and `role` (core, discovery, funnel_to:<ref>, community, archive) <br>&nbsp;&nbsp;– `formats` with weights (keys from the 019 matrix only) <br>&nbsp;&nbsp;– `per_day {min, max}` and `best_hours[]` <br>&nbsp;&nbsp;– `tone`, `hashtag_policy {vocab[], min, max}` and `link_policy` <br>&nbsp;&nbsp;– `cta` (for example "підпишись на TG") <br>• `series[]`: `name`, `cadence` (cron-like: `weekly:sun@10`, `daily@19`), `resource_ref`, `format`, `brief` and `active`. <br>• `pillars[]`: topic pillars with share percentages. <br>• `rules[]`: free-text owner rules carried from the brief. <br>Code validates it: formats are implemented on that platform, per_day respects matrix caps, hours are in 0–23, `funnel_to` points to a resource in the same network, and the pillar shares sum to 100 ± 5. |
| FR-003 | **Brief → playbook** (orchestrator run `build_playbook`, triggered by `set_brief` (018), on agent creation, or by the owner's "rebuild"). <br>• The orchestrator reads the brief, the resource profiles and 28 days of stats per resource. It submits `submit_playbook({body, rationale})`. <br>• The idea reviewer (FR-006) reviews it, with the verdict and comments stored in `review`. <br>• **The first version and every structural change** → `pending_owner`, plus a card (diff against the active version, `[✅ Затвердити] [❌ Відхилити]`). <br>• **A non-structural change** (format weights within ±0.3, best hours, hashtag vocab, a series pause) → `active` immediately, with a notification. <br>• Without a brief, the orchestrator proposes a playbook from stats with `rationale` and it always goes to the owner. |
| FR-004 | **Orchestrator daily run** (06:30, `orchestrate`). The orchestrator: <br>• (a) reads its inbox: new directives (021) and owner rules (018); <br>• (b) resolves each directive with `accept_directive({id, plan})` or `reject_directive({id, reason})` (stub tools until 021); <br>• (c) expires stale ideas; <br>• (d) generates new ideas with `add_idea` until the pool holds enough for 2 days of the playbook's `per_day.max` across platforms, from live sources (009 tools), the library, series instances, stats ("what worked") and trends; <br>• (e) finishes with `finish_orchestration({summary})`. <br>Budget: the agent's. Max 30 steps. |
| FR-005 | **`add_idea` validation** (code): <br>• title 5–140 characters; <br>• at least one variant, and each variant's `resource_ref` belongs to the scope and its format is implemented and allowed by the playbook; <br>• `sources` are required unless the origin is series or owner; <br>• dedup against open ideas and 14 days of `network_posts` by title-and-angle trigram similarity (0.6 or more → error with the closest match); <br>• `expires_at` is at most 7 days ahead. |
| FR-006 | **Idea reviewer** (kind `idea_reviewer`; default model `z-ai/glm-5.3`, reasoning low). It runs after each orchestration, in batches of up to 15 new ideas. Each idea gets `review_idea({id, verdict: accept or revise or reject, scores: {fit, novelty, verifiability, platform_fit, risk}, comment})`. <br>• The scores are 1–5. Code rejects an idea when risk is 2 or less, or verifiability is 2 or less (unless the origin is series or owner). <br>• `revise` goes back to the orchestrator at its next run, at most once; after that it becomes `rejected`. <br>• Rejections with reasons go to the agent's memory as `avoid` patterns when the same reason repeats 3 or more times in 14 days. <br>Skill: `idea-review` (criteria, examples, and the rule to never accept an idea that cannot be verified from its sources). |
| FR-007 | **Network planner** (07:00, kind `planner` under an orchestrated network orchestrator). Inputs: <br>• the active playbook <br>• accepted ideas <br>• series due today <br>• reserved slots on any resource of the network (ads 008, cross-promo 022) <br>• resource health (019) <br>• accepted directives that touch today <br>• yesterday's results <br>It calls `submit_network_plan({slots:[{resource_ref, at, format, idea_id or series, angle, note}], rationale})`. Code validates: <br>• per resource: `per_day` min and max, min gap, quiet hours, the matrix's 24 h cap, health `ok`; <br>• per idea: each variant on a distinct resource, with at least 90 min between variants of one idea across resources, and a Telegram variant first when the playbook role marks Telegram as `core`; <br>• no slot overlaps a reserved slot within the gap. <br>On success: one `network_plans` row and `editor_slots` rows (`resource_ref`, `idea_id`); the ideas become `planned`. Errors are returned as data, as for the 005 planner. |
| FR-008 | **Executors per slot.** <br>• A **Telegram slot** → today's executor with `idea` context (title, angle, sources, note). <br>• A **non-Telegram slot** → the platform executor (019 FR-008), with the playbook platform section and the platform skill inline. <br>On success the idea becomes `used` once all its variants are done or skipped. |
| FR-009 | **Single-resource orchestrators** (a Telegram channel without a network) keep today's planner, executor and reviewer. The playbook still exists (one platform), and the idea pool and idea reviewer apply too. The 005 planner gains `list_ideas` and must reference `idea_id` when it plans from the pool. |
| FR-010 | **Switching a network to `orchestrated`:** an owner action (agent page or `@ai0`, with a card). It requires an active playbook. It starts in shadow mode with every resource in shadow. While shadowed, the old mirror keeps running if it was on. Going live is a separate card per network. |
| FR-011 | **Dashboard.** <br>• **Playbook tab** (017 placeholder): the active version, rendered per platform; history with diffs; a pending card; a "Rebuild from brief" button and the brief editor. <br>• **Ideas tab:** the pool with status filters, scores, the reviewer comment and the variants; owner actions: accept, reject, "plan today". <br>• **Plan tab:** today and tomorrow, a timeline per resource lane, the slot status, and a preview per variant. |

## Corner cases
- **The brief contradicts the platform capabilities** ("Reels every day" before 019b) → the playbook validation errors.
  The orchestrator adapts the playbook (carousels for now) and says so in `rationale`.
- **The idea pool runs empty** (sources down) → the planner falls back to series plus the "evergreen" library formats.
  If the minimum is still not reached, it plans what it can and notifies the owner once.
- **A series instance collides with an ad slot** → the series moves within ±2 h. If that is impossible, it is skipped,
  with a note.
- **The owner edits the playbook by hand** → the owner version becomes `active` immediately (owner precedence), and the
  orchestrator's pending draft is `superseded`.
- **The idea reviewer is down or over budget** → ideas stay `new`, and the planner may use only series, owner and
  library items that day.
- **A resource leaves the network** → its playbook section is dropped at the next build, and its future slots are
  skipped.

## Success criteria
- Unit tests:
  - playbook validation (every rule);
  - structural vs non-structural diff classification;
  - `add_idea` validation, including dedup;
  - reviewer code rules;
  - network plan validation (every constraint);
  - series cadence expansion;
  - the idea status machine.
- PG e2e with a scripted LLM: brief → playbook (pending_owner) → approve → orchestrate (ideas) → review → network plan →
  Telegram and Instagram executors in shadow → ideas `used`.
- Live evals:
  - `playbook-from-brief` (valid, follows the brief);
  - `idea-review-duplicate` (rejects);
  - `idea-review-unverifiable` (rejects);
  - `network-plan-staggered` (variants on distinct resources, Telegram first, valid).
