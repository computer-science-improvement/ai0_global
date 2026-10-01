# 008: Revenue path

**Status:** TODO · **Depends on:** 001 (LiqPay callback reachable), 005 (editor reserves slots)

## Why
Payments work, but the commercial wrapper is missing:
- no price list
- no legal ad label
- no creative (image or button)
- no link from order → post → stats
- no advertiser report

The audience is small (~9.4k), so every sale has to look professional.

## Requirements and tasks
- [ ] T001 **Price list:**
  - `ad_prices` table: channel, format, price_uah, active.
  - A public `GET /api/landing/prices`.
  - An `ad_orders.price_id` FK; the amount is computed server-side.
- [ ] T002 **Ad creative:**
  - Add `creative` JSONB to `ad_orders`, as a PostSpec subset (004): body, media, CTA button.
  - Sponsored posts render through `renderTelegram` with a mandatory `#реклама` line added by code, never by the model.
- [ ] T003 **Reserved slots:**
  - A paid order creates an `editor_slots` row with `kind='reserved'` at the agreed time.
  - The planner (005) sees reserved slots as fixed and plans around them.
  - Reserved slots publish deterministically, without the LLM, through the same guarded publisher.
- [ ] T004 **Order lifecycle:**
  - Statuses `scheduled → published (post_id) → reported`.
  - `ad_orders.published_post_id` FK to `published_posts`.
- [ ] T005 **Advertiser report:**
  - A job at +24 h and +72 h after publish builds a report: views, forwards, reactions, CTR proxy if UTM.
  - The output is an HTML page (public tokenized URL), plus a draft DM to the advertiser as an SP2 `agent_actions` row (owner approves the send).
- [ ] T006 **Digest sponsor slot:** sponsors come from paid `ad_orders` (format `digest_sponsor`) instead of a static param; the URL renders as a link with UTM.
- [ ] T007 **Sales agent tooling** (semi-autonomous; principle II plus human approval):
  - The triage agent replies to `ad_offer` DMs with a price-list template, as a pending action.
  - It drafts an invoice and creates the `ad_order` in `draft`.
  - The owner approves. Caps: `AGENT_REPLY_DAILY_CAP`.
- [ ] T008 **Media kit page** on the landing site: live stats from `editor_v_channel_daily`, plus the prices.
