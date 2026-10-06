# 026: Public landing: autonomous AI-run network, white-label offer, ad ordering via Telegram DM

**Status:** SPEC · **Depends on:** 017–022 (agent platform, DONE), 008 (ad prices), 016 + 019b (YouTube, FR-010 only) · **Supersedes/extends:** BR-CORE-01…08, BR-MKT-01…08; extends BR-EDT-54/55 (DM triage); feeds 011 and 015
**Migration:** `058_landing_ai_network.sql`
**Owner comments addressed:** #9, #10, #11, #12 (plans/brd-comments-2026-10-06.md)

## Why
The landing still sells "a publishing pipeline". Since 017–022 the network is run by named agents, and the page says
nothing about it. The owner asked for four changes:
- **#9:** «показ того що управління відбувається АІ агентами… продаж white label рішень під ресурси інших людей»;
- **#10:** «перебудувати структуру і додати акцент на АІ системне управління»;
- **#11:** «редірект на акаунт MTPROTO… із заготовленим повідомленням»;
- **#12:** «після інтеграції… відео — потрібно додати ютуб у список».

Constitution VIII applies to a public page too. Every autonomy claim is computed from live data, and no copy implies that a
human answers when an AI drafts the reply.

## Current state (as-is)
- **The page.** `apps/dashboard/src/routes/index.tsx` is English only, with hardcoded copy (BR-CORE-08):
  - the pill says "One network · five platforms";
  - `PLATFORMS` and `STEPS` (Create/Schedule/Publish/Track, "AI strategies") are static arrays;
  - `NetworkVisual` draws "ai0 pipeline → 5 platforms".
- **The data.** `GET /api/landing/resources` (`config/landing-resources.service.ts`) returns a flat list over
  `tracked_channels`, `meta_accounts` and `tiktok_accounts`. There are no networks, no agents and no YouTube
  (BR-CORE-02…04, BR-MKT-03…05). `youtube_accounts` (051) has no landing columns. BR-MKT-01: the admin list shows inactive
  accounts.
- **Contact.** "Contact us" is a `mailto:` to the owner's personal address (BR-CORE-06). There is no form and nothing is
  written to the DB. The badge says "Self-serve — coming soon".
- **Proof already in the DB:**
  - `agents` (`mode` off/shadow/live);
  - `editor_runs` (`agent_id`, `status`);
  - `published_posts.strategy_type` (`'editor'` for agents, `'ad'` for sponsored posts);
  - `platform_posts` (`status`, `agent_id`);
  - `editor_slots.status='skipped'`;
  - `agent_directives`, `manager_reviews`, `content_ideas`.
  `editor/agents/resource-catalog.ts` already resolves resource → network (`meta_account_groups`) → agent.
- **The DM account.** The MTProto agent account (`mtproto_sessions.role='agent'`, `username` captured on verify) is polled by
  `AgentInboxPoller`. Triage classifies a DM as `ad` and drafts a deterministic price-list reply, which the owner approves
  (BR-EDT-52…56, BR-MKT-29). The source of a DM is not recorded.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `058_landing_ai_network.sql`** (idempotent, additive): <br>• `landing_leads(id uuid pk, kind check in (ad, white_label), status default 'new' check in (new, contacted, qualified, won, lost, spam), name, contact not null, contact_kind check in (telegram, email, phone, other), company, resources jsonb default '[]', platforms text[], audience_size check in (lt_10k, 10k_100k, 100k_1m, gt_1m, unknown), service_mode check in (dedicated, consult, unsure), target, message, lang check in (uk, en), placement, utm jsonb, ip_hash, consent_at not null, owner_note, notified_at, purged_at, created_at, updated_at)`. Indexes `(status, created_at desc)` and `(ip_hash, created_at desc)`. **No grant to `editor_ro`.** <br>• `landing_cta_daily(day, cta, placement, lang, clicks, pk(day, cta, placement, lang))`. <br>• `youtube_accounts` gets `handle`, `subscribers`, `landing_visible` (default false) and `landing_order` (default 0). <br>• `meta_account_groups` gets `landing_blurb_uk`, `landing_blurb_en` and `landing_order`. |
