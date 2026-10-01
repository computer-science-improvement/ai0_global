# 013: Group presence: the agent in admin and ad-exchange chats

**Status:** SPEC · **Depends on:** 011, 012, SP4 chat intel (`agent_monitored_chats`, `agent_opportunities`)

## Why
Ad buyers and cross-promo (ВП) partners live in admin chats such as "біржа реклами" and "ВП чати". The agent must:
- notice ad and ВП offers there;
- post our own offers by the chat's rules;
- move every negotiation to DMs.

It must not get the account banned or look like a spammer.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Chats are allow-listed by the owner only.** This reuses `agent_monitored_chats`. The agent never joins chats; there is no join method, which keeps the SP4 invariant. Per-chat config: `can_post`, `post_cooldown_hours` (default 24), `post_template`, `allowed_topics`, `language`, `rules_text` (synced from the pinned message and description on add, then refreshed weekly) and `autonomy` (default `approve`). |
| FR-002 | **Detection.** The existing pre-filter feeds the classifier (SP4), with real-time ingest (011 §3). Categories: `ad_offer` (someone sells ads), `ad_request` (someone wants to buy ads, our lead), `vp_request`, `pricing_info` (market intel only) and `irrelevant`. Each `ad_request` or `vp_request` relevant to our channels becomes an *opportunity* with a score. |
| FR-003 | **Reaction policy.** For a relevant opportunity the agent **replies in a DM**, never in the group. Allowed openers (011 §2.5): only when the person published a request inviting contact ("пишіть в лс", "шукаю ВП"), and within the group's rules. The DM opener references the group message ("Бачив ваш запит у <chat> про ВП…"). Limits: ≤ 10 group-sourced DMs/day, ≤ 1 per person per 14 days. |
| FR-004 | **Our posts in groups.** The agent drafts offers ("шукаємо ВП для каналу X", "продаємо рекламу в мережі") from the media kit (008) and the chat rules, and publishes them only in chats with `can_post`, after the cooldown, within working hours, and after approval in phases 0–2. The text is varied (no duplicate ≥ 0.8 within 30 days in the same chat). A post that matches the rules regex (e.g. "1 пост на день", "без посилань") is pre-validated. |
| FR-005 | **Public replies.** The agent may reply in the group only with a single short pointer ("написав в особисті") when someone replies to our post or mentions us. It never negotiates publicly or gives prices in groups, unless the chat format requires it (a per-chat flag). |
| FR-006 | **Health.** Track per chat: messages deleted by admins, our account muted or banned (`ChatWriteForbidden`, `USER_BANNED_IN_CHANNEL`) → automatically set `can_post=false` and notify. If any spam signals appear (A1 in the threat model), stop all group posting for 7 days. |
| FR-007 | **Market intel.** `pricing_info` messages update `market_prices` (topic, subscribers, price, date), which the planner and quote logic can use as context. The quote logic never sets prices automatically from it. |

## Corner cases
- The group rules forbid bots or automation. The owner decides per chat; the default is `can_post=false`.
- The same person is in many groups → deduplicated by peer id, so they get one conversation.
- The group is an aggregator with fake requests → the score uses 014 channel checks of the requester's channel.
- Messages in a thread or forum topic → topic-aware: rules and posting apply per topic.
- Our group post gets negative reactions or is deleted → stored as feedback, and the cooldown doubles.

## Success criteria
- Unit tests: rule parsing, cooldowns, dedup, the DM-opener gating, the never-negotiate-in-group gate rule, and the auto-disable
  on ban errors.
- Evals: a simulated group stream with a mix of offers, spam and requests.
  - Expected: correct opportunity extraction (precision ≥ 0.8 on the fixture set).
  - Zero public price messages.
  - DM openers only for invited requests.
