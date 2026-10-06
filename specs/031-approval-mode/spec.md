# 031: Approval mode: the owner approves every agent post while a resource is tested, then switches it to autonomous

**Status:** SPEC · **Depends on:** 010 (chat drafts), 017/018 (agents, Inbox, cards), 019 (platform posts), 020 (planner)
· **Extends:** 023 (schedule changes), 024 (per-resource variants), 025 (directives), 026 (landing claim), 029 (stats)
· **Migration:** `063_approval_mode.sql`

**Owner decision (2026-10-06, chat):** «агенти будуть працювати через мій апрув лише на етапі тестування та відлагодження
платформи, і по дефолту це буде увімкнено для нових ресурсів які я додаватиму, після цього я можу перемкнути і агент буде
працювати автономно».

## Why
Today a resource is either `shadow` (the agent writes a preview, nothing goes out) or `live` (the agent publishes on its
own). There is nothing in between, so the owner cannot launch a new resource with real posts and still check each
one. This spec adds a third working mode, `approve`. In this mode the agent plans, writes and schedules posts as in
live, but every post waits for the owner's approval before it is sent. It is the default for every new resource. The
owner switches a resource to autonomous (`live`) when they trust it, and can switch it back at any time.

## Current state (as-is)
- **Modes.**
  - `editor_channels.mode` is `off | shadow | live` (042).
  - Agents have the same modes (`agents.mode`).
  - The effective mode of a slot is `live` only when both the orchestrator and the card are `live`
    (`editor-runner.service.ts:162`).
- **New agents.** They start in `shadow` for `SHADOW_DAYS = 3` (`agent-creator.ts`). After that, `agents-housekeeping`
  posts a `go_live` Inbox card (`editor.module.ts:275`).
- **Shadow.**
  - `publish_post` stores the spec and preview and sets the slot to `shadowed` (`role-tools.ts:126`).
  - Platform posts get `platform_posts.status='shadowed'` (051).
- **Chat drafts (010, 047).** `editor_drafts` has the statuses `draft | scheduled | published | failed | canceled` and
  can link to a slot. Since 48e54c2 the dashboard shows a Telegram-style preview of a draft (`DraftCard`,
  `TelegramPreview`).
- **Timing.** Slots are written at their scheduled time. There is no lead time, so a written post could not wait for
  an approval anyway.

