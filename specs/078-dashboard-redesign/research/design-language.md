# design-language: Visual design language of the prototypes (App-Today/Inbox/Agent/Calendar, Main skimmed), mapped onto apps/dashboard/src/index.css tokens and shared primitives, applied app-wide

## Checks

- [confirmed] §1.1(1) --color-ink-dim #6f6f6f is ~3.4:1 on canvas and lower on surfaces; #949494 gives >=4.5:1 on all four — index.css:23. Measured: #6f6f6f = 3.43 canvas / 3.24 s1 / 3.09 s2 / 2.86 s3; #949494 = 5.68 / 5.37 / 5.12 / 4.73. Side effect: ink-muted #a0a0a0 is 6.59, so dim and muted end up only about 0.9 apart
- [partial] §1.1(2) --font-mono is not defined, so the code falls back to Tailwind's default mono — Nothing in src defines it, but Tailwind v4's default theme puts it in the build: dist/assets/index-CoikM-UO.css has --font-mono:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace. 9 TSX files use var(--font-mono). 13 places hard-code their own stack: ArtifactPanel.tsx:27, AgentLoadout.tsx:21, AgentSkills.tsx:28, ToolChips.tsx:53,64, SlashMenu.tsx:121-122, ActionCard.tsx:300,332,350, AuditBody.tsx:128, EditorUi.tsx:194 → FIX: Define it explicitly in @theme (no webfont) and replace the 13 literal stacks with var(--font-mono) or a .mono class
- [confirmed] §1.1(3) .text-heading-md is used but not defined — 4 uses, each with inline font overrides: ui/Card.tsx:16 (13/500), ui/primitives.tsx:113 SectionCard h2 (14/600), ui/Placeholder.tsx:12, agents/AgentLoadout.tsx:120 (13/600) → FIX: Define it as the panel-title tier (15px/600/1.3/-0.01em) and remove the inline sizes
- [partial] §1.1(4) var(--shadow-2) at SchemaEditor.tsx:181 does not exist (the inventory says that element has no shadow) — SchemaEditor.tsx:181 is boxShadow: 'var(--shadow-2, 0 8px 24px rgba(0,0,0,0.35))'. The fallback renders, so the element does have a shadow. There are no shadow tokens anywhere → FIX: Add the --shadow-* tokens (see brief); the inventory's 'no shadow' is wrong
- [partial] §1.1(5) slot tone maps diverge at routes/app.index.tsx:35-38 and EditorUi.tsx:25-28; skipped is warning on one and neutral on the other — The maps are at app.index.tsx:34-37 (SLOT_STATUS_TONE) and EditorUi.tsx:25-28 (SLOT_TONE). They differ on 4 statuses, not 1: running accent/warning, shadowed neutral/accent, approved success/accent, skipped warning/neutral → FIX: Point the lines at 34-37. status-tone.ts must replace both maps
- [confirmed] §1.1(6) compose-rise, modal-*, la-shimmer, logs-spin and recharts ignore prefers-reduced-motion — index.css:480-486 (modal) and :514-521 (compose-rise) have no guard. app.landing.tsx:377-379, app.logs.tsx:142,270. None of the 6 recharts files sets isAnimationActive (Engagement, SubsHistory, ViewsBar, MetaProfileViews, MetaReachImpressions, spend/SpendChart). Gotcha: .compose-rise starts at opacity:0 and animates forwards, so animation:none would leave 48 files' content invisible
- [confirmed] §2 --color-accent and --color-success are the same #3ecf8e — index.css:26 and :31
- [partial] §1 radii 10–20px map onto --radius-md…--radius-xl; buttons stay --radius-sm — The prototype uses 18px for panels, 20px for the agent avatar, and 12px for .btn/.search/.inp. Our largest radius is --radius-xl 16 (index.css:52). .panel is currently --radius-lg and .card --radius-md → FIX: Mapping: 18/20→xl, 14/12→lg, 10→md, 7–9→sm. Buttons stay sm as the handoff says, and that is a deliberate departure from the prototype's 12px
- [partial] §1 #F2B24C → --color-warning is the 'human' colour (approve, missed, needs action) — The token mapping is fine, but the code gives modes the opposite tones: EditorUi.tsx:20 MODE_TONE = {off:neutral, shadow:warning, approve:accent, live:success}, with 11 users. The prototype's .segm/.modes use approve=amber, shadow=dim green, live=accent → FIX: Remap MODE_TONE to approve:warning, shadow:neutral (or an accent tint), live:success
- [missing] Amber buttons (.btn-a 'Resume planning', .modes .ap on) need dark text on warning — There is no --color-on-warning token. Prototype text is #1E1404, and dark-on-#ffb224 measures about 10:1 → FIX: Add --color-on-warning (≈#1f1503)
- [partial] §1 #1A2320 / #1E2B25 active segment → --color-surface-3 or --color-success-soft — These are two different controls. Inbox .tabs selected = #1A2320 with neutral ink, which maps to surface-3. Mode .segm selected = #1E2B25 with green text, which maps to success-soft + accent. SegmentedTabs today has one selected style (success-soft + accent + green hairline, index.css:665-669) → FIX: SegmentedTabs needs a neutral default selection plus a per-option tone
- [missing] §7 After saving, a toast 'Scheduled for … Undo' appears — ui/Toast.tsx:10-34 has only toast.error/success(text). Each toast is a <button> that dismisses on click (Toast.tsx:75), so an action button can't be nested in it → FIX: Change the item to a div with role=status plus dismiss and action buttons, and add an optional {action:{label,onClick}} argument that is backward compatible with the ~203 existing calls
- [partial] §5.1 Below 860px the Inbox details open in a Modal or bottom-sheet — The 860 shell breakpoint is AppShell.tsx:32. Modal at ≤600 only bottom-aligns a near-fullscreen shell (index.css:838-840); it is not a real sheet and has no drawer variant (needed by the Calendar composer)
- [confirmed] §4 BudgetBar and StatTile exist and can be reused — overview/AiSpendCard.tsx:39 BudgetBar is 6px tall, radius 3 (lines 52-53), which already matches the prototype .bar. StatTile is at ui/primitives.tsx:58 (87 uses). No sparkline component exists
- [confirmed] Inventory: PageHeader uses .text-display-md but overrides it to 24px — ui/PageHeader.tsx:14 sets fontSize 24, weight 500, tracking -0.03em. It is used on 29 /app routes; 4 more routes hand-roll an h1