| FR-002 | **Config in `app_settings`:** <br>• `landing.ad_tg_username`; <br>• `landing.ad_message_uk`, default `Привіт! Хочу замовити рекламу в {target}. {ref}`; <br>• `landing.ad_message_en`, default `Hi! I'd like to order an ad in {target}. {ref}`; <br>• `landing.white_label_enabled` (true); <br>• `landing.default_lang` (uk). <br>The username resolves in this order: the setting, then the `username` of the active `role='agent'` session, then `null`. With `null`, only the form CTA shows. The username must match `^[A-Za-z][A-Za-z0-9_]{4,31}$`. <br>Endpoints: public `GET /api/landing/config` returns `{defaultLang, adDm: {available, username}, whiteLabelEnabled}`; owner-only `GET/PUT /api/landing/admin/config`. |
| FR-003 | **DM link builder** (pure, `config/landing-dm.ts`): `buildAdDmUrl({username, template, target, placement, lang})` returns `https://t.me/<username>?text=<encodeURIComponent(msg)>`. <br>• `{target}` is the channel or network title; the default is «мережі ai0» / "the ai0 network". <br>• `{ref}` is `[ai0web:<placement>]` or `[ai0web:<placement>:<channel_key>]`. <br>• Placements: `hero, topbar, network, resource, mediakit, advertise, footer, howitworks`. <br>• The message is capped at 300 characters by truncating the target; the tag is never cut. <br>The server returns ready `adDmUrl` values (FR-006, FR-009), so the client has no template logic. |
| FR-004 | **`GET /api/landing/pulse`** (public; no ids, handles, costs or personal data). <br>• A 300 s in-process cache plus `Cache-Control: public, max-age=300`, and a 2 s statement timeout. On an error it serves the stale value for ≤ 1 h, then `503`. <br>• The response: `agents{orchestratorsLive, orchestratorsShadow, rolesActive, manager}`, `last7d{agentPosts, allPosts, autonomyShare, platforms[], agentRuns, skippedByAgents, directivesFiled, managerReviews, ideasReviewed, ownerDecisions}`, `lastAgentPostAt` (rounded to the minute), `claims{managerLive}`. <br>**Counting rules:** <br>• `agentPosts` = `published_posts` where `strategy_type='editor'`, plus `platform_posts` where `status='published' AND platform<>'telegram' AND agent_id IS NOT NULL`. Shadowed posts never count. Ads and legacy strategies count only in `allPosts`. <br>• `agentRuns` = `editor_runs` where `status='ok' AND agent_id IS NOT NULL`. <br>• `ownerDecisions` = owner approvals and declines: directives, playbooks and `agent_actions`. <br>• `agentPosts` includes posts that agents wrote and the owner approved in approval mode (spec 031); they are agent posts. <br>• No threshold gates the headline claim (owner decision 2026-10-06, see FR-005). |
| FR-005 | **The hero** (uk primary). <br>• The pill reads «Мережа, якою керують AI-агенти · {N} платформ», with N from the data. <br>• H1 always: «Медіамережа, яку ведуть AI-агенти» / "A media network run by AI agents" (owner decision 2026-10-06: agents plan, write and schedule; the owner only approves posts at the start). <br>• Subhead: MANAGER watches the network and issues directives or advice; orchestrators plan and write each resource; the owner approves only structural changes. <br>• **Proof strip:** «{agentPosts} постів від агентів за 7 днів», «{orchestratorsLive} агентів у live», «{autonomyShare}% контенту створили агенти», «останній пост агента {relative}». A tile with a zero value is hidden. Each tile has a "?" that shows the FR-004 definition. <br>• `NetworkVisual` becomes MANAGER (dimmed and labelled «скоро» unless it is live) → ≤ 4 real network or orchestrator nodes → role chips → the platform row (from data). <br>• CTAs: «Подивитись мережу ↓», «Замовити рекламу в Telegram», and a link «White label для ваших ресурсів →». |
| FR-006 | **`GET /api/landing/networks`** (public, cached for 300 s). It returns `[{name, blurb{uk,en}, order, agent{name, emoji, mode}\|null, followers, resources[]}]`, plus a final `name:null` group for standalone resources. <br>• Each resource is `LandingResource` plus `aiRun: live\|shadow\|none` plus `adDmUrl` (set only when the resource has an active `ad_prices` row). <br>• The agent comes from `ResourceCatalog`. No handles or ids are exposed. <br>• `/api/landing/resources` stays as it is and gains `youtube`. |
| FR-007 | **"Мережі під керуванням AI"** replaces "Channels & profiles we run". <br>• **Network block:** the name, the owner blurb, the agent chip («🤖 Веде {agent} · live» or «AI-агент у тренуванні (shadow)»), followers, and platform icons. <br>• **Resource cards** inside, each with an `aiRun` badge: «Веде AI-агент», «Агент у shadow — публікує класичний конвеєр» or «Автоматизований конвеєр». A card with an `adDmUrl` gets «Реклама тут». <br>• Standalone resources come last, under «Окремі канали». <br>• The loading, error and empty states stay. The React key becomes `platform:handle:order`, which fixes the BRD 08 §3.1 collision. |
| FR-008 | **"How it works" is redesigned around agents.** <br>**Row 1, «Хто веде мережу»:** <br>1. MANAGER: KPI digest → directives or advice. <br>2. Orchestrator: playbook and idea pool. <br>3. Planner: the day plan per resource and platform. <br>4. Executor: writes and publishes through code guards (dedup, limits, quiet hours, budget, kill switch). <br>5. Reviewer: measures and learns. <br>A footnote: «Структурні рішення затверджує власник». <br>**Row 2, «Як замовити рекламу»:** write to the AI ad manager in Telegram → price list and slot → LiqPay → a post labelled #реклама, with reports at 24 and 72 h. <br>**Disclosure** under row 2 step 1: «Відповідь готує AI-асистент від імені власника; власник її перевіряє. Людина — на запит». After 011 goes live it changes to «Відповідає AI-асистент…». |
| FR-009 | **Ad CTAs.** <br>• Placements: the top bar «Реклама», the hero, network and resource cards, every `MediaKit` row (with that channel as the target; the media-kit payload gains `adDmUrl`), the advertise section and the footer. <br>• Each is an `<a target="_blank" rel="noopener">`. A click also sends `sendBeacon('/api/landing/cta', {cta, placement, lang})`, which upserts `landing_cta_daily`. That endpoint is public, rate-limited to 60/min, and stores no IP. <br>• Next to each DM CTA: «Немає Telegram? Залиште заявку». It opens the ad form (FR-011) with the target prefilled. <br>• The badge «Self-serve — coming soon», the `mailto:` and the personal address are deleted. |
| FR-010 | **YouTube.** <br>• `LandingPlatform` gains `youtube`; the URL is `youtube.com/@<handle>`, else `/channel/<channel_id>`. <br>• `/app/landing` lists active `youtube_accounts` with Feature, Hide and Move. The admin list now hides inactive accounts on every platform (BR-MKT-01). <br>• YouTube enters the pill, the platform row and the diagram **only** when ≥ 1 active, featured YouTube resource exists. Before 016/019b nothing shows. <br>• `subscribers` is filled once 019b adds YouTube stats; until then it is `null`. |
| FR-011 | **`POST /api/landing/leads`** (public). <br>• A zod body per kind: `contact` ≤ 200, `message` ≤ 2,000, `resources` ≤ 10 http(s) URLs, and `consent: true`. <br>• A honeypot field `website`: if it is filled, store the lead as `spam` and return `201`. <br>• The existing `RateLimitGuard` allows 5/hour per IP. `ip_hash` = sha256(salt + ip), with the salt from 022. <br>• A duplicate (same ip_hash, contact and kind within 24 h) updates the existing row without a new alert. <br>• A new lead calls `OwnerInbox.post({kind: 'landing_lead', severity: 'action'})`, which also sends the admin-bot alert. That is capped at 20 alerts a day; leads past the cap are still stored. <br>• Retention: message and resources are purged after 180 days for `lost` and `spam`. |
| FR-012 | **White label.** <br>• A section `#white-label` and a public route `/white-label` (uk/en). Both are hidden when the flag is off; then the route shows «тимчасово недоступна» and a `white_label` POST returns `403`. <br>• Content: the agent hierarchy for the client's own resources, a shadow-first rollout, the MANAGER/KPI digest, ad tooling, owner cards, and the live `/pulse` strip. <br>• The delivery block: «Сьогодні ai0 — single-tenant. White label = окреме розгортання під ваші ресурси (своя БД, ключі, бот і акаунти), яке ми налаштовуємо й супроводжуємо. Спільного кабінету для кількох клієнтів поки немає». <br>• A FAQ: data ownership, the AI disclosure in DMs, the shadow period, and which platforms are supported today. <br>• The form (`kind='white_label'`): name, contact, company, resource links, platforms, audience size, service mode (dedicated / consultation / unsure), message, consent. |
| FR-013 | **"What a shared platform would need"** (collapsed on `/white-label`; no code in this spec): <br>• real accounts and roles instead of one `TRACKING_TOKEN` (BR-CORE-17…26); <br>• `tenant_id` plus RLS on every table; <br>• per-tenant secrets, encryption keys, LLM budgets and keys; <br>• a MANAGER and cross-promo (022) scoped to the tenant, so different clients' networks are never mixed; <br>• per-tenant MTProto, bot and platform accounts with flood isolation; <br>• queue prefixes and distributed locks (lifting the single-replica constraint); <br>• billing, export and deletion, and an audit log. |
| FR-014 | **Language: uk + en.** <br>• A dictionary module `components/landing/i18n.ts`, with no new library. <br>• Language order: `?lang=`, then `localStorage['landing:lang']` (in try/catch), then a `navigator.language` starting with uk/ru → uk, then the config default. <br>• A «UA / EN» toggle. A missing key falls back to uk. `<html lang>` and the title follow the language, and `Intl` uses the matching locale. <br>• `index.html` meta is bilingual, and the hardcoded `dev.ai0.global` becomes `VITE_PUBLIC_URL`. |
| FR-015 | **`/app/landing` admin** (all under `TrackingAuthGuard`): <br>• **Networks:** blurb uk/en and order, via `PATCH /api/landing/admin/network/:groupId`; <br>• **Public page:** the templates and username, with a live link preview and «Test link»; <br>• **Leads:** filter by kind and status, set the status, add a note, copy the contact; `GET /api/landing/admin/leads`, `PATCH …/leads/:id`; <br>• **CTA stats:** clicks per placement over 30 days against tagged DM threads, via `GET /api/landing/admin/cta-stats`. |
| FR-016 | **DM attribution.** <br>• A pure `parseLandingRef(text)` in `agent-triage.helpers.ts`, with the regex `\[ai0web:([a-z_]{2,16})(?::@?([A-Za-z0-9_]{3,64}))?\]`. <br>• On a match, `AgentInboxPoller` merges `fields.source='landing'`, `placement` and `channel` into `agent_dm_threads.fields` before the LLM call (no migration). It forces `category='ad'` when the model says `other` or `question`. The price-list draft (BR-EDT-55) then filters by `fields.channel`. <br>• An untagged follow-up message keeps `source`: it is merged, not overwritten. <br>• `/app/agent` shows a «з лендінгу · {placement}» chip. |

