# inbox: Handoff §5 Inbox (/app/agents/inbox), prototype App-Inbox.dc.html, backend gaps #1/#2/#3

## Checks

- [missing] docs/ui-data-contract.md is the source of the §5.2 endpoints — File not in repo (ls fails, no git history). Every row below was checked against code instead.
- [confirmed] Tabs Critical/Action/FYI are a client filter on severity from GET /api/agents/inbox — agents.controller.ts:19-22 (?unread=true|1), agents.service.ts:570-572 (limit 200, no paging), owner-inbox.ts:241-249; severity CHECK in ('info','action','critical') at migration 049_agents.sql:110 → FIX: There is no paging or 'before' param, so the prototype's 'N older notes · Load more' has no backend. Tab counts only cover the 200 loaded rows.
- [confirmed] Mark as done = POST /api/agents/inbox/read {ids:[id]}; Mark all = {ids:'all'} — agents.service.ts:574-578 zod strict {ids: number[] (max 500) | 'all'} -> {marked:number}; hook useMarkInboxRead api/agents.ts:413-419 → FIX: 'all' marks every unread note, including those on other tabs. On a filtered tab, send the visible ids.
- [partial] Grouping duplicates (2 Threads notes -> one) needs subject (gap #1) — agent_inbox.subject/parts/actions columns exist (093_series_pauses.sql:41-43). subject is per resource: 'resource:<ref>' (resource-health.service.ts:59), 'connection:<ref>' (connection-keeper.ts:92), 'silent:<ref>:miss|critic' (silent-days.ts:94-95). → FIX: Two Threads accounts never share a subject. Cross-account grouping needs a client rule on kind + parts ('state:token_invalid') + platform. subject only merges repeats of the same problem.
- [wrong] resource_health/_daily/connection_broken: Threads -> POST /api/meta-accounts/:id/refresh-threads-token — connection-keeper.ts:99-107: Threads cannot refresh an expired token, only a reconnect helps. meta-accounts.controller.ts:126-151 needs a live token. → FIX: Offer refresh only for state token_expiring. For token_invalid/no_access, link to /app/connections?section=meta. The state is in the title, or in parts once gap #1 lands.
- [partial] ref -> accountId mapping for health notes (uncertain) — resource_health: refType 'resource', refId '<platform>:<id>' (agent.types.ts:105-115 resourceRef/parseResourceRef). For threads, instagram and facebook the id is meta_accounts.id; tiktok uses tiktok_accounts.id; telegram uses the channel key. resource_health_daily: refType 'resource_day', refId '<ref>|<YYYY-MM-DD>#<8hex>' (owner-inbox.ts:43,128). connection_broken: refType 'resource_day', refId 'bot:<my_bots.id>|…', 'telegraph:<id>|…' or 'mtproto:<id>|…' (connection-keeper.ts:159,179,198) → FIX: Parse with refId.split('#')[0].split('|')[0], then split on the first ':'. bot/telegraph/mtproto are not Platforms, so map them separately.
- [confirmed] Bot verify POST /api/my-bots/:id/verify; MTProto POST /api/mtproto-sessions/:id/verify; TikTok GET /api/tiktok/oauth/start — my-bots.controller.ts:60, mtproto-sessions.controller.ts:65, telegraph-accounts.controller.ts:65, tiktok-oauth.controller.ts:20-23 returns {url} → FIX: The MTProto verify opens a second connection. The keeper avoids this on purpose (AUTH_KEY_DUPLICATED risk, connection-keeper.ts:75-79), so link to /app/connections instead of making it one click.
- [missing] Gap #4 one-step connection check — No controller re-checks one resource's health. ResourceHealthService.check(ref) (resource-health.service.ts:43) is reusable.
- [confirmed] series_paused Resume = POST /api/agents/:handle/series-pauses {action:'resume', id: refId} — agents.controller.ts:114-117, agents.service.ts:389-400; the note refType 'series_pause', refId = pause uuid (series-breaker.ts:100-101). The dashboard resume also marks the pause's notes read (pause-actions.ts:39-42). → FIX: handle comes from note.agentId via useAgentTree. agentId can be null (series-breaker.ts:100 catches to null). Gap #2 avoids that case.
- [confirmed] series_paused Keep paused = gap #2 — keep exists only in SeriesPauseActions.keep/run (pause-actions.ts:58-63,84-94), reached from Telegram (card-sources.ts:283-286)
- [confirmed] series_missed/dark_day Replan tomorrow = POST /api/editor/channels/:key/replan?date=tomorrow — editor.controller.ts:40-42 (@Controller('api/editor')), editor-ops replan accepts today|tomorrow, 409 replan_in_progress; hook useReplan api/editor.ts:61-66 → FIX: key is the channel key. Get it from refId '<resourceRef>|<day>#h8' where the ref is 'telegram:@x'. A non-telegram ref (COALESCE resource_ref, silent-days.ts:279) has no channel, so use the orchestrator's telegram scope (agentId -> tree).
- [partial] Pause series = gap #3 — Silent-day notes already store pause keys 'pause:[channelKey, seriesKey, label]' in agent_inbox.actions (silent-days.ts:350, note-actions.ts:30-37). → FIX: Gap #2 covers this for the Inbox. Gap #3 is only needed outside the Inbox (agent page, Calendar).
- [partial] critic_reject_streak: Open channel + Pause series — severity action, refType resource_day; carries pauseActions (silent-days.ts:224-228,350); /app/editor/$channel route exists
- [confirmed] manager_escalation: Ask @manager via /app/chat prefill (verify param) — app.chat.tsx:44-48 search param q (max 2000), used as the composer prefill (:41,84). Note refId 'escalation:<handle>:<kind>|<day>#h8' (escalation.ts:40-42,167)
- [confirmed] directive_structural Approve/Decline — manager.controller.ts:19-23; 409 not_awaiting_owner; hook useDecideDirective api/manager.ts:238 → FIX: Deciding does not mark the note read, so also call markRead([id]). There is no GET for a single directive; read status from useDirectives.
- [confirmed] directive_contested Accept refusal / Uphold — manager.controller.ts:26-31; 409 not_contested; hook useContestDecision api/manager.ts:~252
- [confirmed] directive_ignored/directive_failed -> @manager?tab=directives — inboxTarget lib/directive-view.ts:246-250; route InboxLinks lines 112-116 (search {tab:'directives', directive:id}). directive_failed is info for advice (executors/index.ts:170).
- [confirmed] playbook_pending Approve/Reject — network.controller.ts:25-29; refType 'playbook', refId pb.id (series-edit.ts:139-150, strategy-migration.service.ts:175-182); hook useDecidePlaybook api/network.ts:255
- [partial] skill_self_edit/skill_rolled_back/skill_probe: Roll back = POST /api/skills/:id/rollback — agents.controller.ts:155; body {version:int>=1} required (agents.service.ts:327-333). The note has only the skill id (refType 'skill'). → FIX: The version must come from useSkillVersions(id) (api/agents.ts:369). Safer to link to the agent's ?tab=skills.
- [confirmed] ready_for_autonomy Go live via AutonomyDialog — refType 'channel', refId channelKey (editor.module.ts:1449-1450); AutonomyDialog({channel}) components/approvals/AutonomyDialog.tsx:12 → FIX: Its severity is info, so it appears under FYI.
- [confirmed] shadow_ended Choose mode = PATCH /api/agents/:handle {mode} — refType 'agent', refId handle (editor.module.ts:883-890); PatchSchema mode enum (agents.service.ts:83) → FIX: Reuse AgentModeSwitch (AgentsUi.tsx:89). It already routes live -> AutonomyDialog.
- [confirmed] network_independent_offer Keep = POST /api/network-offers/:groupId/keep — network.controller.ts:50; refId groupId (network-offers.ts:212-213); reuse NetworkOfferActions (already in route lines 165-167)
- [confirmed] budget_blocked -> /app/spend?tab=budgets — critical, refType llm_budget (llm-usage.module.ts:19); SPEND_TABS lib/spend-search.ts:3
- [confirmed] landing_lead -> /app/landing?tab=leads — landing-leads.service.ts:173; app.landing.tsx:45-46
- [confirmed] ad_orders_stuck/ad_order_unfulfilled -> /app/ads — stuck-ad-orders.ts:79-86 (refId id|null), sponsor-fulfilment.ts:202
- [partial] low_runway, series_source_empty -> /app/data/$key — low_runway refType 'dataset', refId table (catalog-context.ts:175) is correct. series_source_empty refType 'series', refId '<handle|channelKey>:<series>' (schedule.service.ts:337-343) has no dataset key. → FIX: For series_source_empty, link to the agent page (?tab=schedule or playbook).
- [partial] critic_failed, derived_post_failed, approval_dedup, evergreen_fallback -> /app/editor/slot/:refId — derived_post_failed refType 'slot' (editor.module.ts:417), approval_dedup 'slot' (:1421), evergreen_fallback 'editor_slot' (evergreen.ts:105) → FIX: critic_failed is NOT an inbox kind. It is an editor_slots.error prefix (critic-gate.ts:433). Match both 'slot' and 'editor_slot'.
- [confirmed] loadout_suggestions -> Loadout tab; audit_report -> /app/artifacts — loadout-notes.ts:69 (refId week); audit-schedule.ts:43 (refType 'audit', severity action if errors else info); InboxLinks lines 106-108,120-122
- [missing] The §5.2 table lists all kinds — These kinds are not in the table: host_struck, event_not_covered, legacy_bindings_enabled, strategy_cutover_ready, sponsor_cutover, launch_graduated (action); directive_expired, directive_auto_applied, resource_paused/resumed, resource_health_ok, playbook_updated, network_mode, strategy_cutover, ad_order_placed, setup_expired, source_failing (info).
- [missing] Gap #1: list returns subject + actions — list() maps neither field (owner-inbox.ts:245-247). The columns exist, so no migration is needed. Stored action labels are Ukrainian (note-actions.ts:24-41).
- [missing] Gap #2: POST /api/agents/inbox/:id/actions {key} -> SeriesPauseActions.run — run(noteId,key) exists (pause-actions.ts:84-94) and is wired in AgentsService already (editor.module.ts:1949). The Pick type limits it to list|resume (agents.service.ts:63).
- [missing] Gap #3: series-pauses {action:'pause', key, label} — ResumeBody is resume-only (agents.service.ts:66); SeriesPauseActions.pause exists (pause-actions.ts:66-72)
- [partial] Existing deep links (InboxLinks, ?tab=) must keep working — Only ?tab=approvals|unread|all exists (route lines 21-27). There is no ?note= param. InboxLinks (lines 95-128) are links out of the Inbox. Its refType 'run' branch has no writer today.
- [partial] Technical details as a <details> spoiler; two-column list/detail — apps/dashboard/CLAUDE.md 'Compact cards': inbox messages use CompactCard + dialog, and the rules say never use <details>. → FIX: The lead must accept this deviation explicitly and update CLAUDE.md, or put Technical details inside the detail pane/Modal.

## Brief
## 0. Inputs
- `docs/ui-data-contract.md` does **not exist**. Everything below was checked against code.
- Current page: `apps/dashboard/src/routes/app.agents_.inbox.tsx` (179 lines). It has `SegmentedTabs` approvals/unread/all, a `CompactCard` grid with a dialog per note, `ApprovalList` (`components/approvals/ApprovalList.tsx:29`), `NetworkOfferActions` and `InboxLinks` (lines 95-128).
- `agents/Directives.tsx:521 AgentInbox` is the per-agent **directives** inbox (agent page `?tab=inbox`). It does not use `agent_inbox`, so leave it alone.

## 1. Data contract (as built)
- `GET /api/agents/inbox[?unread=true]` returns `{ items: InboxItem[] }`. It is capped at 200 (`agents.service.ts:570-572`), newest first, with no paging, so the prototype's "Load more" has no backend.
- Dashboard type (`api/agents.ts:179-190`):
```ts
interface InboxItem { id:number; agentId:string|null; kind:string; title:string; body:string|null;
  refType:string|null; refId:string|null; severity:'info'|'action'|'critical'; readAt:string|null; createdAt:string }
```
- Severity is enforced by a DB CHECK (`049_agents.sql:110`). The existing tone map (route line 29) is info→neutral, action→warning, critical→danger.
- `POST /api/agents/inbox/read {ids:number[]≤500 | 'all'}` returns `{marked}` (`agents.service.ts:574-578`).
- Hooks to reuse: `useAgentInbox(unreadOnly)`, `useMarkInboxRead()` (`api/agents.ts:405-419`), `useAgentTree` + `indexTree` (agentId → handle/emoji), `useApprovalsCount().waiting`, `useMediaQuery` (`lib/useMediaQuery.ts:11`) for the ≤860px Modal, and `fmtRelative`/`fmtDate`.
- **refId parsing rule:** a gated `postOnce` appends `#<8hex>` (`owner-inbox.ts:128`), and `resource_day` refs are `<ref>|<YYYY-MM-DD>`. Always use `refId.split('#')[0].split('|')[0]`.

## 2. Every kind the backend writes
All notes go through `OwnerInbox.post`/`postOnce`. No other code inserts into `agent_inbox`.

**critical**
- `connection_broken`: refType `resource_day`, refId `bot:|telegraph:|mtproto:<uuid>|day#h`. Written at `config/connection-keeper.ts:92`. No actions.
- `resource_health`: refType `resource`, refId `<platform>:<id>`.
- `resource_health_daily`: refType `resource_day`, refId `<ref>|day#h`.
  - Both are critical for no_access/token_invalid and action for token_expiring/rate_limited (`resource-health.service.ts:59,61,140`).
  - Both carry the action `mute:<ref>`.
  - Id per platform: threads/instagram/facebook → `meta_accounts.id`, tiktok → `tiktok_accounts.id`, telegram → the channel key.
- `budget_blocked`: refType `llm_budget`, refId `<scope>:<key>`.

**action**
- `series_paused`: refType `series_pause`, refId = pause uuid. Actions resume/keep (`series-breaker.ts:100`).
- `dark_day`, `series_missed`, `critic_reject_streak`: refType `resource_day`. Carry 0–2 `pause:` actions (`silent-days.ts:349-350`).
- `manager_escalation`: refType `escalation`, refId `escalation:<handle>:<kind>|day#h`.
- `directive_structural`, `directive_contested`, `directive_ignored`, `directive_failed` (info when it is advice): refType `directive`.
- `playbook_pending`: refType `playbook`.
- `network_independent_offer`: refType `network_group`.
- `shadow_ended`: refType `agent`, refId = handle.
- `landing_lead`: refType `landing_lead`.
- `ad_orders_stuck`, `ad_order_unfulfilled`: refType `ad_order`.
- `sponsor_cutover`: refType `agent`.
- `low_runway`: refType `dataset`, refId = table.
- `series_source_empty`: refType `series`, refId `<handle>:<series>`.
- `derived_post_failed`: refType `slot`.
- `audit_report`: refType `audit`. Action when there are errors, otherwise info.
- `host_struck`: refType `host`, refId `<channelKey>/<host>`. **The stored text is Ukrainian** (`source-health.service.ts:89`).
- `event_not_covered`: refType `story_event`.
- `legacy_bindings_enabled`: refType `legacy_bindings_day`.
- `strategy_cutover_ready`: refType `channel`.
- `launch_graduated`: refType `launch`.

**info**
- `skill_self_edit`, `skill_rolled_back`, `skill_probe`: refType `skill`.
- `ready_for_autonomy`: refType `channel`.
- `approval_dedup`: refType `slot`.
- `evergreen_fallback`: refType `editor_slot` (note the different spelling from `slot`).
- `loadout_suggestions`: refType `loadout`, refId = week.
- `resource_paused`, `resource_resumed`: refType `directive` or `resource`.
- `resource_health_ok`.
- `directive_expired`, `directive_auto_applied`.
- `playbook_updated`, `network_mode`, `strategy_cutover`, `ad_order_placed`, `setup_expired`, `source_failing`.

## 3. §5.2 corrections for `src/lib/inbox-kinds.ts`
The file does not exist yet. Make it pure, with no React, and test it with node:test like `lib/directive-view.test.ts`. Move `inboxTarget` logic in or reuse it.

- **Health notes:**
  - Refresh Threads only when the state is `token_expiring`.
  - For token_invalid/no_access, the primary action is "Reconnect", linking to `/app/connections?section=meta|telegram|tiktok`. Use the same mapping as `map.service.ts:59-61`; bots, sessions and Telegraph use `tab=bots|sessions|telegraph`.
  - Don't put MTProto verify on a button (AUTH_KEY_DUPLICATED risk, `connection-keeper.ts:75-79`).
  - Gap #4 (re-check one resource) is missing; it would wrap `ResourceHealthService.check(ref)`.
- **Removed / changed rows:**
  - Drop `critic_failed`: it is not an inbox kind.
  - `series_source_empty` links to the agent page, not `/app/data`.
  - The slot link must match both `slot` and `editor_slot`.
- **Skill rollback** needs `{version}`. Link to `?tab=skills` instead.
- **Decisions don't mark the note read:** after a directive or playbook decision, call `markRead([id])`.
- **Replan key:** take it from the `telegram:@x` resource ref, falling back to the orchestrator scope.
- **Ask @manager:** `/app/chat?q=@manager …` (the `q` param exists, `app.chat.tsx:44-48`).
- **Reusable components and hooks:**
  - Components: `NetworkOfferActions`, `AgentModeSwitch` (`AgentsUi.tsx:89`), `AutonomyDialog channel=refId`.
  - Hooks: `useDecideDirective`, `useContestDecision`, `useDecidePlaybook`, `useReplan`, `useResumeSeries`, `useRefreshThreadsToken`, `useVerifyBot`.
- **Missing rows:** add the missing kinds from §2; most of them get a link or "Got it".
- **"Why it matters" copy:** write it in English. Note that the `host_struck` body is Ukrainian.

## 4. Backend gaps

### Gap #1: list returns subject, parts and actions
- No migration is needed: the columns come from `093_series_pauses.sql:41-43`.
- `owner-inbox.ts:47-52`: extend `InboxItem` with `subject:string|null; parts:string[]|null; actions:InboxActionView[]`.
- `owner-inbox.ts:245-247`: map the new fields:
  ```ts
  subject: r.subject ?? null,
  parts: r.parts ?? null,
  actions: cleanActions(r.actions).map(actionView)
  ```
- `note-actions.ts`: add `actionView`. Stored labels are Ukrainian Telegram text, but the dashboard must be English (CLAUDE.md "Language"). Return:
  ```ts
  { key, type: 'resume'|'keep'|'pause'|'mute', label /* English */, target }
  ```
  - English labels: "Resume", "Keep paused", "Pause series" or "Pause: <label>", "Mute for 7 days".
  - `target` comes from `parseNoteAction`: `{pauseId}`, `{channelKey, seriesKey, label}` or `{ref}`.
- Add `OwnerInbox.get(id)`; gap #2 needs it.
- `agents.service.ts:571` is the only consumer of `list()`.
- Dashboard: add the fields as optional (older server) at `api/agents.ts:179`.
- Optional: add `refType`/`refId`/`actions` to `nav-attention.service.ts:45-52` (feeds Today; it lacks them now).
- Tests: `editor/agents/owner-inbox.test.ts` (fake pool). Cover the mapping and that invalid actions are dropped.

### Gap #2: `POST /api/agents/inbox/:id/actions {key}`
- **Controller:** in `agents.controller.ts`, add `@Post('agents/inbox/:id/actions')` after line 27 with `ParseIntPipe` (already imported). It does not collide with `agents/:handle/...`.
- **Wiring:** in `agents.service.ts:63`, widen `pauses` to `Pick<SeriesPauseActions,'list'|'resume'|'pause'|'run'>`. The factory at `editor.module.ts:1949` already passes a full instance, so no wiring change.
- **Service `inboxAction(id, body)`:**
  1. Validate with zod: `{key: string 1..600}.strict()`.
  2. Run `SELECT id, actions FROM agent_inbox WHERE id=$1`. Not found → 404 `note_not_found`.
  3. **Same check as Telegram:** the key must be one of `cleanActions(row.actions)`, otherwise 400 `unknown_action`. Telegram never accepts a client key, only an index into stored `card.buttons` (`owner-bot.service.ts:355-356`).
  4. `pauses` absent → 404 `not_available`.
  5. Call `run(id, key, 'dashboard')` and return `{ outcome, code, item: inbox.get(id) }`.
- **`pause-actions.ts` changes:**
  - `run()` hardcodes `'telegram'` (line 87).
  - The log and reason strings say "Telegram card" (lines 61, 67, 70, 79). Thread `via` through them.
  - Outcomes are Ukrainian (lines 51-80). Add a `code` (resumed, already_resumed, not_found, kept, paused, already_paused, muted, not_broken, unavailable) for English toasts. Keep `run()`'s string return for `card-sources.ts:285`.
- **No lock needed:** Telegram's `acting` set (`owner-bot.service.ts:375-386`) has no dashboard equivalent, but the repo operations are idempotent (`WHERE resumed_at IS NULL`, `ON CONFLICT DO NOTHING`).
- **The Telegram card closes itself:** `run()` marks the note read, `inboxSource.waiting` only lists unread notes (`card-sources.ts:277-279`), and the minute sweep closes the card with "Вирішено в дашборді" (`owner-bot.service.ts:160-165`).
- **Decide:** the A10 demotion counts only `resolved_by LIKE 'telegram:%'` as an owner reaction (`owner-inbox.ts:166-176`, `note-runs.ts`). Dashboard actions won't count, so later notes of that subject get demoted to info.
- **Dashboard:** add `useInboxAction()` in `api/agents.ts`. It invalidates `['agents','inbox']` and `['agents','series-pauses']`, and calls `requestFreshBadges()` (`api/nav.ts:50`).
- **Tests:**
  - `series-pause/note-actions.060.test.ts:150-185` builds `AgentsService` with fake pauses. Add cases for 400, 404 and `run` called with `'dashboard'`.
  - `pause-actions.060.pg.test.ts:97-160` (needs `EDITOR_PG_TEST_URL`). Check that the trace says "from the dashboard".

### Gap #3: `series-pauses {action:'pause', key, label}`
- `agents.service.ts:66`: replace `ResumeBody` with a `z.discriminatedUnion('action', …)`. The pause branch takes:
  - `key` matching `/^(series:.{1,200}|rule:[0-9a-f-]{36})$/`. Refuse `resource:` keys, as `note-actions.ts:32,53` does.
  - `label` 1..200.
- In `seriesPauseAction` (389-400):
  - Take the channel from `telegramKeyOf(orch)`; none → 404 `no_channel`.
  - Call `pauses.pause({channelKey, seriesKey: key, label}, null, 'dashboard')`.
  - `!changed` → 409 `already_paused`.
  - Return `seriesPauses(handle)`.
- Optional: check that the series exists, as `pause-resume-action.ts:35-42` does.
- Cosmetic: `skipPlanned`'s error text says "after repeated skips" even for an owner pause (`series-pauses.repository.ts:100`).
- For the Inbox, gap #2 already covers pausing. Gap #3 serves the agent page and Calendar.
- Dashboard: add `usePauseSeries(handle)` next to `useResumeSeries` (`api/agents.ts:316`).
- Tests: follow the pattern at `note-actions.060.test.ts:175-185`.

## 5. Deep links that must keep working
- **`?tab=approvals`:**
  - `nav/registry.ts:64`, `overview/AgentsCard.tsx:76`, `map/MapDrawers.tsx:168`.
  - `map.service.ts:308`, `approval-alerts.ts:57` (Telegram), `lib/map-demo.ts:145`.
- **`?tab=unread`:** `nav/NeedsYou.tsx:34,39`. Map it to All with Unread only on.
- **`?tab=all`:** map it to All with Unread only off.
- **Bare `/app/agents/inbox`:** `owner-inbox.ts:233` (plain alert), the owner-bot "Open" button (`card-sources.ts:124,141,168,296`), `routes/app.agents.tsx:20`, `registry.ts:79` (id `agents-inbox`, badge `agentsInbox`).
- **Proposed search params:** `{tab?: approvals|all|critical|action|fyi|unread(legacy), unread?: boolean, note?: number}`. `note` is new and selects the item. Default to unread-only so "Mark as done" removes the item, as in the prototype.
- **Outgoing links to keep:** InboxLinks targets skills/loadout/landing leads/`@manager?tab=directives&directive=`/`artifacts?type=audit&open=audit:<id>`/`editor/run/$id`. The run branch currently has no writer.

## 6. UI-rule conflicts to settle in the spec
- CLAUDE.md "Compact cards" names inbox messages as CompactCard + dialog and bans `<details>`. The two-column master/detail layout and the "Technical details" spoiler both deviate from that. Either update CLAUDE.md or put Technical details inside the detail pane.
- Use `SegmentedTabs` for the tabs and `Badge` for severity. The prototype's shape-coded severity dots should come from the `StatusMark` work in PR 1.

## Skeptic: wrong

- critic_failed is NOT an inbox kind; it is only an editor_slots.error prefix (critic-gate.ts:433). Drop it from the kind map. — critic-gate.ts:551-557 posts an inbox note with kind 'critic_failed', severity 'action', refType 'slot', refId = the slot id, agentId = inboxAgentId and a Ukrainian alert. It is called at line 434 when the critic fails. editor.module.ts:1658 wires it in as `critic: { inbox: (i) => infra.inbox.post(i) }`. The refType grep counts three 'slot' writers: critic_failed, derived_post_failed and approval_dedup. → Keep the row 'critic_failed → Open slot /app/editor/slot/$refId' (severity action) as the handoff has it. Also add critic_failed to the list of action kinds in §2.
- nav-attention.service.ts:45-52 'feeds Today', so adding refType/refId/actions there helps Today — GET /api/nav/attention is read only by components/nav/NeedsYou.tsx. That component is rendered on /app/agents (app.agents.tsx:42, show inbox+directives) and on /app/chat (app.chat.tsx:366, chat cards only). app.index.tsx (Today) does not import it or call the endpoint. → Say that it feeds the NeedsYou panel on /app/agents. Today would need to adopt that endpoint, or useAgentInbox, as new work under handoff §4.
- Id per platform for resource_health refs: threads/instagram/facebook → meta_accounts.id, tiktok → tiktok_accounts.id, telegram → channel key (the full list) — PLATFORMS also includes youtube (agent.types.ts:102). The catalog emits `youtube:<youtube_accounts.id>` (resource-catalog.ts:87-92), and health access checks youtube_accounts (resource-catalog.ts:155). map.service.ts:59 maps youtube to the 'telegram' connections section. → Add youtube → youtube_accounts.id. It has no refresh or verify endpoint, so the action is a link to /app/connections?section=telegram, the same as map.service CONNECTION_SECTION.
- Line refs: ResourceHealthService.check at resource-health.service.ts:43; severity CHECK at 049_agents.sql:110; AUTH_KEY_DUPLICATED note at connection-keeper.ts:75-79 — check(ref) is at line 44. The severity CHECK is at 049_agents.sql:109. The MTProto AUTH_KEY_DUPLICATED comment is at connection-keeper.ts:79-81 (lines 72-82 are the whole doc comment). → resource-health.service.ts:44; 049_agents.sql:109; connection-keeper.ts:79-81.

## Skeptic: missed

- Mute already has a dashboard endpoint, so it does not need gap #2: POST /api/agents/:handle/health/dismiss (agents.controller.ts:75-78 → agents.service.ts:433-440), hook useDismissHealth(handle) at api/agents.ts:690. It mutes the orchestrator's profileKey: scopeId, or `network:<id>` for a network agent, so it only covers the agent's own resource. It returns 400 no_resource or not_broken. It does not mark the note read and only invalidates ['agents','profile',handle], so the Inbox must also call markRead([id]).
- Health and connection notes have no agentId. resource_health, resource_health_daily and resource_health_ok are posted without agentId (resource-health.service.ts:59,61,63-67), and so is connection_broken (connection-keeper.ts:91-93). The same is true of event_not_covered (event-watch.ts:57), landing_lead, budget_blocked and stuck ad orders. To get a handle, for example for mute or the agent link, match the parsed resource ref against AgentNode.scopeId (api/agents.ts:24) from useAgentTree, not note.agentId.
- Notes already supersede each other on the server. OwnerInbox.post and postOnce mark every older unread note of the same subject read (owner-inbox.ts:157-159, 198-202), unless the gate is standalone (only a pastDay series_missed). That includes resource_health_ok, which reads that resource's open health notes, and series_missed/dark_day, which share the subject silent:<ref>:miss. So with Unread only, two notes of one subject never coexist, and grouping by subject only matters on All. Notes can also turn read without any action from the owner, so 'read' does not mean 'handled'.
- useResumeSeries (api/agents.ts:316-322) only setQueryData's ['agents','series-pauses',handle]. The server marks the series_paused note read (pause-actions.ts:39-42), but the Inbox query is not invalidated, so the note stays on screen until the 60 s refetch (api/agents.ts:409). The Inbox must invalidate ['agents','inbox'] itself.
- useDecideDirective, useContestDecision (api/manager.ts:238-260) and useDecidePlaybook (api/network.ts:255-262) set meta {silentError:true}, so the caller must show the 409 errors (not_awaiting_owner, not_contested). useRollbackSkill (api/agents.ts:377) toasts on its own.
- skill_probe has an existing 'Adopt anyway' action: POST /api/skills/:id/versions/:version/adopt (agents.controller.ts:150-153 → agents.service adoptRejected), hook useAdoptRejectedSkill (api/agents.ts:391), which already invalidates ['agents','inbox']. Like rollback, it needs a version that the note does not carry (refId is only the skill id, skill-probe.ts:312).
- seriesPauseAction only resumes a pause on the handle's orchestrator Telegram channel (agents.service.ts:389-400): telegramKeyOf(orchestratorOf(handle)). It returns 404 no_channel or pause_not_found, or 409 not_paused. series_paused.agentId is the top-level orchestrator with scope_id 'telegram:<channelKey>' (series-pauses.repository.ts:123-127) or null. A pause on a channel without such an agent cannot be resumed from the Inbox until gap #2 lands.
- For exact tab counts beyond the 200 loaded rows, the nav badge counts already have agentInboxUnread and agentInboxCritical (nav-badges.service.ts:27-28; dashboard nav/badges.ts:21-22). No action-severity count exists.
- Key the kind→action map by kind, not by refType. refType 'channel' is used by both ready_for_autonomy (editor.module.ts:1450) and strategy_cutover_ready (migration-actions.ts:125). refType 'agent' with refId = handle is shared by shadow_ended, network_mode (network.service.ts:270), strategy_cutover (strategy-migration.service.ts:315) and sponsor_cutover, whose refId can be null (sponsor-fulfilment.ts:257). refType 'slot' is shared by critic_failed, derived_post_failed and approval_dedup.
- event_not_covered refId is `<storyId>|<ISO timestamp>` (story-event.ts:355-357, refType 'story_event'). series_source_empty refId is `<handle|channelKey>:<series name>`, and a series name may contain ':', so split only on the first ':'.
- Existing tests pin the inbox deep links and must keep passing: nav/registry.test.ts:62 ('/app/agents/inbox?tab=approvals'), nav/ops.test.ts:41 and nav/resolve.test.ts:106 ('/app/agents/inbox').
- Health note titles and bodies carry the raw ref, for example `⚠️ threads:<uuid>: token_invalid` (resource-health.service.ts:92). To show an account name, the UI must map the ref to a name via the agent tree or GET /api/map (map.controller.ts).