## Brief
## Visual design language: prototype system → our tokens and classes

### 1. What the prototypes define (values; hex given as our token)
- **Shell:** sidebar 248px on surface-1. Main area max-width 1240, padding 32 (24–28 top) on desktop and 16 at ≤760. Top bar padding 14/32.
- **Page header:** optional *eyebrow line* in mono 12px, .06em, uppercase, ink-dim ("WED, 28 OCT · KYIV 21:51"). h1 34px/600/-.035em (32 on the agent page). Subtitle 15px ink-muted, 6px below. Header row uses `align-items:flex-end`; actions or severity pills sit on the right.
- **Panel `.pnl`:** surface-2, 1px hairline, radius 18, **flat (no gradient)**, gap 16 between panels.
  - Header `.ph` padding 18/20/0; title `.pt` 15px/600/-.01em.
  - Right-side link: 13px accent, "Open inbox · 17 →", padding 10px 0 so it has a hit area.
  - Content padding 20, or *flush* rows.
- **Rows `.row/.need/.act/.item`:** padding 12–16 × 20, `border-top` hairline, first row borderless, hover ≈2% white. A selected item gets an accent-tinted background and a 2px accent left border.
- **Buttons `.btn`:** min-height 44, padding 0 16, 14/600, gap 8, radius 12, transitions .2s. Variants:
  - primary: accent / on-accent; hover lifts -1px with an accent glow.
  - ghost `.btn-g`: transparent, border white .14 → .3 on hover, bg +4%.
  - quiet `.btn-q`: no border, muted text, hover surface.
  - amber `.btn-a`: warning bg / dark text.
  - small `.btn-s`: 36px, 0 12, 13px, `::after{inset:-4px 0}` so the hit area reaches 44.
  - icon `.icb`: 44 square.
  - disabled: opacity .45.
- **Segmented controls:**
  - (a) Mode `.segm`: track canvas + hairline, padding 3, radius 10. Items 30px, 12px, `::after inset:-7px 0`. Selected colour depends on the mode: live/shadow green-soft, approve warning-soft, off white .1.
  - (b) Big mode `.modes`: 4 equal columns, 44px items, 14/600, **solid** selected fill (accent / warning / dim green / white .14); 2 columns at ≤760.
  - (c) Filter tabs `.tabs`: track surface-1, padding 4, radius 14. Items 40px, 14/500. Selected = neutral surface-3 + ink. Count `.tn` in mono 11 dim.
  - (d) Section tabs (agent page): underline style, 46px items, 2px accent bar inset 12px, border-bottom hairline.
