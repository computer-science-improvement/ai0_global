# agent: Handoff §6: Agent detail (/app/agents/$handle) and prototype App-Agent.dc.html

## Checks

- [confirmed] §6.1 ?tab= stays a leaf key; current 15 leaves validated in the route — routes/app.agents_.$handle.tsx:32 TABS (overview, approvals, reviews, directives, artifacts, skills, loadout, memory, history, playbook, schedule, ideas, plan, inbox, promo); validateSearch :56-64 sets tab=undefined for unknown values (falls back to overview); hidden() :106-107 sends gated leaves to overview (NETWORK_TABS :34 need a networked agent, MANAGER_TABS :35 need kind=manager)
- [partial] §6.1 group table covers every section of the page — All 15 leaves are placed. But 'Settings: profile (Edit), resource, formatting' are not tabs: they are sections on Overview (AgentOverview.tsx:150-151 ResourceSection/FormattingSection, :156 ProfileSummary). Overview also holds ConflictsLine :148, ActiveEffects :149, PausedSeries :152, SourcesSection :153, ArtifactsLine :154 and Roles :158, which the table never places → FIX: Add at least one new leaf, e.g. 'settings', to TABS and TAB_OPTIONS. Decide where ActiveEffects goes (the prototype puts it in Activity as 'In force now'), and where Sources, Conflicts, the Artifacts line and Roles go
- [wrong] Activity group 'inbox' = notes from this agent (prototype: 'same notes as the main Inbox, filtered to the agent') — route :197 renders AgentInbox (components/agents/Directives.tsx:521), which lists MANAGER directives and advice addressed to the orchestrator (useDirectives({agent})). Owner-inbox notes: GET /api/agents/inbox (agents.controller.ts:19, limit 200, no agent filter) returns InboxItem with agentId (api/agents.ts:179) → FIX: Keep the 'inbox' leaf as directives and label it 'From @manager'. A notes view would be a new leaf that filters useAgentInbox() on the client by agentId ∈ {agent.id, children ids}
- [partial] All old links (from Inbox etc.) keep working — Every tab link in the code uses one of the 15 keys, so leaf keys survive. Links with no tab that rely on Overview content would break once that content moves: app.agents_.inbox.tsx:104 'Review and switch' (mode switch), :116 'Open active effects' (ActiveEffects); backend texts 'Overview → Paused series' in series-breaker.ts:35, pause-resume-action.ts:54, docs/import-bundle.ts:163 → FIX: Give those links an explicit tab, or keep PausedSeries and ActiveEffects reachable where the texts say
- [confirmed] Header: description, kind chip, '@handle → scopeId' from GET /api/agents/:handle — agents.service.ts:163-174 returns {agent:{...Agent, paused, activity|null, effectiveMode?}, parent, children[], channelKey}; Agent type api/agents.ts:20-47 has kind, description: string|null, scopeId: string|null, mode, dailyBudgetUsd: number|null
- [partial] Large AgentModeSwitch (4 segments) — AgentsUi.tsx:89-122 hardcodes <SegmentedTabs size="sm">; it renders a tablist, not a radiogroup. Going live opens AutonomyDialog for a Telegram orchestrator, otherwise a confirm. Role agents cannot switch: PATCH mode returns 400 mode_follows_orchestrator (agents.service.ts:214-223) → FIX: Add a size prop to AgentModeSwitch. For agents with d.parent, show FollowsBadge (AgentsUi.tsx:54) in the header instead of the switch
- [missing] Mode explanation lines taken from contract §9.3 — docs/ui-data-contract.md does not exist; no mode-hint strings exist in src → FIX: Write four strings in a lib constant. The approval line can reuse planScheduleNote facts (lib/slot-plan.ts:144: evening batch at 20:00)
- [confirmed] Run now action — POST /api/agents/:handle/run (agents.controller.ts:59) returns {started:boolean, what:string}; 409 agent_paused. Implementation editor.module.ts:1954-1967: orchestrator/planner → replan of the rest of today (needs a channel), reviewer → reviewer run, other kinds return started:false. @manager: POST /api/manager/run → {started:true}, 409 manager_off (manager.service.ts:69-75). Both already wired at route :110-121
- [confirmed] Chat with <name> → /app/chat with prefill — The parameter is ?q= (no ?prefill): app.chat.tsx:44-49 validates q (≤2000 chars) and :41 says it prefills the composer once. Precedent: MapDrawers.tsx:289 search={{ q: `@${handle} ` }}
- [partial] More menu: Set up channel, Pause/Resume, Edit — The actions exist: AgentSetupButton (setup/AgentSetupButton.tsx:12; badge + button + SetupProposalDialog; shown at route :141 only when kind=orchestrator, channelKey is set and scopeId starts with 'telegram:'), PauseButton (AgentsUi.tsx:131, PATCH status/paused_until), AgentEditDialog (AgentOverview.tsx:243). There is no dropdown component: NavContextMenu.tsx:18 opens at the pointer. The Icon set has no 'more'/ellipsis icon → FIX: Build a small anchored menu (or adapt NavContextMenu to accept the button's rect) and add a 'more' icon (MoreHorizontal) to ui/Icon.tsx. Split AgentSetupButton into a hook plus a dialog so it can be triggered from the menu
- [confirmed] Pause banner from GET /api/agents/:handle/series-pauses → open[] — agents.service.ts:377-386 returns {channelKey, open: SeriesPause[], recent: SeriesPause[] (≤5)}; SeriesPause = {id, key, label, cause:'no_material'|'source_unreachable'|'owner', reason, streak, pausedAt, resumedAt, resumedBy} (api/agents.ts ~296-301). Hook: useSeriesPauses (api/agents.ts:306). Current UI: PausedSeries.tsx. Empty for an agent with no Telegram channel
- [partial] key prefixes resource: → 'Planning paused', series: → 'Series “label” paused' — series-pauses.repository.ts:9 lists three kinds: series:<name> | rule:<schedule_rule_id> | resource:<ref>; streak.ts:31-36; backend wording series-breaker.ts:29 uses 'Fixed slot …' for rule: → FIX: Add a rule: case, titled 'Fixed slot <label without the fixed slot prefix> paused'. Use p.streak for 'after N skips in a row'
- [confirmed] Resume → POST series-pauses {action:'resume', id} — agents.service.ts:66 ResumeBody z.object({action: z.literal('resume'), id: uuid}); :389-399 errors 404 no_channel / pause_not_found, 409 not_paused; returns refreshed SeriesPausesResponse. Hook useResumeSeries (api/agents.ts:316). The prototype's Undo is not possible: no pause action exists (HANDOFF PR 4b gap)
- [confirmed] KPI: activity.spentTodayUsd / dailyBudgetUsd, activity.runsToday — AgentActivity {spentTodayUsd, lastRunAt, lastStatus, runsToday} (api/agents.ts:49-54); activity can be null. The current Overview sums the children into spend and runs (AgentOverview.tsx:116-119, 'incl. roles'). dailyBudgetUsd null → 'default cap'
- [confirmed] postsPerDayMin–Max from GET /api/editor/channels/:key — editor.controller.ts:29 → editor-ops.service.ts:143 getChannel; EditorCardFields.postsPerDayMin/Max (api/types.ts:560-561); hook useEditorChannel(key) (api/editor.ts:23, enabled only when key is set). Telegram channels only (d.channelKey)
- [confirmed] 'Answers to @manager' table source (to find) — Found on /app, not on the agent Overview: NetworkHealth.tsx:206-245 ComplianceTable, rendered at :338 by NetworkHealthCard (app.index.tsx:112). Data: GET /api/kpi/digest (manager.controller.ts:39; useKpiDigest api/manager.ts:314, 5-minute poll) → compliance?: ComplianceRow[] {agent, advice_followed, advice_declined, decline_reasons[], contested, auto_applied}, 30 days, shadow directives excluded (kpi-digest.service.ts:85-104) → FIX: For one agent, use compliance.find(r => r.agent === handle). The digest is a heavy network-wide build. A lighter option: useDirectives({agent, binding:'advice'}) (GET /api/directives, limit 200), keep !shadow and createdAt ≥ now−30 days, then count status in accepted/applied/evaluated as followed and declined as declined
- [confirmed] Today: GET /api/editor/plans?date=&channel= — editor.controller.ts:60 → editor-ops.service.ts:172; the default date is Kyiv-local; returns {date, plans: EditorPlan[] (the active plan first, then superseded ones), previewEstimates}. Hook useEditorPlans(date, channel) (api/editor.ts:78). EditorSlot has scheduledAt, status, error, seriesName, scheduleRuleId, topic (api/types.ts:605) → FIX: Use only the plan with status 'active'. For non-Telegram orchestrators, GET /api/agents/:handle/plan?date= (useNetworkPlan, network.ts:285) returns PlanSlot[] with at/status/error/seriesName/pinned, plus schedule {timezone, planHour, approval, batchHour}
- [confirmed] Today: GET /api/editor/runs?channel=&limit= — editor.controller.ts:87 → editor-ops.service.ts:301; returns a bare EditorRun[] (api/types.ts:682), newest first, limit 1–200 (default 50), no date filter. Hook useEditorRuns (api/editor.ts:134) → FIX: Filter startedAt to today in the channel's time zone on the client. Alternative: useAgentRuns(handle) → GET /api/agents/:handle/runs returns {runs: AgentRun[]} for the agent and its children, which also covers agents without a channel
- [partial] Skip reason from skipReason() in lib/slot-plan.ts — lib/slot-plan.ts:107-126 returns {code, label, detail}. It has no branch for the 'series_paused: …' error the breaker writes (series-pauses.repository.ts:100), so those slots get the label 'Note' → FIX: Add a branch: /^series_paused\b/ → {code:'series_paused', label:'Series paused'}
- [partial] missed computed via isMissed (handoff §2), used for the timeline — The §2 pseudo-code `a || b && c && d` binds as a || (b && c && d). The backend NOT_A_MISS list (editor/silent/skip-reasons.ts:21) also excludes /^draft canceled/ and /^series_paused\b/ → FIX: Use (seriesName != null || scheduleRuleId != null) && status in [skipped, failed, expired] && the error matches none of: superseded by a new plan | mode_changed | draft canceled | series_paused
- [partial] Channel block = ResourceSection summary + health chip — ResourceProfile.tsx:90 ResourceSection is the full SectionCard (Details/Edit); the compact ProfileSummary (:162) is not exported. HealthBadge (:66) and HEALTH (:50) are exported. Data: useResourceProfile → GET /api/agents/:handle/profile {ref, profile{topic, language, goals, timezone…}, health{state, detail, checkedAt}, updatedAt} (api/agents.ts:682-704); the time zone comes from useResourceClock → FIX: Export a compact summary (or add a compact prop) for Overview; keep the full section under Settings
- [wrong] How posts look = FormattingSection (hashtagMin/Max, linkStyle, emojiPolicy, formats) with Lock buttons — hashtagMin/Max, linkStyle ('inline'|'footer'|'button'), emojiPolicy ('none'|'sparse'|'free') and formats are channel-card fields (EditorCardFields api/types.ts:555-582) and cannot be locked. FormattingSection (ResourceFormatting.tsx:34) shows format_prefs per resource: hashtags{count,style,fixed}, links ('inline'|'bio'|'first_comment'|'button'), emoji ('none'|'light'|'rich'), preferred_formats[], with locks: FormatPrefField[] and changesPerDay (FormattingResponse api/agents.ts:633) → FIX: Build the rows from format_prefs of the resource where ref === a.scopeId, and use FORMAT_LABEL/formatValue from lib/format-prefs. Inline lock: usePutResourceFormatting with {ref, format_prefs: r.formatPrefs (whole), format_locks: toggled}, PUT /api/agents/:handle/formatting/:ref. Show the card fields read-only with a link to /app/editor/$channel
- [missing] StatusMark / status-tone available for the timeline — src/lib/status-tone.ts and components/ui/StatusMark.tsx do not exist (they are PR 1). Existing maps: SLOT_TONE and RUN_TONE in editor/EditorUi.tsx:25,30
- [missing] docs/ui-data-contract.md referenced by the handoff — ls docs/ui-data-contract.md → No such file

## Brief
## Brief for PR 5: Agent detail (`/app/agents/$handle`)

### 1. How the page works today
- `apps/dashboard/src/routes/app.agents_.$handle.tsx` (201 lines).
  - `TABS` (:32) holds the 15 leaf keys.
  - `NETWORK_TABS` (:34) = approvals, playbook, schedule, ideas, plan, inbox, promo. They are shown only if `networked` (:103), which means an orchestrator or a role agent that has a parent.
  - `MANAGER_TABS` (:35) = reviews, directives. They are shown only for `kind==='manager'`.
- `validateSearch` (:56-64) accepts these params:
  - `tab`: only a value in `TABS`, otherwise `undefined`, which means overview;
  - `idea`;
  - `directive`, with `d` as an alias;
  - `binding` and `kind`, through `directiveFilterSearch(parseDirectiveFilters)` (lib/directive-view).
- A gated leaf falls back to overview (:106-108). `setTab` (:77) writes `{tab}` with `replace:true` and drops the other params. `openIdea` (:78) moves from Plan to Ideas with `?idea=`.
- Header (:134-161): `AgentGlyph 48`, then `PageHeader` with these actions:
  - `AgentSetupButton`: orchestrator with a `channelKey` and a `telegram:` scope;
  - Run now;
  - `PauseButton`;
  - Edit, which opens `AgentEditDialog`.
- Under the header: `ScopeChip`, `StateBadges`, the description and `ConnectionBanner` (:164). The tabs are `SegmentedTabs` inside an `overflowX:auto` wrapper (:166-168). There is also a callout for when @manager is off (:170-175).
- Tab bodies (:177-198):

| Leaf | Component |
|---|---|
| overview | `AgentOverview` |
| approvals | `ApprovalStatsPanel` + `ApprovalList{channel}` |
| reviews | `ManagerReviews` |
| directives | `ManagerDirectives` |
| artifacts | `ArtifactList{agent}` |
| skills | `AgentSkills` |
| loadout | `AgentLoadout` |
| memory | `AgentMemory` |
| history | `AgentHistory` (`useAgentRuns`, cursor) |
| playbook | `AgentPlaybook` |
| schedule | `AgentSchedule` |
| ideas | `AgentIdeas` |
| plan | `AgentPlan` (`useNetworkPlan`) |
| inbox | `AgentInbox` (**MANAGER directives sent to this orchestrator, not owner notes**) |
| promo | `AgentPromo` |

- `AgentOverview` (components/agents/AgentOverview.tsx:110-186) contains, in order:
  - stat-grid: Mode switch, Spend (children summed in), Runs, Last run;
  - `ConflictsLine` (:94);
  - `ActiveEffects`;
  - `ResourceSection`;
  - `FormattingSection`;
  - `PausedSeries`;
  - `SourcesSection`;
  - `ArtifactsLine`;
  - `ProfileSummary` with Edit (:198);
  - Roles.

### 2. Groups (new, pure module + test)
Create `src/lib/agent-tabs.ts`. Tests run with `tsx --test` on `*.test.ts` only, so this logic must not live in a `.tsx` file. It exports:
- `GROUP_OF: Record<Tab, Group>`;
- `groupOf(tab)`;
- `leavesOf(group, visible)`;
- `firstLeaf(group, visible)`.

Proposed mapping (handoff §6.1, plus the decisions it leaves open):
- **Overview**: `overview`.
- **Content**: `plan`, `schedule`, `ideas`, `approvals`. All are network-gated, so the group is hidden for manager, builder and auditor.
- **Brain**: `playbook`, `skills`, `loadout`, `memory`, `artifacts`.
- **Activity**: `history`, `inbox` (relabel it "From @manager"), `reviews`, `directives`. Optionally add a new `effects` leaf for ActiveEffects, which the prototype calls "In force now".
- **Settings**: a **new leaf `settings`** (it must be added to `TABS`) plus `promo`. The `settings` leaf renders:
  - ProfileSummary with Edit;
  - ResourceSection (full);
  - FormattingSection (full);
  - SourcesSection.
- Visibility: a group is visible if at least one of its leaves passes `hidden()`.
- Clicking a group navigates to `firstLeaf`.
- A group with more than one visible leaf renders a second `SegmentedTabs size="sm"`.
- Optionally, `validateSearch` can also accept group names (`content`, `brain`, `activity`) as aliases that resolve to the first leaf.
- Update the copy that says "on the Overview tab" (:115, :172), because the mode switch moves to the header.

**Links that must still land correctly**:
- Tab links:
  - AgentOverview.tsx:104 (memory), :419 (artifacts);
  - NetworkHealth.tsx:225 (inbox), :311 (directives);
  - Directives.tsx:535;
  - NetworkOfferActions.tsx:28 (playbook);
  - AgentSkills.tsx:141 (skills);
  - AgentLoadout.tsx:193 (skills);
  - ActiveEffects.tsx:32 (directives + directive), :101 (playbook);
  - ManagerReviews.tsx:133;
  - MapDrawers.tsx:287-288 (artifacts, loadout), :353-355 (directives, promo, playbook);
  - nav/NeedsYou.tsx:45;
  - overview/AgentsCard.tsx:81;
  - nav/registry.ts:80 (`/app/agents/manager?tab=directives`);
  - app.agents_.inbox.tsx:101, :107, :113;
  - app.index.tsx:128 (schedule);
  - strategies/MigrationBanner.tsx:96 (schedule);
  - the route's own :78 (ideas + idea).
- String links:
  - automation `editor/loadout/loadout-notes.ts:71` (`/app/agents/<h>?tab=loadout`);
  - `editor/map/map.service.ts:326`;
  - `lib/map-demo.ts:148`.
- Links with no tab that rely on Overview content:
  - inbox.tsx:104 "Review and switch" (mode switch, which moves to the header: fine);
  - inbox.tsx:116 "Open active effects" (needs a tab if ActiveEffects moves);
  - backend texts "Overview → Paused series" in series-breaker.ts:35, pause-resume-action.ts:54, import-bundle.ts:163. Keep the pause banner in the header, visible on every tab, and keep that wording.
- Keep the `?directive=`/`?d=`, `?idea=` and `?binding=&kind=` params working.

### 3. Header (prototype, block by block)
- **Breadcrumb**: keep `Crumbs`, `useCrumbs('agent-detail')`.
- **Identity**:
  - glyph: `AgentGlyph size={64}`;
  - h1: `a.name`;
  - kind chip: `.chip` with `KIND_LABEL[a.kind]`;
  - description: `a.description`, clamp to 2 lines (max 500 characters);
  - mono line: `@{a.handle} → {a.scopeId}`. Use the ScopeChip label logic for network/system scopes.
  - Keep the "Planner of @parent" line (:126-133) for role agents.
- **Mode**:
  - `AgentModeSwitch` with a new `size` prop (AgentsUi.tsx:116 currently hardcodes `sm`). It keeps the AutonomyDialog and confirm logic.
  - Add one hint line underneath. There are no existing strings, and the contract §9.3 the handoff cites is missing. Use the prototype copy: Off = does nothing; Shadow = plans and writes, publishes nothing; Approval = the next day is batch-planned at 20:00 the evening before and waits for you (`planScheduleNote`, lib/slot-plan.ts:144); Live = publishes through code guards.
  - Role agents get `FollowsBadge` (AgentsUi.tsx:54) instead of the switch, because PATCH mode returns 400 `mode_follows_orchestrator`.
  - Keep the "shadow until" note (AgentOverview.tsx:134).
- **Actions**:
  - **Run now**: existing logic (:110-121). `POST /api/agents/:handle/run` returns `{started, what}`. For an orchestrator or planner it replans the rest of today (editor.module.ts:1954-1967). @manager uses `POST /api/manager/run`. The tooltip should say "replans the rest of today".
  - **Chat with {name}**: `<Link to="/app/chat" search={{ q: `@${a.handle} ` }}>`. The parameter is **`?q=`** (app.chat.tsx:44-49); there is no `?prefill`.
  - **More**: Set up channel (`AgentSetupButton`, which must be split into a hook plus `SetupProposalDialog`, same Telegram-orchestrator condition), Pause/Resume (`PauseButton` logic plus `PauseModal`), Edit (`AgentEditDialog`).
  - There is no dropdown component: `NavContextMenu` (nav/NavContextMenu.tsx:18) opens at the pointer. Add an anchored variant, and add `more: MoreHorizontal` to ui/Icon.tsx.
- **Pause banner** (warning callout, one per open pause, or "N paused"):
  - Data: `useSeriesPauses(handle)` → `GET /api/agents/:handle/series-pauses` returns `{channelKey, open: SeriesPause[], recent}`. Each `SeriesPause` has `{id, key, label, cause, reason, streak, pausedAt, resumedAt, resumedBy}`.
  - Title by key prefix:
    - `resource:` → "Planning paused";
    - `series:` → `Series "<label>" paused`;
    - **`rule:` → `Fixed slot <label> paused`** (the handoff misses this one).
  - Subtitle: "after {streak} skips in a row", the cause label from `PausedSeries.tsx:12`, and `reason`.
  - Resume: `useResumeSeries` → `POST … {action:'resume', id:uuid}`. It returns the refreshed list; errors are 404 `pause_not_found`/`no_channel` and 409 `not_paused`.
  - After Resume, show "Next plan at HH:00 <zone>" using `EditorChannel.planHour`/`timezone`, or 20:00 in approval mode.
  - **Undo cannot be built**: there is no pause action (HANDOFF PR 4b gap). Leave it out.
  - Keep `ConnectionBanner`.

### 4. Overview
- **KPI row** (4 tiles; `StatTile`/`.stat-grid`, ui/primitives.tsx:58):
  - Spend today = `activity.spentTodayUsd` plus the children's, with "cap {dailyBudgetUsd ?? 'default'} · incl. roles". `activity` is nullable.
  - Runs today = `activity.runsToday` plus the children's.
  - Daily plan = `postsPerDayMin–postsPerDayMax` from `useEditorChannel(d.channelKey)` (`GET /api/editor/channels/:key`, EditorCardFields api/types.ts:560-561). Telegram only; otherwise hide the tile or show "—".
  - MANAGER advice · 30 d = followed / declined. Source found: the "Answers to @manager" table is `ComplianceTable` (NetworkHealth.tsx:206), shown on **/app**. It reads `GET /api/kpi/digest` → `compliance[]` (`ComplianceRow {agent, advice_followed, advice_declined, decline_reasons, contested, auto_applied}`, kpi-digest.service.ts:85, 30 days, shadow excluded). Use `useKpiDigest().data?.compliance?.find(r=>r.agent===handle)`; it shares the cache with /app but the build is heavy. A lighter option is `useDirectives({agent, binding:'advice'})` with counts on the client (see checks).
- **Today, step by step**: merge these sources and sort by time.
  - (a) Slots of the **active** plan (`plans.find(p=>p.status==='active')`) from `useEditorPlans(today, d.channelKey)` → `GET /api/editor/plans?date=YYYY-MM-DD&channel=`. The response includes superseded plans; the default date is Kyiv.
  - (b) Runs: `useEditorRuns({channel, limit:50})` returns a bare `EditorRun[]` with no date filter, so filter `startedAt` to today in the card's time zone. Alternative: `useAgentRuns(handle)` covers agent and children by `agent_id`.
  - (c) Open pauses whose `pausedAt` is today (the prototype's "Planning paused" row).
  - Label sources:
    - `skipReason(slot.error)` (lib/slot-plan.ts:107). **Add a `series_paused` branch.**
    - `runLabel(role)` (:134).
    - `RUN_TONE` and `SLOT_TONE` (editor/EditorUi.tsx:25,30) until `StatusMark` exists (PR 1).
  - Missed rule: `(seriesName||scheduleRuleId) && status∈{skipped,failed,expired} && error !~ superseded|mode_changed|draft canceled|series_paused` (backend `editor/silent/skip-reasons.ts:21`; the handoff's version has an operator-precedence bug).
  - Links: slot → `/app/editor/slot/$id`, run → `/app/editor/run/$id`.
  - For non-Telegram orchestrators use `useNetworkPlan(handle, day)` (`GET /api/agents/:handle/plan`; `PlanSlot` has `at`, `status`, `error`, `seriesName`, `pinned`, and `schedule{timezone, planHour, approval, batchHour}`).
- **Channel**:
  - Data: `useResourceProfile` → `{ref, profile{topic, language, goals, timezone}, health{state, detail, checkedAt}}`.
  - `HealthBadge`/`HEALTH` are exported from ResourceProfile.tsx:50-70. `ProfileSummary` (:162) is private, so export a compact version.
  - The prototype's "bot is an admin…" line is `health.detail`.
  - Add an "Edit" link that goes to `?tab=settings`.
- **How posts look**:
  - **The handoff mixes up two data sources.** Lockable values are `format_prefs` from `useResourceFormatting` (`GET /api/agents/:handle/formatting` → `{changesPerDay, resources[{ref, formatPrefs, locks, changesToday}], history}`). Pick `ref===a.scopeId`.
  - Rows: hashtags (`{count}`), links, emoji, preferred_formats. Use `FORMAT_LABEL` and `formatValue` (lib/format-prefs).
  - Lock toggle: `usePutResourceFormatting({ref, format_prefs: r.formatPrefs, format_locks})`. The PUT replaces the whole prefs object; check that `style` round-trips.
  - The card's `hashtagMin/Max`, `linkStyle`, `emojiPolicy` and `formats` are read-only, with a link to `/app/editor/$channel`.
  - Header line: "at most {changesPerDay} changes a day · {locks.length} locked".
- **Optional on Overview**: compact Roles. The prototype drops the "Last run" tile.

### 5. Other groups (the prototype only shows placeholder cards)
These map to the existing components listed in §1. The prototype's "Notes from this agent" (Activity) does not exist. Building it means filtering `useAgentInbox()` on the client (`GET /api/agents/inbox`, limit 200, `InboxItem.agentId`) by the agent's id and its children's ids, under a new leaf (e.g. `notes`). The existing `inbox` leaf stays as the MANAGER directives view.

### 6. Rules and reuse
- Use tokens only. Status cells use `Badge`; sections use `SectionCard`; tabs use `SegmentedTabs`; numbers use `StatTile`.
- Follow the compact-card rules (apps/dashboard/CLAUDE.md).
- Mobile: the header wraps; the 4-segment mode switch becomes 2×2 at ≤760px in the prototype (the shell breakpoint is 860).
- Respect `prefers-reduced-motion`.
- No backend changes are needed apart from the optional `skipReason` branch, which is client-side only.
- `docs/ui-data-contract.md` does not exist, so every claim above was checked against the code.

## Skeptic: wrong

- For non-Telegram orchestrators, use GET /api/agents/:handle/plan?date= (useNetworkPlan, network.ts:285) as the Today/plan fallback — apps/automation/src/editor/network/network.service.ts:49-56: orch() resolves role→orchestrator, then throws 400 {error:'no_channel_card'} when telegramKeyOf(orch) is null. Plans and slots are keyed by channel_key, so an agent with no Telegram card has no plan source at all. The endpoint is better used as the primary source for Telegram agents: it defaults the date to the card's time zone (:177), returns only the active plan's slots (:184-185), and also returns schedule {timezone, planHour, mode, approval, batchHour} (:198). → Use useNetworkPlan(handle, '') for Telegram agents. An empty date makes the server pick the card-local today, so there is no need to filter superseded plans or work out the date on the client, and it also covers role agents. Note that PlanSlot carries `pinned` instead of `scheduleRuleId`. For agents without d.channelKey, hide 'Today, step by step' and the 'Daily plan' tile. Take the batch hour from schedule.batchHour rather than hardcoding 20.
- Corrected missed rule: (seriesName||scheduleRuleId) && status∈{skipped,failed,expired} && error !~ superseded|mode_changed|draft canceled|series_paused — The backend excludes owner decisions as well. manager/quality-digest.ts:195 and silent/silent-days.ts:192 drop every slot where isOwnerDecision(error) is true; the OWNER list is in silent/skip-reasons.ts:23: /^rejected by owner/, /^resource_paused/, /^agent @.* is paused/, /^agent paused/. Without these, a slot the owner rejected or a @manager resource pause would show as 'missed' on the client. → isMissed = (seriesName || scheduleRuleId || pinned) && ['skipped','failed','expired'].includes(status) && !NOT_A_MISS.some(r=>r.test(e)) && !OWNER.some(r=>r.test(e)). Copy both regex lists from skip-reasons.ts:21,23.
- Run now: POST /api/agents/:handle/run → {started, what}; the only listed error is 409 agent_paused; the tooltip should say 'replans the rest of today' — The replan path has more errors. editor/api/editor-ops.service.ts:98-99 returns 409 channel_off when the card mode is off, :193 returns 409 replan_in_progress, and :95 returns 503 editor_disabled. The result also depends on kind (editor.module.ts:1954-1967): only orchestrator and planner replan; reviewer starts a reviewer run; ideator, idea_reviewer, executor, builder and auditor return started:false with 'X runs on its own schedule', which useRunAgent (api/agents.ts:237) shows as an error toast. Separately, POST /api/manager/run can return 400 no_manager. → Set the tooltip by kind. Hide or disable Run now for kinds that return started:false, and also when the channel mode is off (the mode is in the header). Map the 409 channel_off and replan_in_progress errors to readable toasts.

## Skeptic: missed

- There are two pause sources, and the brief's banner covers only one. Pauses that @manager makes with pause_resource directives come from GET /api/resources/pauses (useResourcePauses, api/manager.ts:268; filtered by pausesOf in lib/directive-view.ts:216). They are lifted with POST /api/resources/:ref/pause/lift (useLiftPause, :279) and the slot error is `resource_paused`. Today only ActiveEffects shows them. The Inbox link 'Open active effects' (app.agents_.inbox.tsx:116, from inboxTarget in lib/directive-view.ts:248 for resource_paused/resource_resumed) relies on that. If ActiveEffects moves into Activity, the header banner must also show active resource pauses with a Lift button, or that link needs ?tab=<effects leaf>.
- The brief's link list misses components/health/NetworkHealthView.tsx. At :132 the /app/health Sources rows link to the agent page with no tab and rely on SourcesSection being on Overview, which breaks if Sources moves to Settings. At :74-76, AgentLink types its tab as 'overview'|'ideas'|'playbook' (used at :190-191).
- useEditorPlans (api/editor.ts:78-88) and useEditorRuns (:134-144) have no `enabled` option. Called with channel undefined, they fetch the plans or runs of every channel. Guard them, or add an enabled parameter. useEditorChannel takes a `string`, so pass `d.channelKey ?? ''` as PlanTimesNote does (AgentOverview.tsx:385).
- Every section the brief moves into Settings or summarises on Overview is orchestrator-only today (AgentOverview.tsx:148-154). Conflicts, Resource, Formatting and Artifacts need kind==='orchestrator' && scopeId; PausedSeries and Sources also need scopeId.startsWith('telegram:'). For role, manager, builder and auditor agents, the new 'settings' leaf would hold only the agent profile. There are also two private components named ProfileSummary: the agent profile at AgentOverview.tsx:198 and the resource summary at ResourceProfile.tsx:162. The spec must say which one each block reuses.
- 'Chat with <name>' for a role agent: the chat server sends a role mention to its orchestrator (editor/chat/editor-chat.service.ts:255-257), and GET /api/agents/handles lists only top-level agents (agents.service.ts:530). For agents with d.parent, label the button and prefill it with @parent.handle.
- PauseModal is not exported (AgentsUi.tsx:149). The More menu's Pause item needs it exported, or PauseButton split into a trigger and a modal.
- Formatting for a networked Telegram orchestrator: formatRefs (agents.service.ts:465-477) returns the anchor plus every network member. Picking ref===scopeId shows only the anchor, so the other resources must stay reachable under Settings. PUT returns 404 resource_not_found for a ref outside that set.
- Pause banner subtitle: owner pauses (cause 'owner') have streak 0, and PausedSeries.tsx guards with p.streak > 0. Only render 'after N skips in a row' when streak > 0.
- Mode hint strings must depend on the agent kind. For @manager, Shadow means 'directives are filed but nothing structural acts' (existing copy at route :172), not 'plans and writes, publishes nothing'. The live confirm copy already exists at AgentsUi.tsx:98-103.
- ComplianceRow is keyed by the directive's to_agent_id handle, which is the orchestrator (kpi-digest.service.ts:85-104). Role agents have no row, so for them use the parent handle or hide the tile. useAgentRuns is a useInfiniteQuery (api/agents.ts:244): read data.pages[].runs, not data.runs.