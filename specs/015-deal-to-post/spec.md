# 015: Deal → paid post: the conversational order flow on top of 008

**Status:** SPEC · **Depends on:** 008 (prices, orders, LiqPay, reserved slots, reports), 011, 012

## Why
008 built the commerce pieces, but the owner still assembles each order by hand on `/app/ads`. This spec lets the deal
agent run the whole flow inside a DM. Every money and legal decision stays in code or with the owner.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Quote.** `quote(channel, format, dates[], package?)`: <br>• prices come from `ad_prices`; discounts follow `deal_policy.discounts` <br>• the result is frozen in `ad_quotes(id, conversation_id, items jsonb, total_uah, valid_until (48 h), status)` <br>• the agent's message must contain the exact total; the gate cross-checks it against the quote |
| FR-002 | **Slot hold.** On quote: <br>• a tentative hold `editor_slots` with `kind='reserved'` and `status='hold'` (new status, migration) for 2 h; on invoice it is extended to the invoice TTL <br>• a unique partial index on `(channel_key, date_trunc('minute', scheduled_at)) WHERE status IN ('hold','planned')` prevents double booking <br>• an expired hold is released by a sweeper |
| FR-003 | **Invoice.** <br>• `create_order` comes from the quote, reusing `ad_orders` with `thread_id` and `price_id` <br>• `send_payment_link` creates the LiqPay checkout (hosted, server-side amount, 008) with `order_id` and `expired_date` = hold TTL <br>• the link is inserted only through a template <br>• reminder at T-30 min before expiry; after expiry → the hold is released and the agent offers to renew |
| FR-004 | **Paid** is only the LiqPay signed callback with status `success`. It then: <br>• moves the conversation to `paid` <br>• turns the hold into `planned` <br>• sends a thank-you plus the creative request (template) <br>• notifies the owner (milestone card) |
| FR-005 | **Creative intake.** The advertiser sends text, a photo or video, and a link. `submit_creative` collects the message ids, downloads the media through the agent client into the slide or video bucket, builds the `SponsoredCreative` and runs `lintSponsored` plus the policy LLM check (banned topics, misleading claims). If it is OK → the agent sends a **preview** (a rendered image of the post, or the exact text and attachments) and asks for "так/підтверджую". If it is not OK → the agent explains what to change (from the lint codes, written in human words). <br>Limits: max 3 revision rounds, then escalate. Media: images ≤ 10 MB, video ≤ 20 MB (Bot API URL limit) or uploaded via MTProto. |
| FR-006 | **Schedule.** After confirmation → `schedule_ad`: the creative is stored on the reserved slot, and the 008 SponsoredPublisher publishes it at the time. The agent replies with the exact date and time. |
| FR-007 | **Post-publish.** <br>• after publish: the agent sends the post link within 5 min <br>• at 24 h and 72 h: report links (008 reports), sent as an agent DM in phase ≥ 2, or as an approval card in phases 0–1 |
| FR-008 | **Changes after payment.** <br>• reschedule (the advertiser asks) → allowed once, ≥ 24 h before the slot, to a free slot within 14 days <br>• otherwise → owner <br>• creative changes ≥ 6 h before the slot → re-lint and re-confirm <br>• cancellation or refund → always the owner (C1) |
| FR-009 | **Packages.** Multi-post orders (3 posts, digest mentions) → one order with several reserved slots. Each slot is published and reported separately. |

## Corner cases
- **The advertiser pays after the hold expired.** The callback arrives for an expired order → accept the payment, try to
  re-hold the same slot, and if it is gone → owner escalation with the next free slots.
- **The amount in the callback differs from the order** (manipulation) → do not mark it paid, and send a critical alert.
- **Duplicate callbacks** → idempotent (008).
- **The advertiser sends the creative before paying** → store it and say it will be checked after payment. It is never
  scheduled before payment.
- **The creative contains a competitor's link, a ru-domain or a shortener** → lint error with a human explanation.
- **The advertiser asks for an invoice for a legal entity (ФОП/ТОВ) or for fiscal documents** → escalate (C8).
- **The channel is paused (`publish_paused`) at publish time** → the slot fails, then the owner is notified, and the agent
  apologises and offers a new time after the owner's approval.

## Success criteria
- Unit tests:
  - quote freezing and expiry;
  - hold, double booking and the sweeper;
  - invoice TTL and reminders;
  - callback amount mismatch;
  - creative intake and lint-to-human messages;
  - revision limits;
  - reschedule rules.
- E2E `pg` with a scripted LLM, a fake MTProto client, a fake LiqPay callback and a fake TG publisher:
  DM → quote → hold → invoice → callback → creative → preview → confirm → reserved slot published → post link →
  24 h report DM.
