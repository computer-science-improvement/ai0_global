# 068 — Stop dead series

Status: planned · Builds on 060 (series breaker), 061 (slot pre-flight), 083 (`post_requires`), 058 (data store) · Migration 095

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

## Why

Review 4 (P1 #3, P3 "plan-time checks") found that dead series are planned and run every day. Over 6 days, @ai0_prompts_dev (series «Prompt») skipped 11 of 12 slots and @pdr_dev_channel skipped 11 of 12. `series_pauses` is empty: the 060 breaker never fired.

1. **The cause is read from free text, and the same cause lands in different classes.**
   - `skip_slot` takes a free-text reason; its only `code`s are `no_fresh_item` and `story_skip`.
   - `series-pause/skip-cause.ts` guesses the class with regexes:
     - `UNREACHABLE_TEXT` («недоступн») is tested before `NO_MATERIAL_TEXT`, so «недоступний у бібліотеці» counts as unreachable;
     - the code regexes are anchored at `^`, so `skipped by agent: … source_already_posted` never matches;
     - the Ukrainian stems use ASCII `\w` (`вільн\w*`, `закінчил\w+`, `не знайшов\w*`), which never matches Cyrillic.
   - `streak.ts:85` breaks the run on any class change. The Prompt series read N U U N O N N U N N P O, so its longest same-class run was 2 and the threshold is 3.
2. **The plan validator forces doomed slots.**
   - `roles/plan-rules.ts:88-94` makes `posts_per_day_min` (2) a hard floor.
   - `plan-schedule-rules.ts:142-146` refuses to skip a locked series.
   - The pdr planner (run 07c19718, 10-22) and the Prompt planner (e11add74, 10-25) both submitted an honest empty day and were refused. They then planned 2 slots each, and all of them skipped.
   - `planPerDay` ignores paused series, so a pause does not lower the minimum. For a resource-paused network section the minimum is unsatisfiable.
3. **The data hides that the material is gone.**
   - Migration 083 set `prompts.post_requires = [["page_url"],["prompt_text","media_url"]]`. Groups are ANDed and fields inside a group are ORed (`data/post-requires.ts`), so page_url AND (prompt_text OR media_url).
   - Every PromptHero row has a page_url and a media_url, so all count as postable. The catalog shows `unposted_here: 4764`, while `prompt_text` is empty in 100% of the rows.
4. **The pre-flight does not look at library slots.** `preflight/slot-preflight.ts:110-111` gives up when a slot has any non-URL hint. Every Prompt slot carried `series:Prompt`, `library:prompts` and `data://prompts/N`, so 27 of 59 non-live slots were never checked, and 22 of them skipped.
5. **`query_data` cannot fetch a row by its ref.** The executor tried `filters: [{field: 'id', …}]` 13 times. The dataset's own `id` field is a CDN URL and is not filterable; the ref uses `data_items.id`.

The lead's code map is at `<scratchpad>/r5/map-068-dead-series.md`. It has file:line anchors for everything below and a replay of the 24 real skip texts. Where it and this spec differ, this spec wins.

## What

### FR-001 `skip_slot` names its cause

- **Input.** `{ reason, cause, code? }`, where `cause` is required: `no_material | source_unreachable | source_used | quality | other`.
- **Stored error.** `skipped by agent: <cause>: <reason>`. The prefix `skipped by agent:` must stay. `skip-reasons.ts` (`isCriticRejection`, `skipGroupOf`), `fallback-ladder.ts:186`, `config/landing-pulse.service.ts:131` and the dashboard (`lib/slot-plan.ts:112`) read it.
- **With a `code`.** The error stays `<code>: <reason>` as today. `no_fresh_item` counts as `no_material`; `story_skip` counts as `other`.
- **One helper,** `skipSlotError(reason, cause, code?)`, is shared by `role-tools.ts` (skip_slot) and `roles/preview-run.ts:83-87`.
- **Prompts.** Every prompt line that tells the executor to call `skip_slot` names the enum, in Ukrainian, with one example each (list in the code map). A call without `cause` fails validation, so it costs one step.

### FR-002 The classifier

`classifyClose` (`skip-cause.ts`):
1. **New-format rows.** Parse `^skipped by agent:\s*(no_material|source_unreachable|source_used|quality|other):` first, and use that cause.
2. **Legacy rows** (14-day window):
   - strip the `skipped by agent:` prefix;
   - search code words anywhere in the text, unanchored: `source_already_posted`, `library_item_already_posted`, `already_posted` → `source_used`; `library_ref_not_found` → `no_material`;
   - make every text regex Cyrillic-safe: `[\p{L}\p{N}_]` with the `u` flag instead of `\w`;
   - when the text names the library, a row or a `data://` ref, `no_material` wins over `unreachable`;
   - `story_repeat` / `story_skip` stay `other`.
3. **New codes:**
   - `planner_no_material` (FR-004) and `preflight_no_material` (FR-006) → `no_material`;
   - `planner_source_unreachable` → `source_unreachable`.
   These are also added to `silent/skip-reasons.ts` RULES as `nothing_fresh`, after the agent-plus-revise critic check, and to `network/idea-outcome.ts` NO_MATERIAL. They must **not** go into `NOT_A_MISS`.
4. **Classes.** The classes are `no_material`, `source_used`, `source_unreachable`, `quality`, `other` and `critic`, plus the ignored and out classes as today.

### FR-003 The streak counts a family

`skipStreaks` (`streak.ts`):
- **Critic closes are transparent.** They neither count nor end a run (today they end it).
- **Series and rule groups.** One family: `no_material ∪ source_used ∪ source_unreachable`.
- **Resource groups.** `no_material ∪ source_used` is one family. `source_unreachable` is a separate class, so a host outage cannot stop a whole channel. The 20-hour minimum span stays.
- **What ends a run.** `quality`, `other`, a class outside the family, and a published, shadowed, approved or awaiting slot.
- **Cause of the pause.** It maps to the 093 CHECK set: `no_material` when any member is `no_material` or `source_used`, else `source_unreachable`.
- **Docs.** Update the `SERIES_SKIP_STREAK` help (`settings/catalog.ts:129`) and runbook § 19.

### FR-004 An honest empty day

**In `submit_plan`:**
- `skipped_series[]` items get `cause: no_material | source_unreachable | other` (default `other`).
- A **locked** series may be skipped only with a material cause (`no_material` or `source_unreachable`).
- The due instances of a series skipped with a material cause are subtracted from the day's minimum.

**A whole short day.** `SubmitPlanInput` gets `short_day?: { cause: 'no_material' | 'source_unreachable', reason (≥ 20 chars) }`; the network form is `short_days: [{ resource_ref, cause, reason }]`. It lowers the day's minimum to 0 for that resource. The maximum still applies.

**The record is a placeholder slot,** inserted in the same transaction as the plan (`createPlan` / `replacePlan` / `createNetworkPlan`):
- **One per declaration:**
  - a material-skipped series gets one row per due instance, with `scheduled_at` = the instance time and `series_name` set;
  - a `short_day` gets one row per resource per day, with `scheduled_at` = max(now, local 00:00 of the plan day) and no series.
- **Fields:**
  - `kind 'content'`, `status 'skipped'`;
  - `format` = the series format;
  - topic «Порожній випуск: <series>», `source_hints ['series:<name>']`;
  - error `planner_no_material: <reason>` or `planner_source_unreachable: <reason>`.
- **Replan.** `replacePlan` marks the future placeholders of the plan it replaces as superseded, so a second plan the same day does not count twice. Placeholders whose time has passed are kept.
- **No new note kind.** The breaker counts placeholders as they are (`closedSlots`). `dark_day` and `series_missed` show the planner's reason, and the breaker's pause note follows at the threshold.

**The refusal text** for a short count and for a locked skip names the way out, in Ukrainian: «якщо матеріалу немає — `skipped_series` з `cause: no_material` або `short_day`». A planner with no material is then never trapped by `same_plan_rejected`.

### FR-005 Pauses lower the minimum

`planPerDay` (`schedule/plan-schedule-rules.ts`, shared by `effectiveCard` and `effectiveNet`) takes the open pauses, the series and their clocks. These inputs are optional, so old callers still work.
- The day's minimum loses the instances of paused series on that resource.
- A resource pause (a plain-slot pause) sets the minimum to 0.

**Silent days.** `silent/silent-days.ts` uses the lowered minimum. Today it uses the card's `postsPerDayMin` (~:283-286), so a paused channel gets a daily `dark_day`.

### FR-006 The pre-flight checks library slots

In `preflight/slot-preflight.ts`:
- **Ignored hints.** `series:` and `directive:` hints are left out before the URL test, so the URL hints of a series slot are judged.
- **Material hints** are URLs, `data://…`, `library://…` and `library:<table>[/<category>]`. Unknown kinds (`feed:`, `api:`, `network_highlights:`) count as usable. The slot fails only when every material hint fails, as today for URLs.
- **`data://` and `library://` hints.** One SQL statement checks `data_items` joined with `data_schemas`, matching `d.id` or `legacy_ref`:
  - row missing or not active → `preflight_no_material` «рядок … не знайдено»;
  - `NOT data_postable(post_requires, data)` → `preflight_no_material` «рядок … без <missing fields>»;
  - the row passes, then the ledger: `ContentLedger.check(resource, ref, { waiting: true })` → `preflight_source_used`.
- **`library:<table>` hints.** `buildCatalog(pool, { dataset, resource })[0].unposted_here` is 0 → `preflight_no_material` «у датасеті <t> немає непублікованих рядків для <resource>». The category is ignored, which is conservative.
- **Classification.** Add the new code to `skip-reasons` RULES, `preflightCauseOf`, `skip-cause` (FR-002) and `idea-outcome` NO_MATERIAL.

### FR-007 The cheap checks run at plan time

- **New entry point.** `SlotPreflight` exposes `assessPlanned(slotLike, card)`, the same checks without the idea swap.
- **Where it runs.** `submit_plan` and `submit_network_plan` run it on the validated slots. Each failure returns as a `plan_invalid` line: «слот N (HH:MM): <причина> — заміни джерело/рядок або постав skipped_series з cause no_material / short_day».
- **Wiring.** `RoleToolDeps` gets `preflight`. Build one `SlotPreflight` in `editor.module.ts` and share it with the runner.
- **Formats.** `validatePlan` drops formats that fail `formatAvailable` from the allowed set, so carousel is not offered without slide hosting.
- **Host blocks.** They stay checked at run time too: 2 of 5 review-4 blocks happened after planning.

### FR-008 `query_data` by ref

`QueryDataInput.refs?: string[]` (1–20 `data://` or `library://` refs).
- **Dataset check.** Every `data://` ref must name the `schema` argument, else the error `ref_dataset_mismatch`.
- **Fetching.** `queryDataset` gets `ids` and `legacyRefs`. With them it bypasses filters, search, `postableOnly` and `unposted_on`, and reads any status.
- **Flags per row.** `postable`, `missing` (the missing `post_requires` groups) and `used_here` (when a resource is known). A ref with no row comes back as `{ ref, found: false }`.
- **Visibility.** Field visibility still applies to the fields returned.
- **Hints.**
  - The `field_not_filterable` error for a field named `id` says «щоб взяти рядок за ref — `refs`».
  - The zero-hit note no longer claims "nothing unposted" when the search fields are empty in most rows.

### FR-009 Migration 095: the prompts rule

`095_prompts_post_requires.sql`, data only.
- **The update.** In a DO block guarded by the existence of `data_schemas.post_requires`, set `prompts.post_requires` to `[["prompt_text"],["media_url"]]`. Update only when the current value is exactly the 083 value `[["page_url"],["prompt_text","media_url"]]`, so an owner's own rule wins.
- **Description.** Optionally append to the description «PromptHero rows have no prompt text and cannot be posted», while it is still the 083 text.
- **Stats.** `PERFORM data_schema_stats_refresh(<prompts id>)`, then record in `schema_migrations`.
- **Down file.** It restores the 083 value when the 095 value is still in place.

No version bump: `post_requires` is not structural. No rows change. `data/post-requires.migration.pg.test.ts` applies every migration except 083 before 083, so 095 must be a no-op when the column is missing. Add a migration PG test in that style.

### FR-010 Replay fixture

`series-pause/fixtures/review4-skips.ts` holds the 24 Prompt and pdr rows and the 11 other non-critic skips of the review-4 export: id, channel, series, scheduled_at, status, error, verdict. Tests replay them through `classifyClose` and `skipStreaks` and expect:
- **Prompt** gets a series hit with n ≥ 3.
- **pdr** (a resource group) gets a hit on its `no_material` / `source_used` run before the 10-25 post. After the post, U N U does not pause.
- **«AI-новини дня»** gets a hit by 10-24 09:00, because critic closes are transparent.
- **Slot 89320f09** (story_repeat) stays `other`.
- **Cyrillic regressions**: «немає вільних рядків», «закінчилися рядки», «не знайшла свіжих» and «немає непублікованих записів» all classify as `no_material`.

## Out of scope

- A per-series `requires` field list (the dataset's `post_requires` is the rule).
- Binding a series to a library source with `source_mode: required` (that is the 069 card, or an owner action).
- Changing that a resource pause stops `maybePlan` for the whole channel.

## Acceptance

Unit tests with fakes and PG tests (`EDITOR_PG_TEST_URL`, own throwaway DB) for each FR. The code map lists the new and the updated tests.

**Behaviour that must hold:**
- the old `skipped by agent: <text>` rows keep their class, except where FR-002 deliberately fixes them;
- a locked series skipped without a material cause still fails;
- placeholders are counted once after a replan;
- `planPerDay` without pause inputs returns what it returned before.

`npm test` and `npm run build` pass. The dashboard checks pass if `slot-plan.ts` labels change.

## Amendments after the builder check

The builder check (2026-10-27) found gaps. These rules override the body.

**A1. Replan (FR-004).**
- `replacePlan` sets the error `superseded by a new plan` (a `NOT_A_MISS` code) on the old plan's future placeholders.
- A new placeholder is written only for an instance that is still required. It is never written when an unsuperseded `planner_*` placeholder already exists for the same series and `scheduled_at`. For `short_day`, the match is the same resource and day.
- PG test: a `short_day`, then a replan 5 h later, counts as one close.

**A2. The order in `classifyClose`.** Check in this order:
1. out of scope;
2. expired or not closed;
3. `NOT_A_MISS` and owner closes;
4. `series_paused`;
5. budget;
6. critic, including an agent skip that follows a revise or reject;
7. `preflight_*`;
8. `story_repeat` or `story_skip`;
9. the new-format cause;
10. the legacy text classifier.

Test: `skipped by agent: no_material: x` after a revise verdict is classified as critic.

**A3. Source-unreachable runs.** A run made only of `source_unreachable` skips still pauses the resource group, as in 060. Drop the wording that a host outage cannot stop a channel.

**A4. New codes in the classifier.**
- `planner_*` and `preflight_no_material` go into `RULES` as `nothing_fresh`.
- In `skipGroupOf`, after the critic line, the agent causes `no_material`, `source_used` and `source_unreachable` map to `nothing_fresh`. The causes `quality` and `other` stay `other`.
- `not_next_in_order` (a guard code from spec 071) goes into `CONTENT_FAILURE_CODES` and into the `RULES` `lint` group, and the streak classifier maps it to `other`. Add it now so that 071 finds it in place.

**A5. Where the cause enum lives.** The cause enum appears only in the zod `describe` and in `prompts.ts:255`. Leave the other mentions alone. `cause` is optional when `code` is given. The legacy anchored forms stay `no_material`, or the tests that pin them are updated.

**A6. Placeholders.**
- A `short_day` placeholder has format `text`, topic «Порожній день: <reason>» and `source_hints: []`.
- Placeholders produce `dark_day` parts.
- `short_day` may come together with slots.

**A7. Plan size (FR-005).**
- `silent-days` gets an optional dependency `minPerDay(card, day)`.
- `planPerDay` widens its `Pick` of the ctx fields and subtracts only `dueInstances`.

**A8. Pre-flight (FR-006).**
- `PreflightDeps` gains an optional `material` member. Add `preflight_no_material` to `PREFLIGHT_CODES` and to the order at `:122`. Use `excludeSlotId`.
- `buildCatalog` needs `today: kyivMonthDay()`.
- A second `SlotPreflight` instance is fine (separate providers). `NetworkToolDeps` needs `preflight`.
- `assessPlanned` skips reserved, promo and adapt slots, and never throws.
- `validatePlan` gets an optional `formatOk`.
- Library and `data://` hints get a real check: the pre-flight reads `buildCatalog(...).unposted_here` for them. Today `assess()` returns at `:111` for a library hint. Put the `data://` check where 071 can later add its «пропущене в цьому колі» text.
- Keep the timeout exemption for host blocks (`block.reason !== 'timeout'` at `slot-preflight.ts:146`). Spec 070 records connection resets as `timeout`.

**A9. `query_data` `refs` (FR-008).** With `refs`: `unpostedOn` is null, there is no zero-hit note, and (after 071) no roll and no round order. The zero-hit note change is merged with 071's. A `data://` ledger hit with status `passed` (added by 071) maps to `preflight_source_used`. `preview-run` never calls pass.

**A10. Migration 095.** The `data_schema_stats_refresh()` call sits inside the guarded `DO` block.

**A11. Text classifier.** Use the regex from the replay script (stems `знайш`, `непублікован`, `запис`; see the code map's notes).

**A12. Tests that will change on purpose.** In addition to the body's list: `evergreen.pg.test.ts:172/185` and `monotony.test.ts:136`. The fixture comes from `$EXPORT/editor_slots.jsonl` (the path is in the task prompt).

**A13. Runbook.**
- Add a line that the 083 insert check now refuses PromptHero loads.
- Update runbook §20 at line ~560.

**Merge order.** 068 merges after 067, before 070, 069 and 071.
