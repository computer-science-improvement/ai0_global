# 026: Public landing: autonomous AI-run network, white-label offer, ad ordering via Telegram DM

**Status:** DONE (owner: live checks below — DM attribution, DM account, network blurbs, white-label flag) · **Depends on:** 017–022 (agent platform, DONE), 008 (ad prices), 016 + 019b (YouTube, FR-010 only) · **Supersedes/extends:** BR-CORE-01…08, BR-MKT-01…08; extends BR-EDT-54/55 (DM triage); feeds 011 and 015
**Migration:** `066_landing_ai_network.sql` (renumbered: 063 and 058 were taken, 065 is reserved for spec 025)
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
| FR-001 | **Migration `066_landing_ai_network.sql`** (idempotent, additive): <br>• `landing_leads(id uuid pk, kind check in (ad, white_label), status default 'new' check in (new, contacted, qualified, won, lost, spam), name, contact not null, contact_kind check in (telegram, email, phone, other), company, resources jsonb default '[]', platforms text[], audience_size check in (lt_10k, 10k_100k, 100k_1m, gt_1m, unknown), service_mode check in (dedicated, consult, unsure), target, message, lang check in (uk, en), placement, utm jsonb, ip_hash, consent_at not null, owner_note, notified_at, purged_at, created_at, updated_at)`. Indexes `(status, created_at desc)` and `(ip_hash, created_at desc)`. **No grant to `editor_ro`.** <br>• `landing_cta_daily(day, cta, placement, lang, clicks, pk(day, cta, placement, lang))`. <br>• `youtube_accounts` gets `handle`, `subscribers`, `landing_visible` (default false) and `landing_order` (default 0). <br>• `meta_account_groups` gets `landing_blurb_uk`, `landing_blurb_en` and `landing_order`. |
| FR-002 | **Config in `app_settings`:** <br>• `landing.ad_tg_username`; <br>• `landing.ad_message_uk`, default `Привіт! Хочу замовити рекламу в {target}. {ref}`; <br>• `landing.ad_message_en`, default `Hi! I'd like to order an ad in {target}. {ref}`; <br>• `landing.white_label_enabled` (true); <br>• `landing.default_lang` (uk). <br>The username resolves in this order: the setting, then the `username` of the active `role='agent'` session, then `null`. With `null`, only the form CTA shows. The username must match `^[A-Za-z][A-Za-z0-9_]{4,31}$`. <br>Endpoints: public `GET /api/landing/config` returns `{defaultLang, adDm: {available, username}, whiteLabelEnabled}`; owner-only `GET/PUT /api/landing/admin/config`. |
| FR-003 | **DM link builder** (pure, `config/landing-dm.ts`): `buildAdDmUrl({username, template, target, placement, lang})` returns `https://t.me/<username>?text=<encodeURIComponent(msg)>`. <br>• `{target}` is the channel or network title; the default is «мережі ai0» / "the ai0 network". <br>• `{ref}` is `[ai0web:<placement>]` or `[ai0web:<placement>:<channel_key>]`. <br>• Placements: `hero, topbar, network, resource, mediakit, advertise, footer, howitworks`. <br>• The message is capped at 300 characters by truncating the target; the tag is never cut. <br>The server returns ready `adDmUrl` values (FR-006, FR-009), so the client has no template logic. |
| FR-004 | **`GET /api/landing/pulse`** (public; no ids, handles, costs or personal data). <br>• A 300 s in-process cache plus `Cache-Control: public, max-age=300`, and a 2 s statement timeout. On an error it serves the stale value for ≤ 1 h, then `503`. <br>• The response: `agents{orchestratorsLive, orchestratorsShadow, rolesActive, manager}`, `last7d{agentPosts, allPosts, autonomyShare, platforms[], agentRuns, skippedByAgents, directivesFiled, managerReviews, ideasReviewed, ownerDecisions}`, `lastAgentPostAt` (rounded to the minute), `claims{managerLive}`. <br>**Counting rules:** <br>• `agentPosts` = `published_posts` where `strategy_type='editor'`, plus `platform_posts` where `status='published' AND platform<>'telegram' AND agent_id IS NOT NULL`. Shadowed posts never count. Ads and legacy strategies count only in `allPosts`. <br>• `agentRuns` = `editor_runs` where `status='ok' AND agent_id IS NOT NULL`. <br>• `ownerDecisions` = owner approvals and declines: directives, playbooks and `agent_actions`. <br>• `agentPosts` includes posts that agents wrote and the owner approved in approval mode (spec 031); they are agent posts. <br>• No threshold gates the headline claim (owner decision 2026-10-06, see FR-005). |
| FR-005 | **The hero** (English; owner rule 2026-10-06: all interface text is English). <br>• The pill reads «Мережа, якою керують AI-агенти · {N} платформ», with N from the data. <br>• H1 always: «Медіамережа, яку ведуть AI-агенти» / "A media network run by AI agents" (owner decision 2026-10-06: agents plan, write and schedule; the owner only approves posts at the start). <br>• Subhead: MANAGER watches the network and issues directives or advice; orchestrators plan and write each resource; the owner approves only structural changes. <br>• **Proof strip:** «{agentPosts} постів від агентів за 7 днів», «{orchestratorsLive} агентів у live», «{autonomyShare}% контенту створили агенти», «останній пост агента {relative}». A tile with a zero value is hidden. Each tile has a "?" that shows the FR-004 definition. <br>• `NetworkVisual` becomes MANAGER (dimmed and labelled «скоро» unless it is live) → ≤ 4 real network or orchestrator nodes → role chips → the platform row (from data). <br>• CTAs: «Подивитись мережу ↓», «Замовити рекламу в Telegram», and a link «White label для ваших ресурсів →». |
| FR-006 | **`GET /api/landing/networks`** (public, cached for 300 s). It returns `[{name, blurb{uk,en}, order, agent{name, emoji, mode}\|null, followers, resources[]}]`, plus a final `name:null` group for standalone resources. <br>• Each resource is `LandingResource` plus `aiRun: live\|shadow\|none` plus `adDmUrl` (set only when the resource has an active `ad_prices` row). <br>• The agent comes from `ResourceCatalog`. No handles or ids are exposed. <br>• `/api/landing/resources` stays as it is and gains `youtube`. |
| FR-007 | **"Мережі під керуванням AI"** replaces "Channels & profiles we run". <br>• **Network block:** the name, the owner blurb, the agent chip («🤖 Веде {agent} · live» or «AI-агент у тренуванні (shadow)»), followers, and platform icons. <br>• **Resource cards** inside, each with an `aiRun` badge: «Веде AI-агент», «Агент у shadow — публікує класичний конвеєр» or «Автоматизований конвеєр». A card with an `adDmUrl` gets «Реклама тут». <br>• Standalone resources come last, under «Окремі канали». <br>• The loading, error and empty states stay. The React key becomes `platform:handle:order`, which fixes the BRD 08 §3.1 collision. |
| FR-008 | **"How it works" is redesigned around agents.** <br>**Row 1, «Хто веде мережу»:** <br>1. MANAGER: KPI digest → directives or advice. <br>2. Orchestrator: playbook and idea pool. <br>3. Planner: the day plan per resource and platform. <br>4. Executor: writes and publishes through code guards (dedup, limits, quiet hours, budget, kill switch). <br>5. Reviewer: measures and learns. <br>A footnote: «Структурні рішення затверджує власник». <br>**Row 2, «Як замовити рекламу»:** write to the AI ad manager in Telegram → price list and slot → LiqPay → a post labelled #реклама, with reports at 24 and 72 h. <br>**Disclosure** under row 2 step 1: «Відповідь готує AI-асистент від імені власника; власник її перевіряє. Людина — на запит». After 011 goes live it changes to «Відповідає AI-асистент…». |
| FR-009 | **Ad CTAs.** <br>• Placements: the top bar «Реклама», the hero, network and resource cards, every `MediaKit` row (with that channel as the target; the media-kit payload gains `adDmUrl`), the advertise section and the footer. <br>• Each is an `<a target="_blank" rel="noopener">`. A click also sends `sendBeacon('/api/landing/cta', {cta, placement, lang})`, which upserts `landing_cta_daily`. That endpoint is public, rate-limited to 60/min, and stores no IP. <br>• Next to each DM CTA: «Немає Telegram? Залиште заявку». It opens the ad form (FR-011) with the target prefilled. <br>• The badge «Self-serve — coming soon», the `mailto:` and the personal address are deleted. |
| FR-010 | **YouTube.** <br>• `LandingPlatform` gains `youtube`; the URL is `youtube.com/@<handle>`, else `/channel/<channel_id>`. <br>• `/app/landing` lists active `youtube_accounts` with Feature, Hide and Move. The admin list now hides inactive accounts on every platform (BR-MKT-01). <br>• YouTube enters the pill, the platform row and the diagram **only** when ≥ 1 active, featured YouTube resource exists. Before 016/019b nothing shows. <br>• `subscribers` is filled once 019b adds YouTube stats; until then it is `null`. |
| FR-011 | **`POST /api/landing/leads`** (public). <br>• A zod body per kind: `contact` ≤ 200, `message` ≤ 2,000, `resources` ≤ 10 http(s) URLs, and `consent: true`. <br>• A honeypot field `website`: if it is filled, store the lead as `spam` and return `201`. <br>• The existing `RateLimitGuard` allows 5/hour per IP. `ip_hash` = sha256(salt + ip), with the salt from 022. <br>• A duplicate (same ip_hash, contact and kind within 24 h) updates the existing row without a new alert. <br>• A new lead calls `OwnerInbox.post({kind: 'landing_lead', severity: 'action'})`, which also sends the admin-bot alert. That is capped at 20 alerts a day; leads past the cap are still stored. <br>• Retention: message and resources are purged after 180 days for `lost` and `spam`. |
| FR-012 | **White label.** <br>• A section `#white-label` and a public route `/white-label` (uk/en). Both are hidden when the flag is off; then the route shows «тимчасово недоступна» and a `white_label` POST returns `403`. <br>• Content: the agent hierarchy for the client's own resources, a shadow-first rollout, the MANAGER/KPI digest, ad tooling, owner cards, and the live `/pulse` strip. <br>• The delivery block: «Сьогодні ai0 — single-tenant. White label = окреме розгортання під ваші ресурси (своя БД, ключі, бот і акаунти), яке ми налаштовуємо й супроводжуємо. Спільного кабінету для кількох клієнтів поки немає». <br>• A FAQ: data ownership, the AI disclosure in DMs, the shadow period, and which platforms are supported today. <br>• The form (`kind='white_label'`): name, contact, company, resource links, platforms, audience size, service mode (dedicated / consultation / unsure), message, consent. |
| FR-013 | **"What a shared platform would need"** (collapsed on `/white-label`; no code in this spec): <br>• real accounts and roles instead of one `TRACKING_TOKEN` (BR-CORE-17…26); <br>• `tenant_id` plus RLS on every table; <br>• per-tenant secrets, encryption keys, LLM budgets and keys; <br>• a MANAGER and cross-promo (022) scoped to the tenant, so different clients' networks are never mixed; <br>• per-tenant MTProto, bot and platform accounts with flood isolation; <br>• queue prefixes and distributed locks (lifting the single-replica constraint); <br>• billing, export and deletion, and an audit log. |
| FR-014 | **Not built (owner decision 2026-10-06: the landing ships English only).** Kept for reference: **Language: uk + en.** <br>• A dictionary module `components/landing/i18n.ts`, with no new library. <br>• Language order: `?lang=`, then `localStorage['landing:lang']` (in try/catch), then a `navigator.language` starting with uk/ru → uk, then the config default. <br>• A «UA / EN» toggle. A missing key falls back to uk. `<html lang>` and the title follow the language, and `Intl` uses the matching locale. <br>• `index.html` meta is bilingual, and the hardcoded `dev.ai0.global` becomes `VITE_PUBLIC_URL`. |
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
1. ~~What is the default language?~~ **Decided 2026-10-06:** English only. The Ukrainian strings quoted in this spec are the meaning; ship them in English.
2. ~~What threshold switches on the "run by AI agents" claim?~~ **Decided 2026-10-06:** no threshold, the claim is
   always on. Agents run the network; the owner approves posts during the launch period (spec 031).
