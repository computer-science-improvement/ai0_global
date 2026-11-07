# 091 — Channel SLO controller: every channel posts its daily minimum

Status: implemented (2026-11-07, feat/editor-agent) · P0 · Builds on 034 (fallback ladder, evergreen), 036/037 (silent days), 053 (budget gate), 057 (`replaces_slot_id`), 060 (series pauses), 062 (escalation), 073 (planner retries) · Pairs with 090 (autonomy contract) · Migration 104

> Source: the autonomy review (`docs/reviews/2026-11-07-autonomy-review.md` §3.2, §4, §5.2) and the dev-stage diagnosis of 2026-11-07. The code facts below were read at `72bd12c8`. Paths are relative to `apps/automation/src/editor/` unless stated otherwise.

## Why

Channel state lives in four places, and nobody owns it:

- the planner decides how many slots to plan;
- the circuit breaker (060) pauses whatever skips 3 times in a row;
- the silent-days detector reports a dark day;
- the manager escalates.

Each part is correct on its own. Together they kept two channels dark for 6 and 15 days.

1. **A channel-wide pause has no exit.** Plain slots (no series and no schedule rule) are keyed as `resource:telegram:<channel>` (`series-pause/streak.ts:36`). Three skipped plain slots pause that key, and `plainPausedChannels` (`series-pause/series-pauses.repository.ts:67-70`) then stops the scheduler from planning the channel at all (`editor.scheduler.ts:173-182`). After `72bd12c8` the pause lifts after 24 h for `no_material`. A pause for `source_unreachable` still has no exit, and the channel goes back to the same skips.
2. **A dark channel stops being "dark".** Under a pause, the day's minimum becomes 0. `dark_day` therefore never fires (`silent/silent-days.ts:197`), and escalation leaves the channel out (`manager/escalation.ts`).
3. **The manager and the breaker fight.** On 11-06 the manager filed a `task` directive to post on @ai0_global. Its slot was skipped at $0 as `series_paused` (`skipPlanned`), and the directive went to `directive_failed`.
4. **A skip is never replaced.** Seven days, 0 replacement slots. A channel that asks for 3 posts and loses 2 slots by 10:00 ends the day with 1 post. The column for this, `editor_slots.replaces_slot_id` with a unique index (migration 057), exists and is used only by approvals.
5. **The planner gives up for the day.** After `PLANNER_MAX_TRIES = 3` failed planner runs (`editor.scheduler.ts:98`, 323-325), the channel is not planned again until the next day.

The owner needs one guarantee: **a channel in `live` mode posts at least its daily minimum, or the system has tried every cheap way to get there and says so once.** That needs one controller with a target and a recovery ladder, not four observers.

## What

### FR-001 One daily target per channel

`slo/slo-target.ts` exports the pure `dailyTarget(card, playbook, capacity, day)`:

- **Base:** the card's `posts_per_day.min`.
- **Clipped to the playbook:** when the active playbook has `per_day.min`/`per_day.max` for the channel, the base is clipped into that range. The playbook wins over the card defaults. 092 removes the duplication; until then this rule decides.
- **Capacity:** the target never exceeds what can still be planned that day (`remainingCapacity`, `roles/plan-rules.ts:52`).
- **The target is 0, with `held` and a reason, when:**
  - the channel mode is `off` or `shadow`;
  - the channel's agent is paused;
  - an owner `resource_pauses` row is active;
  - every series of the channel is paused by the owner.

  A pause for `no_material` or `source_unreachable` **does not** lower the target. That is the change that keeps a starving channel visible.

Tests pin each rule. `dark_day` and escalation (FR-007) read the target from this function instead of their own `minPerDay`.

### FR-002 Channel state, and the breaker stops pausing whole channels

**Migration 104** adds the daily state table:

