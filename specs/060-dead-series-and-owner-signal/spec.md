# 060 — Dead series breaker and owner signal

Status: done · Builds on 037 FR-010 (silent days), 012 (owner bot), 046 (manager), 049 (health, keeper) · Migration 093

## Why

Review 3 (`docs/reviews/2026-10-22-agent-review-3.md`, findings 1, 3, 4) found three problems:

- **Dead series still cost money.** @ai0_prompts_dev had 12 skipped slots and 0 posts in 7 days ($2.55). @pdr_dev_channel had 7 × `source_already_posted` skips. The planner even wrote «пропустити слот» into the topic of slots it planned. Nothing turns a run of identical skips into a stop.
- **The owner gets repeats.** 26 of 50 Inbox notes repeat a (kind, subject). A `series_missed` at 09:02 and a `dark_day` at 15:00 about the same slot arrive as two notes. The same `critic_reject_streak` N is re-sent. Owner-bot cards only have Read / Open, so there is no way to act from Telegram.
- **The manager is toothless.** It filed 0 directives in 4 days while marking 5/5 resources "issue", because any open directive counts as cover. 3 of 5 `applied` advices are `verification.adherence = not_followed`, and the manager never sees this.

## What

### FR-001 Skip-streak breaker (code, no LLM)

After a slot ends `skipped` (or `failed` for a non-budget reason), classify it with `silent/skip-reasons.ts`. Then count the consecutive closed slots of the same **series** with the same cause class:

- Same series = same `series_name`, or the same `schedule_rule_id`, or the channel when neither is set.
- Cause classes: `no_material` covers no_fresh_item, library empty, rows without required fields and source_already_posted. `source_unreachable` covers 403, timeout, too large and host blocked. `critic` covers critic rejected.
- Owner decisions and budget skips never count.

When the count reaches `SERIES_SKIP_STREAK` (setting, default 3, 0 = off) for `no_material` or `source_unreachable`:

- The series is **paused**. Migration 093 adds `series_pauses (channel_key, series_key, cause, reason text, streak int, paused_at, resumed_at, resumed_by)`, with one open pause per (channel_key, series_key).
- The planner does not create slots of a paused series. Already planned future slots of that series are skipped with code `series_paused`, which costs $0.
- The owner gets **one** Inbox note and one owner-bot card, in Ukrainian. It names the channel, the series and the last reason, for example: «серію "Prompt" на @ai0_prompts_dev призупинено: 3 пропуски поспіль — у рядках немає повного тексту промпту». The card has the buttons **Відновити**, **Залишити на паузі** and **Відкрити**.
  - **Відновити** resumes the series: `resumed_at`, `resumed_by='owner'`.
  - **Залишити на паузі** marks the card read.
  - The dashboard shows paused series on the channel's agent page (Overview) with a Resume button. UI text is English.
- `critic` streaks are not paused. They keep the existing `critic_reject_streak` note, with the FR-002 dedup applied.

A pause is a soft stop. It does not touch the channel's mode or `resource_pauses`.

### FR-002 Planner sees why slots were skipped

The planner's input for a channel gets the last 3 skip reasons per series (code + one line, ≤ 160 chars each) and the list of paused series. The planner prompt says not to plan a slot whose only material is known to be missing, and to pick another series or format instead.

### FR-003 One note per cause, not per day

- **Merge.** `series_missed` and `dark_day` for the same resource and day become one note. The note sent later in the day updates or replaces the first instead of adding a second.
- **Re-fire only on change.** A (kind, subject) note fires again only when its cause or number changes. A streak N that has not changed does not fire again. Otherwise it fires again once per `OWNER_NOTE_REPEAT_DAYS` (default 3) as «досі … N днів».
  - The memory of a note across days lives in the Inbox rows themselves: look up the last note of the same kind and subject. Do not add a new table unless needed.
- **Close older cards.** When an owner card is sent for a (kind, subject), older open cards of the same (kind, subject) are closed (answered = superseded). The owner sees one live card per problem.
- **Critical health.** Critical health notes (`token_invalid` and other keeper notes) follow the same rule: once, then once per 3 days.

### FR-004 Card actions

Cards get real actions on top of Read / Open:

- **Health cards** (token_invalid, source down, …): **Заглушити на 7 днів**. This calls the existing health dismiss path (`POST /api/agents/:handle/health/dismiss`, spec 049) for 7 days.
- **Silent-day cards** (series_missed, dark_day, critic_reject_streak): **Пауза серії**. This pauses that series as in FR-001 with `cause='owner'`.
- **Series-paused cards:** see FR-001.

Callback data still carries only the card id and the button index (`owner-cards.repository.ts`). Each action is logged on the card and in the Inbox row.

### FR-005 Manager sees whether advice was followed

- The digest's open-directive list (`kpi-digest.service.ts` ~366) and `openDirectivesText` (`manager-runner.ts` ~130) include `verification.adherence` and the directive's age in days.
- `reviewSignature` (`kpi-digest.service.ts` ~134) does not count a directive as cover when it is `applied` with `adherence = not_followed`, or `accepted` and older than its review date.
- A `critic_reject_streak` ≥ 3, a `dark_day`, or a paused series on an agent forces a review even when it is otherwise covered.
- Manager prompt: an advice `not_followed` once should be re-filed as `binding: directive` that supersedes the old one. Not followed twice means escalate to the owner (structural directive). A dead series that is paused is not re-advised.
- `owner_rejection_rate` and `owner_edit_rate` are rejected as `expected_metric` (tool error with remedy) when the target channel had 0 owner approvals in the last 7 days, because they cannot be measured.
- An outcome of `not_followed` or `inconclusive` writes one `agent_memory` line for the manager (kind `avoid` or `insight`, with the directive id), the same as `worked` does today.

## Out of scope

Choosing a new prompts source (owner decision). Spec 061 (pre-flight per slot) is separate and complementary: 061 stops a single slot before the LLM, 060 stops a series after a streak.

## Acceptance

- Unit tests with fakes for the streak counter (classes, owner/budget excluded, threshold 0 = off), merge and re-fire rules, card closing, button actions and the manager signature.
- PG tests for migration 093, one open pause per series, the planner filter and skipping planned slots of a paused series.
- Replaying the review-3 numbers in a test fixture: 12 prompts skips produce 1 pause note, not 10 notes.
