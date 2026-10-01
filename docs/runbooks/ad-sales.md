# Runbook: selling an ad, end to end

Spec [008](../../specs/008-revenue-path/spec.md). One page from "set a price" to "the advertiser has a report".
Every step that talks to the advertiser or publishes is approved by you; code only drafts.

```
price ──► inquiry (DM) ──► draft reply with prices ──► you approve the send
                                                          │
order (price → amount) ──► LiqPay link ──► paid (webhook) ──► schedule ──► you approve the action
                                                                              │
                     reserved editor slot (or SP2 queue) ──► published (#реклама) ──► report 24 h ──► report 72 h
                                                                                         │
                                                                    draft DM with the report link ──► you approve
```

## 0. One-time setup

1. Apply migration `044_ad_revenue` (`database/migrate.sh`, or let the service apply it at boot).
2. `.env`: `DASHBOARD_URL` must be the public dashboard origin (report links are `${DASHBOARD_URL}/report/<token>`),
   plus the LiqPay keys from `.env.example` (unchanged since SP3).
3. For automatic placement and reports, the channel needs an editor card (`editor_channels`, any mode, even `off`)
   and `EDITOR_ENABLED=true` at the moment you approve the order. See [editor-agent.md](editor-agent.md) §2 and §5.
   Without them the ad still goes out through the old SP2 queue, but with no post link and no report.

## 1. Price list

`/app/ads` → **Price list**. Pick a channel, a format and a price in UAH:

| Format | What the advertiser gets |
|---|---|
| `post` | one sponsored post at the agreed time |
| `pin_24h` | the same, pinned for 24 h. **Pinning is manual:** the "published" alert reminds you to pin it, and you unpin it after 24 h |
| `digest_sponsor` | the "Партнер дайджесту" line in that channel's network/topic digest on the agreed day |

Saving a new price for the same channel and format deactivates the old one, which is kept as history. Active prices
are public: `GET /api/landing/prices`, and the media kit on the landing page (`GET /api/landing/media-kit`:
subscribers, average views per post over 30 days, prices). A channel without active prices is not in the media kit.

## 2. Inquiry → price-list reply

When the DM triage classifies a message as `ad`, the agent drafts a **pending `reply` action** with the price list:
the named channel's prices, or all of them. It never sends anything itself. Approve or reject it on `/app/agent`.
`AGENT_REPLY_DAILY_CAP` applies at approval, and a thread never gets a second draft while one is pending.

## 3. Order and invoice

`/app/ads` → **New order**:
- **Price.** Pick one and the server sets the amount and default channel; a client-sent amount is ignored.
  "Custom amount" still works for one-off deals.
- **Publish at.** The agreed time. For `digest_sponsor` it is the digest **day** (Kyiv date).
- **Ad text, image, button.** This is the creative. Write it in Ukrainian; a blank line starts a new paragraph;
  `**bold**`, `_italic_` and `[link](https://…)` work. No hashtags and no HTML.
  **`#реклама` is always added by code as the last line.** "Customer line" adds `Реклама. Замовник: …` above it.
- To link the order to the advertiser's DM thread (so the report DM goes to them), pass `threadId`.
  The API supports it; the dashboard form does not have this field yet.

Click **Get payment link** and send the LiqPay link to the advertiser. The signed LiqPay webhook flips the order to
`paid` (only `success`; `sandbox` only with `LIQPAY_SANDBOX=true`).

Edits before publication: `PATCH /api/ad-orders/:id` (creative, customer line, publish time, channel, thread).

## 4. Schedule → approve → placement

On a `paid` order click **Schedule post** (channel and time default to the order). The server lints the creative
(media count, length incl. the ad label, URLs) and creates a pending `schedule_post` action whose preview already ends
with `#реклама`. The order becomes `scheduled`.

Approve the action on `/app/agent`. Then:
- **Editor path** (`EDITOR_ENABLED=true` and the channel has a card): a reserved slot appears in that day's plan on
  `/app/editor`, and the order shows "reserved slot". At the agreed time it is published without any LLM, even if
  the channel's editor is `off`/`shadow` or `EDITOR_ENABLED` was switched off later. `publish_paused` blocks it.
  It is never posted more than 6 h late. You get a `💰` alert on success and a `⚠️` alert on failure.
- **SP2 path** (otherwise): a row in `/app/scheduled` with the rendered creative. It is published by the scheduled
  posts worker; the order stays `scheduled`.

`digest_sponsor` orders skip this step. A `paid` order whose publish day is today is picked up by the digest
strategies; the link gets `utm_source=ai0&utm_medium=telegram&utm_campaign=<first 8 chars of the order id>`.
After the digest is posted, the order is `published` and linked to the digest post.

## 5. Published → reports

Order statuses: `scheduled → published` (with `published_post_id`) `→ reported`.

The hourly job (minute 17) builds the report from `post_stats_snapshots`:
- **≥ 24 h:** first report.
- **≥ 72 h:** final report; the order becomes `reported`.

The report holds views, forwards, reactions, replies, reach (views / subscribers), a views-by-hour curve, and the
link with a UTM flag. Telegram has no click data, so a UTM-tagged link is the CTR proxy.

- Public page: `/report/<token>` (JSON at `GET /api/ads/report/:token`). The **Report** button on the order opens it.
- On the first report the agent drafts a pending `reply` with the link for the order's DM thread. Approve it on
  `/app/agent`. If the order has no thread, the admin bot sends you the link to forward yourself.
- The same link shows the final report after 72 h.

Reports need post stats, so the stats collector must be running for the channel.

## 6. Troubleshooting

| Symptom | Check |
|---|---|
| Order stuck in `scheduled` | Was the action approved? Is the slot `failed` (`SELECT status, error FROM editor_slots WHERE id = (SELECT editor_slot_id FROM ad_orders WHERE id = …)`)? On the SP2 path `scheduled` is final. |
| "creative invalid" on schedule | Photo needs exactly 1 image; text ≤ 4096 visible characters incl. the ad label (a long photo post becomes a text post with a large image preview); http(s) URLs only. |
| Digest has no sponsor | Order must be `paid`, priced as `digest_sponsor`, with `publish_at` on today's Kyiv date, and the button URL set (it is the sponsor link). |
| No report after 24 h | `published_post_id` must be set and the post must have stats snapshots. |
| Reschedule a failed ad | Fix the cause, then set the order back: `UPDATE ad_orders SET status='paid', editor_slot_id=NULL WHERE id=…`, and schedule again. |