3. **Should AI cost be shown publicly?** Proposed: no. At most, an owner-typed range on `/white-label`.
4. **Should agent names be exposed?** Proposed: the name and emoji yes, the `@handle` no.
5. **What is the white-label promise?** Proposed: a dedicated deployment operated by the owner, plus consultation. No
   self-hosted licence.
6. **What lead retention applies?** Proposed: 180 days for lost and spam; won and qualified leads are kept.

## Implementation notes (T1–T2, 2026-10-08)
Decisions where the spec was open or has been overtaken by owner decisions:
- **English only.** No `landing.ad_message_uk` and no `landing.default_lang`: the template key is
  `landing.ad_message_en`, and `GET /api/landing/config` always returns `defaultLang: 'en'` (kept for the
  contract). `landing_leads.lang` defaults to `'en'`; the CHECK still allows `uk`. `buildAdDmUrl` takes no
  `lang` (the template is already chosen) but takes an optional `channelKey` for the `{ref}` tag.
- **Settings ownership.** `landing.*` rows belong to `LandingConfigService`; `SettingsService` skips them like
  `ui.*` and `cap.*`, so they never show as env overrides on `/app/settings`.
- **Public config carries ready links.** `adDm.urls` has a link for each network-level placement (`hero`,
  `topbar`, `advertise`, `footer`, `howitworks`; target "the ai0 network"), so T3/T5 need no template logic.
  Per-channel links (`network`, `resource`, `mediakit`) come with the T4/T5 payloads through
  `LandingConfigService.adDm()` + `buildAdDmUrl`. The username is normalized from `@name` or a `t.me/` link;
  an invalid stored value falls through to the agent session.
