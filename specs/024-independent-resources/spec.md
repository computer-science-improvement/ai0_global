# 024: Independent resources: per-resource content decisions (duplicate / adapt / unique) and per-resource time zones

**Status:** SPEC · **Depends on:** 019, 020, 021 · **Supersedes/extends:** supersedes the `mirror`/`orchestrated` network modes of 020
(FR-010, BR-AGT-56/57, BR-CON-32…36) and BR-GEN-01; extends 019 (native posts), 020 (planner, playbook), 018 (resource profiles)
and 009 T003 (editor cross-posting) · **Migration:** `061_independent_resources.sql`

**Owner comments addressed:** #1, #6, #8 (plans/brd-comments-2026-10-06.md)

## Why
The BRD describes Meta and TikTok accounts as "mirrors" of a Telegram channel. The owner rejects that model:
- #1: «Це не дзеркала, кожен ресурс окрема одиниця, просто десь контент дублюється, а десь він унікальний».
- #6: «дублювання в інші ресурси (на розсуд агента), або абсолютну інший пост для інших ресурсів - вони у одній групі але
  сам формат і частота публікування буде вирішуватись агентом».
- #8: «часовим поясом можна управляти під різні ресурси він свій, але по дефолту Kyiv».

Today duplication is a code side effect the agent cannot skip or rewrite, and every time is Kyiv. This spec makes each
resource its own unit: per idea, the agent records one decision per resource (duplicate, adapt, unique or skip) with a reason.
Duplication becomes a tool, and every resource gets its own time zone.

## Current state (as-is)
- **Network modes.** `meta_account_groups.mode` is `mirror` (default) or `orchestrated` (migration 052; BR-CON-36, BR-AGT-56/57).
  - In `mirror`, only Telegram is planned, and `EditorCrossPoster` (`editor/publish/editor-crosspost.ts`) fans each live post
    out through `CrossPostService` and `GroupFanOutService`, gated by `editor_channels.crosspost` (046, default `true`).
  - In `orchestrated`, the planner (`network/network-plan.ts`) builds native slots per resource, and `EditorCrossPoster` returns early.
- **Strategy fan-out.** `GroupFanOutService` (`common/content-strategy/group-fanout.service.ts`) is also called by `recipe-carousel`
  and `ai0-prompts` and ignores the group mode, so they keep mirroring even in `orchestrated` groups (BRD 07 §3.3).
- **Planner rules.** `validateNetworkPlan` forces each planned idea onto every resource that has a variant and room
  (BR-AGT-72), requires 90 min between variants, and requires Telegram (`core`) to go first. A variant is always written from scratch by
  the platform executor; there is no "post as-is" and no recorded reason for leaving a resource out.
- **Time zones.**
  - `editor_channels.timezone` exists, but only the anchor card's zone is used: the planner, quiet hours, series cadence
    («Київ» in `playbook.ts`) and best hours all follow it.
  - `resource_profiles` (`agents/resource-profile.ts`) has no time zone.
  - Kyiv is hardcoded in about 20 places (`kpi-digest.service.ts`, `scope-kpi.ts`, `platform-stats.collector.ts`,
    `read-tools.ts`, `agent-prompts.ts`, `budget.service.ts`, …).
  - The Plan timeline uses the browser zone (`AgentPlan.tsx` `getHours()`; BRD 04 §3.9).
  - BR-GEN-01 says every time is Kyiv.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `061_independent_resources.sql`** (additive, idempotent; it rewrites only the mode values). <br>• `meta_account_groups.mode`: drop `meta_account_groups_mode_chk`; `UPDATE … SET mode='independent' WHERE mode='orchestrated'`; `UPDATE … SET mode='legacy_duplicate' WHERE mode='mirror'`; re-add the CHECK as `mode IN ('independent','legacy_duplicate')`; `SET DEFAULT 'independent'`. <br>• `editor_slots` gets: `treatment TEXT NULL CHECK (treatment IN ('unique','duplicate','adapt'))` (NULL = a pre-024 or single-channel slot); `treatment_reason TEXT`; `derived_from_slot_id UUID REFERENCES editor_slots(id) ON DELETE SET NULL`; `source_post JSONB` (non-slot source). <br>• `content_decisions(id uuid pk, agent_id uuid not null, idea_id uuid null, source_key text null, resource_ref text not null, decision text not null check in (unique, duplicate, adapt, skip), reason text not null, reason_code text null, slot_id uuid null, decided_by text not null check in (planner, orchestrator, executor, owner, system), run_id uuid, created_at)`, plus `UNIQUE (idea_id, resource_ref) WHERE idea_id IS NOT NULL` and `UNIQUE (source_key, resource_ref) WHERE idea_id IS NULL`. <br>• SQL function `resource_tz(ref text) RETURNS text STABLE`, in this order: `resource_profiles.profile->>'timezone'`; then `editor_channels.timezone` for `telegram:` refs; then `'Europe/Kyiv'`. <br>• `ALTER TABLE editor_channels ALTER COLUMN crosspost SET DEFAULT false` (existing rows keep their value). <br>• `GRANT SELECT ON content_decisions TO editor_ro`; `GRANT EXECUTE ON FUNCTION resource_tz` to `editor_ro`; record the version in `schema_migrations`. |