- **Pills:**
  - `.sev`: mono 11/600, .04em, uppercase, padding 3/9, pill. Tones: crit = danger-soft, act = warning-soft, info = white .07.
  - `.live`: pill, padding 6/12, 13px, accent 8% bg, accent 25% border, with a pulsing dot.
  - `.chip`: 12px, padding 4/10, white .06; a mono variant for kinds and values.
  - Nav count `.cnt`: mono 11, padding 2/8, warning-soft/warning, or green for "5 live".
- **Avatars `.av`:** 32px, radius 10, green-tinted fill, accent 30% border, mono 12px initials. Neutral border for pipelines. The agent header avatar is 64px, radius 20, with a 6px accent halo.
- **Nav:**
  - Links `.nl`: min-height 40, padding 0 10, radius 10, 14px, muted; hover adds a white .05 bg.
  - **Active:** accent 10% bg, ink text, **accent icon**.
  - Group labels `.ng`: mono 11, .12em, uppercase, ink-dim, padding 18/10/6.
  - "More tools" is a `<details>` with a chevron that rotates 90°; its children are bordered 12px link chips.
- **Search ⌘K:** `flex:1 1 240px`, max-width 440, 44px tall, radius 12, surface-1, ink-dim 14px. kbd in mono 11, radius 6.
- **KPIs:** a *strip*, i.e. one panel holding tiles split by vertical hairlines (`.kpi` padding 18/20). Label 12px ink-dim in sentence case. Value 28/600/-.03em. Optional mono delta. Sparkline: 7 bars, gap 5, height 40, radius 3 3 0 0, accent at 35% with the last bar full accent.
- **Bars:** 6px track, radius 6, accent fill.
- **Empty state (inside a panel):** no border, padding 40/20. Medallion 44px, radius 14, success-soft with an accent check icon. Title 15/600, note 13px ink-dim, max-width 300.
- **Toast:** inline, accent-tinted bg, accent 30% border, radius 12, padding 10/12/10/16, 13px, quiet "Undo" button.
- **Banner:** warning 8% bg, warning 30% border, radius 14, padding 14/16, title 14/600, amber action button.
- **Detail boxes:**
  - `.box`: padding 16, radius 14, darker than the panel.
  - Key label `.k`: mono 11, .1em, uppercase.
  - `.code`: mono 12/1.6, darkest bg, radius 10.
- **Inputs:** min-height 44, radius 12, border white .14, darkest bg, 14px. Focus = accent border plus a 3px accent-18% ring. Labels 12px muted.
- **Motion:**
  - Easing `cubic-bezier(.2,.8,.2,1)`, hover transitions .2s.
  - Keyframes: slideIn (8px, .4s, list items and toast), fadeUp (6px, .35s, tab or detail swap), pop (scale .96, .35s, calendar chips), slideL (16px, .4s, drawer), grow / growY (bars, sparkline bars staggered .05s), pulseDot (2s infinite ring).
  - Reduced motion turns off every animation and transition.
  - `@media(hover:none)` shows hover-only controls.
- **Mono is used for** handles, times and relative ages, kind codes, counts in pills, money in dense rows, avatar initials, breadcrumbs, eyebrow and overline labels, tech details. It is **never** used for titles, prose or big KPI values.
- **Main.dc.html (landing)** uses pill buttons (48px, radius 999), an accent mono eyebrow and 20px cards. These stay landing-local and should not enter /app.

### 2. Token changes (index.css `@theme`, PR 1)
- `--color-ink-dim: #949494` (confirmed ≥4.73:1 on all four surfaces).
  - **Optional:** `--color-ink-muted: #b0b0b0` (7.94 on canvas). Without it the muted/dim steps sit only 5.68 vs 6.59 apart.
- `--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;` Tailwind already emits a default; this makes it ours. No Geist.
- `--color-on-warning: #1f1503`.
- New, on `:root`: `--shadow-1: 0 8px 28px rgba(0,0,0,.28)`, `--shadow-2: 0 8px 24px rgba(0,0,0,.35)`, `--shadow-pop: 0 12px 32px rgba(0,0,0,.45)`, `--shadow-modal`.
- Motion tokens: `--ease-out: cubic-bezier(.2,.8,.2,1)`, `--dur-fast: 120ms`, `--dur-base: 200ms`, `--dur-enter: 360ms`.
- Keep the radius and spacing values unchanged. Map the prototype radii onto them (18/20→xl, 14/12→lg, 10→md); buttons stay sm per the handoff.

