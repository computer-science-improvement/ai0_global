# today: Handoff §4 — Today (/app, routes/app.index.tsx) vs prototype App-Today.dc.html

## Checks

- [partial] GET /api/nav/attention returns the items behind the counters: top-8 unread inbox notes, critical first — settings/nav/nav-attention.service.ts:8 ATTENTION_LIMIT=8; :43-55 ORDER BY critical, action, created_at DESC. Shape (dashboard api/nav.ts:6-10): {inbox,directives,chatCards} each {total, items[]}; inbox item = {id:number,title(≤200),severity:'info'|'action'|'critical',kind,agentHandle|null,createdAt} → FIX: Inbox items carry NO body, refType or refId. The prototype's body line and every kind→action CTA that needs an id (series_paused resume uses refId = pause id, series-breaker.ts:101) need GET /api/agents/inbox?unread=true (InboxItem: id,agentId,kind,title,body,refType,refId,severity,readAt,createdAt; newest first, limit 200; sort by severity on the client). Other options: extend attention (a backend change, but PR3 says no backend changes).
- [confirmed] GET /api/editor/approvals/count gives the approvals part of the headline count — editor/approval/approvals.controller.ts:22 → approvals.service.ts:153 returns {waiting:number}; hook useApprovalsCount (api/approvals.ts:82)
- [confirmed] GET /api/editor/channels: each channel carries mode, today.slots, today.runs, today.spendUsd — editor-ops.service.ts:111-129; type EditorChannel (api/types.ts:590) = EditorCard (mode, dailyBudgetUsd, timezone…) + today:{date,spendUsd,runs,slots: Partial<Record<EditorSlotStatus,number>>}; response {enabled,date,channels}; hook useEditorChannels (api/editor.ts:15, 30 s poll) → FIX: Caveats: today.slots is for the channel's own timezone date and counts every slot of the active plan, reserved slots included (repo slotStatusCounts :675). runs/spendUsd come from llm_usage 'editor.%' per Kyiv day (editor-runs.repository.ts:113).
- [partial] Glance ring = Σ channels[].today.slots (published N of M) — Counts per status exist; there is no 'missed' status → FIX: Count published + shadowed as done, with M = the sum of all statuses (exclude skipped rows whose error is NOT_A_MISS if you want 'planned'). Missed needs per-slot errors, so take it from the plans query (isMissed), not from the counts.
- [confirmed] AI spend/budget from GET /api/spend/summary?range=7d → periods.today, budgets[] — spend.service.ts:340-389; SpendSummary type api/spend.ts:46. budgets = [global cap, agents cap, top 3 others by pct] (:365-387). Periods are computed regardless of range. hook useSpendSummary → FIX: The summary has no per-day series. The KPI sparkline needs GET /api/spend/breakdown?range=7d&groupBy=day → chart.days[].total (useSpendBreakdown, api/spend.ts:173). For 'Busiest channel budget', use channels[].dailyBudgetUsd vs today.spendUsd or a budgets[] row with scopeKind 'resource'.
- [confirmed] Existing BudgetBar can be reused — components/overview/AiSpendCard.tsx:39 export BudgetBar({b: BudgetStatus}), role=meter, tokens only
- [confirmed] Timeline from GET /api/editor/plans?date=<today> → plans[status=active].slots; slot fields status, scheduledAt, seriesName?, scheduleRuleId?, error, topic — editor.controller.ts:60 → editor-ops.service.ts:172 ({date, plans, previewEstimates}); repo listPlans :624 returns active first, then superseded, per channel. EditorSlot type api/types.ts:605 has scheduledAt, status, topic, format, kind, error, seriesName?, scheduleRuleId?, topicMode?, runId. hook useEditorPlans(date) api/editor.ts:78 → FIX: date defaults to the Kyiv date, and a channel in another zone may have its plan under another date. Filter p.status==='active', which also hides superseded plans after a replan. Decide whether kind==='reserved' slots are drawn.
- [partial] Raw timeline already in agents/AgentPlan.tsx:290-313, can be generalised — Timeline is AgentPlan.tsx:230-318 and LaneRow :320. Lines 290-313 are only the source→derived connector SVG. It renders network-plan PlanSlot (useNetworkPlan: at, resourceRef) as 176px pills with packRows, not EditorSlot markers → FIX: Reuse the pure helpers in lib/plan-timeline.ts (slotMinutes :24, axisLabel :42, packRows :45) and lib/zoned-time.ts (KYIV_TZ, minutesFromDayStart, formatIn). Build the new DayTimeline with a fixed 06–24 axis and point markers. Do not refactor AgentPlan.
- [partial] isMissed = (seriesName||scheduleRuleId) && status in skipped/failed/expired && error not 'superseded'/'mode_changed' — Backend editor/silent/skip-reasons.ts:21 NOT_A_MISS = superseded by a new plan, mode_changed, draft canceled, series_paused; OWNER (:23) = rejected by owner, resource_paused, agent paused → FIX: The handoff pseudo-code has an operator-precedence bug (a || b && c). Use (seriesName!=null || scheduleRuleId!=null) && status∈{skipped,failed,expired} && !/^(superseded by a new plan|mode_changed|draft canceled|series_paused)/.test(error??''), and preferably exclude the OWNER prefixes too.
- [partial] GET /api/agents gives name/emoji of the orchestrator via scopeId ↔ channelKey — agents.controller.ts:13 → agents.service.ts:145 tree() {agents: AgentNode[]} (Agent + activity{spentTodayUsd,lastRunAt,lastStatus,runsToday}, paused, children). The GET runs registry sync, so orchestrator.mode mirrors card.mode (agent-registry-sync.ts:50) → FIX: scopeId is a resource ref 'telegram:@x', while editor channelKey is '@x'. Match on kind==='orchestrator' && scopeId===`telegram:${channelKey}` (server telegramKeyOf, agent.types.ts:118). emoji may be null, so fall back to AgentGlyph. Hook useAgentTree, indexTree in AgentsUi.tsx:231.
- [confirmed] AgentModeSwitch inline, live goes through AutonomyDialog — components/agents/AgentsUi.tsx:89 AgentModeSwitch({agent: Pick<Agent,'handle'|'mode'|'scopeId'|'kind'|'name'>}) → SegmentedTabs size sm with MODE_OPTIONS (EditorUi.tsx:59, labels Off/Shadow/In approval/Live). Live on a Telegram orchestrator opens AutonomyDialog({channel,title,onClose}) (approvals/AutonomyDialog.tsx:12, POST /api/editor/approvals/autonomy). Other modes PATCH /api/agents/:handle {mode}, and the server syncs the card mode (agents.service.ts:233-235) → FIX: usePatchAgent (api/agents.ts:221) invalidates only ['agents']. If the row reads today.* from useEditorChannels, also invalidate ['editor'] (useSwitchAutonomy already does). Role agents refuse mode changes (mode_follows_orchestrator), so pass only orchestrators.
- [confirmed] Live activity: source of the 'Activity · last 24h' panel in components/map/*, or GET /api/editor/runs?limit=10 — components/map/MapHud.tsx:124 FeedPanel is fed by GET /api/map snapshot.events: MapEvent {id,at,kind:MapEventKind,agent,ref,toRef?,text} (api/map.ts:65), 30 newest of the last 24 h (map.service.ts:353, MAX_EVENTS=30; map.queries.ts:273+), server cache 5 s. There is no exported hook: MapPage.tsx:34 has an inline useQuery({queryKey: MAP_KEY, queryFn: mapApi.snapshot, refetchInterval: pollInterval}). Helpers: lib/map-state.ts EVENT_ICON, isBadEvent, ago, resourceTitle; map/MapAvatar.tsx Avatar → FIX: Extract a useMapSnapshot() hook into api/map.ts (same MAP_KEY, so the cache is shared with /app/map). Do not reuse FeedPanel itself: it is styled with .map-hud classes. GET /api/editor/runs returns a bare EditorRun[] (no wrapper, no agent handle), which makes it a worse source.
- [wrong] KPI strip uses GET /api/kpi/digest for 'Network health · N problems' — KpiDigest (kpi-digest.service.ts:31) has no problem count; the current NetworkHealthCard derives anomalies from it → FIX: Use GET /api/network-health → NetworkHealth.problems:number (api/health.ts:25-38, useNetworkHealth, 60 s), which is the same source as /app/health. connections[] (state token_invalid…) also gives the 'N Threads accounts need reconnecting' line.
- [confirmed] Dismiss = POST /api/agents/inbox/read {ids:[id]} — agents.controller.ts:24 → agents.service.ts:574 zod {ids: int[]≤500 | 'all'} strict → {marked:number}; owner-inbox.ts:251. Hook useMarkInboxRead (api/agents.ts:413). router.ts:30-35 MutationCache.onSuccess invalidates NAV_ATTENTION_KEY + NAV_BADGES_KEY with requestFreshBadges(), so the counter refreshes without a reload
- [missing] Prototype undo toast after Dismiss — No mark-unread endpoint (grep read_at = NULL finds nothing) → FIX: Either delay the POST by about 5 s behind an optimistic removal with Undo (a client-side timer), or drop Undo, or add POST /api/agents/inbox/unread (a backend change).
- [partial] KPI strip: Telegram subs, Meta followers, posts.d7, spend 7d with sparkline via StatTile — Subs: GET /tracking/channels?filter=mine&pageSize=200 Σ subsCount (app.index.tsx:55-66). Followers: GET /api/meta-accounts Σ followers. posts.d7: GET /api/overview/agents → posts.d7.published/shadowed (useAgentsOverview). Spend: summary periods['7d'].usd and deltaPct. StatTile ui/primitives.tsx:58 has no sparkline slot → FIX: '88% of all content' has no source, so drop it. The sparkline needs breakdown chart.days plus a small inline SVG (or recharts with isAnimationActive off under reduced motion).
- [confirmed] Errors tile counts legacy strategy errors — app.index.tsx:69 strategies.filter(last_run.status==='error'); :99-103
- [partial] Move 'Legacy strategy runs' to /app/logs — app.logs.tsx:1-2 already reads 'union of strategy runs + scheduled posts' (GET /activity) with All/Posts/Errors/Skipped/Running tabs and a strategy filter → FIX: Nothing to move: delete the block (app.index.tsx:145-162).
- [partial] Move Meta accounts section to /app/connections — /app/connections?section=meta renders MetaAccountsManager (followers shown, :165). Δ24h is shown on /app/analytics:206 and on /app/connections/meta/$accountId, which also has the Refresh stats button (useRefreshMetaStats) → FIX: Nothing is lost by deleting app.index.tsx:165-208. Optionally add a 'Refresh stats' button to MetaAccountsManager.
- [partial] Network health block is empty — It is NetworkHealthCard (components/agents/NetworkHealth.tsx:248, KPI digest: anomalies, quality flags, directives), used only on Overview → FIX: Replace it with a one-line link to /app/health. After removal, NetworkHealthCard, AgentsCard, AiSpendCard (except BudgetBar) and useUpcomingSlots have no users, so delete them or keep them on purpose.
- [missing] lib/inbox-kinds.ts, lib/status-tone.ts, ui/StatusMark exist or come from earlier PRs — Not in src/lib or src/components/ui. Current slot tones disagree: app.index.tsx:35 (skipped=warning) vs EditorUi.tsx:25 SLOT_TONE (skipped=neutral) → FIX: PR3 depends on PR1 (status-tone + StatusMark + isMissed) and on part of PR4 (inbox-kinds). Either sequence the PRs or create minimal versions in PR3.
- [confirmed] manager_escalation → /app/chat with @manager prefill (to check) — routes/app.chat.tsx:44-47 validateSearch q (≤2000 chars), :84 used as the prefill
- [missing] docs/ui-data-contract.md is the source of field claims — File not in repo; all claims above were checked against the code

## Brief
## Today (/app): brief for the spec

### Current page (to replace)
`apps/dashboard/src/routes/app.index.tsx` (211 lines), `OverviewPage`:
- StatTiles at :89-104: Telegram subs, Meta followers, **Meta Δ 24h** (remove), Upcoming slots, **Errors** (remove; it counts legacy `strategies.last_run`).
- `AgentsCard` + `AiSpendCard` at :107-110.
- `NetworkHealthCard` at :112.
- Upcoming slots list at :115-143 (`useUpcomingSlots(24,8)`).
- **Legacy strategy runs** at :145-162 (remove; `/app/logs` already lists strategy runs via GET /activity with an Errors tab).
- **Meta accounts** at :165-208 (remove; `/app/connections?section=meta` and the account page already cover it, Δ24h is also on /app/analytics).
- Local `SLOT_STATUS_TONE` at :35 conflicts with `EditorUi.SLOT_TONE` (skipped is warning in one and neutral in the other).

After removal, `AgentsCard`, `NetworkHealthCard`, `useAgentsOverview`'s only consumer and `useUpcomingSlots` become unused. `BudgetBar` (AiSpendCard.tsx:39) stays.

**Dependencies:** `lib/status-tone.ts`, `ui/StatusMark.tsx`, `isMissed()` (PR1) and `lib/inbox-kinds.ts` (PR4) do **not exist yet**. Sequence the PRs, or create minimal versions in PR3.

### Prototype → data → components, block by block

**1. Eyebrow + headline.**
- Eyebrow: `WED, 28 OCT · KYIV 21:51`. Use client clock in `KYIV_TZ` with `formatIn` from lib/zoned-time.
- Greeting by Kyiv hour.
- Headline: `N things need you`, where N = `attention.inbox.total + attention.directives.total + attention.chatCards.total + approvals.waiting`. Sources: `useNavAttention` (api/nav.ts:33, 30 s poll) and `useApprovalsCount` → `{waiting}`.
- Zero → "Nothing needs you."
- Use `PageHeader`, or a custom h1 inside it.

**2. Severity counters** ("N critical", "N to act on").
- Attention gives only totals, so count from unread items.
- Alternatively, `GET /api/nav/badges` has `counts.agentInboxCritical` (nav-badges.service.ts:28), but there is no action count.
- Render with `Badge tone="danger"` / `"warning"`.

**3. Needs you panel** (up to 4 rows + "Open inbox · N →").
- Prototype row: severity icon tile, sev pill, mono meta `kind · agent · age`, title, 2-line body, CTA button, Dismiss.
- Data: `GET /api/nav/attention` has **no body/refType/refId**. Use `useAgentInbox(true)` (GET /api/agents/inbox?unread=true → `{items: InboxItem[]}`, api/agents.ts:179/405), sort critical > action > info then newest, and take 4.
- Agent handle: `agentId` → `indexTree(useAgentTree())`.
- Also show directives and chat cards from attention (as `nav/NeedsYou.tsx` does: Row/meta helpers at :97-128, CardOpener at :86). Extend NeedsYou or build `NeedsYouList`.
- "Open inbox · N" uses the nav badge formula `agentInboxUnread + waiting`.
- CTA: per-kind map (§5.2). Links already exist via `inboxTarget` (lib/directive-view.ts:246) and `InboxLinks` (app.agents_.inbox.tsx:95). Mutations that already exist:
  - replan: `useReplan({key, date:'tomorrow'})`
  - series resume: `POST /api/agents/:handle/series-pauses {action:'resume', id: refId}`
  - Ask @manager: `/app/chat?q=@manager …` (the `q` param exists, app.chat.tsx:47)
- Dismiss: `useMarkInboxRead().mutate([id])` → `POST /api/agents/inbox/read {ids}` → `{marked}`. The global MutationCache (router.ts:30-35) refreshes attention and badges.
  - Add an optimistic removal via `qc.setQueryData` on `['agents','inbox',true]` and `NAV_ATTENTION_KEY`.
  - There is **no undo endpoint**. Either delay the POST about 5 s behind the toast's Undo, or drop Undo.
- Empty state: "All clear for today" (`EmptyState icon="check"`).
- CLAUDE.md conflict: CompactCard forbids buttons inside the card. Rows with an inline CTA/Dismiss must be card-rows (`card row-lift`), not CompactCard.

**4. Today at a glance.**
- Ring "8/15 slots published":
  - Done = Σ `today.slots.published + shadowed`.
  - Total = Σ all statuses (reserved slots included unless filtered).
  - Legend rows: Published / Skipped / Missed.
  - Missed must come from the plans query (per-slot `error`), not from the counts.
  - New `SlotRing` SVG with an aria-label.
- "Agent runs 32 · 100% ok (7d)": `useAgentsOverview()` → `runs.today|d7|successRate7d` (GET /api/overview/agents), or Σ `channels.today.runs`.
- "AI spend $x / $cap": `useSpendSummary('7d')`. Use `periods.today.usd`, and for the cap the `budgets.find(b=>b.scopeKind==='global')` row (`spentTodayUsd`, `dailyUsd`). Render with `BudgetBar`.
- "Busiest channel budget": the max of `channels[].today.spendUsd / dailyBudgetUsd`, or a budget row with `scopeKind 'resource'`.

**5. Today's schedule** (lanes per agent, fixed 06–24 axis, markers, past shading, now-line, legend).
- Data: `useEditorPlans(todayKyiv)` → `plans.filter(p=>p.status==='active')`. This also hides superseded plans after a replan.
- Slot fields: `scheduledAt`, `status`, `topic`, `format`, `kind`, `error`, `seriesName?`, `scheduleRuleId?`.
- Lane = channelKey. Name/emoji from the agent tree: `kind==='orchestrator' && scopeId===\`telegram:${channelKey}\``. scopeId is a resource ref; channelKey is the bare `@x`.
- Marker x = `minutesFromDayStart(scheduledAt, day, KYIV_TZ)` mapped onto 06:00–24:00. Clamp or flag slots outside the axis.
- Tooltip: `HH:MM · status · seriesName`, plus `skipReason(error).label` (lib/slot-plan.ts:107).
- Marker shapes per §2:
  - published = filled
  - planned = ring
  - skipped = grey ring
  - missed = warning diamond
  - failed = danger square
  - running = pulse, disabled under reduced motion
- Missed rule (correct the handoff, which has a precedence bug): `(seriesName!=null||scheduleRuleId!=null) && ['skipped','failed','expired'].includes(status) && !/^(superseded by a new plan|mode_changed|draft canceled|series_paused)/.test(error??'')`. This mirrors backend `skip-reasons.ts:21`.
- Now-line: re-render each minute (`useNow` exists in map/MapHud.tsx:15; move it to lib).
- Reuse the pure helpers `axisLabel`/`packRows` from lib/plan-timeline.ts. `AgentPlan.Timeline` (AgentPlan.tsx:230-318) renders network PlanSlot pills, not EditorSlot points. Do not refactor it; build `DayTimeline`.
- Tests: 0 slots → empty state; 15+ slots with overlaps → `packRows` or stacking; replan → superseded hidden.
- Wrap in `overflow-x:auto` with min-width about 760 (as the prototype does) at ≤860px.

**6. Agents table** (avatar, name, @handle, 4-segment mode switch, runs, spend today; footer with system agents).
- Rows: the agent tree's root orchestrators joined to editor channels by key, giving `channel.mode`, `today.runs`, `today.spendUsd` (or `agent.activity.runsToday` / `spentTodayUsd`).
- Switch: `<AgentModeSwitch agent={orch}/>` (AgentsUi.tsx:89). Live on a Telegram orchestrator opens `AutonomyDialog`; other modes PATCH `/api/agents/:handle {mode}` and the server syncs the card.
  - `usePatchAgent` invalidates only `['agents']`. Also invalidate `['editor']` or the runs/mode columns lag up to 30 s.
  - The label is "In approval", not "Approval".
- Footer: tree roots with `kind manager|builder|auditor` → `activity.lastRunAt` / `spentTodayUsd` (`LastRun` component).
- CLAUDE.md: either a `table` with `num` columns, or card-rows. Card-rows fit better because each row holds a toggle.

**7. Live activity.**
- Source: the map feed = `GET /api/map` → `snapshot.events: MapEvent[]` `{id, at, kind, agent, ref, toRef?, text}`. 30 newest of the last 24 h, server cache 5 s (map.service.ts:161, :353).
- There is no exported hook. Extract `useMapSnapshot()` into api/map.ts with `MAP_KEY` and `pollInterval` (lib/map-diff.ts:20), which shares the cache with /app/map.
- Render rows with `Avatar` (map/MapAvatar.tsx:42), `EVENT_ICON`/`isBadEvent`/`ago`/`resourceTitle` (lib/map-state.ts), take 6–8 and add a link to /app/map. Do not reuse `FeedPanel` (it uses .map-hud styling).
- Optionally the same snapshot's `units[]` (mode, effectiveMode, runsToday, spentTodayUsd, emoji) could also feed the agents table and save two queries.
- "streaming" pill = poll indicator.

**8. KPI strip.**
- Telegram subscribers: `trackingApi.listChannels({filter:'mine',pageSize:200})` Σ `subsCount`; "N channels" = `items.length`.
- Meta followers: `useMetaAccounts()` Σ `followers`. The warning sub-line counts `useNetworkHealth().connections` (token_invalid…).
- Agent posts · 7 days: `overview.posts.d7.published`. "88% of all content" has **no source**, so drop it.
- AI spend · 7 days: `periods['7d'].usd`, Δ via `fmtDelta`/`deltaTone` (lib/spend). Sparkline: `useSpendBreakdown({range:'7d',groupBy:'day'})` → `chart.days[].total` as a small SVG. StatTile (primitives.tsx:58) has no chart slot, so add a `children`/`extra` prop or use a sibling.
- Network health line: **not /api/kpi/digest** (it has no problem count). Use `useNetworkHealth()` → `problems:number` (GET /api/network-health), linking to /app/health.

### Not in §4 scope
The prototype's sidebar (Inbox 17, "More tools", AI budget box) and its top bar (⌘K search, "5 agents live", New post) belong to §3 / AppShell.

### Token and rule notes for implementers
- Prototype hex → tokens per handoff §1. Severity tints map to `--color-danger-soft` / `--color-warning-soft` (index.css:34-36).
- `--font-mono` is undefined until PR1.
- Use `SectionCard` for panels and `Badge` for every status.
- All animations need `prefers-reduced-motion` guards.
- English UI.
- Mobile ≤860px: panels stack and the timeline scrolls horizontally.

## Skeptic: wrong

- Headline N = attention.inbox.total + directives.total + chatCards.total + approvals.waiting — This counts directives twice. A directive that reaches awaiting_owner or contested also posts an unread inbox note: kind directive_structural with refType 'directive' (automation/src/editor/manager/directive-tools.ts:361-371), and kind directive_contested (:576). The same directive is therefore in inbox.total and in directives.total. inbox.total also includes severity 'info' notes, which are FYI items and do not 'need you'. → Take the inbox part from useAgentInbox(true), counting only severity critical or action, and drop notes with refType==='directive' whose refId is already in attention.directives. Or count directives only through their inbox notes.
- 'Open inbox · N' uses the nav badge formula agentInboxUnread + waiting — No such formula exists today. In nav/badges.ts:49-51 the agentsInbox badge is agentInboxUnread alone. The 'agents' badge (:41-47) is agentInboxUnread + directivesAwaitingOwner. 'agentInboxUnread + approvals.waiting' is the handoff §3 proposal, which only lands in PR2. → Compute it locally: badges.counts.agentInboxUnread + useApprovalsCount().waiting. Or make PR3 depend on PR2.
- Extend nav/NeedsYou.tsx and reuse Row/meta helpers (:97-128) and CardOpener (:86) — The path is apps/dashboard/src/components/nav/NeedsYou.tsx. Row, meta, More and CardOpener are module-private functions, so they cannot be imported. Only NeedsYou and chatsWaiting are exported. → Export the helpers, or copy them into the new NeedsYouList.
- Agents table: today.runs/spendUsd from the channel, 'or agent.activity.runsToday / spentTodayUsd'; the map snapshot units[] could also feed the table — The two sources are not equivalent. agents.repository.ts:156-169 counts only runs whose agent_id equals the agent itself, and spend comes from editor_runs.cost_usd. Most runs belong to the role children (planner, executor, reviewer). That is linkLegacyRuns at :172-178, which sets agent_id to the child of kind=role. So an orchestrator's own activity undercounts heavily. Map units (map.service.ts:294-295) use the same per-agent activity. → Use channel today.runs/spendUsd (from llm_usage editor.%). Or sum activity over the orchestrator's subtree (node.children).
- Eyebrow 'WED, 28 OCT · KYIV 21:51' via formatIn from lib/zoned-time — formatIn (lib/zoned-time.ts:50-53) returns only 'HH:MM'. → Use formatIn for the time. For weekday and date use Intl.DateTimeFormat('en-GB', {timeZone: KYIV_TZ, weekday:'short', day:'2-digit', month:'short'}), or zonedParts (:35).
- Undo: delay the POST ~5 s behind the toast's Undo — The toast system has no actions. components/ui/Toast.tsx:10-34 supports only toast.error/success(text); a click dismisses it, and it has no buttons or callbacks. → Add an action-toast variant to Toast.tsx (a scope change), or render the prototype's 'Resolved: … Undo' strip inline in the panel.
- map.service.ts:161 (5 s cache) and :353 (MAX_EVENTS=30) — The line numbers are wrong. The constants are MAP_CACHE_MS=5_000 at :22 and MAX_EVENTS=30 at :25. The cache check is at :163. :353-355 is the merge, sort and slice. Each event source query is itself capped at the 30 newest of the last 24 h (map.queries.ts:273+). → Cite :22/:25/:163. Note that the feed cannot show items older than 24 h (the prototype shows '2 d ago').

## Skeptic: missed

- Network plans put several resources in one lane. An anchor Telegram channel's active plan holds slots for every resource of its network: non-Telegram slots have resourceRef set (editor-plans.repository.ts:411-414, 437-443; repurpose slots at :470-500; promo slots at :291-296). slotStatusCounts (:675-682) counts all of them, so channels[].today.slots and any lane keyed by channelKey mix IG/FB/Threads copies with the Telegram posts, and the ring total grows. Compute the ring from the plans query. Filter !s.resourceRef for the Telegram lane, or draw separate per-resourceRef rows.
- Some orchestrators have no editor channel. Orchestrators for native platforms have scope 'resource' and a non-Telegram scopeId (editor/agents/agent-creator.ts:128-136). They have no editor channel card, so joining the tree to /api/editor/channels drops them from the Agents table. Decide whether to list them; their runs and spend would come only from subtree activity.
- A ready mode switch keyed by channel already exists. ModeSwitch({channelKey, mode, title}) at components/editor/EditorUi.tsx:72 is fed directly by useEditorChannels: it does PUT /api/editor/channels/:key {mode} (useSetEditorMode, api/editor.ts:46-56, which invalidates ['editor']) and opens AutonomyDialog for live. It needs no agent-tree join and avoids the stale-invalidation problem of usePatchAgent. The tree's orchestrator.mode re-syncs from the card on the next GET /api/agents.
- CTA data for series_missed and dark_day notes: refType is 'resource_day' and refId is '<resourceRef>|<YYYY-MM-DD>' (owner-inbox.ts:41-45, silent-days.ts:348-351). The channelKey for 'Replan tomorrow' must be parsed from refId: strip the 'telegram:' prefix and the '|day' suffix. The 'Pause series' button keys (NoteAction 'pause:[channelKey,seriesKey,label]', series-pause/note-actions.ts) are stored in agent_inbox.actions, but GET /api/agents/inbox does not return them (owner-inbox.ts:241-248). That is backend gap #1, so Pause series cannot be built in PR3.
- Which CTAs clear the note: resuming a series from the dashboard marks its series_paused note read on the server (series-pause/pause-actions.ts:35-45). But useResumeSeries (api/agents.ts:316-321) only updates ['agents','series-pauses',handle]. The global MutationCache refreshes nav attention and badges, not ['agents','inbox',…], so a Today list built on useAgentInbox keeps the row for up to 60 s. Replan and 'Ask @manager' do not mark the note read at all. If a CTA should resolve the row, as in the prototype, call useMarkInboxRead as well and invalidate ['agents','inbox'].
- A series_paused note can have agentId null (series-breaker.ts:99, agentOf(...).catch(() => null)). Then there is no handle for POST /api/agents/:handle/series-pauses. Fall back to the orchestrator whose scopeId is 'telegram:'+channelKey; the pause's channel is in the note text only, so a list lookup via useSeriesPauses may be needed.
- lib/no-cyrillic-ui.test.ts fails the build on any Cyrillic in apps/dashboard/src. The prototype's agent names (Айра, Нова, Локо…) and the NoteAction labels are Ukrainian, so render names only from data and never hardcode prototype strings.
- AI spend sources disagree. summary.periods.today is read from the llm_usage_daily rollup (spend.repository.ts:160-164), and the rollup job recomputes every 5 min (common/ai/usage/llm-usage-rollup.ts). channels[].today.spendUsd and budgets[].spentTodayUsd come from raw llm_usage. Mixing them on one card gives totals that do not match by up to 5 minutes of spend.
- The network-health 'problems' count (editor/health/network-health.ts:130) includes muted connections and every stuck group, approval_waiting among them. So 'Network health · N problems' overlaps the approvals in the headline. For the 'N accounts need reconnecting' line, filter connections[] with !muted.
- Avatar (components/map/MapAvatar.tsx:42) requires kind: MapAgentKind, which has no 'auditor' (api/map.ts:10). Passing agent-tree kinds for @sysadmin in the agents footer or the activity rows is a type error.
- isMissed parity: the backend also counts a published series slot that an evergreen fallback filled as missed (silent-days.ts series_missed loop, evergreenFilled). The client cannot see that fallback, so the timeline will show some missed slots as published. The backend trims error and matches /^series_paused\b/.
- For the plan date there is no todayKyiv helper. useEditorPlans(undefined) already defaults to the Kyiv date on the server (editor-ops.service.ts:172), and EditorChannelsResponse.date is the Kyiv day. Otherwise use dayIn(new Date(), KYIV_TZ).