| FR-002 | **Network modes.**  `independent`: every member is its own resource, and the orchestrator decides what each one publishes; `legacy_duplicate`: today's mirror behaviour for groups the owner has not converted. `POST /api/agents/:handle/network-mode {mode}` accepts `independent` or `legacy_duplicate`. `orchestrated`/`mirror` are accepted as aliases for one release and logged as deprecated. The `409 no_active_playbook` guard goes away: an `independent` group without an active playbook plans Telegram only, and auto-duplication continues (FR-003). `NetworkCtx.mode` becomes `'single' \| 'independent' \| 'legacy_duplicate'`. |
| FR-003 | **One gate for automatic duplication:** `autoDuplicateActive(groupId)` in `network.repository.ts`. It is **false** only when `mode='independent'` **and** the anchor orchestrator is `live` **and** it has an active playbook; shadow, off, no playbook or `legacy_duplicate` keep it true, so no resource goes silent (020 FR-010). Used by `EditorCrossPoster` (replacing `isOrchestrated`) and, newly, `GroupFanOutService.fanOut` (strategy path); when false, fan-out returns `{status:'skipped', detail:'independent network'}` per target, traced as `GroupFanOut`. A gate change takes effect at the anchor's next plan-day boundary so daily caps are not double-counted. `CrossPostService` targets of an editor channel are used only when `card.crosspost=true` **and** the gate is true. |
| FR-004 | **Per-resource time zone.** `ResourceProfileSchema` gains: <br>• `timezone`: IANA, validated by constructing `Intl.DateTimeFormat` with it; default `Europe/Kyiv`. <br>• `quiet_hours {start: 0–23, end: 0–23}`: optional; default 23→8. <br>For `telegram:` refs, the card's `timezone` and `quiet_start_hour/quiet_end_hour` stay authoritative, and the profile fields are ignored and shown read-only. One resolver, `editor/time/resource-time.ts`: `tzOf(ref)`, `quietOf(ref)`, `localDay(ref, instant)`. It has the same fallback order as SQL `resource_tz()`. `renderProfile` prints `Часовий пояс: <tz> (зараз HH:MM)` when the zone is not Kyiv. |
| FR-005 | **Where the resource time zone applies.** <br>• `submit_network_plan`: a slot's `time` is HH:MM in **that resource's** zone on the plan date. Quiet hours, `best_hours` and `per_day` are counted in the resource's local day. A local time that does not exist (spring DST gap) is an error; an ambiguous one (autumn) resolves to the earlier instant. <br>• Series cadence is in the series resource's zone (`SeriesSchema` describe text: «у часовому поясі ресурсу»). <br>• Per-resource SQL uses `resource_tz(resource_ref)` instead of `'Europe/Kyiv'`: `read-tools.ts` best hours, `platform-tools.ts` stats window, the `platform-stats.collector.ts` day key, the per-resource series in `kpi-digest.service.ts` and `scope-kpi.ts`. <br>• Prompts (`agent-prompts.ts`, `roles/prompts.ts`) show the anchor's "now" plus one line per resource that is not in Kyiv: `instagram:x — America/New_York, зараз 09:12`. <br>• **Stays Kyiv:** the budget day (BR-EDT-06), the MANAGER schedule, network/system KPI aggregates, spend tables, strategy digests, and chat schedule input (`CHAT_TIMEZONE`; an explicit zone suffix is accepted). <br>• **BR-GEN-01 is replaced by:** "Owner-facing times are Kyiv. A resource's own times are in its time zone (default Kyiv), and the UI shows both when they differ." |
| FR-006 | **Content decisions in the network plan.** `NetworkSlotInput` gains: <br>• `treatment` (`unique`\|`duplicate`\|`adapt`, default `unique`); <br>• `from_slot` (1-based index into the same submission; required for duplicate/adapt); <br>• `reason` (10–300 characters; required when `idea_id` is set). <br>`SubmitNetworkPlanInput` gains `skips: [{idea_id, resource_ref, reason (10–300), reason_code? enum(off_topic, audience_mismatch, format_unfit, low_kpi, cadence, other)}]` (≤ 60). <br>`validateNetworkPlan` drops BR-AGT-72's "cover every variant" rule and the "Telegram core first" rule. It now requires: <br>(a) every idea in the plan has **exactly one decision per usable network resource that has a playbook section**: a slot or a skip. Code auto-adds `skip` with `reason_code='cadence'` for a resource already at `per_day.max`. <br>(b) a duplicate or adapt slot points `from_slot` at a `unique` slot of the same idea on another resource, scheduled at the same time or later (the agent picks the gap, including 0). There are no chains. <br>(c) a target format is rejected only when it is **technically impossible** on the target (`capabilities.ts` hard limits, e.g. Instagram without an image, TikTok without media). Any direction is allowed, including native → Telegram. <br>(d) a `unique` slot's format is allowed by the playbook. The idea's variant is a hint, not a requirement. <br>Slots store `treatment`, `treatment_reason`, `derived_from_slot_id`; one `content_decisions` row per (idea, resource), `decided_by='planner'`. Single-channel plans are unchanged. |
| FR-007 | **Executing derived slots** (`network-runner.ts`). <br>• A due derived slot whose source is not yet `published`/`shadowed` is re-checked every tick. If the source is `failed`/`skipped`, the slot is `skipped` with `source_failed`. After the existing 3 h staleness rule it is `skipped` with `source_not_published`. <br>• A derived slot of a **shadowed** source is always shadowed. <br>• **The agent formats every target post itself** (owner decision 2026-10-06: «агент повинен мати змогу сам налаштовувати пости і форматування, а не просто слідувати правилу дзеркала»). There is no code-only mirror path. For each derived slot a short executor run gets the source post, the target's resource profile with its `format_prefs` (FR-013), the agent's `format_notes` and the platform hard limits, and returns the final `PlatformPostSpec` / `PostSpec`. <br>• **duplicate:** the same content and media; the agent decides the presentation: markup and line breaks, emoji, length cut, hashtags, mentions, CTA and link placement (inline, `LINK_IN_BIO`, first comment, button), media order, cover and crop, alt text, and the post type (single photo, carousel, album, reel/short where the media allow). `duplicateSpec()` (pure, `post/duplicate.ts`) is only the starting draft handed to the agent, never the published result. Expected cost ≈ $0.002–0.003 per target on the default model (`trace.kind='duplicate'`). <br>• **adapt:** the same idea and facts, rewritten natively for the target. <br>• Every result goes through `publishPlatformNow` with every guard (lint, health, 7-day dedup, same-resource similarity, cap). On a lint failure the agent gets the lint codes and fixes its own post once; a second failure → `failed` plus an Inbox note. <br>• **unique:** the current 020 path. <br>• **Media lifetime:** hosted slides (`SlideHostingService`) of a source with pending derived slots are deleted after the last derived slot finishes or after 24 h. |
| FR-008 | **Tool `repurpose_post`** (`network/repurpose-tool.ts`, kind `write`; roles `orchestrator`, `planner`, `executor`). <br>Input: <br>• `source`: exactly one of `slot_id` (uuid), `platform_post_id` (int) or `published_post_id` (int; any origin, including strategy posts); <br>• `targets[1..5]`: `{resource_ref, treatment: duplicate\|adapt, at?: 'HH:MM' (target zone, today) \| delay_min?: 0–1440, format_notes?: string ≤ 500, reason: 10–300}` (`format_notes`: the agent's own formatting instructions for the target run). <br>Code validation: <br>• the source belongs to this network and is published/shadowed within 72 h, or is a planned slot of today's plan (for the executor: its own slot, meaning "after this is published"); <br>• each target is in the network, usable, not the source resource, and has a playbook section; <br>• there is no existing decision for (idea, or `source_key`, × target), otherwise `already_decided`; <br>• the target format is technically possible on the target (hard limits only), otherwise `unsupported_format`; <br>• the target's local-day `per_day.max` and API cap, quiet hours in the target zone, and not before the source. Spacing between posts on one resource is the agent's choice; code enforces only platform API rate limits; <br>• at most 10 calls per orchestrator per anchor day. <br>Creates derived slots in the anchor's active plan for that date (or a minimal plan, rationale `repurpose`) plus `content_decisions` rows; returns `{slots:[{id, resource_ref, scheduled_at}], decisions}`. Same in shadow; not structural (within the playbook). <br>Chat agents (010/018) get it only as a pending action `repurpose` (Apply card). `source_key` = `slot:<id>`, `pp:<id>` or `tg:<id>`. |
| FR-009 | **Strategy fan-out (`recipe-carousel`, `ai0-prompts`).** Strategies call `GroupFanOutService` unchanged: identical behaviour wherever the gate is true; in a gated-off group they no longer mirror, but their posts stay visible (`network_posts`) and are valid `repurpose_post` sources (deleted carousel slides → `source_media_gone`). <br>• The Groups page warning for strategies on members changes to "Strategy <type> publishes into an independent network on its own; retire it (009 T004) or keep the group on auto-duplicate". <br>Strategy retirement itself stays in 009. |
| FR-010 | **Migrating existing mirror groups (owner-approved; structural, Constitution IX).** After 059, a once-per-group housekeeping step (idempotent by `(kind, group_id)`) writes an Inbox item `network_independent_offer` for every `legacy_duplicate` group whose anchor has an orchestrator. Checklist: active playbook, orchestrator mode, strategies on members, auto-duplicate source. Buttons: **Switch to independent** (`POST …/network-mode`) / **Keep auto-duplicate**. Re-offered when a first playbook is approved for a legacy group; `@ai0` gets pending action `set_network_mode`. The confirmation says: "In shadow the agent records decisions as previews and auto-duplication continues; it stops when the agent goes live." The `network_mode` Inbox record stays. |
| FR-011 | **Dashboard.** <br>• **Terminology:** "Mirror" → "Auto-duplicate (legacy)", "Orchestrated" → "Independent" (`AgentPlaybook.tsx`, `NetworkUi.tsx` badges `single \| independent \| auto-duplicate`); `MetaGroupsManager.tsx` intro: "Each member is its own resource; the network's agent decides per post: duplicate, adapt, unique or skip"; Source selector → "Auto-duplicate source", shown only while the gate is true; `CrosspostSection.tsx` option "duplicate" (stored value stays `mirror`); editor card row "Auto-duplicate (legacy)". <br>• **Plan tab:** a treatment badge on each pill (U/D/A); a connector from source to derived slot; the slot detail shows the treatment, reason and source link; a per-idea "Decisions" list with skips and reasons. <br>• **Times:** timeline axis in the network (anchor) zone via `Intl`, not `getHours()`; lane headers show the resource zone and local now; pills show `09:00 America/New_York · 16:00 Київ` when zones differ. <br>• **ResourceProfile editor:** a time zone picker (`Intl.supportedValuesOf('timeZone')` with search; default Europe/Kyiv) and quiet hours; for Telegram it is read-only with a link to the card. <br>• `lib/kyiv-time.ts` is generalised to `lib/zoned-time.ts` (`formatIn(iso, tz)`, `dual(iso, tz)`). <br>• The Ideas card shows the decision matrix once planned. |
| FR-012 | **Skill and prompts.** New builtin skill `resource-decisions` (orchestrator, planner, executor). It covers when to: <br>• **duplicate:** same audience and language, and the source fits the target format; the agent still formats it for the target (FR-007); <br>• **adapt:** the platform norms differ, or the source is long or link-heavy; <br>• **unique:** a different angle serves the resource's profile or KPIs better; <br>• **skip:** off-topic for the profile, the resource is weak on this format, or the cadence is full. <br>Skipping is a normal outcome; the reason must name the profile, playbook or KPI signal. The skill also teaches how to read and evolve `format_prefs` (FR-013): change them from KPI evidence or owner edits, never back and forth. Prompts and skills drop «дзеркало/дзеркалити» in favour of «дублювати / адаптувати / унікальний пост». The REST network payload adds `autoDuplicateActive` and per-resource `timezone`. |
| FR-013 | **Agent-owned formatting per resource.** <br>• `ResourceProfileSchema` gains `format_prefs`: `{tone?, length?: {target, max}, emoji?: none\|light\|rich, hashtags?: {count, style, fixed[]}, mentions?, cta?, links?: inline\|bio\|first_comment\|button, line_breaks?, signature?, preferred_formats?: string[], media?: {aspect, cover_style}, notes?: string ≤ 1000}`. Every field is optional; empty means "agent's judgement". <br>• The orchestrator and planner change `format_prefs` themselves with tool `update_resource_format {resource_ref, patch, reason}`. Each change is a new profile version (who, when, why, diff) on the agent page; no owner card, because it is within the playbook. At most 3 changes per resource per day. <br>• The owner can edit the same fields and **lock** any of them; a locked field is read-only to agents (`locked_by_owner`). <br>• Platform hard limits (caption length, hashtag maximum, media types, API rules) stay in code (`capabilities.ts`) and are the only formatting rules code enforces. Today's soft defaults (a fixed hashtag cut, a fixed caption trim, the 30/60/90 min gaps) become hints in the prompt. <br>• In approval mode (031) each owner edit of a post is offered to the agent as a `format_prefs` suggestion. |

## Corner cases
- **DST mismatch** (Kyiv and New York switch on different weekends): instants use `zonedToUtc` per resource zone; tests cover both weeks.
- **A zone changes mid-day:** existing slots keep their UTC instant; the next plan uses the new zone; Inbox info item.
- **Invalid stored zone:** the resolver falls back to Kyiv with a `resource_health.detail` warning; zod blocks new writes.
- **The source is deleted on the platform, or its media is gone** before a duplicate → `skipped` with `source_missing` or
  `source_media_gone`.
- **A resource leaves the group** with derived slots pending → `skipped` with `resource_left_network`; its decisions stay as history.
- **Planner and `repurpose_post` decide the same (idea, resource)** → the unique index wins and the tool returns `already_decided`.
- **The orchestrator goes live mid-day in an independent group:** the gate flips at the next plan day, so today's legacy mirrors
  are not also planned natively.
- **022 `repost` / `cross_promo` directives** stay reserved promo slots, not content decisions; `repurpose_post` works only inside one network.
- **A single channel without a group:** `repurpose_post` → `no_network`, and the plan records no decisions.
- **Duplicate to Telegram from an Instagram post:** allowed; the agent formats it for Telegram (markup, buttons, album).
- **The agent flips `format_prefs` back and forth:** capped at 3 changes per resource per day; MANAGER sees the history in its digest.
- **Similarity guard** compares only with the target resource's own posts, so cross-resource duplicates pass.

## Non-goals
- YouTube and LinkedIn publishing (comment #3; 019b and future specs).
- Deleting strategies or their fan-out code (009 T004–T006).
- Automatic translation for resources in other languages. A different language means `adapt` or `unique` by the agent.
- Per-resource budgets, and moving the MANAGER schedule or the budget day off Kyiv.
- Converting channel-level `meta_crosspost_targets` into groups.
- Editing, moving or skipping slots from the Plan UI (BRD 04 §3.9 open question).

## Success criteria
- **Unit (`node:test`):** `validateNetworkPlan` (one decision per idea × resource, auto-skip at cap, `from_slot` rules, no chains,
  hard-limit format checks, gap 0 allowed, local-day `per_day` across zones, DST gap/ambiguity); `duplicateSpec` snapshots per platform pair;
  every `repurpose_post` error, its daily cap and shadow→shadow; the `autoDuplicateActive` truth table incl. the plan-day boundary;
  `tzOf`/`resource_tz` fallback order and profile zone validation.
- **PG e2e** (scripted LLM, scratch PG): 059 applied twice maps mirror→legacy_duplicate and orchestrated→independent; a legacy
  group with a live orchestrator still fans out; independent + shadow orchestrator keeps fan-out and shadows decisions, going live
  stops fan-out from the next day; a duplicate slot is formatted by one short executor run that reads the target's `format_prefs`; a locked field cannot be changed by `update_resource_format`; strategy fan-out in a gated-off
  group is skipped and traced.
- **Live evals:** `planner-mixed-decisions` (4-resource network with differing profiles → ≥ 2 distinct treatments, every reason
  cites a profile/playbook/KPI signal); `planner-skip-offtopic` (a recipe idea is skipped for a resource whose profile excludes
  food); `orchestrator-repurpose-hit` (a top-decile Telegram post → `repurpose_post` duplicate to Threads).
- No user-visible "mirror" strings remain in `apps/dashboard/src`; the Plan timeline is correct with the browser in `America/New_York`.

## Open questions for the owner
1. ~~The gap between a source and its duplicate.~~ **Decided 2026-10-06:** the agent decides; 0 (simultaneous) is allowed.
2. **Must every skip be explicit?** Proposed: yes, with a short reason (cadence-full skips are auto-filled by code), because the
   reasons are the audit trail.
3. **Groups run only by strategies** (no orchestrator): proposed to stay `legacy_duplicate` until 009 T004 moves them to the editor. No
   offer card is sent for them.
4. ~~Duplicate into Telegram from a native post.~~ **Decided 2026-10-06:** allowed in any direction; the agent formats every target post itself (FR-007, FR-013).
5. **Owner input in chat** (`schedule`, `@agent post at 18:00`): proposed to stay Kyiv unless a zone is named, even when the target
   resource uses another zone.

## Task breakdown

### T1: Ship migration 059 and the independent / legacy-duplicate mode model
**Scope:**
- `061_independent_resources.sql` (mode rewrite + CHECK, slot columns, `content_decisions`, `resource_tz()`, crosspost default, grants).
- `autoDuplicateActive` wired into `EditorCrossPoster` and `GroupFanOutService`, with the plan-day boundary.
- `network-mode` endpoint (new values + aliases) and the `NetworkCtx.mode` type.

**Acceptance:**
- [ ] Migration idempotent on scratch PG; existing rows mapped.
- [ ] Gate truth-table tests pass; strategy fan-out skipped only when the gate is false.
- [ ] Regression: a legacy group with a live orchestrator behaves exactly as today.

**Size:** M · **Depends on:** —

### T2: Add per-resource time zones to profiles, planner, KPIs and stats
**Scope:**
- `timezone`/`quiet_hours` in `ResourceProfileSchema`; `resource-time.ts` resolver.
- Planner, quiet hours, best hours, series cadence and local-day `per_day` use the resource zone.
- Per-resource Kyiv SQL → `resource_tz()` (stats collector, KPI digest series, scope-kpi, read/platform tools); prompt time lines.

**Acceptance:**
- [ ] DST and fallback unit tests pass; a NY 09:00 slot is stored as 13:00/14:00 UTC.
- [ ] `resource_daily_stats.day` follows the resource zone; budget, MANAGER and chat stay Kyiv.
- [ ] BR-GEN-01 updated in `docs/brd/00-overview.md`.

**Size:** L · **Depends on:** T1

### T3: Record per-resource decisions in the network plan and execute derived slots
**Scope:**
- `treatment`/`from_slot`/`reason`/`skips` in `submit_network_plan`; new `validateNetworkPlan` rules (replace BR-AGT-72).
- Persist `content_decisions` and slot columns.
- Pure `duplicateSpec()` as a starting draft and hard-limit format checks; runner paths for duplicate (short agent formatting run), adapt, unique; source waiting/skipping; delayed media cleanup.

**Acceptance:**
- [ ] Planner unit tests cover every rule.
- [ ] PG e2e: a duplicate is formatted by one executor run using `format_prefs`; a failed source skips its derived slots; shadow source → shadow only.

**Size:** L · **Depends on:** T1, T2

### T4: Turn fan-out into the `repurpose_post` agent tool
**Scope:**
- Tool for orchestrator/planner/executor with full validation and the daily cap.
- Sources: slot, platform post, published post (incl. strategy posts).
- Chat pending action `repurpose` with an Apply card.

**Acceptance:**
- [ ] Every error code has a unit test.
- [ ] The executor can schedule "after this is published" duplicates of its own slot.
- [ ] Chat Apply creates the slots; Decline creates nothing.

**Size:** M · **Depends on:** T3

### T5: Migrate mirror groups with owner offer cards
**Scope:**
- Housekeeping step writing `network_independent_offer` Inbox items with the checklist; re-trigger on first playbook approval.
- `@ai0` pending action `set_network_mode`; reworded Groups-page strategy warning (FR-009).

**Acceptance:**
- [ ] One offer per legacy group with an orchestrator, none for strategy-only groups; "Keep" never re-offers.
- [ ] Switching writes the `network_mode` record and stops fan-out only under the gate rules.

**Size:** M · **Depends on:** T1

### T6: Update dashboard terminology, decisions view and dual time display
**Scope:**
- Terminology (FR-011) across Playbook, NetworkUi, Groups, CrosspostSection and the editor card.
- Plan tab: treatment badges, source→derived connectors, decision lists, network-zone axis with dual labels; `lib/zoned-time.ts`.
- ResourceProfile editor: time zone and quiet hours fields (Telegram read-only).

**Acceptance:**
- [ ] No user-visible "mirror" strings; the timeline is correct with the browser in America/New_York.
- [ ] Telegram profiles show the card zone read-only.

**Size:** M · **Depends on:** T2, T3

### T7: Add the `resource-decisions` skill, prompt wording and evals
**Scope:**
- Builtin skill `resource-decisions`; remove mirror wording from prompts and skills.
- The three live evals from the success criteria.

**Acceptance:**
- [ ] The skill passes `skill-lint`.
- [ ] `planner-mixed-decisions`, `planner-skip-offtopic` and `orchestrator-repurpose-hit` are green.

**Size:** S · **Depends on:** T3, T4

### T8: Let agents own per-resource formatting
**Scope:**
- `format_prefs` in `ResourceProfileSchema` with owner locks and profile versions (FR-013).
- Tool `update_resource_format` for orchestrator and planner (3 changes per resource per day, locked fields refused).
- Soft formatting defaults move from code into prompt hints; code keeps only platform hard limits.
- ResourceProfile editor: the formatting fields, lock toggles and the change history.

**Acceptance:**
- [ ] A locked field is refused with `locked_by_owner`; the 4th change in a day is refused.
- [ ] The executor prompt for a target contains its `format_prefs` (fixture).
- [ ] Eval `executor-format-prefs`: two resources with different `format_prefs` get differently formatted posts from one source.

**Size:** M · **Depends on:** T3

## Implementation notes

### T1 (2026-10-06)
- **Migration number:** `061_independent_resources.sql` (not 063/059 as written above; 059–060 belong to another stream).
- **`resource_tz()` order:** for `telegram:` refs the card zone comes first, then the profile zone, then Kyiv. FR-001 lists the
  profile first, but FR-004 makes the card authoritative for Telegram; the SQL function and `resource-time.ts` follow FR-004.
  An invalid stored zone falls back to Kyiv (plpgsql, `invalid_parameter_value`).
- **Plan-day boundary of the gate:** `meta_account_groups` gains `auto_duplicate_day DATE` + `auto_duplicate BOOLEAN` (not in
  FR-001). `autoDuplicateActive(groupId, now)` pins the gate value for the anchor's local plan day on first use; the editor
  scheduler touches it for every active card each tick (`pinGate`), and `setGroupMode` pins today before changing the mode,
  so a change of network mode, agent mode or playbook takes effect at the next plan day in both directions. If the service
  is down across midnight, the first evaluation after restart pins that day.
- **"Live"** = effective mode (orchestrator ∧ card, spec 031 ladder) is `live` and the orchestrator is not paused. `approve`
  counts as not live (auto-duplication continues), per the literal FR-003; revisit when 024 adds per-resource modes (T3+),
  since today a mode lives only on the Telegram card and platform refs answer `resource_follows_network` (031).
- **Fail-open:** if the gate query fails, `EditorCrossPoster` and `GroupFanOutService` keep duplicating (pre-024 behaviour).
  `GroupFanOutService` gets the gate through the optional `AUTO_DUPLICATE_GATE` provider in `CommonModule`.
- **Behaviour change for groups already `orchestrated` with a shadow/off orchestrator:** they now auto-duplicate again
  (FR-003: "no resource goes silent"); with a live orchestrator and a playbook they keep not duplicating.
- **`network-mode`:** the response adds `deprecated_alias` when `orchestrated`/`mirror` was sent; the Inbox text is English
  (alert text Ukrainian). `GET …/network` adds `autoDuplicateActive` (FR-012).
- **Dashboard:** only what the new mode values need: `NetworkMode` type, the Playbook tab switch ("Auto-duplicate (legacy)" /
  "Independent", no playbook required) and the badge labels. The rest of FR-011 stays in T6.
- `editor_channels.crosspost` DB default is now false; the repository still writes `card.crosspost ?? true` for card objects
  without the field (`makeDefaultCard` already sets false).

### T2 (2026-10-06)
- **Resolver:** `editor/time/resource-time.ts` — `ResourceTime.tzOf/quietOf/localDay`, pure `resolveTz/resolveQuiet`,
  `zonedToUtcStrict` (spring gap → null, autumn ambiguity → earlier instant) and `resourceTimeLines` for prompts. Order as in
  SQL `resource_tz()` (Telegram card first, see T1). An invalid stored zone falls back to Kyiv, logs and writes
  `resource_health.detail` (`ResourceProfilesRepository.noteHealthDetail`, the health state is kept).
- **Profile fields are optional** (`timezone`, `quiet_hours`): absent means Europe/Kyiv and 23→8 through the resolver, so
  existing profiles and callers that build `ResourceProfile` objects need no change. Reading a stored profile with an invalid
  zone drops only that field instead of losing the profile. The dashboard profile editor keeps stored `timezone` /
  `quiet_hours` when saving; the fields themselves arrive with T6.
- **Planner:** `NetworkCtx.resources[]` carry `tz` + `quiet` (resolved in `networkContext`; without a resolver Telegram uses
  the card, others Kyiv 23→8). `validateNetworkPlan` converts each slot in its resource zone, checks that resource's quiet
  hours and counts `per_day` per resource on the plan date in its zone. Platform publishing keeps its rolling-24 h cap (no
  calendar day there). BR-AGT-72 / "Telegram first" / the 90-min idea gap are untouched until T3.
- **Series cadence:** the plan date's weekday is the same in every zone, so `seriesDue` is unchanged; the planner prompt
  prints each due series time with its resource zone, and `SeriesSchema` says «у часовому поясі ресурсу».
- **SQL on `resource_tz()`:** `get_channel_stats` best hours, `get_platform_stats` window, `rollupDaily` day key (computed per
  row in SQL), KPI-digest per-resource series (posts, revenue, joins, and each resource's own "today"), and `scope-kpi` for
  `resource` scopes only — network/system scopes, the digest's agent spend, slots and budget stay on the Kyiv day.
- **Prompts:** network planner and daily orchestrator prompts add «## Час ресурсів (не Київ)» lines; the composer adds
  «Час каналу: …» for a non-Kyiv card (owner time stays Kyiv); `renderProfile` prints «Часовий пояс: … (зараз HH:MM)» for
  non-Kyiv, non-Telegram profiles. `GET …/network` resources carry `timezone` and `quietHours` (FR-012).
- BR-GEN-01 is updated in `docs/brd/00-overview.md`.

### T3 (2026-10-07)
- **Decision rules** live in `network/plan-decisions.ts` (pure) and are called from `validateNetworkPlan`. Gone: BR-AGT-72
  "cover every variant", "Telegram core first", the 90-min gap between variants and "the idea must have a variant for this
  resource" (variants are hints). The 60-min gap between posts of one platform resource stays until T8.
- **Input:** `treatment` is optional (default `unique`); `reason` is enforced by the rules (not zod) so the planner gets every
  error at once; `skips` is optional. Added `format_notes` (≤ 500) to `NetworkSlotInput` — not in FR-006, but FR-007's run
  reads "the agent's format_notes"; stored in `editor_slots.source_post.format_notes`. A derived slot of a series slot (no
  idea) is allowed when it names the same series; it records no decision (decisions are per idea). A skip must name an idea
  planned in the same submission.
- **Persistence:** `createNetworkPlan` inserts sources first, sets `derived_from_slot_id`, and upserts one `content_decisions`
  row per (idea, resource). A re-plan replaces `planner`/`system` rows; rows from `repurpose_post` or the owner stay and count
  as decided (`NetworkRepository.decidedElsewhere`). `GET …/plan` adds slot `treatment`, `treatmentReason`, `derivedFrom` and
  `decisions[]` (for T6).
- **Hard limits:** `derivedFormatProblem` (`post/duplicate.ts`) — implemented formats, media kind and count per format
  (Telegram formats get a capacity table), polls. Plan time checks by format; run time re-checks with the source's real media:
  impossible by format → `unsupported_format`, possible by format but the media are missing → `source_media_gone`.
- **Execution** is in `EditorRunnerService.runDerived` + `network/derived-slots.ts` (slots run in the editor runner, not in
  `network-runner.ts`). `claimDue` / `plannedBefore` claim a derived slot only once its source is no longer
  planned/running/awaiting_approval/approved; `skipStale` names `source_not_published` while the source is still pending after
  3 h. In approval mode a derived post is written after its source went out and waits for its own approval.
- **Duplicate:** one short run (≤ 6 steps; tools lint / preview / publish / skip only) with the source spec, the
  `duplicateSpec()` draft, the target profile, format_prefs (filled by T8), the format notes and the hard limits. **Adapt:** the
  full executor tool set, 14 steps. No retry: a run without a result fails the slot; lint failing twice → `failed` + Inbox
  `derived_post_failed` (English). There is no `trace.kind` column: a derived run is the slot's `run_id` with its `treatment`.
- **Sources:** a Telegram source reads `post_spec`; a platform source reads `post_spec` (`publish_platform_post` now stores the
  spec on the slot in shadow/live too) or `platform_posts.spec`.
- **Media lifetime:** `062_resource_formatting.sql` adds `media_holds`; `EditorMediaPreparer.hostSlides` asks
  `MediaHolds.holdIfDerived` before deleting. Held slides are reused as the duplicate's media and swept after each derived run
  and on every scheduler tick (24 h at most).
- The `network-planning` skill and the `network-plan-staggered` eval now describe decisions (T7 adds `resource-decisions`).
- Tests: the PG suite is not re-runnable on the same database (editor/autonomy e2e leave `content_ledger` rows — pre-existing);
  use a fresh scratch database.

### T4 (2026-10-07)
- **Tool** `repurpose_post` (`network/repurpose-tool.ts`, kind `act` — the harness has no `write` kind) for orchestrator,
  planner and executor; the logic is `RepurposeService.run`, shared with the chat's Apply handler. Error codes: `no_network`,
  `daily_limit`, `source_not_found`, `source_not_in_network`, `source_not_eligible` (older than 72 h, not out, derived, not
  today's plan), `not_own_slot`, `not_in_network`, `same_resource`, `duplicate_target`, `no_playbook_section`,
  `already_decided`, `unsupported_format`, `invalid_time` (DST gap), `time_passed`, `before_source`, `quiet_hours`, `daily_cap`
  (playbook `per_day.max` on the target's local day, and the platform API cap). On a target error nothing is written; the
  response lists every target's error.
- **Input additions:** `targets[].format` (optional, not in FR-008): without it code takes the first playbook format (by
  weight), then any implemented format, that can technically carry the source. `at` and `delay_min` are exclusive; neither
  means delay 0. A delay from an already published source that lands in the past becomes "now + 1 min".
- **Daily cap:** 10 calls per orchestrator per anchor day, counted by `content_decisions.call_id` (migration 062). The owner's
  chat Apply is outside it.
- **Writes:** `EditorPlansRepository.createRepurpose` puts the slots into the anchor's active plan of their date (a plan with
  rationale `repurpose` when the day has none — the scheduler treats it like `reserved only` and still plans the day) and the
  decisions, in one transaction; a race on the unique index → `already_decided`. A re-plan of the day moves planned
  repurposed slots (`source_post.via = 'repurpose'`) to the new plan.
- **Sources:** a slot source (or a platform / Telegram post that has an editor slot) is linked by `derived_from_slot_id`, so
  the T3 waiting rules apply ("after this is published"); slot-less posts (strategy posts, chat platform posts) carry
  `source_post.key` (`pp:<id>` / `tg:<id>`). A strategy post has no stored text or media: its title, tags and source URL
  form the draft, and a target that needs media → `source_media_gone`.
- **Finding sources:** `get_network_posts` now returns `published_post_id` / `platform_post_id` (062 appends `post_ref` to
  the `network_posts` view).
- **Chat:** chat agents get `propose_repurpose` (composer role): it dry-runs the same validation and proposes a `repurpose`
  card; Apply runs it with `decided_by = 'owner'`, Discard writes nothing.
- **Per-resource modes** would plug in at `RepurposeService.run` (mode of the target) and in `runDerived` (today the run mode is
  the anchor's effective mode; platform refs still answer `resource_follows_network`).
- FR-009's gate in `GroupFanOutService` shipped with T1 (its test stays the coverage); the Groups-page warning is T5.

### T8 (2026-10-07)
- **Schema:** `format_prefs` (`FormatPrefsSchema`, strict, every field optional; `hashtags.style` optional, `line_breaks` free
  text) and `format_locks` (field names) in `ResourceProfileSchema`. A stored profile with invalid formatting drops only the
  formatting. A profile save without these keys keeps the stored ones (the profile form, the builder and old clients never wipe
  them).
- **Storage:** format_prefs live in the profile JSON, so a member resource without a full profile can still have them
  (`profiles.get` stays null for it; `formatOf` reads them). Versions: `resource_profile_versions` (migration 062) — every
  profile save and every formatting change, with `changed_by`, `agent_id`, `reason`, a field-level `diff` and the snapshot.
- **Tools:** `update_resource_format {resource_ref, patch, reason}` (orchestrator, planner; `null` clears a field) and the
  read tool `get_resource_format` (also executor; not in the spec). Errors: `locked_by_owner`, `daily_limit` (3 agent changes
  per resource per local day via `resource_tz()`), `invalid_patch`, `no_change`, `not_in_network`, `no_network`.
- **Owner edits:** `GET /api/agents/:handle/formatting` (every resource of the agent's network with prefs, locks and today's
  agent changes, plus the history) and `PUT /api/agents/:handle/formatting/:ref {format_prefs, format_locks}` (replaces both;
  outside the daily cap). The UI is a "Formatting" section on the orchestrator's Overview next to "Resource" (not inside the
  profile modal: member resources have no profile form), with per-field lock toggles and a collapsible change history.
- **Prompts:** the target's format_prefs (locked fields marked) go into the platform executor's system prompt, the Telegram
  executor's slot prompt and the duplicate / adapt run; the orchestrator prompt tells it to evolve them from KPIs and from the
  owner's approval edits (031 owner preferences are in its memory) — a hint, not a separate suggestion card.
- **Soft defaults → hints:** the 60-min gap between posts of one platform resource is gone from `validateNetworkPlan` and from
  `publishPlatformNow` (`min_gap`); the planner prompt names the old values as guidance. The Telegram card's `minGapMinutes`
  (an owner setting) still applies. No fixed hashtag cut or caption trim existed in the agent path (`renderPlatform` trims only
  at the platform maximum); the strategies' caption helpers are legacy fan-out and stay (non-goal).
- **Eval** `executor-format-prefs` (`evals/cases/agents.ts`) written, not run; the eval stack now wires derived slots.

### T5 (2026-10-08)
- **Storage:** migration `064_network_offers.sql` — one `network_offers` row per (group, kind) (idempotency of the
  once-per-group step), with `status` open / switched / kept, `had_playbook` (offered with an active playbook?) and
  `reoffered_at`. The Inbox item is `network_independent_offer` (`ref_type = 'network_group'`, `ref_id` = group id,
  severity `action`); dashboard text English, the Telegram alert Ukrainian (as `network_mode`).
- **Step:** `NetworkOffers.run()` (`network/network-offers.ts`), hourly cron `network-offers` (:29) in `AgentsUpkeep`.
  Candidates are groups whose anchor channel (first `tracked_channels.channel_key`, as the gate) has a top-level
  orchestrator; strategy-only groups have none and get nothing. Checklist: playbook (active / pending / none), orchestrator
  mode (+ paused), enabled strategies on members (`strategy_bindings` by channel / Meta / TikTok member), auto-duplicate
  source (`source_platform`), and the FR-010 shadow sentence.
- **Re-offer:** once, when a group offered without a playbook gets an active one — immediately from the owner's approval
  or playbook edit (`NetworkService.decide` / `putPlaybook`) and otherwise by the hourly step (covers every other path).
- **Answers:** "Switch to independent" = `POST …/network-mode` (the offer becomes `switched`, the `network_mode` record is
  written as before, and the gate rules decide when fan-out stops). "Keep auto-duplicate" = `POST /api/network-offers/:groupId/keep`
  (`kept`, never offered again; the mode is untouched). An explicit `legacy_duplicate` via network-mode also answers an
  open offer as kept; a group switched elsewhere (Playbook tab) closes its open offer as `switched` (`decided_by = 'mode_change'`).
  `GET /api/network-offers` lists offers for the Inbox buttons.
- **@ai0:** builder tool `set_network_mode {handle, mode}` (`network/network-mode-tool.ts`) proposes the pending action
  `set_network_mode`; the handler (registered with `NETWORK_SERVICE`) runs `NetworkService.setMode`. The
  `agent-onboarding` skill names it.
- **Groups page (FR-009):** a member's enabled strategy in an `independent` group shows "Strategy <type> publishes into an
  independent network on its own; retire it or keep the group on auto-duplicate" (the "009 T004" reference is left out
  of the UI text). The group list (`SELECT *`) already carries `mode` and the pinned `auto_duplicate`.

### T6 (2026-10-08)
- **Terminology:** no user-visible "mirror" in `apps/dashboard/src` — guard `lib/no-mirror-ui.test.ts` (comments and
  the quoted stored value `'mirror'` are allowed). Crosspost option and badges say "duplicate" (stored value stays
  `mirror`); the editor card row and the card form say "Auto-duplicate (legacy)"; Groups: new intro, "Auto-duplicate source"
  shown only while the group auto-duplicates (`mode = legacy_duplicate` or today's pinned `auto_duplicate` not false —
  the list API already returns both), otherwise an "independent" chip, and the SOURCE badge / double-post warnings only
  while auto-duplicating. The backend's Instagram crosspost error no longer says "mirror". The Playbook switch and the
  network badges were already done in T1.
- **Times:** `lib/zoned-time.ts` (`formatIn`, `dual`, `dayIn`, `zonedToUtc`, `minutesFromDayStart`, `listZones`…);
  `lib/kyiv-time.ts` is now a thin wrapper (chat callers unchanged). The pure layout lives in `lib/plan-timeline.ts`.
  The Plan tab's day ("Today") and axis are the anchor's zone (its Telegram resource's `timezone` from `GET …/network`);
  positions are minutes from the plan day's 00:00 in that zone, so a resource behind the anchor (New York evening) lands
  after 24:00 (axis up to 36 h, "00+1" marks midnight). Lanes show the zone and local now; pills show the resource's
  time plus "· HH:MM Kyiv" when it differs (the full `09:00 America/New_York · 16:00 Kyiv` is the tooltip and the detail
  header; the pill is too narrow for both zone names). On a 25-hour DST day positions are by real time.
  `fmtDay` / `shiftDay` are UTC-based. Test `lib/plan-timeline.test.ts` runs with `TZ=America/New_York`.
- **Plan tab:** U/D/A mark on pills and list rows; dashed SVG connectors source → derived (solid when either is selected);
  slot detail shows treatment, reason, the source (jump) and derived slots, and the idea's decisions; a "Decisions" panel
  lists every idea of the day with each resource's decision, reason, reason code and who decided.
- **Ideas:** `GET …/ideas` now returns `decisions[]` per idea (from `content_decisions`); the idea card shows them.
- **ResourceProfile:** time zone (searchable `<datalist>` of `Intl.supportedValuesOf('timeZone')`, empty = Europe/Kyiv,
  validated with `Intl`) and quiet hours (both or neither; empty = 23→8) in the profile form and view. For a `telegram:`
  ref both are read-only from the card (via `GET …/network`) with a link to `/app/editor/$channel`.