- **Templates.** At most 240 characters, only `{target}` and `{ref}` placeholders (anything else in braces is
  rejected as a typo). A template without `{ref}` gets the tag appended. Saving the default text, or an empty
  one, deletes the key. Characters are counted as code points, so a cut never splits an emoji.
- **Admin preview.** `POST /api/landing/admin/config/preview` renders an unsaved draft through the same
  builder (three fixed samples: the hero, a channel card, a very long media-kit title), so the dashboard
  holds no copy of the link logic. Validation issues come back as `{path, message}`.
- **Pulse definitions** (FR-004 left these open):
  - `orchestratorsLive` counts top-level orchestrators in mode `live` **or `approve`** (approval mode
    publishes after the owner's OK; owner rule: those are agent posts); paused agents count as off.
    `agents.manager` is `off | shadow | live` with `approve` shown as `live`.
  - `rolesActive` is a list of role kinds (`planner`, `ideator`, `idea_reviewer`, `executor`, `reviewer`) with
    at least one successful run in the window — evidence, not configuration — for the T3 role chips.
  - `last7d.platforms` is `[{platform, posts, agentPosts}]` per platform with at least one published post.
  - `skippedByAgents` counts only slots an agent skipped by its own decision (`error LIKE 'skipped by agent:%'`),
    not owner rejections, stale slots or superseded plans. `directivesFiled` excludes shadow directives;
    `managerReviews` excludes `verdict='skipped'`; `ideasReviewed` = ideas with `reviewed_by` set, updated in the
    window; `ownerDecisions` = directives with `owner_decision` approved/declined + playbooks `decided_at` +
    `agent_actions` no longer pending (timeouts are not owner decisions).
  - Chat drafts (`strategy_type='chat'`) count in `allPosts` only, like ads and legacy strategies.
  - `lastAgentPostAt` looks at all time (not just 7 days). The payload also carries `generatedAt` and `stale`.
- **Claim gating.** The headline is never gated. The only gated claim is `claims.managerLive`: the MANAGER is
  live **and** has at least one non-skipped review in the window. Zero values stay in the payload; T3 hides the
  tiles.
- **Resilience.** One read-only statement with `SET LOCAL statement_timeout = 2000`, an overall 3 s guard
  for a pool that cannot connect, one query in flight however many visitors arrive, and a 30 s back-off
  after a failure (stale value served meanwhile). A 503 is sent with `Cache-Control: no-store`.

### Notes for T3–T6
- Fetch `GET /api/landing/pulse` (dashboard hook `useLandingPulse`, no retry) and hide the proof strip on any
  error; hide a tile whose number is 0 and the "last agent post" tile when `lastAgentPostAt` is null.
- `useLandingPublicConfig().data.adDm` gives `available` and the ready `urls`; with `available=false` show only
  the form CTA.
- T4: `meta_account_groups.landing_blurb_en` is the blurb column to use (`landing_blurb_uk` exists from FR-001
  but stays unused while the page is English only). `youtube_accounts.handle`, `subscribers`,
  `landing_visible`, `landing_order` exist.
- T5: `landing_cta_daily` exists (`lang` defaults to `'en'`); the `{ref}` grammar is
  `[ai0web:<placement>]` / `[ai0web:<placement>:<channel_key>]` with the key matching `[A-Za-z0-9_]{3,64}`.
- T6: `landing_leads` exists; `landing.white_label_enabled` is read through `LandingConfigService`
  (`publicConfig().whiteLabelEnabled`).

## Implementation notes (T3–T4, 2026-10-08)
- **No migration.** 066 already had every column T4 needs (`youtube_accounts.handle/subscribers/landing_visible/
  landing_order`, `meta_account_groups.landing_blurb_en/landing_order`), so 067 was not created.
- **`GET /api/landing/networks`** (`config/landing-networks.service.ts`): `[{name, blurb, order, agent{name, emoji,
  mode}|null, followers, platforms[], adDmUrl, resources[]}]`, the standalone group last with `name: null`.
  Deviations from FR-006: `blurb` is one English string (no `{uk,en}`: English only); `platforms` (display order)
  and a network-level `adDmUrl` (placement `network`, set when one of its channels has an active price) were
  added for the page. Cached 300 s in-process + `Cache-Control: public, max-age=300`; a failed refresh serves the
  last good value; admin edits (blurb, order, featured toggles) expire the cache but keep the fallback.
- **aiRun** is the resource's top-level orchestrator (from `ResourceCatalog`) mapped like the pulse:
  `live`/`approve` → `live`, `shadow` → `shadow`, `off`, paused or no agent → `none`. A network's agent is its own
  network orchestrator, else the agent of its Telegram anchor, else the one agent all its resources share; an
  `off` or paused agent is not shown. Only the agent's name and emoji are public, never the `@handle`.
- **ResourceCatalog fix:** TikTok and YouTube rows now carry their `group_id` network (they were always
  standalone before), so they inherit the network's agent like Meta accounts. This also affects the KPI digest
  and cross-promo grouping, which is the intended spec 020 behaviour.
- **YouTube:** `YoutubeLandingRepository` (public columns only, never tokens). `/api/landing/resources` gains
  YouTube; the URL is `youtube.com/@handle`, else `youtube.com/channel/<channel_id>`. YouTube enters the pill,
  the diagram's platform row and the showcase only through an active **and** featured row. The admin list now
  hides inactive Meta, TikTok and YouTube accounts (BR-MKT-01).
- **Admin:** `GET /api/landing/admin/networks` returns every network (`id`, blurb, order, resource and featured
  counts, agent) plus `preview`, the exact public payload built uncached by the same code; `/app/landing`
  renders that preview with the same `NetworkShowcase` component as `/`. `PATCH /api/landing/admin/network/:id`
  takes `{blurb?: string|null (≤ 280), order?: 0–9999}`; the Networks card reorders by renumbering.
- **Hero (T3):** the H1 is always "A media network run by AI agents". The pill counts the showcase platforms
  (falls back to the pulse's platforms with posts). The subhead names MANAGER as steering only when
  `claims.managerLive`, otherwise "coming soon", and says the owner approves structural changes and, during the
  launch period, each post. The proof strip hides zero tiles, the last-post tile without `lastAgentPostAt`, and
  the whole strip on a pulse error; each "?" is a click/tap toggle with the FR-004 definition. The diagram is
  MANAGER (dashed, "soon" unless live) → up to 4 networks (live agents first) → the five roles (lit when they
  ran this week) → platforms. CTAs: "See the network ↓" and "Order an ad in Telegram" (`adDm.urls.hero`), or
  "Advertise with us" when `adDm.available` is false. The white-label link is left for T6 (no section yet).
- **How it works (T3):** row 1 MANAGER → Orchestrator → Planner → Executor → Reviewer with the owner footnote;
  row 2 the four ad steps with the AI disclosure under step 1 and a CTA from `adDm.urls.howitworks`.
- **`index.html`:** English meta; absolute OG/Twitter URLs use a placeholder that `vite.config.ts` fills from
  `VITE_PUBLIC_URL` (default `https://dev.ai0.global`; invalid values fail the build). The Dockerfile and both
  image workflows pass `vars.VITE_PUBLIC_URL`.
- **Motion:** the page sits in `MotionConfig reducedMotion="user"`; CSS loops (pulses, packets, mesh, shimmer)
  stop under `prefers-reduced-motion`. Checked at 375 px with full data, zero agent posts and a failing pulse:
  no horizontal scroll.

### Notes for T5–T6
- The hero CTA, the "How it works" CTA and the per-card "Ads here" / "Advertise in this network" links are plain
  `<a target="_blank" rel="noopener">`; T5 adds the beacon and the "No Telegram?" form link next to each. With
  `adDm.available=false` the hero shows "Advertise with us" (→ `#advertise`); T5/T6 swap in the form.
- The top bar "Advertise", the `#advertise` block (badge, `mailto:`) and the footer are untouched (T5).
- The section ids are `#networks` (was `#resources`) and `#how-it-works`; row 2 of "How it works" has
  `#order-an-ad`. T6 adds the white-label link to the hero CTA row.
- `HowItWorks.tsx` is allow-listed in the Cyrillic guard for the legal `#реклама` label only.

## Implementation notes (T5, 2026-10-08)
- **No migration.** `landing_cta_daily` (066) is enough; DM attribution lives in `agent_dm_threads.fields` (jsonb).
- **CTA placements.** Top bar "Advertise" (`topbar`), hero (`hero`), network block "Advertise in this network"
  (`network`), resource card "Ads here" (`resource`), every media-kit card (`mediakit`; `GET /api/landing/media-kit`
  rows gain `adDmUrl`, target = the channel title), the `#advertise` block (`advertise`), "How it works" (`howitworks`)
  and the footer "Advertise" (`footer`). Each is `<a target="_blank" rel="noopener">` to the server-built link. Without
  a DM account the top bar and footer fall back to `#advertise`.
- **Beacon.** `POST /api/landing/cta {cta, placement, lang}` with `cta ∈ ad_dm | ad_form | white_label` and a known
  placement; anything else is ignored (204). It upserts `landing_cta_daily` for the UTC day; `lang` is always stored as
  `'en'`. Nothing about the visitor is written (the table has no such column). 60/min per client through an in-process
  sliding window keyed by `sha256(salt + ip)` (`LandingClientGate`; the salt derives from `PROMO_HASH_SALT`, else
  `TOKEN_ENCRYPTION_KEY`, as in 022; a per-process random salt otherwise). No `RateLimitGuard` existed, so the shared
  `common/rate-limit/sliding-window-limiter.ts` was added (single replica, owner decision). The dashboard counts clicks
  only on the public page: the tracking sits in a React context that the admin preview does not provide.
- **Attribution (FR-016).** `parseLandingRef` + `applyLandingAttribution` in `agent-triage.helpers.ts`. The poller reads
  the tag and the thread's stored fields before the model runs; the tag sets `source='landing'`, `placement` and the
  tagged `channel`; `other`/`question` become `ad` for any attributed thread (tag now or earlier), `spam` and `vp` stay.
  `upsertThread` now merges `fields` in SQL (`old || new`), so `source` survives an untagged follow-up (the model may
  still name a channel, and then it wins). The price-list draft filters by the merged `fields.channel`.
- **`/app/dm`** (the old `/app/agent` redirects there) shows a "From landing · {placement} · @channel" chip.
- **CTA stats** on `/app/landing` → "CTA stats" tab: `GET /api/landing/admin/cta-stats?days=30` returns per placement
  the Telegram clicks, the landing-tagged DM threads (and the rate), form opens, form leads and white-label clicks, plus
  the ad DM threads without a tag in the window.
- **Personal email removed.** The `mailto:` and the "Self-serve — coming soon" badge are gone from `#advertise`. CI
  (`ci-feature.yml`) greps `apps/dashboard/src`, `index.html` and `public/` for a mail link or a Gmail address (file
  names only in the log); `apps/dashboard/src/lib/no-personal-contact.test.ts` runs the same check (plus other webmail
  domains) in the dashboard tests. `dist` is not grepped in CI: the feature CI does not build the dashboard, and a
  built bundle always contains `mailto:` in TanStack Router's safe-protocol list (a local build had no Gmail address).

## Implementation notes (T6, 2026-10-08)
- **No migration.** `landing_leads` (066) has every column; `ip_hash` is the only client trace, `lang` is `'en'`.
- **`POST /api/landing/leads`** (`config/landing-leads.ts` pure rules + `landing-leads.service.ts`). Order: 5/hour per
  client (the same in-process limiter as the beacon; 429) → `white_label` with the flag off → 403 (nothing stored) →
  zod validation per kind → 400 `{error: 'invalid_lead', issues: [{path, message}]}` (one message per field) → spam →
  dedup → insert + alert. 201 `{ok: true}` for stored, deduplicated and spam submissions alike. DB down → 503 with the
  advertise DM link. Rules: `contact` ≤ 200 and must read as a Telegram `@username`/`t.me` link (normalised to
  `@name`), an email or a phone (stored with `contact_kind`); `message` ≤ 2,000; `resources` ≤ 10 http(s) links (white
  label only); `consent: true`; a white-label request needs a name. Unknown `utm_*` keys are dropped.
- **Spam.** The honeypot `website` and a time check (`elapsedMs` < 2.5 s from form open); either stores the lead as
  `spam` with no alert. Spam is hidden from the default Leads list (Status → Spam shows it).
- **Dedup.** Same `ip_hash` + contact (case-insensitive) + kind within 24 h updates the row (latest wording wins,
  status kept, `consent_at` refreshed), no new alert.
- **Alert.** A new lead posts one `agent_inbox` item (`kind='landing_lead'`, `severity='action'`,
  `ref_type='landing_lead'`) through `OwnerInbox`, which also sends the admin-bot alert; at most 20 a day (counted by
  `notified_at` today); leads past the cap are stored without `notified_at`. The stored inbox item has **no name or
  contact** (company, platforms, audience, service mode, target and placement only); only the Telegram alert to the
  owner carries the contact. `/app/agents/inbox` links the item to Landing → Leads.
- **Retention.** `RetentionService` scrubs `message` and `resources` of `lost`/`spam` leads 180 days after `updated_at`
  and stamps `purged_at` (`LANDING_LEAD_PURGE_DAYS`; scrub policies gained an optional row filter and stamp column).
- **Owner side.** `GET /api/landing/admin/leads?kind=&status=&limit=` (never returns `ip_hash`) and
  `PATCH /api/landing/admin/leads/:id {status?, ownerNote?}` (declared before `:platform/:id`). The **Leads** tab on
  `/app/landing` (`?tab=leads`): kind tabs, a status filter, a `ui/table` list with Badge statuses, copy contact, mark as
  spam, and a details modal to set the status and a note. `editor_ro` still has no grant on `landing_leads` (a PG test
  asserts `has_table_privilege` is false).
- **Forms.** `components/landing/LeadForms.tsx`: visible labels, required marks, hints, inline errors on blur and on
  submit (`aria-invalid` + `aria-describedby`), an error summary that takes focus after a failed submit, a busy button, a
  success panel that takes focus, and the 429/403/503 messages (503 offers the Telegram link). The ad form opens in a
  modal from every "No Telegram? Leave a request" link with the target prefilled; without a DM account the ad CTAs become
  "Request an ad placement" buttons. Requests are sent without cookies.
- **White label (FR-012/013).** `#white-label` on `/` (three feature cards, the single-tenant statement, a link to the
  page) and the public `/white-label` page (hero, the live pulse strip, six features, the four-step delivery, the
  single-tenant statement, an FAQ on data ownership, the AI disclosure, the shadow period, supported platforms and
  pricing, a collapsed "What would a shared, multi-client platform need?" with the FR-013 list, and the form). The
  statement lives once in `lib/white-label-copy.ts`: "Today ai0 is single-tenant. White label means a separate
  deployment for your resources, with its own database, keys, bot and accounts, which we set up and run for you. There
  is no shared cabinet for several clients yet." With the flag off (or before the config loads) the section, the hero
  link "White label for your own resources →" and the footer link are not rendered, `/white-label` says the offer is
  temporarily unavailable, and the API answers 403. A new placement `whitelabel` counts the section CTA and tags its
  leads (it never appears in a DM tag).

### Owner checklist (live)
1. **DM account.** On `/app/landing` → Page setup, set the ad Telegram username (or verify the agent MTProto session's
   username), then use "Test link" and check the prefilled text ends with the `[ai0web:…]` tag.
2. **Live DM attribution.** From a phone, tap "Ads here" on a priced channel card and send the prefilled message to the
   ad account. After the next inbox poll, `/app/dm` shows "From landing · channel card · @channel", the thread is under
   **Ad**, and the pending price-list draft lists only that channel. Send an untagged follow-up; the chip stays.
3. **CTA stats.** `/app/landing` → CTA stats shows that click against the tagged thread.
4. **Network blurbs.** Write a blurb for each network on `/app/landing` → Page setup → Networks.
5. **White label.** Decide whether the offer is on (Page setup → white-label switch). Send a test request from
   `/white-label`; it should reach the admin bot, `/app/agents/inbox` and Landing → Leads. Mark it as spam afterwards.
6. Set `PROMO_HASH_SALT` (or keep `TOKEN_ENCRYPTION_KEY`) so lead dedup and the limits survive restarts.

## Task breakdown

### T1: Add migration 066 and the landing config surface
**Scope:**
- `066_landing_ai_network.sql` (FR-001).
- Config keys and username resolution (FR-002).
- The pure `buildAdDmUrl` (FR-003).
- The "Public page" card on `/app/landing`.

**Acceptance:**
- [x] The migration applies twice cleanly and records its version.
- [x] The URL and username tests pass.
- [x] `adDm.available=false` when no username resolves.
- [x] The owner edits the templates and sees a live preview.

**Size:** M · **Depends on:** —

### T2: Serve live autonomy proof from `/api/landing/pulse`
**Scope:**
- `LandingPulseService` with the FR-004 rules, cache, stale-on-error and timeout.
- Claim gating.
- A public route with `Cache-Control`.

**Acceptance:**
- [x] The PG counting tests pass.
- [x] An empty DB gives no claims.
- [x] The payload has no ids, handles, costs or personal data.

**Size:** M · **Depends on:** T1, 017–022

### T3: Rebuild the hero and "How it works" around agents (English only)
**Scope:**
- ~~i18n and the toggle (FR-014)~~ — not built: English only (owner decision 2026-10-06).
- The hero, proof strip and hierarchy diagram (FR-005).
- The two-row "How it works" with the disclosure (FR-008).
- The `index.html` meta and `VITE_PUBLIC_URL`.

**Acceptance:**
- [x] The page renders fully in English (owner decision 2026-10-06: English only, no second language).
- [x] The H1 is the same with zero agent posts; zero-value tiles are hidden.
- [x] Reduced motion is respected.
- [x] There is no horizontal scroll at 375 px.

**Size:** L · **Depends on:** T2

### T4: Group the showcase by network with agent badges, and add YouTube
**Scope:**
- `GET /api/landing/networks` (FR-006) and the section (FR-007).
- YouTube support (FR-010).
- The Networks admin card (FR-015).

**Acceptance:**
- [x] The `aiRun` badges are correct for live, shadow and legacy fixtures.
- [x] YouTube appears only with an active, featured row, and then increments the platform count.
- [x] The admin preview equals the public page.

**Size:** M · **Depends on:** T1

### T5: Add Telegram DM ad ordering with attribution, and remove the personal email
**Scope:**
- All CTA placements, the media-kit `adDmUrl` and the CTA beacon (FR-009).
- `parseLandingRef` and the triage merge (FR-016).
- The `/app/agent` chip and the CTA stats.
- The CI grep.

**Acceptance:**
- [x] A tagged DM is attributed, categorised `ad`, and its price list is filtered.
- [x] `source` survives an untagged follow-up.
- [x] The grep is green.
- [x] No IP is stored for clicks.

**Size:** M · **Depends on:** T1, T4

### T6: Build lead intake, the white-label section and page, and owner notification
**Scope:**
- `POST /api/landing/leads` (FR-011).
- The ad fallback form and the white-label form.
- The `#white-label` section and `/white-label` page (FR-012, FR-013).
- The OwnerInbox alert.
- The Leads tab.

**Acceptance:**
- [x] The validation, spam, dedup and cap tests pass.
- [x] A lead appears in `agent_inbox` and in Leads.
- [x] With the flag off: 403 and hidden UI.
- [x] The "single-tenant today" statement is present (English only, owner decision 2026-10-06: one language).

**Size:** L · **Depends on:** T1, T3
