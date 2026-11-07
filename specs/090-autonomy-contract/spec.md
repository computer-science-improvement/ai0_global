# 090 — Autonomy contract: owner silence is a default, not a veto

Status: proposed · P0 · Builds on 012 (owner bot), 025 (resource pauses), 042/057 (setup proposals), 053/065 (directives), 055 (audit), 060 (series pauses), 072 (readiness), 078 D5 (note demotion) · Pairs with 091 (channel SLO controller) · Migration 103

> Source: the autonomy review (`docs/reviews/2026-11-07-autonomy-review.md` §3.1, §4, §5.1, §5.8) and the owner's goal of 2026-11-07: "the system runs the channels with no owner action, or very little". The gate inventory below was read from the code at `72bd12c8`. Paths are relative to `apps/automation/src/editor/` unless stated otherwise.

## Why

The system notices problems within hours. Repairing them, though, waits for the owner in **15 places**, and only 2 of them do anything when the owner stays silent:

- resource pauses (spec 025) lift themselves at `until`;
- since `72bd12c8`, a series pause for "no material" lifts itself after `SERIES_PAUSE_RETRY_HOURS`.

Every other gate drops the change, expires it, or waits forever:

| Gate | What happens on silence today |
|---|---|
| Structural directive (`awaiting_owner`) | dropped after 12 h (`timeout_dropped`), unless its kind is in `DIRECTIVE_TIMEOUT_APPLY_KINDS`. That setting was empty until 2026-11-07, when it was set on dev-stage. Even an applied one then waits up to 24 h more for the orchestrator (`RESOLVE_WITHIN_MS`, `manager/manager-runner.ts:48`). After 5 drops in a row the manager writes itself "propose such directives less often" (`manager-runner.ts:463-465`). |
| Contested directive | the refusal stands after 24 h |
| Pending action (every Apply card) | expired after 24 h (hard-coded `ACTION_TTL_MS`, `agents/pending-actions.ts:20`) |
| Setup proposal (042) | expired after 14 days |
| Playbook version `pending_owner` | waits forever |
| Audit findings "fixable in one click" | wait forever; the next weekly report rebuilds them |
| Readiness fixes except `tools_allow_add` and `hashtag_min_zero` | wait forever |
| Series pause for an unreadable source, even when readiness says the cause is gone | waits forever |
| Launch graduation (default `propose`) | waits forever |
| Action notes without a gate object (`dark_day`, `low_runway`, `host_struck`, `escalation`, …) | stay unread; after 3 repeats they are demoted to `info` |

The owner did not act on any of the 13 action notes or the 14 Telegram cards of the review week (§1 of the review). Under that reality, "wait for the owner" means "do nothing", and two channels stayed dark for 6 and 15 days.

## Principle

Every gate declares what happens when the owner is silent:

- a **reversible** change applies after a timeout, with a trace and an undo;
- an **irreversible or outward-facing** change still waits, or is dropped.

The owner keeps a short list of decisions that are theirs by nature (FR-009). Everything else becomes a decision the system makes and the owner can reverse.

## What

### FR-001 One registry of owner gates

New module `autonomy/owner-gates.ts` holds a closed registry, one entry per gate type:

```ts
interface OwnerGate {
  key: GateKey;                 // 'directive' | 'pending_action:<kind>' | 'playbook' | 'audit_fix:<kind>' | …
  onSilence: 'apply' | 'drop' | 'wait';
  afterHours: () => number;     // read from the setting named in the table, live
  reversible: boolean;          // true only when FR-010 can undo it
  humanOnly?: true;             // FR-009: never applied by code, the owner is reminded weekly
}
```

The entries are listed in the table below. A unit test pins the registry: adding a gate, or changing an `onSilence` of `wait` or `drop` to `apply`, fails the test, so every such change is a reviewed decision. Every timeout path named in FR-002 to FR-008 reads its behaviour from the registry, not from local constants.