## Functional requirements
| ID | Requirement |
|---|---|
| FR-001 | **Mode `approve` (`063_approval_mode.sql`).** <br>• `approve` is added to `editor_channels.mode` and `agents.mode`. <br>• The slot statuses `awaiting_approval`, `approved` and `expired` are added to `editor_slots`; `awaiting_approval` is added to `platform_posts.status`. <br>• `editor_channels` gets `approval_hold_hours int default 6` and `approval_lead_hours int default 12`. <br>• `editor_slots` gets `approved_at`, `approved_by` (`owner`), `owner_edited bool` and `reject_reason text`. <br>• The effective mode is the lowest of the orchestrator's and the card's mode, in the order `off < shadow < approve < live`. |
| FR-002 | **Default for new resources.** <br>• Every new resource and agent starts in `approve`. This covers `agent-creator`, connecting a Telegram channel, a Meta/TikTok account, a YouTube or LinkedIn resource (030) and an independent resource (024). <br>• This replaces the 3-day shadow start. <br>• `shadow` stays available as a manual dry-run mode. <br>• The migration does not change the mode of existing resources. |
| FR-003 | **Lead time.** <br>• In `approve`, the executor writes a slot ahead of time. The batch for the next day is written at 20:00 in the resource's zone. A slot added later is written at least `approval_lead_hours` before it is due, capped at 3 h for slots created less than 12 h ahead. <br>• Time-sensitive formats (news, a feed source) are written 2 h before the slot and carry a `freshness_deadline`. |
| FR-004 | **Waiting posts.** <br>• In `approve`, `publish_post` and `publish_platform` run every check of a live publish: lint, dedup and a dry render. Media are fully prepared, including carousel slides and album files, so the owner sees exactly what will go out. <br>• The slot then goes to `awaiting_approval`, with the spec, the rendered preview and the `render.messages` used by `TelegramPreview`. <br>• Nothing is sent. The tool returns `{ok: true, awaiting_approval: true}` so the agent ends the run normally. |
| FR-005 | **Where the owner approves.** <br>• **Inbox:** a section «Пости на апрув», grouped by resource and day. <br>• **Agent chat and agent page:** the same card. <br>• **Card contents:** the Telegram or platform preview (`TelegramPreview`, with platform previews for the other networks), the slot time in the resource's zone, the agent's rationale (idea, source, why this time), and the actions. <br>• **Menu badge:** the waiting count (027 badges). <br>• **Telegram alert:** one message per resource per batch ("6 постів на завтра чекають апруву → link"), not one per post. v1 does not approve from Telegram. |
| FR-006 | **Actions.** <br>• **Approve:** the slot becomes `approved` and is published at its scheduled time by the normal slot runner. If the time has passed and the delay is under 2 h, it is published now. Otherwise the agent is asked to move it to the next free slot. <br>• **Edit and approve:** the owner edits inline (the chat-draft editor). The edited spec passes lint again, and `owner_edited=true` is set. <br>• **Reschedule:** a new time, checked against quiet hours and the series spacing. <br>• **Reject:** an optional reason; the slot becomes `skipped`. If there is time before the slot (`approval_lead_hours`), the agent gets one retry for a replacement, which also needs approval. <br>• **Bulk:** «Апрувнути все на завтра» per resource, and per network. Bulk never includes posts with lint warnings. |
| FR-007 | **Expiry.** A post still waiting `approval_hold_hours` after its slot time becomes `expired` and is never published by itself. A post with a `freshness_deadline` expires at that deadline. The agent sees expired slots in its history, and the daily digest counts them. |
| FR-008 | **Learning.** Each edit (before/after diff) and each reject reason is saved to the agent's memory as an owner preference ("owner shortened the intro", "rejected: the topic was posted yesterday"). The planner and executor prompts read the last 20 entries. |
| FR-009 | **Interplay with other specs.** <br>• **023:** in `approve`, every schedule change, including a series time shift of 90 min or less, goes through a card. The silent ≤ 90 min shift applies only in `live`. A strategy cutover (023 FR-012) moves a resource to `approve`, not `live`. <br>• **024:** each resource variant (duplicate, adapt, unique) is its own waiting post. The card shows the variants of one idea together, with «Апрувнути всі варіанти». <br>• **025:** directives apply as before; the posts they produce still wait for approval. <br>• **022:** promo and repost slots wait for approval. <br>• **Sponsored and reserved slots:** not affected, because the deal was already approved (015). |
| FR-010 | **Switching to autonomous.** <br>• Only the owner switches `approve → live`, per resource or per network, through a confirm dialog. The dialog shows the last 14 days: approved without edits, edited, rejected and expired. It also asks "approve the N waiting posts as well?" (default yes). <br>• `live → approve` is one click, always allowed, and takes effect from the next written slot. <br>• Agents and MANAGER can never change a mode. MANAGER may file an **advice** (025) "ready for autonomy" when a resource has ≥ 20 approved posts in 14 days and ≥ 90 % of them were approved without edits. |
| FR-011 | **Stats.** <br>• On the agent page and in the 029 Agents card: approval rate, edit rate, top reject reasons, median time to approve, and expired count. <br>• `GET /api/editor/approvals?status=&resource=&from=&to=` and `POST /api/editor/approvals/:slotId/{approve,edit,reschedule,reject}`, behind `TrackingAuthGuard`. |

## Corner cases
- **Mode switch while posts are waiting.**
  - `approve → live`: the dialog choice decides (approve them, or leave them waiting until they expire).
  - `approve → shadow` or `approve → off`: waiting posts become `skipped` with the reason `mode_changed`.
- **Resource paused or token broken after approval.** An approved post is not published. It follows the normal
  failed-slot path and appears in the failures badge.
- **The owner edits after approval but before publish.** Allowed until 2 minutes before the slot. After that the
  card is locked.
- **Source got stale while waiting** (news superseded, dedup hit by another resource). The publish step re-runs dedup.
  On a hit, the slot is `skipped` with the reason `dedup_after_approval`, and the owner sees it.