```sql
CREATE TABLE IF NOT EXISTS channel_slo (
  channel_key    TEXT NOT NULL,
  day            DATE NOT NULL,                  -- the channel's local day
  target         INT  NOT NULL,
  published      INT  NOT NULL DEFAULT 0,
  planned_ahead  INT  NOT NULL DEFAULT 0,        -- planned/claimed slots still to run today
  skipped        INT  NOT NULL DEFAULT 0,
  replacements   INT  NOT NULL DEFAULT 0,
  recovery_runs  INT  NOT NULL DEFAULT 0,
  state          TEXT NOT NULL CHECK (state IN ('on_track','behind','recovering','starved','dark','held','met')),
  reason         TEXT,                           -- English, one line, for the dashboard
  last_post_at   TIMESTAMPTZ,
  dark_since     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_key, day)
);
```

In the same migration, each open `series_pauses` row with a `resource:telegram:%` key and a cause other than `owner` gets `resumed_by = 'slo'` and `resumed_at = now()`. An inbox note line records it, as `autoResume` does today. The down migration drops the table and leaves the pauses alone.

**States**, computed by the pure `sloState(row, now, dayEnd)`:

| State | When |
|---|---|
| `held` | target 0 (FR-001) |
| `met` | published ≥ target |
| `on_track` | published + planned_ahead ≥ target |
| `behind` | published + planned_ahead < target, capacity left |
| `recovering` | a replacement or recovery run was started in the last hour and has not closed |
| `starved` | `behind` and the ladder (FR-004) has no rung left for today |
| `dark` | no published post for `SLO_DARK_HOURS` while not `held` (overrides the others except `held`) |

**The breaker changes.** `SeriesBreaker.check` still pauses `series:` and `rule:` keys exactly as today; a series that cannot be fed should stop burning runs. It no longer creates `resource:` pauses.

- `streak.ts` still reports streaks of plain slots. The breaker hands them to the controller (`onPlainStreak(channelKey, hit)`), which counts them toward `starved`.
- `plainPausedChannels` and the scheduler gate at `editor.scheduler.ts:173-182` are removed. The controller (FR-003) decides whether a channel gets more plain slots.
- `SeriesPausesRepository.pause` refuses a `resource:telegram:` key unless the cause is `owner`. That is a guard, with a test.

The owner can still pause a channel: `resource_pauses` for whole resources, or the agent pause. Both make the target 0 (`held`).

### FR-003 Replacement slots

**Trigger.** A content slot closes as `skipped`, `failed` or `expired`, and all of these hold:

- the close cause (`classifyClose`, `series-pause/skip-cause.ts:74`) is not `ignore` (budget, config) and not an owner action;
- the slot is not in an approval hold;
- the day's `published + planned_ahead < target`;
- the channel has capacity left (`remainingCapacity`), at least `SLO_REPLACEMENT_LEAD_MIN` before the day's last posting hour;
- the budget gate allows another run (`editor.module.ts:1708-1718` headroom, channel daily cap).

**Insert.** The controller then inserts one replacement slot into the channel's active plan:

- `replaces_slot_id` = the closed slot, using `ON CONFLICT (replaces_slot_id) DO NOTHING` as `approval/approvals.repository.ts:157-169` does. The unique index makes it at most one replacement per closed slot.
- Time: the earliest free time ≥ now + `SLO_REPLACEMENT_LEAD_MIN` (default 15) that respects the channel's spacing and posting hours. It reuses `freeTime`/`roomBlock` from `live/news-watch.ts:160-194`; they move to `slo/slot-time.ts` and news-watch imports them.
- Topic and spec: from the recovery ladder (FR-004).
- `meta.slo = { replaces, rung, cause }`.

**Replans.** A replacement never replaces a replacement of a replacement: a chain stops at depth 2, so it is one try and one retry. `replacePlan`'s `REPLACEABLE` (`repo/editor-plans.repository.ts:182`) leaves slots with `meta.slo` in place, so a replan does not delete them.

**Where the events come from.** The scheduler calls `controller.onSlotClosed(slot)` from the three close paths:

- `skipByCode` (`roles/editor-runner.service.ts:860`);
- the ladder's final skip (`:720-722`);
- `skipStale`.

The call is fire-and-forget with a logged error: it never fails the run that closed the slot.

### FR-004 Recovery ladder by skip cause