**Master switch:** `OWNER_SILENCE` (`act` | `wait`, default `act`, live).

- `act` uses the registry.
- `wait` turns every `apply` into today's behaviour: drop for directives and pending actions, wait for the rest. This lets the owner go back to the old contract in one setting.

| Gate key | onSilence | after (setting, default) | reversible |
|---|---|---|---|
| `series_pause:no_material` | apply (resume) | `SERIES_PAUSE_RETRY_HOURS`, 24 | yes |
| `series_pause:source_unreachable` | apply (resume) **when readiness reports `pause_cause_gone`** | next readiness recheck | yes |
| `series_pause:owner` | wait | — | — |
| `directive:<reversible kind>` (FR-002) | apply | `DIRECTIVE_TIMEOUT_HOURS`, 12 | yes |
| `directive:cross_promo`, `directive:strategy`, `directive:pause_resource`, `directive:repost` | drop | `DIRECTIVE_TIMEOUT_HOURS`, 12 | — |
| `directive_contest` | drop (the refusal stands) | `DIRECTIVE_CONTEST_TIMEOUT_HOURS`, 24 | — |
| `pending_action:change_source` (add or limit, proven by the 076 probe, not chat) | apply | `PENDING_ACTION_TTL_HOURS`, 24 | yes |
| `pending_action:edit_data_schema` (not chat) | apply | 24 | yes |
| `pending_action:*` created in a chat (`chat_id` set) | drop | 24 | — |
| `pending_action:repurpose`, `set_network_mode`, `migrate_strategies`, `strategy_cutover`, `strategy_rollback`, `file_directive` | drop | 24 | — |
| other non-chat `pending_action:*` | drop | 24 | — |
| `playbook` (non-structural for FR-004) | apply | `PLAYBOOK_PENDING_HOURS`, 48 | yes |
| `playbook` (structural for FR-004) | wait | — | — |
| `setup_proposal` | apply the safe sections (FR-007) | `SETUP_PROPOSAL_APPLY_HOURS`, 72 | yes |
| `audit_fix:<safe kind>` (FR-006) | apply | `AUDIT_AUTO_FIX_HOURS`, 24 | yes |
| `audit_fix:<other kind>` | wait | — | — |
| `readiness_fix:<safe kind>` | apply (today's `AUTO_SAFE_FIX_KINDS` plus `series_resume` when the cause is gone) | next recheck | yes |
| `launch_graduation` | apply when no readiness blocker (`LAUNCH_GRADUATION=auto`) | as today | yes |
| `post_approval` (mode `approve`) | drop (as today: the owner chose to approve posts) | `approval_hold_hours` | — |
| `mode_switch`, `launch_start`, `bot_admin`, `credential`, `budget_raise`, `steering_set`, `network_offer` | wait, `humanOnly` | — | — |

### FR-002 Directives apply on silence, without the second wait

1. **Default kinds.** The catalog default of `DIRECTIVE_TIMEOUT_APPLY_KINDS` becomes `frequency,format_mix,format_shift,voice_fix,task,pause_series,experiment,advice`. The registry is the source; the setting stays as an override. Kinds left out of the default: `cross_promo` (it posts to another owner's channel), `strategy` (it only leads to a playbook gate), `pause_resource` (it silences a channel), and `repost`.
2. **No second wait.** A directive that is `timeout_applied` skips the orchestrator's 24 h answer window:
   - it goes to its executor at once, or to `directive_auto_applied` when there is no executor;
   - the orchestrator still gets the directive in its next run and can `contest` it;
   - a contested, already-applied change is rolled back with its executor's undo (FR-010).
3. **No back-off memory.** The `NOT_RESPONDING_AFTER` block in `manager-runner.ts:463-465` is removed: owner silence must not teach the manager to do less. Instead, the manager's KPI digest gets one fact line, "owner answered N of M structural directives in 14 days". It is information, not an instruction.
4. **Help text.** The help text of `DIRECTIVE_TIMEOUT_HOURS` says what happens: "kinds in DIRECTIVE_TIMEOUT_APPLY_KINDS are applied, the rest expire".
5. **Weekly report.** `weekWork` (`owner-bot/owner-reports.ts:214-240`) counts `timeout_applied` and `timeout_dropped` in separate lines.

### FR-003 Pending actions: a TTL setting and a per-kind silence policy

- **TTL setting.** `ACTION_TTL_MS` becomes the live setting `PENDING_ACTION_TTL_HOURS` (default 24, min 1, max 168).
- **Expiry routes by the registry.** `expireOld` (`agents/pending-actions.ts:56-60`) routes each card through the registry:
  - **apply:** the card is applied with `applied_by = 'auto:silence'`, through the same handler as the owner's Apply (`pending-actions.ts:181-206`). A failed apply becomes `failed`, with the error in the card and the decision log.
  - **drop:** status `expired`, as today.
- **`change_source` applies on silence only when:**
  - it adds or limits a source (never removes one);
  - the source passed the 076 probe within the last 6 h;
  - the card is not from a chat.

  A removal waits; a source that fails the probe is dropped.
- **Chat cards** (`chat_id` set) always drop. The owner was in that conversation and chose not to press Apply.

### FR-004 Playbook versions apply on silence unless they are structural

A `pending_owner` playbook version older than `PLAYBOOK_PENDING_HOURS` (default 48, live) becomes `active`, exactly as the owner's approve does (`network/network.repository.ts:319-324`), with `decided_at` set and the decision logged. **Exception:** it keeps waiting when, compared with the active version, it does any of these:

- changes or deletes a series with `locked: true` or `origin: 'owner'`;
- adds or removes a platform section;
- was built by a `strategy` directive;
- changes `rules` lines that came from an owner rule (`owner_rule` memory).

The comparison is a pure function `structuralForSilence(prev, next)` next to `network/playbook.ts:282-322`, with tests.

### FR-005 Pauses

- **`series_pause:no_material`:** as shipped in `72bd12c8` (`series-pause/series-breaker.ts:106-122`). The decision is now also written to the log (FR-010).
- **`series_pause:source_unreachable`:** when a readiness recheck reports `pause_cause_gone` for a pause (`readiness/checks/pauses.ts:80-92`), the `series_resume` fix is applied by code. `AUTO_SAFE_FIX_KINDS` gains `series_resume`, limited by a guard to findings whose code is `pause_cause_gone`. The test that pins the list changes on purpose.
- **091 change:** under 091, whole-channel `resource:telegram:<key>` pauses are no longer created at all. See 091 FR-002.

### FR-006 Audit fixes apply on silence for safe kinds

Open findings of the weekly audit (`sysadmin/audit.service.ts`) whose fix kind is safe are applied by code once the report is older than `AUDIT_AUTO_FIX_HOURS` (default 24, live). The audit schedule's hourly check runs `runFix` (`sysadmin/fix-runner.ts`) with `by = 'auto:silence'`.

| Fix kind | Silence | Why |
|---|---|---|
| `memory_retire` | apply | retires a stale memory line; reversible (re-activate) |
| `tools_allow_add` | apply | already auto-safe in readiness |
| `hashtag_min_zero` | apply | already auto-safe in readiness |
| `series_resume` | apply only for `pause_cause_gone` | as FR-005 |
| `series_source_require` | apply | binds a series to its own dataset; reversible |
| `skill_inline_off` | apply | reversible toggle |
| `conflicts_resolve` | wait | rewrites config; the owner's eyes (092 makes most of these disappear) |
| `skill_disable` | wait | can weaken an agent |
| `source_drop` | wait | destructive |
| `host_proxy_add` | wait | infrastructure and egress |

A failed fix stays `failed` and is reported once in the daily report.

### FR-007 Setup proposals apply their safe sections

A setup proposal (042) in status `ready` that is older than `SETUP_PROPOSAL_APPLY_HOURS` (default 72, live) gets its safe sections applied by code with `setup-apply.ts`. Safe sections are those that only change:

- the channel brief's tone and voice;
- examples;
- the hashtag policy;
- posting hours within the card's range.

Sections that change sources, platforms, series or the format mix stay `ready` until `SETUP_PROPOSAL_TTL_DAYS` and then expire, as today. The proposal becomes `partially_applied`.

The section names are read from `setup/setup.types.ts` at implementation time. The safe list is a closed constant with a pinning test.

### FR-008 Launch graduation

The catalog default of `LAUNCH_GRADUATION` becomes `auto`. Graduation stays held by readiness blockers (`launch/launch.service.ts:296-313`). Launch **Start** and bot admin rights stay human (FR-009).

### FR-009 What stays with the owner

These gates are `humanOnly`. Code never applies them. Each one keeps its card, and an open one is listed in the weekly report under «Чекає саме на вас» with its age:

1. credentials and connections: `connection_broken`, `resource_health` with `token_invalid` / `token_expired`, bot admin rights;
2. budget raises after `budget_blocked`;
3. channel mode switches (`off` / `shadow` / `approve` / `live`) and post approvals in `approve` mode;
4. launch Start;
5. cross-promotion with another owner's channel, network mode, strategy migrations;
6. steering sets and network offers.

These are the only kinds that send a Telegram alert or card on their own (FR-011).

### FR-010 Every silent decision is logged and, where possible, undoable

**Migration 103** adds the decision log:

```sql
CREATE TABLE IF NOT EXISTS autonomy_decisions (
  id          BIGSERIAL PRIMARY KEY,
  gate        TEXT NOT NULL,                 -- registry key, e.g. 'directive:frequency'
  ref_type    TEXT NOT NULL,                 -- 'directive' | 'pending_action' | 'playbook' | 'audit_finding' | 'series_pause' | 'setup_proposal' | …
  ref_id      TEXT NOT NULL,
  channel_key TEXT,
  action      TEXT NOT NULL CHECK (action IN ('applied','dropped','resumed','failed','undone')),
  summary     TEXT NOT NULL,                 -- one English line for the dashboard and the report
  undo        JSONB,                         -- how to reverse it; null = cannot be undone by code
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at   TIMESTAMPTZ,
  undone_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_at ON autonomy_decisions (decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_channel ON autonomy_decisions (channel_key, decided_at DESC);
```

**Undo per kind:**

| Kind | Undo |
|---|---|
| pause resume | re-pause with the same key, cause `owner` |
| playbook activation | re-activate the previous version |
| `change_source` | the inverse source change |
| `edit_data_schema` | the previous description |
| audit and readiness fixes | the fix's own inverse where `fix-runner` has one; otherwise `undo = null` |
| directive | its executor's rollback (the playbook version or resource pause it wrote) |

The undo is a typed record; a pure function maps it to the call.

**API:**
- `GET /api/autonomy/decisions?channel=&since=` lists decisions.
- `POST /api/autonomy/decisions/:id/undo` reverses one where `undo` is set, and writes an `undone` row.

**Dashboard:** `/app/health` gets a section "Decided without you" with the last 14 days and an Undo button where possible. All text is English, in the compact card + details dialog pattern (AI0-151).

### FR-011 The owner gets a digest, not a queue

1. **Daily report** (`owner-bot/owner-reports.ts:296-324`): a new section «Зроблено без вас», placed after «Канали».
   - Counts by gate family from `autonomy_decisions` for the day, plus up to 5 lines.
   - Failed silent decisions are listed first.
   - The section is left out when it is empty.
2. **Weekly report:** «Чекає саме на вас» lists the open FR-009 items with their age. Silent decisions get one line per family for the week.
3. **Alerts:** inbox notes of every kind outside FR-009 are posted as `info`. They are visible in the Inbox and counted in the daily report, but send no Telegram card or alert. The demotion logic (spec 078 D5) stays for FR-009 kinds.
   - The kinds this changes: `dark_day`, `series_missed`, `series_paused`, `low_runway`, `host_struck`, `escalation`, `directive_ignored`, `directive_failed`, `audit_report`, `loadout_suggestions`, `event_not_covered`, `evergreen_fallback`, `playbook_pending`, `directive_structural`.
   - Under 091, `dark_day` becomes a controller signal and reaches the owner only through the report. The exception is a channel dark for more than 72 h, which 091 FR-005 reports once as `action`.
4. **Owner bot sweep:** the sweep closes a card whose item was decided by silence with the outcome «Застосовано автоматично» or «Скасовано автоматично». Today it says «Минув термін» or «Вирішено в дашборді» (`owner-bot/owner-bot.service.ts:160-165`). It does this by reading `autonomy_decisions` for the ref.

### FR-012 Settings

New entries in `apps/automation/src/settings/catalog.ts`, group `editor`, all `live`:

| Key | Default | Range |
|---|---|---|
| `OWNER_SILENCE` | `act` | `act` / `wait` |
| `PENDING_ACTION_TTL_HOURS` | 24 | 1–168 |
| `PLAYBOOK_PENDING_HOURS` | 48 | 0–720 (0 = wait forever) |
| `AUDIT_AUTO_FIX_HOURS` | 24 | 0–720 (0 = off) |
| `SETUP_PROPOSAL_APPLY_HOURS` | 72 | 0–720 (0 = off) |

Changed defaults: `DIRECTIVE_TIMEOUT_APPLY_KINDS` (FR-002) and `LAUNCH_GRADUATION=auto` (FR-008). An existing row in `app_settings` wins (spec 039 "DB wins"). The dev-stage row written on 2026-11-07 (`frequency,format_mix,format_shift,voice_fix,task`) stays until the owner resets it.

The help texts are English and say what silence does.

## Not in this spec

- The channel controller, replacement slots and the dark-channel recovery: **091**.
- One source of truth for card, brief and playbook settings, and `inferred` settings: **092**.
- Material runway and imports applied without a card from approved sources: **093**. Until then, `import_list` cards stay chat-only and drop on silence.
- Effect verification and rollback by metric: **094**. FR-010's undo is manual or contest-driven.
- Credential expiry forecasts: **095**.

## Tests

- **Unit**
  - Registry pinning: the keys, the `onSilence` per key and the `humanOnly` set.
  - `OWNER_SILENCE=wait` maps every `apply` back to today's behaviour.
  - `structuralForSilence` cases: locked series, owner series, platform added, strategy origin, owner-rule line; plus a tone-only change that is not structural.
  - Pending-action routing: chat vs non-chat; `change_source` add with a fresh probe (apply), add with a failed probe (drop), removal (wait/drop).
  - Audit safe-kind list pinning; readiness `series_resume` only on `pause_cause_gone`.
  - Report sections: «Зроблено без вас» with and without decisions; `timeout_applied` and `timeout_dropped` counted.
- **PG** (scratch DB, `EDITOR_PG_TEST_URL`)
  - Migration 103: up, re-up, down.
  - A directive `awaiting_owner` past the timeout becomes `timeout_applied` and runs its executor in the same housekeeping pass, with a decision row.
  - A pending `change_source` past the TTL is applied, with a decision row and a working undo.
  - A `pending_owner` playbook past 48 h is activated; a structural one is not.
  - An audit finding of `memory_retire` is applied after 24 h; `source_drop` is not.
  - Undo of a pause resume re-pauses.
- **Regression:** the NOT_RESPONDING memory line is never written (`manager-060.test.ts` or the housekeeping test).

## Rollout

1. Deploy with migration 103.
2. `OWNER_SILENCE=act` is the default. On dev-stage, watch «Зроблено без вас» for 3 days, and Undo anything wrong from `/app/health`.
3. Ship together with 091, or before it. 090 alone already removes the "nothing happens" outcome of the directive, playbook and audit gates.