## Corner cases
- **Fresh install, all agents in shadow, or legacy strategies still dominant.** The H1 stays the same; proof tiles with
  zero values are hidden, so the page never shows a number that contradicts the claim.
- **Approval mode (spec 031).** Posts the owner approved count as agent posts. The copy never says "without a human";
  the autonomy tile reads "created by agents".
- **MANAGER is `off`.** Its node is dimmed, and the copy makes no claim that it "steers".
- **The agent session is deleted or renamed.** The CTAs fall back to the form within one cache period (300 s).
- **The client ignores `?text=`, or the user deletes the tag.** The thread has no source, and the gap is visible in CTA stats.
- **A forged tag.** It only sets attribution and category `ad`. No price, payment or send depends on it.
- **A long target title.** The title is truncated; the tag is kept.
- **Bots or a flood.** Honeypot, 5/hour per IP, and the 20 alerts/day cap.
- **The DB is down on submit.** `503` with «Не вдалося надіслати — напишіть нам у Telegram» and the DM link, if one exists.
- **`/pulse` on a cold start with no cache and a failing DB.** The strip hides; the rest of the page renders.

## Non-goals
- Multi-tenancy or a shared client cabinet (FR-013 only lists the work).
- Self-serve checkout on the landing (015).
- Auto-sent DM replies before 011.
- A CMS beyond network blurbs and DM templates.
- Third-party analytics, cookies or pixels.
- SSR or SEO.
- Public white-label pricing.
- Public AI spend.

