# landing: Handoff §8: landing '/' vs prototype Main.dc.html

## Checks

- [confirmed] motion (motion/react) is installed and <MotionConfig reducedMotion="user"> already wraps the page; no new deps needed — apps/dashboard/package.json:31 "motion": "^12.40.0"; routes/index.tsx:3 import, :79 <MotionConfig reducedMotion="user">
- [partial] Hero: the subtitle is still transparent after 2 s — index.tsx:125-130: motion.p opacity 0→1, delay 0.14 + duration 0.65, so it finishes at about 0.8 s. The code cannot cause a 2 s delay. The likely cause is rAF throttling in a hidden or background tab, because motion runs on rAF → FIX: Not reproducible from the code. The real requirement is that the content must not depend on rAF or IO to become visible. Use CSS keyframes with fill-mode `both` (as the prototype does) for the hero entry, or verify it in a foreground tab
- [partial] HeroHeadline: stagger ≤0.07 s per word, whole entry ≤900 ms — The prototype (Main.dc.html:201-207, :37, :142) uses word delays .05/.12/.19/.30/.37/.44/.51 s and `wordUp` 1s cubic-bezier(.16,.9,.2,1) `both`. The last word ends at 1.51 s. Then sub .6 s, CTAs .75 s, WL link .85 s, stats .95 s, all `fadeUp` 1 s, so everything ends at about 1.95 s → FIX: The prototype breaks the handoff's own 900 ms budget. Compress it, e.g. 0.05 s stagger and 0.45 s per word, so 7 words end at about 0.75 s, and start sub/CTA at ≤0.45 s with 0.4 s duration. The headline text is the same as now ('A media network run by AI agents', owner decision, index.tsx:115)
- [confirmed] HeroOrbit: CSS @keyframes rotate, agent labels counter-rotate, transform/opacity only — Main.dc.html:41-58. The rings counter-rotate. `ripple` uses transform+opacity. Data exists: diagramNodes(networks,max) at landing-view.ts:123 gives name/emoji/mode per network agent. heroPlatforms at :39. pulse.last7d.platforms[].agentPosts marks a platform 'live' → FIX: Agent names reach the public payload only per network (LandingNetwork.agent). Agents of channels outside a network group are dropped (landing-networks.service.ts:147,185-192). Showing all 5 needs a small backend add: `agent` per LandingNetworkResource (publicAgent(agent) is already computed at :148)
- [missing] AgentLog: phase 1 static 10 lines; phase 2 new public endpoint (gap L1) — No public activity feed exists. The public routes are GET /api/landing/{resources,config,pulse,networks} (config/api/landing.controller.ts:69-96), GET /api/landing/{prices,media-kit} (payments/ads-public.controller.ts:24,34), and POST /api/landing/{cta,leads}. The only event feed is GET /api/map → MapSnapshot.events: MapEvent{id,at,kind,agent,ref,text}. It is guarded (editor/map/map.controller.ts:11-12, TrackingAuthGuard) and carries @handles, which the public rules forbid (landing.controller.ts:4) → FIX: Static invented lines under a 'streaming' live dot would be misleading. Phase 1 should build the lines from real pulse aggregates instead (see brief). L1 = a new GET /api/landing/activity built from map.queries.ts:273+ sources, with templated English text, no handles, and positive kinds only
- [wrong] ChannelMarquee replaces ProofStrip; data from existing landing-view — ProofStrip (ProofStrip.tsx, proofTiles landing-view.ts:88-118) shows pulse numbers with '?' definitions. It is also used by /white-label (white-label.tsx:8). The prototype's equivalent is the hero mono stats row (Main.dc.html:215-219: posts in 7d · % agent-made · last post). The marquee lists channels, which is networks[].resources data → FIX: Marquee = a new component fed by flattening useLandingNetworks(). Hero stats row = ProofStrip restyled, keeping proofTiles' zero-hide rule and the definitions. Keep the ProofStrip export for /white-label
- [partial] RoleExplorer replaces AgentHierarchy; ah-travel packets remain — AgentHierarchy (hero, live data: managerLive gate, network nodes, roleChips from pulse.rolesActive, platforms). In the prototype the hero diagram becomes HeroOrbit, and RoleExplorer sits in #how. It replaces the 'Who runs the network' row of HowItWorks.tsx:61-68 (agentSteps :14-24, whose copy the prototype reuses verbatim). Ideator and Idea reviewer copy is new → FIX: AgentHierarchy → HeroOrbit + RoleExplorer. Keep the managerLive gating (MANAGER 'Soon'/'Will read…', HowItWorks.tsx:16-18) and light the role buttons from roleChips(pulse). ROLES kinds (landing-view.ts:134-140) match the prototype ids
- [partial] LoopRing + GuardTrack replace HowItWorks — HowItWorks has 2 rows: agent steps and ad steps (AD_STEPS :26-31) plus AdCtaPair placement 'howitworks' (:83-87). LoopRing/GuardTrack are new illustrative sections with no data. The guard list matches the Executor copy (:21) → FIX: The ad-steps row moves to AdSteps, and the 'howitworks' CTA placement needs a decision (keep it or fold it into 'advertise')
- [confirmed] ApprovalDeck: CSS keyframes, 3 cards with negative delays — Main.dc.html:92-94,158-159,385-407: `deck` 9s cubic-bezier(.6,0,.3,1) infinite, delays 0/-3/-6 s; `stamp` 9s linear → FIX: The card contents are Cyrillic placeholders with dev handles. Hardcoding them fails lib/no-cyrillic-ui.test.ts. Use English skeleton cards
- [partial] NetworkShowcase: no data changes, hover-lift + spotlight — It already has hover lift (-3px) and a per-platform glow (NetworkShowcase.tsx:31,200-206). The prototype flattens to one grid and drops network headers, the per-resource 'Ads here' (placement resource, :64-70) and the network 'Advertise in this network' (placement network, :102-107). It shows only 2 badge states. The component is shared with the /app/landing preview (app.landing.tsx:24,300) → FIX: Restyle only. Keep the grouping or the ad links, the 3-state aiRunBadge (shadow included), and 'no data fetching/router hooks'. A per-card agent name needs per-resource agent in the payload
- [wrong] AdSteps replaces part of MediaKit (useScroll/whileInView) — The ad steps live in HowItWorks.tsx:26-31,70-87. MediaKit (MediaKit.tsx; GET /api/landing/media-kit → MediaKitChannel{channelKey,title,url,subscribers,avgViews30d,posts30d,prices[],adDmUrl?}) is the price list and has no counterpart in the prototype. The prototype line uses CSS `animation-timeline: view()` (Main.dc.html:137-141), with a fallback of a 3.5 s infinite loop → FIX: AdSteps replaces the HowItWorks ad row. Keep MediaKit in #advertise. Draw the line once with whileInView scaleX, not an infinite loop
- [partial] ShadowLiveDemo replaces part of WhiteLabel (useState) — WhiteLabel.tsx exports are used by /white-label (white-label.tsx:10). lead-form.test.ts:47-51 asserts WhiteLabelSection renders <SingleTenantNote /> and index.tsx contains `{whiteLabel && <WhiteLabelSection />}` → FIX: Add the demo inside WhiteLabelSection. Do not drop SingleTenantNote or the flag gate
- [partial] Counters: existing CountUp; show the final number in the no-JS state — CountUp lives in index.tsx:30-59 and is not exported. It starts as '0' and has no aria-label. The app is a pure CSR SPA (index.html has only #root), so without JS nothing renders at all. The reduced-motion branch already shows the final value (:35-38) → FIX: The no-JS concern does not apply. Instead add aria-label/visually-hidden final values and render after data (audienceStats landing-view.ts:53)
- [partial] Remove '| DEV' from channel names via lib/landing-view.ts — landing-view.ts produces no names. The title is built in NetworkShowcase.tsx:22 (displayName ?? @handle) and MediaKit.tsx:21. displayName = tracked_channels.title (landing-resources.service.ts:79-89), the Telegram channel title synced by the tracker (tracking/repositories/tracked-channels.repository.ts:108-115). Dev titles are like 'AI Шукає Новини | DEV' (evals/cases/integrity.ts:42). The server also puts the title into DM prefill text (landing-networks.service.ts:155; ads-public.controller.ts:43). Handles are *_dev too → FIX: A client helper publicTitle() stripping /\s*\|\s*DEV$/i only fixes the visible text. Cleaner: strip in mapTracked and mediaKit on the server, or feature prod channels on prod
- [wrong] Prototype placeholder texts are marked […] — `grep` finds 0 '[…]' markers in Main.dc.html. All sample data is unmarked: CH (7 channels, followers 4/5/16/3/3/3/3), FEED (10 lines), deck cards, 'Seven channels', '30 posts / 88% / 2 h ago', 'Live · 5 agents' → FIX: Classify by hand (see brief)
- [confirmed] Font stays Inter; Geist optional — index.css:90-100 InterVariable. No --font-mono token exists (only used with fallback at index.css:852,881)

## Brief
## Landing `/` redesign: brief for §8 / Main.dc.html

### Current structure (to be replaced)
`routes/index.tsx` (498 lines) contains:
- topbar (Advertise + Sign in)
- hero: pill `heroPill`, h1, gated sub (`managerLive`), `ProofStrip`, CTAs, `NoTelegramLink hero`, WL link, `AgentHierarchy`
- `#networks`: CountUp stats + `NetworkShowcase`
- `#how-it-works`: `HowItWorks` (agent row + ad row + `AdCtaPair howitworks`)
- `#advertise`: `MediaKit` + `AdCtaPair advertise`
- `#white-label`, gated
- `AdLeadModal`
- footer

The page styles live in an inline `<style>` (`.lp-*`).

Data hooks (api/landing.ts):
- `useLandingNetworks` → `GET /api/landing/networks` → `LandingNetwork[]` {name|null, blurb, order, agent{name,emoji,mode:'live'|'shadow'}|null, followers, platforms[], adDmUrl, resources: LandingNetworkResource[] {platform, handle, displayName, avatarUrl, followerCount, url, order, aiRun:'live'|'shadow'|'none', adDmUrl}}. Cached 300 s.
- `useLandingPulse` → `GET /api/landing/pulse` → `LandingPulse` {agents{orchestratorsLive, orchestratorsShadow, rolesActive[], manager}, last7d{agentPosts, allPosts, autonomyShare, platforms[{platform,posts,agentPosts}], agentRuns, skippedByAgents, directivesFiled, managerReviews, ideasReviewed, ownerDecisions}, lastAgentPostAt, claims{managerLive}, generatedAt, stale}. Returns 503 on failure, so hide the strip.
- `useLandingPublicConfig` → `GET /api/landing/config` → {adDm{available, username, urls: Partial<Record<'hero'|'topbar'|'advertise'|'footer'|'howitworks', string>>}, whiteLabelEnabled}.
- `useMediaKit` (api/ads.ts:105) → `GET /api/landing/media-kit`.

### Prototype sections → implementation

**1. Sticky nav** (Main.dc.html:19-27,181-192)
- Shows blur(14px) and an anchor nav (How it works / Network / Advertise / White label, hidden ≤760px) plus Sign in.
- Keep the topbar Advertise as `AdDmLink placement="topbar"` (index.tsx:95-97), visible on mobile as well.
- Gate the White label link by `whiteLabelVisible(config)`.
- Sign in → `/app`.

**2. Hero left column** (:199-219)
- Pill "Live · N agents publishing to Telegram": N = `pulse.agents.orchestratorsLive`, platform from `last7d.platforms` with `agentPosts>0`. Fall back to `heroPill()` when 0 or on error. Its `.dot` pulses via `pulseDot` 2s, which is a box-shadow (paint). Use an opacity/scale ring pseudo-element instead.
- `HeroHeadline`: the same text as today. Per-word `.w` overflow mask, `wordUp` = translateY(105%) rotate(4deg) → none. The prototype's 1.95 s total must be compressed to ≤900 ms (see checks). Use a CSS `both` fill so the text never stays hidden waiting on rAF. Caret `blink` 1.1s steps(1).
- Subtitle: keep the managerLive-gated copy (index.tsx:131-136). The prototype's "A MANAGER agent watches…" is ungated, and its ending "code guards handle the rest" is marketing.
- CTAs:
  - "See the network" → `#networks`.
  - The secondary must stay `AdDmLink placement="hero"` "Order an ad in Telegram" + `NoTelegramLink hero` when `adUrls.hero` is set, else `#advertise`.
  - WL link with `sendCtaBeacon('white_label','hero')`, gated.
- Mono stats row = restyled ProofStrip. Values:
  - `compact(last7d.agentPosts)` "posts by agents in 7 days" (the prototype's "30 posts" is ambiguous; agentPosts is the defined number)
  - `autonomyShare%` "agent-made"
  - `relativeTime(lastAgentPostAt)`
  - Keep the proofTiles zero-hide rule, the "?" definitions and the `stale` note.
  - Reserve min-height so a late pulse does not shift layout. Today ProofStrip inserts above the CTAs, which is a CLS source.

**3. HeroOrbit** (:40-58,223-244). Replaces AgentHierarchy in the hero.
- Box 520×520.
- r2: inset 16 (radius 244), dashed accent, `spin` 70s linear reverse. Holds platform pills at -140/-68/4/76/148°, counter-rotated by `.up2` 70s forward.
- r1: inset 110 (radius 150), `spin` 40s. Holds 5 agents at 72° steps from -90°, counter-rotated by `.up1` 40s reverse.
- Satellites: `.sat` 7s, `.sat2` 11s reverse (warning dot).
- Core 132px "MANAGER / watches all", `ripple` 3.2s ease-out (scale 1→2.3, opacity .7→0), second ring delay 1.6s.

Data:
- `diagramNodes(networks, 5)`: name, emoji, mode. Show the emoji or the first 2 graphemes of the name, both runtime data, so Cyrillic is fine.
- Platforms from `heroPlatforms()`; "live" when `pulse.last7d.platforms[p].agentPosts>0`.
- MANAGER is dimmed with "soon" unless `claims.managerLive`.
- Gap: agents of channels that belong to no network group are not in the payload. Add `agent: LandingNetworkAgent|null` to `LandingNetworkResource` in `buildNetworks` (landing-networks.service.ts:148-159; `publicAgent()` exists at :108) and to the dashboard type (api/landing.ts:60).

Mobile:
- The prototype uses `scale(.62)` with margin -99px. The layout box stays 520px inside a 343px column and relies on `overflow-x:clip` (index.tsx:289).
- Prefer `--orbit: min(520px, 100vw - 32px)` with radii as % of `--orbit`.
- `aria-hidden` (decorative). Add an sr-only sentence that lists agents and platforms.

**4. AgentLog** (:59-66,245-257,565-576)
- Window 196px with a top/bottom mask. `feed` 26s linear translateY(-50%) over a duplicated list.
- Row grid 44px/70px/1fr; at ≤760 it becomes 40px/1fr with the time spanning 2 rows.
- At ≤1100 the absolutely placed terminal (left:-90, bottom:-60, 430w) moves below the orbit.
- No public feed exists (see checks). The FEED rows are invented, and they carry dev handles and fake times under a "streaming" live dot. That would mislead.
- Phase 1, recommended: lines built from real `pulse.last7d`, labelled "this week" instead of "streaming". Hide each line when its count is 0:
  - `executor · {agentPosts} posts published ({autonomyShare}% of all)`
  - `executor · {skippedByAgents} slots skipped by the agent's own call`
  - `idea reviewer · {ideasReviewed} ideas reviewed`
  - `agents · {agentRuns} successful runs`
  - `manager · {managerReviews} reviews, {directivesFiled} directives` (only if managerLive)
  - `owner · {ownerDecisions} decisions`
  - `last post · relativeTime`
- Phase 2 (L1): `GET /api/landing/activity` → `Array<{at: string /*minute*/, role: 'planner'|'ideator'|'idea_reviewer'|'executor'|'reviewer'|'manager'|'owner', text: string}>`.
  - Public, cached ~120 s.
  - Built from the 24 h event sources in editor/map/map.queries.ts:273+ (runs, slots, directives).
  - Positive kinds only, English templates, network/resource display names allowed, no @handles, no unpublished topics.
- Rows must be `aria-hidden` for the duplicate copy.

**5. ChannelMarquee + outline words** (:67-72,262-276)
- Pills: dot, name, mono handle.
- `marquee` 46s linear translateX(-50%) over a duplicated list. The second row is `.rev` 38s reverse: Plan/Write/Guard/Publish/Measure/Learn, `-webkit-text-stroke` 1.2px, Write/Measure filled accent, font clamp(56px,9vw,132px).
- Mask fade at 10%/90%.
- Data: flatten `networks[].resources`.
  - name = `displayName ?? @handle`, passed through a new `publicTitle()`.
  - Dot: live = pulsing, shadow = warning, none = grey. The prototype has only 2 states.
  - Add a platform icon for non-Telegram resources.
- Hide the duplicate from screen readers. Reserve the height while loading.

**6. #how: RoleExplorer** (:73-81,278-322,537-550)
- Layout: MANAGER and Orchestrator×N big buttons → 5 role buttons → platform pills, joined by `.conn` 2px×56px connectors.
- The travelling dot is `travel` 1.9s cubic-bezier(.5,0,.5,1), delays 0/.6/1.2s. It animates `top`; use translateY instead, close to the existing `ah-travel` 1.8s.
- Detail card: "{num} / 07", title, desc, tags, "Reports to".
- Copy for 5 roles = agentSteps (HowItWorks.tsx:14-24). Ideator and Idea reviewer copy is new.
- Use `aria-pressed` on the buttons and `aria-live="polite"` on the card. Light role buttons from `roleChips(pulse)`. Gate MANAGER copy by managerLive.
- Platform pills: "Telegram" live, others "· soon". Derive this from pulse instead of hardcoding.

**7. LoopRing + GuardTrack** (:82-91,324-369). Static copy, no data.
- Ring 380px. Sweep: conic arc masked to the ring, `spin` 6s linear.
- 6 steps at (50,10.5) (84.2,30.25) (84.2,69.75) (50,89.5) (15.8,69.75) (15.8,30.25)%. `stepLit` 6s, delays 0–5s in 1s steps, lit for 0–14%. This is synced to the sweep.
- Track 150px: 5 gates at 18/34/50/66/82%, `gate` 6s with delays .84/1.87/2.9/3.93/4.96s. These equal the token arrival: `tok` 6s moves left 4→86% over 0–88%. The "Published" end pill has delay 5.2s (hidden on mobile).
- `stepLit`/`gate` animate border/colour/shadow/background, and `tok` animates `left`. Re-implement them as opacity of a glow overlay and translateX, so they stay compositor-only.
- Icons: `copy` and `spend` exist. `gauge`, `moon` and `power` need adding to ui/Icon.tsx (Lucide Gauge/Moon/Power).

**8. Human in the loop: mode cards + ApprovalDeck** (:92-99,371-410)
- 4 static mode cards; Approval is highlighted as "launch period".
- The "agents write tomorrow's posts by 20:00" claim is true (editor/approval/approval-timing.ts:10).
- Deck timings are in the checks. Use English skeleton cards: the titles are Cyrillic, the handles are dev handles, and both are placeholders. `aria-hidden`.

**9. #network** (:100-108,412-443)
- Counters: `audienceStats()` followers / resources / platforms. The prototype says "platform live"; keep "platforms" unless it is computed from pulse.
- The heading "Seven channels. One agent in charge of each." is invented and false for pipeline channels. Make it data-driven or neutral.
- Cards: hover translateY(-6px), with a `::before` radial spotlight whose opacity goes 0→1 over .35s. Add this to `.rs-card` in NetworkShowcase.
- Keep: grouping or network header, `Ads here` (placement resource) + `NoTelegramLink`, `Advertise in this network` (placement network), the shadow badge, the loading skeleton, the error callout and the empty state (index.tsx:204-219).
- Changes also show in the /app/landing preview.

**10. #advertise: AdSteps** (:109-113,445-466)
- Line plus 4 step cards. The copy equals AD_STEPS.
- Keep MediaKit (prices) and `AdCtaPair href={adUrls.advertise} placement="advertise"`. Its no-DM fallback is the "Request an ad placement" button, the prototype's label.
- Keep the AI disclosure note.
- Decide whether to keep the `howitworks` placement, because CtaStats rows are counted per placement.

**11. #white-label: ShadowLiveDemo** (:114-124,468-502,589-599)
- Segment 260px with thumb translateX(100%) .45s cubic-bezier(.2,.8,.2,1). Use `aria-pressed`.
- Lanes of 20 blocks, `marquee` 22s (agent lane 16s). Shadow = dashed, live = filled. The "current setup" lane goes to .3 opacity when live.
- Put it inside `WhiteLabelSection` and keep `<SingleTenantNote />`, `/white-label` CTA and `track('white_label','whitelabel')`.

**12. Final CTA + footer** (:504-527)
- Stroke wordmark clamp(140px,26vw,360px). `bigdot` `pulseBig` 2.4s scale 1→1.15.
- Sign in + "Advertise with us" (`#advertise`).
- Footer keeps `AdDmLink placement="footer"` and the WL beacon `('white_label','footer')`.

### Motion rules
- Add `.loop` to every infinite animation.
- One IntersectionObserver per section toggles `.is-offscreen` → `animation-play-state: paused`.
- `@media (prefers-reduced-motion: reduce) { .lp-root *, ::before, ::after { animation:none; transition:none } }`. With that, `both`-fill entries show their final state.
- Give static fallbacks: token position, the deck's top card, sweep at rest.
- Entries use motion `whileInView` once, reusing the `reveal` preset from index.tsx:21-26. Prefer that over the prototype's `animation-timeline: view()` (`.rv`).
- Known risks:
  - `motion` initial `opacity:0` hides content when rAF/IO stall, as in background tabs.
  - CountUp shows "0" with no aria-label.
  - The SPA has no no-JS rendering at all.
- Follow handoff §1 over the prototype: buttons keep `--radius-sm` (the prototype uses pills), no hex colours, no `--font-mono` yet (PR 1 adds it).

### Must not break
1. `LandingCtaProvider` with `{track: sendCtaBeacon, openAdForm: setAdForm}` and the mounted `AdLeadModal` (index.tsx:75-80, 255-260).
2. Every placement with its DM link and beacon: topbar, hero (+NoTelegram), howitworks, advertise, mediakit, network, resource, footer, whitelabel; white_label beacons from hero and footer. Server placements are fixed in config/landing-dm.ts:12-20, and unknown ones are dropped (204).
3. `AdDmLink` keeps `target=_blank rel=noopener`. `NoTelegramLink` and `AdCtaPair` fall back when `openAdForm` is null (admin preview).
4. White-label gating, plus the lead-form.test.ts:47-51 source regexes.
5. The pulse-error hide, the proofTiles zero-hide, the managerLive gating, and the 3-state `aiRunBadge` (landing-view.test.ts:96-104).
6. lib/no-cyrillic-ui.test.ts. It allows only `#реклама` in index.tsx and HowItWorks.tsx, and it fails on stale entries (:71-75). Moving AD_STEPS to a new file means updating ALLOW in both places. No Ukrainian sample data in source.
7. lib/no-personal-contact.test.ts.
8. Exports used elsewhere:
   - `ProofStrip` (white-label.tsx:8)
   - `WhiteLabelFeatures`, `SingleTenantNote` and `WhiteLabelStyles` (white-label.tsx:10)
   - `LeadFormStyles` and `WhiteLabelForm` (white-label.tsx:9)
   - `NetworkShowcase` (app.landing.tsx:24): keep it presentational.
9. Lead forms untouched: honeypot `website`, `elapsedMs`, focus handling (LeadForms.tsx).
10. Anchors: `#networks`, `#advertise` and `#white-label` are referenced internally. The prototype uses `#network`/`#how`, so keep the old ids or add aliases.

### Real vs invented in Main.dc.html (no `[…]` markers exist)
- **Real or derivable:**
  - headline
  - roles, copy and guard names
  - ad steps
  - 20:00 batch
  - single-tenant/WL copy
  - channel names, handles and followers (a dev snapshot; render them from the API)
  - counter values 37/7/1 (from the API)
- **Invented:**
  - FEED lines and times
  - "30 posts / 88% / 2 h ago"
  - "Live · 5 agents"
  - "Seven channels…"
  - deck cards
  - agent initials
  - "Telegram · live"-only platform states
  - lane captions


## Skeptic: wrong

- diagramNodes(networks, max) at landing-view.ts:123 gives name/emoji/mode per network agent; the orbit can use diagramNodes(networks, 5) for the agent labels — landing-view.ts:126-131 sets key and label to n.name, which is the network's name, not the agent's. Only emoji and mode come from n.agent. It also keeps named networks that have no agent (mode null, ranked last), so an orbit fed from it would draw networks without agents as if they were agents. The default max is 4. → Build the orbit nodes from networks.filter(n => n.agent) → {name: n.agent.name, emoji: n.agent.emoji, mode: n.agent.mode}. Alternatively, add an agentNodes() helper next to diagramNodes and test it in landing-view.test.ts.
- publicAgent(agent) is already computed at landing-networks.service.ts:148 — Line 148 only looks up the raw AgentRow (agentsByHandle.get(item.agent)). For each resource, only aiRunOf(agent) is called (:159). publicAgent() is defined at :108 but is called only for the network (:174) and the admin list (:212). → In the resource object built at :159, add `agent: publicAgent(agent)` and extend LandingNetworkResource in the service (:39-43) and in the dashboard type (api/landing.ts:60-64). The pg leak check (landing-networks.pg.test.ts:130-131) looks only for lowercase handles, so display names pass it.
- ROLES kinds (landing-view.ts:134-140) match the prototype ids — The prototype's R ids are manager, orch, planner, ideator, ireview, executor and reviewer (Main.dc.html:532-540). ROLES uses 'idea_reviewer', not 'ireview', and has no manager or orch entry. roleChips() lights a role only by ROLES kind, which matches pulse rolesActive (ROLE_ORDER, landing-pulse.service.ts:70). → Key the 5 worker buttons by the ROLES kinds and add 2 local ids for MANAGER and Orchestrator. Do not copy the prototype ids.
- The 'agents write tomorrow's posts by 20:00' claim is true (approval-timing.ts:10) — approval-timing.ts:10-13: the next day's batch is written AT 20:00 in the resource's time zone, inside a 20:00–22:00 window (BATCH_WINDOW_MS), not by 20:00. News and feed formats are written 2 h before their slot (NEWS_LEAD_MS, :17). Slots created less than 12 h ahead are written at most 3 h before (:15-16). So not every post is in the evening batch. → Use copy like 'from 20:00 the agents write most of tomorrow's posts, and you clear them in one pass'. Do not say 'by 20:00' or imply that every post is included.
- AdSteps: the copy equals AD_STEPS — The 4 titles match, but the prototype bodies are shortened rewrites (Main.dc.html:453-456, e.g. 'The first message is prefilled — just send it.'). Step 4 drops '(the legal ad label)'. The icons also differ: a card and a chart in the prototype, `spend` and `megaphone` in AD_STEPS (HowItWorks.tsx:26-31). → Keep the AD_STEPS objects as the single source and reuse them, rather than retyping the prototype strings. If AD_STEPS moves to another file, move the '#реклама' ALLOW entry with it.
- No --font-mono token exists (only used with fallback at index.css:852,881) — index.css:1 is `@import "tailwindcss"` (v4). Tailwind's default theme defines --font-mono, and the built CSS contains it: dist/assets/index-*.css has `--font-mono:ui-monospace, SFMono-Regular, Menlo, …`. index.css also uses var(--font-mono) at :896, :1030 and :1038. This matches the handoff's own wording: the mono font is currently Tailwind's default. → var(--font-mono) already works today and resolves to the ui-monospace stack. PR 1 only redefines it in @theme. The landing does not need a fallback or a wait for PR 1.
- The only event feed is GET /api/map → MapSnapshot.events: MapEvent{id,at,kind,agent,ref,text} — There is also GET /activity (activity/activity.controller.ts:9-37, TrackingAuthGuard). It is a paged post log per platform, typed 'posted'|'error'|'skipped'|'running'. MapEvent also has an optional toRef (map.types.ts:106). → Both feeds are guarded, so the conclusion stands (L1 needs a new public endpoint). activity.repository is a second possible source for 'published' lines.
- NetworkShowcase is shared with the /app/landing preview (app.landing.tsx:24,300) — The import is at :24, but the render is at app.landing.tsx:320 (`<NetworkShowcase networks={preview} />`). → Cite app.landing.tsx:320.
- displayName is the Telegram channel title synced by the tracker (tracking/repositories/tracked-channels.repository.ts:108-115) — Lines 108-115 are the upsert for private invite links (channel_key 'invite:…'). Public channels get their title from the username upsert at :121-140 (COALESCE(EXCLUDED.title, …)), so a manual edit is overwritten on the next poll. → Cite :121-140. A '| DEV' strip in the DB would be undone by the poller, which supports stripping at read time (mapTracked, landing-resources.service.ts:78-89, and the media kit).

## Skeptic: missed

- Anchors: spec 026 fixes the section ids as #networks, #how-it-works and #order-an-ad (specs/026-landing-ai-network-white-label/spec.md:215-216; #how-it-works at index.tsx:223, #order-an-ad at HowItWorks.tsx:70). The brief's 'keep old ids' list names only #networks, #advertise and #white-label. The prototype uses #how and #network, so #how-it-works and #order-an-ad also need to be kept or aliased.
- The prototype hero `.scan` line (Main.dc.html:35, used at :195, class `scan loop`) animates `top` from 0 to 100% every 7 s. That is a layout property, and the brief's compositor-only list leaves it out. Re-implement it with translateY inside an overflow-clipped box, or drop it.
- `@keyframes deck` (Main.dc.html:158) animates z-index (1→2→3) along with transform and opacity, so it is not transform/opacity only. Calling the ApprovalDeck 'confirmed' hides this. Give each card a static stacking order that works with its negative delay, or accept a discrete z-index step and say so explicitly.
- heroPlatforms() (landing-view.ts:38-44) returns only the platforms present among featured resources. If only Telegram is featured, the orbit's outer ring gets 1 pill. 'Soon' pills for the other platforms have to come from PLATFORM_ORDER (landing-view.ts:10), which has 6 platforms including YouTube, while the prototype shows 5.
- Agent counts can disagree. The payload carries at most one agent per network (networkAgentHandle, landing-networks.service.ts:117-125), and only for networks with featured resources. pulse.agents.orchestratorsLive counts every active top-level orchestrator in live or approve mode (landing-pulse.service.ts:110-115). So 'Live · N agents' in the pill, the orbit's node count and RoleExplorer's 'Orchestrator ×N' (hardcoded ×5 at Main.dc.html:286) can show different numbers. The spec should pick one source for N.
- WhiteLabelSection renders WhiteLabelFeatures limit={3}, which shows Agents, Shadow first and MANAGER (WhiteLabel.tsx:11-14, :55). Adding ShadowLiveDemo duplicates 'Shadow first'. The prototype's 3 cards are Agents, MANAGER and 'A separate deployment' (Main.dc.html:490-492). WL_FEATURES and WhiteLabelFeatures are shared with /white-label (white-label.tsx:10), so pick cards with a new prop or list. Do not reorder WL_FEATURES.
- The prototype's caption 'Opens Telegram with your first message ready.' (Main.dc.html:461) sits next to 'Request an ad placement'. In our code that label is AdCtaPair's no-DM fallback, which opens the lead form, not Telegram (cta.tsx:85-95). The caption must render only when adUrls.advertise is set.
- MotionConfig reducedMotion="user" (index.tsx:79) turns off only transform and layout animations in motion; opacity animations still run. The brief's CSS rule `animation:none` under prefers-reduced-motion covers only the CSS keyframe entries. The motion whileInView/initial-opacity:0 entries it recommends still depend on motion and IntersectionObserver to become visible. They need useReducedMotion() → initial={false}, or a CSS `both`-fill entry instead.
- The phase-2 L1 role union in the brief has no 'orchestrator'. The prototype FEED has orchestrator lines ('orchestr', Main.dc.html:567), and map run events are emitted for orchestrator runs too. Add 'orchestrator' to the union or explicitly drop those events.
- pulse returns 503 only after the 1 h stale window. Until then it serves the cached value with stale:true (landing-pulse.service.ts:223-236). Hero copy built from pulse (pill, stats row, AgentLog phase-1 lines) must show the stale note too, not only ProofStrip.