- **Budget block (029).** A blocked writer produces no waiting post. The Inbox shows the budget block instead of an
  empty approval list.
- **Two browser tabs approve the same post.** Approval is single-flight: `UPDATE … WHERE status='awaiting_approval'`.
  The second call gets `409 already_decided`.

## Non-goals
- Approving from Telegram (012 owner control bot).
- More than one approver, or roles.
- Approval of DM replies (DM triage already waits for the owner) or of ads (015).

## Success criteria
- A new resource created by `@ai0` starts in `approve`. Its first day's posts appear in «Пости на апрув» the evening
  before, each with a preview identical to what is sent.
- No post from an `approve` resource reaches a platform without an `approved_at`. A pg e2e test proves this for
  Telegram and one platform.
- An expired post is never published. A rejected one gets at most one replacement.
- After `approve → live`, the next slot publishes without a card. After `live → approve`, the next slot waits.
- Tests: the mode ordering, lead-time scheduling, single-flight approve, expiry, edit → lint, dedup after approval,
  and the mode-switch dialog choices.

## Open questions for the owner
1. **Hold window after the slot time.** Default 6 h, then `expired`. Should it be shorter or longer?
2. **When to write the next day's posts.** Default 20:00 in the resource's zone, so the owner approves the batch in the
   evening. Would morning (e.g. 08:00 for the same day) suit you better?
3. **Telegram alert.** Default: one message per resource per batch. Should it be one digest for the whole network
   instead?
4. **MANAGER "ready for autonomy" advice threshold.** Default ≥ 20 approved posts in 14 days, ≥ 90 % without edits.

## Task breakdown
### T1: Add the `approve` mode and make it the default
**Scope:** migration 063 (FR-001); the effective-mode ordering; new resources and agents start in `approve` (FR-002);
the mode selector in the dashboard shows «На апруві»; the shadow-days start and the `go_live` housekeeping card are
replaced.
**Acceptance:** mode-ordering tests; a resource made by `agent-creator` and by each connect flow is `approve`;
existing resources keep their modes.
**Size:** M · **Depends on:** —

### T2: Write ahead and hold waiting posts
**Scope:** lead-time scheduling (FR-003); `publish_post` and `publish_platform` with full media preparation and the
`awaiting_approval` path (FR-004); the runner publishes `approved` slots on time; expiry and the freshness deadline
(FR-007); dedup re-check at publish time.
**Acceptance:** the pg e2e test proves no publish without `approved_at`; expiry and dedup-after-approval tests; the
preview equals the sent payload (snapshot).
**Size:** L · **Depends on:** T1

### T3: Approval cards, actions and the Inbox section
**Scope:** the API (FR-011); the «Пости на апрув» Inbox section; cards in the agent chat and on the agent page
(`TelegramPreview` and platform previews); approve, edit, reschedule, reject, bulk and approve-all-variants (FR-005,
FR-006); the menu badge; single-flight approve.
**Acceptance:** browser check in the dev preview at desktop and 375 px; the 409 on a double approve; an edit re-runs
lint; bulk skips posts with warnings.
**Size:** L · **Depends on:** T2

### T4: Telegram batch alert
**Scope:** one message per resource per batch with the count and a dashboard link (FR-005); dedupe across restarts.
**Acceptance:** one alert per batch; no alert when the batch is empty.
**Size:** S · **Depends on:** T2

### T5: Switch between approval and autonomous
**Scope:** the confirm dialog with 14-day stats and the "approve the waiting posts" choice (FR-010); `live → approve`
in one click; per-network switch; MANAGER "ready for autonomy" advice; the 023/024/025/022 rules from FR-009.
**Acceptance:** after `approve → live` the next slot publishes without a card; agents cannot change a mode (a tool
test); the advice fires only above the threshold.
**Size:** M · **Depends on:** T3

### T6: Learn from edits and rejections, show the stats
**Scope:** edit diffs and reject reasons into agent memory, with the last 20 in the planner and executor prompts
(FR-008); the approval stats on the agent page and in the 029 Agents card (FR-011).
**Acceptance:** a reject reason appears in the next planner prompt (fixture); the stats match a fixture.
**Size:** M · **Depends on:** T3