## Success criteria
- `node:test` unit tests for:
  - `buildAdDmUrl`: Cyrillic, `&`, `#` and newlines; the 300-char cap keeps the tag; username validation;
  - `parseLandingRef`;
  - claim gating;
  - lead validation, honeypot, dedup and the alert cap;
  - the language resolver.
- PG tests for the pulse counting rules:
  - shadowed posts, ads and legacy strategies are excluded;
  - no Telegram double count;
  - an empty DB gives zeros and no claims.
- A triage test: a tagged DM gets `source='landing'`, category `ad`, and a price list filtered by channel.
- `pnpm --filter dashboard build` passes, and a CI grep of `apps/dashboard/src` and `dist` for `mailto:` and `@gmail.com` is
  empty.
- The owner checks live:
  - the hero numbers match SQL and `/app/agents`;
  - «Реклама тут» opens Telegram with the prefilled message;
  - the DM shows the landing chip;
  - a test white-label lead reaches the admin bot and the Leads tab.
- Within 30 days, at least one ad DM is attributed to the landing.

## Open questions for the owner
1. **What is the default language?** Proposed: `uk`, with EN auto-picked for non-uk/ru browsers.
2. ~~What threshold switches on the "run by AI agents" claim?~~ **Decided 2026-10-06:** no threshold, the claim is
   always on. Agents run the network; the owner approves posts during the launch period (spec 031).