### 3. Existing classes and components: what changes
**Global CSS (every page picks it up):**
- `*:focus-visible` (index.css:133-137): **drop `border-radius`**. Today focusing a pill, panel or modal changes its shape to 6px. The outline already follows the element's radius.
- `a:hover{opacity:.85}` (131): scope it to bare links or `.link-accent`, or switch it to a colour change. Today it dims `<a>` nav links and `<a class=btn-*>`.
- `.btn-primary/.btn-secondary/.btn-danger` (148-211):
  - `min-height:40px` (44 under `@media(pointer:coarse)`), `padding:0 16px`, `font-weight:600`, `gap:8px`, `line-height:1`, `transition: var(--dur-base)`.
  - Primary hover: translateY(-1px) + accent glow (`color-mix(... accent 60%, transparent)`).
  - **secondary becomes the prototype ghost:** `background:transparent; border:1px solid var(--color-hairline-strong)`; hover `background: var(--color-surface-3); border-color: var(--color-ink-dim)`.
  - Update the comment "No bordered ghost buttons" (145), which the prototype contradicts.
- `.btn-ghost` (225) becomes the prototype quiet button: `inline-flex; gap 8; min-height 36; padding 0 12; radius sm; 13px/500`.
- `.btn-tiny`/`.btn-tiny-danger`: keep the 30px visual height (it is used inside tables). Add `position:relative` and `::after{content:'';position:absolute;inset:-7px 0}` to get a 44px hit area.
- `.btn-act` stays 30×30 and gets the same ::after.
- `.btn-danger`: white on #e5704b measures **3.11:1** and fails AA. Use dark text, or darken the background.
- `.input-field` (410):
  - border hairline → hairline-strong, radius sm → md, 14px, padding 10px 12px.
  - Remove the hover background swap; hover changes the border to ink-dim instead.
  - Focus adds `box-shadow:0 0 0 3px var(--color-success-soft)`.
  - No forced min-height, because 61 of 252 tags override padding inline (compact inputs in toolbars).
- `.panel` (301): remove the radial wash, padding 18 → 20, keep the inset highlight.
  - Put the **radius xl only on SectionCard**, through a new `.panel.is-section` class. Raw `.panel` (59 tags, 51 with inline `padding:'8px 10px'`-style overrides) is mostly small rows that would look bloated at 16px.
- `.card` (268): remove the wash. Radius md → lg only when padding is ≥16 (CompactCard keeps md).
- `.section-head` (318): `margin-bottom:14px`. Define `.text-heading-md{font-size:15px;font-weight:600;line-height:1.3;letter-spacing:-.01em}` and remove the inline sizes in primitives.tsx:113, Card.tsx:16, Placeholder.tsx:12 and AgentLoadout.tsx:120.
- `.stat-tile` (341): **remove the hover lift**, because the tiles aren't interactive.
- `.empty-state` (367): add `.panel .empty-state{border:0;background:none;padding:40px 20px}`; medallion 44px, radius lg, solid border.
- `.callout-warning/.callout-danger` (748-765; 42 and 75 uses):
  - Border becomes `1px solid color-mix(in srgb,var(--color-warning|danger) 30%,transparent)`; drop the danger 3px left bar.
  - Radius lg, padding 14px 16px, `align-items:center`.
  - Add `.callout-success`.
- `.chip` (678): padding 3px 10px.
- `.tabs-pill` (645-671), used by 32 SegmentedTabs instances plus 6 direct users (AddChannelModal:114/191, EditChannelModal:141/156, PostComposer:153, AgentPlaybook:175-184):
  - It becomes a **track**: `padding:4px; gap:4px; background:var(--color-surface-1); border:1px solid var(--color-hairline); border-radius:var(--radius-lg); max-width:100%`.
  - Items: `min-height:36px; padding:0 14px; radius md; 14px/500`. `.is-sm` → 30px, 12px, with `::after inset:-7px 0`.
  - **Selected becomes neutral:** `background:var(--color-surface-3); color:var(--color-ink); border-color:transparent`.
- `.table-wrap/.table` (709-742): 17 of 22 table files nest the table inside a panel.
  - Keep surface-1 as an inset, add a 1px hairline border, radius xl → lg.
  - `th`: ink-dim 12/500. Row lines hairline-soft → hairline.
  - First and last cells get 20px padding so they align with the panel.