`slo/recovery-ladder.ts` exports the pure `nextRung(cause, tried, channel)`. It picks the cheapest rung not yet tried today for this channel:

| Skip cause | Rungs, in order |
|---|---|
| `quality`, `critic` | 1. same series, next material row or item; 2. the channel's lightest format in the mix (text over poll over image); 3. evergreen |
| `no_material`, `source_used` | 1. wider live window, up to `SLO_WIDEN_MAX_HOURS` (48); 2. another pillar or series of the channel whose dataset has runway (runway > 0 in `query_data` stats); 3. evergreen |
| `source_unreachable` | 1. another source of the channel that passed the 076 probe in the last 6 h; 2. evergreen |
| `ignore` (budget, config) | no replacement; the close is counted in `skipped`, and `reason` says why |

**Evergreen** (`silent/evergreen.ts`) stays the last rung. The controller may exceed `EDITOR_EVERGREEN_PER_DAY` only while the channel is `dark`, up to `SLO_EVERGREEN_DARK_MAX` (default 2) evergreen posts a day. Normal days keep the existing cap.

**`starved`.** When no rung is left, the channel becomes `starved`:

- no more replacement slots that day;
- one `info` note is written, plus a line in the daily report (090 FR-011);
- the material shortfall goes to 093 (runway).

### FR-005 Dark channel recovery

When a channel is `dark` (no post for `SLO_DARK_HOURS`, default 24), the controller does the following once per `SLO_DARK_HOURS`, capped at `SLO_MAX_RECOVERY_RUNS_PER_DAY` (default 3):

1. Clears the channel's in-memory `plannerTries` (`editor.scheduler.ts:110`) and its persisted try counter (spec 073 FR-005), so the planner runs again today.
2. Runs the planner with a recovery context:
   - the dark reason;
   - the last 5 skip reasons;
   - an instruction: "plan at least the target; prefer formats and sources that published in the last 14 days".
3. If the planner returns 0 slots for today, or fails, inserts one evergreen slot at the earliest free time (FR-003 timing).
4. Logs the run in `channel_slo.recovery_runs` and as an `autonomy_decisions` row (090 FR-010) with gate `slo_recovery`.

**Reporting.**
- Under 72 h dark, the owner sees only the daily report line.
- At 72 h, the controller writes one `action` note "Channel dark for 3 days" with the reasons and what was tried. It is one per dark stretch, keyed by `dark_since`.
- This replaces today's `dark_day` action note.

### FR-006 Manager hand-off

- **Digest.** The KPI digest (`manager/kpi-digest.service.ts:458-478`) gets one `slo` signal per channel: state, target, published, replacements and the reason.
- **Prompt.** The manager prompt says: "The SLO controller recovers missed posts and dark channels by itself. Do not file `task` directives to make up a missed post. File directives for strategy, format or frequency."
- **Task directives.** A `task` directive for a channel in `recovering` or `dark` is accepted, and its slot is marked `meta.slo.rung = 'directive'`. With no `resource:` pause any more, it can no longer be killed by `skipPlanned` (the 11-06 case).

### FR-007 Detectors read the target

- `silent/silent-days.ts`: the `minPerDay` dependency (`:328`) becomes `dailyTarget`. The `dark_day` record stays as a metric, but its note is `info`; the action note is FR-005's 72 h note.
- `manager/escalation.ts`: it reads the target, and a `held` channel is excluded with its reason. A `starved` or `dark` channel is included even when its pauses would have excluded it before.

### FR-008 Observability

- **API:** `GET /api/editor/slo?day=` returns the `channel_slo` rows for the day, plus the last 7 days per channel.
- **Dashboard:** `/app/health` gets a "Channels" panel. Each row shows:
  - the channel and its state chip;
  - published / target as a small bar;
  - replacements and recovery runs;
  - the reason line;
  - a 7-day strip of met/missed days.

  English UI, compact card + details dialog (AI0-151).
- **Daily report:** «Канали» shows `published/target` per channel instead of the raw post count, with the state word for any channel below target.

### FR-009 Settings

