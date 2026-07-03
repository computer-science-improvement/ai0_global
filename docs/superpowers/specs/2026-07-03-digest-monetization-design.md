# Digest strategies + monetization roadmap — Design

**Date:** 2026-07-03 · **Branch:** `feat/strategy-improvements`
**Basis:** research workflow (9 agents): verified add-a-strategy recipe, content-source
inventory, 17-strategy catalog, monetization-rails inventory, network-data audit,
web research on Telegram digest formats/monetization (UA market incl. IT Двіж-style
"all news in 1 post/day", telega.in slot conventions, $4–8 CPM tech/AI benchmark).

## Built now (this commit)

### `network-digest` — daily "що опублікувала мережа" (cross-promo + sponsor slot)
- `src/strategies/network-digest/` — strategy + repository + `digest-format.util.ts`
  (pure, unit-tested) + module; registered in AppModule. **No migration** — reads
  `published_posts` (channel_id = channel_key) ⋈ `tracked_channels` (is_mine) ⋈
  latest `post_stats_snapshots` view per post; subs delta from `channel_stats_snapshots`.
- Ranking: **views/hour with a 3h floor** (raw views favor morning posts).
- Format: `📑 <b>header</b>` + top-N `🔘 <a t.me/{user}/{msg}>title</a> — 👁 views`
  + `📈 Мережа за добу: +Δ підписників · N постів` + CTA + optional
  `Партнер дайджесту: … #реклама` (params.sponsor {text,url} — **monetization M1**).
- Custom `execute()` ON PURPOSE: ReviewAgent has a 1024-token output cap that would
  TRUNCATE a multi-link digest, and an AI pass can mangle URLs. The digest is
  deterministic HTML from already-reviewed titles. (Research proposed the generic
  pipeline; this was caught and corrected during implementation.)
- Dedup: sentinel `digest://network/{channelId}/{YYYY-MM-DD Kyiv}` in posted_news —
  one digest per channel per day; digest self-excluded from tomorrow's digest via
  `strategy_type NOT IN ('network-digest','topic-digest')`.
- Overflow: header+footer reserved first, items added while ≤3800 chars — never splits.
  Unlinkable channels (private/invite/chat-id keys) dropped; skip run if < minItems.
- No Meta cross-post (t.me deep links are dead weight off-Telegram).
- Params: windowHours(24) maxItems(8≤) minItems(3) includeChannels showSubsDelta
  headerTitle ctaText sponsor.
- Binding: `POST /api/strategies {ext_id:'network-digest:hub', type:'network-digest',
  channel_id:<uuid>, schedule:'0 19 * * *', params:{}}` → PATCH enabled. Evening post
  (~19:00) per web research. Verify container TZ before trusting the hour.

### `topic-digest` — daily niche digest ("{Тема} за день: головне")
- `src/strategies/topic-digest/` — recaps OUR OWN published news posts
  (params.strategyTypes, default ['ai0-news','ua-news']) — retention loop, zero dedup
  interference with source strategies, content already reviewed.
- AI: ClaudeAgent.chat rewrites titles to ≤90-char one-liners via strict JSON
  contract `[{i,line}]` (+HUMAN_VOICE/ANTI_SLOP skills); **hard fallback to original
  titles** on unavailable/garbage/partial reply — the digest must never be blocked
  by the AI (`parseRewrite` unit-tested for all three failure modes).
- Same sentinel dedup (`digest://topic/...`), same formatter, same overflow rules.

Tests: 21 new (format util 9, network 7, topic 5); suite 623/623.

## Designed, NOT built yet (next steps, in order)

1. **M2 — mediakit/rate-card endpoint** `GET /api/mediakit` (public, cached): per-channel
   avg views (last 30 posts), ER, subs & 30d trend; price = target_cpm × avg_views/1000
   (default $5 CPM, sanity-checked against the TeLeAds catalog already ingested by
   `src/discovery/teleads/teleads.client.ts`). Render on landing `#advertise` replacing
   bare mailto. Effort S/M.
2. **M3 — delivery proof**: migration 042 `ad_order_id` on scheduled_publications;
   snapshot views at 24/48h into ad_orders (`delivered_views`); "promised vs actual"
   in `/app/ads`. Effort M.
3. **`digest-poll`** (novel format, effort S): weekly Sunday poll «Що було найцікавішим
   цього тижня?», options = top-5..8 titles (windowHours 168) ≤100 chars each +
   «Своє — напишу в коментарях»; sendPoll constraints per pdr-quiz (≤10 opts, ≤300-char
   question, plain text); dedup `digest://poll/{channel}/{ISO-week}`. ER lever —
   advertisers price on ER, polls are the cheapest ER boost.
4. **M4 — 1/24 slot mechanics** (slot_type on orders + channel quiet-window) — after
   M1–M3 prove demand. **M5** — list on Collaborator/TeLeAds once mediakit is live
   (+ optional «Реклама» label boolean in TelegramPublisher for compliance).

## Explicitly NOT building (with reasons — see research report)
Advertiser portal (no users yet); generic sponsor hook in all strategies (voice
pollution, near-zero CPM outside digests); multi-platform digest variants (t.me links
dead on IG/Threads); auction/inventory system; trending auto-discovery & UGC
(moderation load); A/B framework (reach too small for significance); 429-pacing infra
(1 digest/day — stagger cron minutes instead); semantic dedup; Telegraph long-form
(only if 4096 cap hits in practice); LiqPay tax automation (ФОП accounting, not code).

## Rollout
Both strategies register automatically; bindings are created disabled via the
dashboard (Strategies → Add). Suggested first bindings: network-digest on the hub
channel 19:00; topic-digest on the news channel 20:00 (staggered). Sponsor slot
activates by adding `params.sponsor` to the binding when an ad_order is paid
(manual for now; auto-link designed in M3).