- `.modal-shell/head/foot` (440-478):
  - Remove the wash, padding 22 → 24.
  - Head and foot lines become **hairline**. hairline-soft on surface-2 is 1.03:1, i.e. invisible.
  - Title 18/600/-.02em (Modal.tsx:71).
  - The close button becomes quiet/ghost 36px instead of the round `btn-icon` (Modal.tsx:81-88).
  - At ≤600 make it a real bottom sheet: top radii only, slide-up, `env(safe-area-inset-bottom)`.
- `.nav-link` (929): `min-height:40px; padding:0 10px; gap:10px; radius md; 14px`; hover background surface-2.
  - `.nav-link-active`: `background:color-mix(in srgb,var(--color-accent) 10%,transparent); color:var(--color-ink)`, plus `.nav-link-active svg{color:var(--color-accent)}`.
  - `.nav-badge` (934): mono 11/500, `padding:1px 8px`, no border, warning-soft/warning by default, with `.is-danger`/`.is-accent` modifiers. SidebarItem.tsx:63 must then use a class instead of the inline `borderColor`.
- `.cmdk-trigger` (998-1001): desktop `flex:1 1 240px; max-width:440px; width:auto; height:40px; radius lg; 14px`; mobile 40px. `.kbd` 11px, radius sm. `.crumbs` in mono.
- Dead CSS to delete: `.nav-item` (783-804, 0 users) and `.btn-translucent` (190, 0 users).

**One component file each (all users benefit):**
- **PageHeader.tsx:14:**
  - Use a new `.page-title` (32/600/1.1/-.035em; 25px at ≤600) instead of the 24px override.
  - Subtitle 15px muted.
  - Header `align-items:flex-end`, margin-bottom 24.
  - New `eyebrow?: ReactNode` prop rendered with `.text-overline`.
  - Covers 29 routes.
- **SectionCard** (primitives.tsx:96): new `flush?` prop (no padding, `.panel-head` padding 18/20/0, children are `.panel-row`); `action` renders as `.panel-link`; icon stays optional.
- **StatTile** (primitives.tsx:58):
  - Label becomes sentence case 12px ink-dim (drop the uppercase at :79); value 28/600/-.03em.
  - New `spark?: number[]` prop.
  - New `StatStrip` wrapper (`.stat-strip > .stat-tile{border:0;border-left:1px solid var(--color-hairline);background:none;border-radius:0;flex:1 1 200px}`).
- **Badge.tsx:28:** 10px → 11px, weight 600. **Keep sentence case.** Uppercase mono would turn `@handles` in FollowsBadge/StateBadges into capitals (318 uses).
- **EmptyState:** new `tone?: 'neutral'|'clear'`. `clear` = success-soft medallion with a check, for "All clear" and "Nothing to approve".
- **SegmentedTabs:**
  - Option gains `count?: number` (rendered as `.tabs-count`, mono 11) and `tone?: 'accent'|'warning'` for the selected fill.
  - New `variant?: 'track'|'underline'` (`.tabs-line`, for the agent-page groups).
  - New `size:'lg'` for the big 4-up mode switch (`.modes`, solid fills, needs `--color-on-warning`).
  - MODE_OPTIONS (EditorUi.tsx:59) carry tones, and MODE_TONE (EditorUi.tsx:20) is remapped: approve warning, shadow neutral.
- **Toast.tsx:** prototype look (accent- or danger-tinted bg, 30% border, radius lg, slide-in), plus an `action` option. The item has to become a div, because nested buttons are invalid.
- **Modal:** `size:'drawer'` (right sheet, slide-left) for the Calendar composer.
- **AppSidebar.tsx:**
  - Group title :99-101 becomes class `.nav-group-title` (mono 11/.12em/uppercase, padding 18/10/6); width 234 → 248.
  - Bottom block: BudgetBar card plus identity and Log out, moved out of the header (AppShell.tsx:171-186).
- **AppShell.tsx:** header padding 14/32 (12/16 mobile); main padding 32/32/48 (16/16/48 mobile); maxWidth 1320 → 1240.
- **AgentGlyph** (AgentsUi.tsx:36) / `.hub-glyph`:
  - Fill `color-mix(accent 8%, surface-2)`, border `color-mix(accent 30%)`, flat.
  - `.is-neutral` for pipelines; `.is-xl` (64px, radius xl, 6px halo).