New entries in `apps/automation/src/settings/catalog.ts`, group `editor`, all `live`:

| Key | Default | Range | Meaning |
|---|---|---|---|
| `SLO_CONTROLLER` | `on` | `on` / `off` | `off` restores today's behaviour, including `resource:` pauses |
| `SLO_DARK_HOURS` | 24 | 6–168 | hours without a post before `dark` |
| `SLO_MAX_RECOVERY_RUNS_PER_DAY` | 3 | 0–10 | planner recovery runs per channel per day |
| `SLO_REPLACEMENT_LEAD_MIN` | 15 | 5–240 | the earliest a replacement slot runs after the close |
| `SLO_WIDEN_MAX_HOURS` | 48 | 6–168 | widest live window for the `no_material` rung |
| `SLO_EVERGREEN_DARK_MAX` | 2 | 0–5 | evergreen posts a day while `dark` |

### FR-010 The controller tick

`slo/slo-controller.ts` (`SloController`) runs inside `EditorScheduler.tick`, after the breaker check and before claiming (around `editor.scheduler.ts:198-209`). It replaces the `plainPaused` gate. Per channel in `live` or `approve` mode, it:

1. computes the target (FR-001) and upserts the day row;
2. counts published, planned_ahead and skipped from `editor_slots` for the local day, with one grouped query for all channels;
3. sets the state (FR-002);
4. for `behind` with no open replacement, inserts one (FR-003);
5. for `dark`, runs FR-005 under its caps.

Cost guard: the tick does no LLM call itself. Replacement slots and recovery runs go through the normal runner and budget gate. A unit test caps the controller at 1 replacement and 1 recovery run per channel per tick.

## Not in this spec

- Owner gates and the decision log: **090** (FR-005 writes into its log).
- Card, brief and playbook as one source of truth: **092**. FR-001 picks the playbook over the card until then.
- Refilling datasets and sources when a channel is `starved`: **093**.
- Checking that a recovery strategy worked better than the old one: **094**.
- `preflight_stale` dropping the idea instead of skipping the slot is a separate small fix. It is tracked in the 11-07 diagnosis and can land with T6.

## Tests

- **Unit**
  - `dailyTarget`: card only, clipped by the playbook, clipped by capacity, every `held` case, and a `no_material` pause that keeps the target.
  - `sloState`: every state and the precedence of `dark` and `held`.
  - `nextRung`: every cause; rungs already tried are skipped; `starved` when none is left; the evergreen cap while `dark`.
  - Replacement timing: spacing, posting hours, the lead time, and no slot after the last hour.
  - The breaker no longer pauses `resource:` keys; the repository refuses one without cause `owner`.
  - The controller per-tick caps.
  - Manager prompt line present; digest signal shape.
- **PG** (scratch DB, `EDITOR_PG_TEST_URL`)
  - Migration 104: up, re-up, down; open `resource:telegram:` pauses closed with `resumed_by='slo'`; owner pauses untouched.
  - A skipped slot gets one replacement, idempotent on a second close event.
  - `replacePlan` keeps `meta.slo` slots.
  - A dark channel gets a recovery run and, when the planner returns nothing, one evergreen slot. A second tick in the same hour does nothing.
  - `silent-days` reports `dark_day` as `info` for a starving channel that used to be excluded.
- **Existing tests to keep green:**
  - `editor.scheduler.test.ts`, `plan-rules.test.ts`;
  - `series-pause.060*`, `silent-days*`, `fallback-ladder*`, `evergreen*`;
  - `approvals.service.pg.test.ts`, which shares `replaces_slot_id`.

  No test covers the `plainPaused` gate today; T2 adds the replacement test before the gate is removed.

## Rollout

1. Deploy with migration 104, after 090's migration 103.
2. `SLO_CONTROLLER=on`. Watch `/app/health` → Channels for 3 days: replacements per day, recovery runs, any `starved` reason.
3. Success measure (review §6): over 14 days, ≥ 90 % of channel-days `met`, no channel `dark` longer than 24 h, and no `task` directive filed only to make up a missed post.
