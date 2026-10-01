# 005: Editor roles: planner, executor, reviewer, scheduler, shadow mode

**Status:** In progress · **Depends on:** 003, 004

## Why
The harness (003) and the post model (004) need roles and a heartbeat. The planner decides **when** and **what**
for the day, the executor turns each slot into a published post, and the reviewer closes the feedback loop by
learning what works and writing it into channel memory. Everything defaults to `off`, and the owner moves channels
through `shadow` → `live`.

## User stories
- **US1 (owner):** I want a channel described by an editorial card (brief, formats, hashtags, sources, limits)
  instead of code, so that adding a channel needs no deploy.
- **US2 (owner):** I want a daily plan per channel that I can inspect, so that I know what the agent will post and why.
- **US3 (owner):** I want shadow mode: the full run without publishing, with a preview sent to my admin chat, so that I
  can judge quality before going live.
- **US4 (owner):** I want weekly self-review that turns stats into channel memory and format weights, so that the
  network learns.
- **US5 (owner):** I want hard publish guards (mode, daily cap, quiet hours, min gap, dedup, lint, budget), so that
  autonomy is safe.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Planner** (role `planner`). Read tools: `get_channel_card`, `get_channel_memory`, `get_channel_stats`, `get_recent_posts`, `get_top_posts`, `get_format_performance`, `sql_readonly`, `list_skills`, `load_skill`, `fetch_feed`. Terminal tool: `submit_plan({rationale, slots:[{time:'HH:MM', format, topic, angle?, source_hints?, is_experiment}]})`. **Validation in code:** <br>• the slot count is within card min..max <br>• times are outside quiet hours, strictly increasing, at least `min_gap_minutes` apart, and in the future (local timezone) <br>• formats are in the card <br>• the experiment share is ≤ `explore_ratio` rounded up <br>A violation returns `{error, details}`, so the model fixes it. On success, any previous active plan for the date is marked superseded and its `planned` slots `skipped`. |
| FR-002 | **Executor** (role `executor`), one run per slot. Read tools: all read tools from 003 and 004. Terminal tools: `publish_post(spec)` and `skip_slot({reason})`. The user prompt contains the slot (format, topic, angle, hints), the card summary and the active memory. |
| FR-003 | **`publish_post` guards**, in order and all in code: <br>1. Slot is `running` and belongs to the ctx channel. <br>2. Lint (004) passes. <br>3. Similarity to the last 60 posts is below 0.6 and `source.url` has not been posted to this channel (`published_posts.source_url`). <br>4. Mode check: `shadow` → store `post_spec` and `rendered_preview`, set status `shadowed`, send the preview to the owner through `TelegramNotifier` if configured, and return `{ok:true, shadow:true}`. <br>5. `live` → daily published count < `posts_per_day_max`, not in quiet hours, at least `min_gap_minutes` since the channel's last post (any source), then render and send. <br>6. On success, insert into `published_posts` (format, `editor_slot_id`, `strategy_type='editor'`, tags=hashtags), call `throttle.recordPublish`, set the slot to `published` with `published_post_id`. <br>Any failure in 5–6 returns `{error}` (not terminal). The slot stays `running` until the loop ends, and then the scheduler marks it `failed` or retries. |
| FR-004 | **Reviewer** (role `reviewer`), weekly per channel (Monday at plan_hour − 1). Read tools plus `get_format_performance`. Act tools: <br>• `add_memory({kind, text, evidence})`, at most 5 per run <br>• `retire_memory({id, reason})` <br>• `set_format_weights({weights})`, where each weight is 0.05..1 and only formats already in the card can be set <br>Terminal tool: `finish_review({summary})`. Memory entries the owner created cannot be retired by the reviewer. |
| FR-005 | **Scheduler** (`EditorScheduler`, `@Cron('* * * * *')`; no-op unless `EDITOR_ENABLED=true`): <br>(a) **Plan:** for each channel with mode ≠ off that has no active plan for its local date and whose local hour ≥ plan_hour, run the planner. <br>(b) **Execute:** atomically claim due slots with `UPDATE … SET status='running', attempts=attempts+1 WHERE id IN (SELECT id … WHERE status='planned' AND scheduled_at<=now() ORDER BY scheduled_at LIMIT 3 FOR UPDATE SKIP LOCKED) RETURNING *`, then run the executor for each claimed slot. Concurrency is ≤2 in-process. <br>(c) **Sweep:** slots `running` for more than 15 min become `failed`, and their runs become `error`. A slot that failed with attempts < 2 is re-planned at now + 15 min, unless that crosses into quiet hours, in which case it becomes `skipped`. <br>(d) **Review:** weekly. <br>Slots older than 3 hours are `skipped` (`stale`) instead of executed. |
| FR-006 | Memory and format tools: <br>• `get_channel_memory` returns active entries, newest first, up to 30. <br>• `get_format_performance(days)` returns, per format, the post count and median views_per_hour at 24 h from `editor_v_post_performance`. |
| FR-007 | `EditorChannelsRepository` covers card CRUD (used by 006). This spec seeds nothing: the owner creates cards through 006 or SQL. A documented example card is provided in `docs/runbooks/editor-agent.md`. |
| FR-008 | Alerts through the existing `AlertingService`/`TelegramNotifier`: 3 consecutive failed slots on a channel, a planner failure, or a budget exhausted. Each alert is de-duplicated per day. |

## Success criteria
- SC-1: `submit_plan` validation tests cover every rule, plus the supersede behaviour.
- SC-2: `publish_post` guard tests cover each guard in shadow and live mode, using a fake publisher and fake repos.
- SC-3: Scheduler tests cover claim, stale skip, sweep and retry, and plan trigger by local hour, with a fake clock.
- SC-4: An end-to-end test with a scripted FakeLlm: planner → slots → executor → shadowed slot with preview. Zero network.
