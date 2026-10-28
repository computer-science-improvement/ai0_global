# other-pages: Dashboard pages without a prototype (30 /app routes + login, white-label, report): page inventory, what the new visual language means for each, and parallel batches

## Checks

- [missing] HANDOFF.md:4 says the handoff was built from docs/ui-data-contract.md (5f8eeedb) — No such file in docs/ (ls docs | grep contract finds nothing) → FIX: Take every endpoint and field from the code. For these pages nothing new is needed, because the restyle is visual only.
- [confirmed] §1.1 #3: .text-heading-md is used but not defined — SectionCard's h2 uses it at ui/primitives.tsx:110 (4 files in total), so every SectionCard page depends on it. Inline fontSize 14/600 hides the gap.
- [confirmed] §1.1 #4: var(--shadow-2) at SchemaEditor.tsx:181 does not exist — components/data/SchemaEditor.tsx:181, on the sticky .panel save bar of the /app/data/$key Schema tab
- [confirmed] §1.1 #6: la-shimmer, logs-spin and recharts ignore reduced motion — app.landing.tsx:377-379, app.logs.tsx:142 and :270. No isAnimationActive in 6 recharts files: Subs, Views, Engagement, MetaReach, MetaProfile and spend/SpendChart.tsx. PR1 therefore edits files that the page batches also edit.
- [confirmed] PR1 prompt: the local tone map in components/editor/EditorUi.tsx:25-28 — SLOT_TONE is at EditorUi.tsx:25-28. Its values differ from the §2 table: running is warning (table: accent), shadowed is accent (table: neutral), expired is neutral (table: warning). All 4 editor pages change colour after PR1. → FIX: Batch B3 starts after PR1.
- [wrong] §3: hiddenByDefault ids include dm, map and agentsInbox, plus a calendar id — nav/registry.ts:74 is 'dm-inbox', :78 is 'network-map', :79 is 'agents-inbox'. agentsInbox is only a BadgeKey (:23). There is no 'calendar' id. → FIX: Use dm-inbox, network-map and agents-inbox, and add a new calendar entry. Almost every page in this brief moves to 'More tools'.
- [partial] §4: move the 'Legacy strategy runs' block from Overview to /app/logs — Logs already lists strategy runs: GET /activity, source 'strategy_run' (app.logs.tsx:107), with a strategy filter (:301-304). All filters are local useState (:192) and there is no validateSearch. → FIX: Logs needs no new block. A pre-filtered deep link from Today needs URL search params on /app/logs.
- [partial] §4: move the 'Meta accounts' section from Overview to /app/connections — MetaAccountsManager.tsx:165 shows followers only. The Overview block (app.index.tsx:165-200) also has followers_delta_24h and a Refresh action through useRefreshMetaStats (:59). → FIX: PR3 has to add Δ24h and Refresh to components/connections/MetaAccountsManager.tsx, which overlaps with batch B2.
- [confirmed] §4: the 'Activity · last 24h' panel on /app/map is the source for Live activity — FeedPanel is at components/map/MapHud.tsx:124. Data comes from GET /api/map → MapSnapshot.events: MapEvent{id,at,kind,agent,ref,toRef?,text} (api/map.ts:64,78,84). Backend: editor/map/map.queries.ts:273-303 (24 h window, 30 newest per source). → FIX: B2 must keep the FeedPanel props unchanged.
- [confirmed] §7: /app/calendar redirects to /app/scheduled; /app/scheduled and /app/compose keep working — routes/app.calendar.tsx (redirect), app.scheduled.tsx (195 lines), app.compose.tsx (92 lines)
- [confirmed] §7: Compose shows validation errors before the first action — post/PostComposer.tsx:117-128 computes errors eagerly and :198 renders them; there is no touched state → FIX: PR6b owns this change. The compose page restyle must not edit PostComposer in parallel.
- [partial] ui-inventory §2.1: inline <style> blocks exist in 5 files — grep finds 15: also white-label.tsx:135, report.$token.tsx:133 and the landing components MediaKit, HowItWorks, NetworksCard, ProofStrip, PublicPageCard, WhiteLabel, LeadsCard and NetworkShowcase → FIX: 15 files
- [confirmed] ui-inventory: about 3,300 inline style objects — 3,349 occurrences of style={{ under src
- [confirmed] ui-inventory §1.3: the /app/map h1 is in MapHud.tsx:56 — components/map/MapHud.tsx:56 <h1>…Network map</h1>
- [partial] Handoff: use SectionCard and CompactCard and follow CLAUDE.md (card-row lists) — The prototypes put rows inside one panel with hairline separators (.row / .need / .item: border-top rgba(255,255,255,.06), padding 12px 20px). apps/dashboard/CLAUDE.md 'Card-row lists' asks for one card row-lift per entity (12+ pages do that). → FIX: The lead must decide and update CLAUDE.md before the batches start. Otherwise implementers will split between the two patterns.
- [partial] Handoff §1: buttons stay --radius-sm — The prototype .btn is min-height 44px with radius 12, and .btn-s is 36px with radius 10. Today .btn-primary uses --radius-sm (6px). → FIX: Decision for the B0 foundation: keep the 6px radius as the handoff says, but take the 44/36px heights.

## Brief
## 0. Scope and size
33 pages in total: 30 `/app` routes plus `login.tsx`, `white-label.tsx` and `report.$token.tsx`.

Excluded:
- the prototype pages: `app.index`, `app.agents_.inbox`, `app.agents_.$handle`, `app.calendar` and `index.tsx`;
- redirect-only routes: `app.agent`, `bots`, `telegraph`, `setup`, `steering`, `strategies×3`, `connections_.meta` and `connections_.tiktok`.

Size: the routes in scope are 7,461 lines; the components they own add about 13k.

Route files are almost token-clean: 0 hex values, 0 literal radii. The noise is literal gaps and paddings (counted as "lit" in §3). Literal hex lives only in per-platform tints (`MetaGroupsManager.tsx:31-36`).

## 1. The language to apply, taken from the prototype CSS in `<helmet>`
- **Page head:**
  - a mono eyebrow: 12px, ink-dim, letter-spacing .06em, uppercase;
  - h1 34/600/−.035em;
  - subtitle 15px ink-muted;
  - actions on the right, bottom-aligned.
  - Source: `App-Today.dc.html:157-165`, `App-Inbox:102-108`.
- **Panel `.pnl`:**
  - surface-2, 1px hairline, radius 18, which maps to `--radius-xl`;
  - header `.ph` with padding 18px 20px 0 and title `.pt` 15/600, **without a glyph tile**;
  - an "Open … →" link on the right.
- **Rows `.row`:** inside the panel, 12px 20px padding, border-top hairline-soft, no top border on the first row, faint hover. This replaces one card per row.
- **KPI `.kpi`:** cells inside one panel (18px 20px), not separate tiles.
- **Tabs**, two styles:
  - a "well" (`.tabs`, Inbox): surface-1 track, radius 14, 40px buttons, the selected one on surface-3, a mono count `.tn`;
  - underline (`.tabs`, Agent).
- **Inline segmented control `.segm`:** 30px.
- **Pills:**
  - `.sev`: mono, uppercase, 11px;
  - filter chips `.chipb`: 40px; when on, accent border on success-soft.
- **Controls:** buttons 44px and small 36px; inputs 44px with a 3px accent focus ring.
- **Avatars:** `.av` 32px with radius 10 and mono initials. The entity header uses a 64px avatar with radius 20 (`App-Agent:125-128`).
- **Timeline `.ev`:** a grid of 52px mono time | 18px mark | text, with a spine.

## 2. Batch 0, the foundation (serial; after or merged with PR1/PR2)
Every page batch depends on it. It owns these shared files:
- `index.css` (`.panel`, `.card`, `.table-wrap`, `.tabs-pill`, `.btn-*`, `.input-field`, `.chip`, a new `.list-row`, `.kpi-strip`, `.chip-filter`, `.mono`);
- `ui/PageHeader.tsx`, with a new `eyebrow?: ReactNode` prop;
- `ui/primitives.tsx`: SectionCard gets a `flush` prop (body without padding, rows full-bleed) and a decision on the `icon` glyph; StatTile gets a `variant="cell"`;
- `SegmentedTabs.tsx`: `variant: 'pill'|'well'|'underline'` and an option `count`;
- `ui/Badge.tsx` (optional caps/`sev` variant), `Pagination.tsx`, `Modal.tsx`;
- the `AppShell.tsx:190-194` main container (prototype padding 32px, max-width 1240);
- the tooltip styling in all 6 recharts files, because PR1 already touches them for `isAnimationActive`. Their tooltip uses a literal radius 10 (`SubsHistoryChart.tsx:15`).
- **Update CLAUDE.md** (card-row rule vs rows-in-panel; see checks).

Page batches must not edit these files. Page-specific CSS goes into an area file imported by the route (precedent: `map/map.css`).

## 3. Page inventory
Column key: lines / `style={{` count / literal sizes ("lit"). "→" lists what the restyle means beyond the global class changes.

**Agents config and system**
- **agents** (164/34/34). h1 "Agents" (PageHeader, InboxButton).
  - Blocks: NeedsYou; stat-grid with 4 StatTiles; MigrationBanner (228); SystemCard `card row-lift` (:80); "Orchestrators" SectionCard with OrchestratorRow `card` (:105) and an expandable ChildRow.
  - → One flush panel of `.row`s with `.av`, a mono @handle and spend on the right, like the Today "Agents" panel. Child rows indent inside it. KPI strip. Eyebrow "N live · M paused". Consume `agents/AgentsUi`, don't edit it (PR3/PR5 own it).
- **models** (548/69/60; the densest page). h1 "Models".
  - Blocks: WorkspaceCard, a SegmentedTabs plus a grid of option `card`s with an accent border (:131-133); Default and Critic field grids; 2 tables (:427, :526); AgentModelModal.
  - Owns `models/ModelSelect` (202), which AgentOverview also uses.
  - → Workspace options become selectable `.chip-filter` tiles; tables go into flush panels.
- **dm** (469/55/46). h1 "DM inbox".
  - Blocks: "Agent status" SectionCard; "Chat intel" table (:288); `compact-grid`s for pending actions (:443) and threads (:464); a category SegmentedTabs; 3 `callout-danger`.
  - → Well tabs with counts. Rename the local `AgentPage` function to `DmPage`.
- **settings** (65). SegmentedTabs over ConfigurationTab (304/36), SecurityTab (145/12) and NavigationTab (584/15).
  - → Underline tabs. Config groups become chips; fields become `.field` rows (label | value | action), like the Agent "How posts look" section.

**Channels and intelligence**
- **channels** (230/21/20) and **tracked** (275/22/20). Both use ChannelRow (185, with a JS hover at `:36-37`), AddChannelModal (242) and Pagination. Both have hand-rolled loading and error `card`s (channels :139, :151; tracked :189, :239).
  - → Rows in a flush panel with CSS hover; errors become `.callout-danger`.
- **channels/$id** (534/44/30). Custom h1 (:141) inside a `card-featured` hero (:125). StatStrip with 5 tiles, 9 SectionCards, a strategies table (:413).
  - Owns PostsList, ForwardRoutesPanel, CrosspostSection, EditChannelModal, EditThemesModal and RoiPanel.
  - → The Agent-prototype entity header (64px avatar, h1 32, kind chip, mono meta line) and a KPI strip.
- **meta/$accountId** (253/20/20). Custom h1 (:164) in a `panel` hero. Its local `Field` (:122) shadows the shared `ui/Field`. Has a TokenPanel and 3 chart cards.
  - → The same entity header as channels/$id.
- **analytics** (257/11). PlatformToggle (:30), selects, 2 stat-grids, 6 chart SectionCards, ChartState (:35).
  - → KPI strip; chart panels get a `.ph` header and a `.lg` legend.
- **discovery** (217/19/21). ResultRow `card row-lift` (:119).
  - → Rows in a flush panel.
- **recommendations** (218/20). A fixed `2fr 1fr 1fr` grid (:35) with **no phone fallback**, plus RecommendationsTable (196).
  - → Make the grid responsive.
- **graph** (219/15). GraphFilters, StatusCard (:176) and Metric (:126), a layout tab switch, ChannelDialog, EdgePanel (299).
  - → Restyle the chrome only.

**Connections, health and map**
- **connections** (111). Three SegmentedTabs: the section (:85) and two sm sub-tab sets (:91, :102). The managers in `connections/*` total 1,506 lines and 170 style objects.
  - → Sections become well tabs, sub-tabs become underline. Each manager's card rows become one flush panel.
- **groups** (25). MetaGroupsManager (291) with `group-card` and `group-rise`.
  - → Panel radius; keep the reduced-motion guard at `index.css:634`.
- **health** (16). NetworkHealthView (246/36) and OwnerBotSection (88).
  - → Problems become rows with `.sev` pills. Today will link here.
- **map** (8 lines; MapPage plus about 2,030 lines in `map/*` and `map.css` at 229 lines, tokens only).
  - → HUD only: TopBar, FeedPanel, Legend and the drawers.

**Publishing and spend**
- **editor** (185/19). ChannelRow `card row-lift` (:103) with ModeSwitch (`EditorUi:72`), the Today SlotRow list, a spend table.
  - → Today-style agent rows with `.segm`; StatusMark for slots.
- **editor/$channel** (256/33/30). Plan with SlotRow, CardSummary rows (:108, already the `.field` pattern), Memory as CompactCards, a runs table.
  - → Reuse PR3's DayTimeline if it has merged.
- **editor/run/$id** (119) and **editor/slot/$id** (115). StepRow and run links are `card row-lift`.
  - → The `.ev` timeline with StatusMark; the eyebrow shows channel · time.
- **scheduled** (195/22). Four StatTiles; PostRow `card row-lift` (:133).
  - → Rows with "yours" tones. Keep it light: it later becomes `calendar?view=list`.
- **compose** (92). An intro `card` (:73) and PostComposer (268).
  - → Edit the route only. Keep `--color-tg-*`.
- **logs** (369/42/49). A filter bar (:276-317); LogRow, a timeline with a status rail and a JS hover (:120-121); a `<style>` block for logs-spin (:270).
  - → `.ev` timeline with mono time; well tabs and `.segm`.
- **spend** (40). SpendReport, PricesTab and BudgetsTab: 735 lines, 90 style objects.
  - → Budgets become 6px `.bar` rows; KPI strip.

**Data, ads and public**
- **data** (108). A `table-wrap` (:52), ImportHistory, ImportWizard (448/55).
- **data/$key** (103/6). Four StatTiles; tabs items / schema / imports; RoundsPanel, DatasetItems, SchemaEditor (296/46, with `--shadow-2` at :181), DataSuggestions.
- **artifacts** (91). A view tab switch, TypeChip (:80) and ArtifactList (113).
  - → TypeChip becomes `.chip-filter`.
- **ads** (500/43/38, 19 `input-field`s). PriceList table (:175), NewOrder grids (:257, :300), OrderRow `card row-lift` (:376), 2 Modals.
  - → The input metrics change most of this page.
- **landing admin** (383/17). A `.la-*` `<style>` block (:325-380). Owns `Panel`, PublicPageCard, NetworksCard, LeadsCard and CtaStatsCard (628 lines, each with its own `<style>`).
  - → Do not touch NetworkShowcase: PR7 owns it.
- **login** (214/18/26). h1 "ai0" (:129) in `card-featured` (:126).
- **report/$token** (151). Advertiser h1 (:86), `.rp-*` CSS (:133-148), the `Curve` SVG (:17), 4 StatTiles.
- **white-label** (200). `.wl-*` CSS (:135-196). Shares ProofStrip, LeadForms and WhiteLabel with `/`.
  - → **Hand it to PR7** in the Main.dc.html language.
- Also `app.tsx` AuthPending/AuthCheckFailed (68) and `NotFound.tsx` (31).

## 4. Special rendering that must not break
- **Graph.** `GraphCanvas` draws on a single canvas. Its colours come from tokens through `themeColors()` (`GraphCanvas.tsx:91-101`), read once per mount. Never per-node DOM. Do not edit GraphCanvas. Check token changes with `/app/graph?synthetic=2000`.
- **Map.**
  - Full-bleed via `AppShell.tsx:58-60` and `:190`; SVG pan and zoom; SMIL at `MapFx.tsx:88`; reduced-motion guards at `map.css:223-229`.
  - Restyle the HUD only. Leave MapStage and MapShapes geometry alone. FeedPanel props are frozen (PR3 reuses it).
- **Chat.**
  - Full-bleed via `isChatPath` (`AppShell.tsx:25,46`); a 3-column grid (`app.chat.tsx:321-325`).
  - The composer textarea and the Mention/Slash menus (:567-600) handle the keyboard; ArtifactPanel is the third column.
  - Keep the scroll containers.
  - The h1 is a `text-subhead` (:348), not a PageHeader.
  - `<details>` ApprovalStrip (:462) breaks CLAUDE.md.
- **Compose.** Its TelegramPreview colours are deliberately not themed.

## 5. Batches (parallel after batch 0)
| Batch | Routes | Owned components | ≈ lines |
|---|---|---|---|
| **B1 Channels & intelligence** | channels, channels_.$id, tracked, analytics, discovery, recommendations, graph | ChannelRow, AddChannelModal, EditChannelModal, EditThemesModal, PostsList, RoiPanel, ForwardRoutesPanel, CrosspostSection, RecommendationsTable, TargetChannelPicker, BudgetInput, GraphFilters, EdgePanel, ChannelDialog | 1,950 + 1,870 |
| **B2 Connections, health & map** | connections, connections_.groups, connections_.meta_.$accountId, health, map | connections/* (8 files), AddBotModal, AddTelegraphAccountModal, health/*, map HUD (MapHud, MapDrawers, MapActions, MapLinkMode, HUD part of map.css) | 413 + ~3,200 |
| **B3 Publishing & spend** | editor, editor_.$channel, editor_.run.$id, editor_.slot.$id, scheduled, compose, logs, spend | editor/CardEditorModal, editor/EditorUi (exports frozen; 12 importers), editor/SlotPlan (also ApprovalCard, DraftCard, AgentPlan), spend/* except SpendChart; PostComposer only after PR6b | 1,371 + ~1,700 |
| **B4 Agents config & system** | agents, models, dm, settings | strategies/MigrationBanner, models/ModelSelect, settings/* | 1,246 + 1,463 |
| **B5 Chat & artifacts** | chat, artifacts | chat/*, artifacts/* (ArtifactList is also the Agent tab), nav/NeedsYou (also used by agents) | 822 + 2,190 |
| **B6 Data, ads & public** | data, data_.$key, ads, landing, login, report.$token, app.tsx auth screens, NotFound | data/*, landing/{CtaStatsCard, LeadsCard, NetworksCard, PublicPageCard} | 1,560 + 1,850 |

`white-label.tsx` goes to PR7.

## 6. Cross-PR ordering and frozen files
- **PR1** edits `app.landing.tsx`, `app.logs.tsx`, `EditorUi.tsx:25-28` and the recharts files. B3, B6 and batch 0 rebase on top of it.
- **PR3** may extend `nav/NeedsYou.tsx`, adds Δ24h and Refresh to `MetaAccountsManager.tsx`, and reuses FeedPanel. Run B2 and B5 after PR3, or freeze those files.
- **PR5** creates the entity header and owns the restyle of AgentsUi, ApprovalList and AgentModeSwitch. B1 (channels/$id, meta/$accountId) and B3 (ModeSwitch) align with it.
- **PR6b** owns PostComposer.
- **PR7** owns NetworkShowcase, ProofStrip, LeadForms, WhiteLabel and `white-label.tsx`.
- **Frozen for every page batch:**
  - `ui/*`, `index.css`, `SegmentedTabs`, `Modal`, `Pagination`, `ChannelAvatar` (shared with PostComposer) and the chart files;
  - `agents/AgentsUi`, `approvals/*`, `overview/*`, `nav/registry.ts`, `nav/badges.ts`, `AppSidebar`, `GraphCanvas`.