### 4. New classes and primitives
- **Type:**
  - `.mono` (font-family var(--font-mono); `font-feature-settings:normal`, because body sets the Inter cv/dlig features).
  - `.text-overline` (mono 11, .1em, uppercase, ink-dim) for the eyebrow/date line, the "What happened" keys and sidebar group labels.
  - Don't restyle `.text-eyebrow`: 34 files use it for Field labels.
- **Layout:** `.panel-head`, `.panel-row` (`padding:12px 20px; border-top:1px solid var(--color-hairline)`, first row none, hover 2% ink), `.panel-foot`, `.panel-link`, `.inset` (box), `.code-block`.
- **Pills and marks:**
  - `SeverityPill` / `.sev .sev-critical|action|info`. Severity is `'info'|'action'|'critical'` (api/agents.ts:187, api/nav.ts:7). Centralize `NeedsYou.tsx` SEVERITY_TONE/LABEL; its "Info" label vs the prototype's "FYI" is an owner choice.
  - `LivePill` (`.pill-live`) with `.status-dot.is-live` (pulse-ring).
  - `StatusMark` (shapes from handoff §2; 14px; hover scale 1.35) plus `.severity-mark` (circle / diamond / hollow).
  - `Sparkline`.
  - `.chip-toggle[aria-pressed=true]` (Lock, channel picker).
  - `.btn-warning`.
- **Hook:** `usePrefersReducedMotion()` (wrapping lib/useMediaQuery.ts), passed to recharts as `isAnimationActive={!reduced}` in all 6 chart files.
- **Keyframes:** `fade-up`, `pop`, `slide-left`, `pulse-ring`, `grow-x`, `grow-y`. Keep `compose-rise` (48 files).
- **Global reduced motion** at the end of index.css:
  - `*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}`.
  - **Not `animation:none`**: `.compose-rise` starts at opacity 0 with `forwards`, so it would stay invisible.
  - Also add `@media(hover:none)` reveals for hover-only controls.
- **Page-level only:** DayTimeline (lanes 44px, dashed separators, `.now` line, past shading), SlotRing, calendar `.sc` chips, the Inbox master-detail list (`.item`), Today "need" rows.

### 5. Global vs page-level
- **Free for all pages:** §2 tokens and every CSS change in §3. Ink-dim alone lifts every tertiary label, placeholder and neutral StatusDot.
- **One component edit, every user benefits:** PageHeader (29 routes), SectionCard (110), StatTile (87), EmptyState (94), Badge (318), SegmentedTabs (32), Modal (52), Toast (~203 calls), sidebar and shell.
- **Page-level:** Today, Inbox, Agent and Calendar layouts, and any page that wants StatStrip, flush panels or eyebrows.

### 6. Risks and counts
- **Inline literals:**
  - `borderRadius`: 168 inline (122 already `var(--radius-*)`, 42 numeric: 3px×9, 10×9, 999×7, 4×6, 8×3, 2×3, 6×2, 7/12/9999×1; plus 4 strings `'9999px'`/`'50%'`).
  - `fontSize`: 194 inline, 186 numeric (11px×52, 13×33, **10×30**, 12×25, 14×10, 15×8, 17 half-pixel sizes 8.5–12.5).
  - 3,349 `style={{` objects overall. Token changes won't reach the numeric literals; sizes below 11px stay tiny.
- **Buttons in dense tables:** btn-tiny has 73 tags in 39 files; 14 table files also use btn-primary/secondary (spend/BudgetsTab, PricesTab, SpendReport, app.models, app.ads, app.editor*, app.data, app.dm, channels_.$id, LeadsCard, AgentMemoryHistory, SchemaEditor, ImportWizard). Keep 30px visuals plus ::after hit areas there; 40/44px only on standalone primary/secondary.
- **Radius:** don't raise `.panel`/`.card` globally (heavy inline padding overrides); use SectionCard plus opt-in classes.
- **Separators:** hairline-soft is invisible on surface-2 (1.03:1); hairline measures 1.14 and hairline-strong 1.36.
- **Doc conflicts:** apps/dashboard/CLAUDE.md and the index.css comments (122 "uppercase-eyebrow anti-pattern", 145 "No bordered ghost buttons") contradict the prototype. The Inbox master-detail layout also conflicts with the CLAUDE.md "Compact cards → dialog" rule. Update them in PR 1.
- **Saved menus:** the sidebar width and nav-link height change in the collapsed rail (64px). Check `.nav-star` positioning at the 40px row height.