3. **Should AI cost be shown publicly?** Proposed: no. At most, an owner-typed range on `/white-label`.
4. **Should agent names be exposed?** Proposed: the name and emoji yes, the `@handle` no.
5. **What is the white-label promise?** Proposed: a dedicated deployment operated by the owner, plus consultation. No
   self-hosted licence.
6. **What lead retention applies?** Proposed: 180 days for lost and spam; won and qualified leads are kept.

## Task breakdown

### T1: Add migration 058 and the landing config surface
**Scope:**
- `058_landing_ai_network.sql` (FR-001).
- Config keys and username resolution (FR-002).
- The pure `buildAdDmUrl` (FR-003).
- The "Public page" card on `/app/landing`.

**Acceptance:**
- [ ] The migration applies twice cleanly and records its version.
- [ ] The URL and username tests pass.
- [ ] `adDm.available=false` when no username resolves.
- [ ] The owner edits the templates and sees a live preview.

**Size:** M · **Depends on:** —

### T2: Serve live autonomy proof from `/api/landing/pulse`
**Scope:**
- `LandingPulseService` with the FR-004 rules, cache, stale-on-error and timeout.
- Claim gating.
- A public route with `Cache-Control`.

**Acceptance:**
- [ ] The PG counting tests pass.
- [ ] An empty DB gives no claims.
- [ ] The payload has no ids, handles, costs or personal data.

**Size:** M · **Depends on:** T1, 017–022

### T3: Rebuild the hero and "How it works" around agents, in uk and en
**Scope:**
- i18n and the toggle (FR-014).
- The hero, proof strip and hierarchy diagram (FR-005).
- The two-row "How it works" with the disclosure (FR-008).
- The `index.html` meta and `VITE_PUBLIC_URL`.

**Acceptance:**
- [ ] The page renders fully in both languages.
- [ ] The H1 is the same with zero agent posts; zero-value tiles are hidden.
- [ ] Reduced motion is respected.
- [ ] There is no horizontal scroll at 375 px.

**Size:** L · **Depends on:** T2

### T4: Group the showcase by network with agent badges, and add YouTube
**Scope:**
- `GET /api/landing/networks` (FR-006) and the section (FR-007).
- YouTube support (FR-010).
- The Networks admin card (FR-015).

**Acceptance:**
- [ ] The `aiRun` badges are correct for live, shadow and legacy fixtures.
- [ ] YouTube appears only with an active, featured row, and then increments the platform count.
- [ ] The admin preview equals the public page.

**Size:** M · **Depends on:** T1

### T5: Add Telegram DM ad ordering with attribution, and remove the personal email
**Scope:**
- All CTA placements, the media-kit `adDmUrl` and the CTA beacon (FR-009).
- `parseLandingRef` and the triage merge (FR-016).
- The `/app/agent` chip and the CTA stats.
- The CI grep.

**Acceptance:**
- [ ] A tagged DM is attributed, categorised `ad`, and its price list is filtered.
- [ ] `source` survives an untagged follow-up.
- [ ] The grep is green.
- [ ] No IP is stored for clicks.

**Size:** M · **Depends on:** T1, T4

### T6: Build lead intake, the white-label section and page, and owner notification
**Scope:**
- `POST /api/landing/leads` (FR-011).
- The ad fallback form and the white-label form.
- The `#white-label` section and `/white-label` page (FR-012, FR-013).
- The OwnerInbox alert.
- The Leads tab.

**Acceptance:**
- [ ] The validation, spam, dedup and cap tests pass.
- [ ] A lead appears in `agent_inbox` and in Leads.
- [ ] With the flag off: 403 and hidden UI.
- [ ] The "single-tenant today" statement is present in both languages.

**Size:** L · **Depends on:** T1, T3
