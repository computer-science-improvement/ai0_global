# Ad Payments (SP3) — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/strategy-improvements`
**Builds on:** SP1 (DM inbox) + SP2 (approval-gated actions). Roadmap step 3 of the agent-operator.

## Context

The network's whole reason to exist is selling ad placements; until now there is zero value capture. SP3 adds the monetization loop: a minimal **ad order / invoice**, a **LiqPay hosted-checkout** link the owner sends to an advertiser, and a **signed webhook** that marks the order paid. On paid, the owner one-click creates an SP2 `schedule_post` action → the sponsored post publishes through the existing queue.

Provider decision (brainstorming): **LiqPay** (Ukrainian audience/advertisers).

### Hard payment constraints (non-negotiable)
- We integrate **hosted checkout only**: the payer enters card data on **LiqPay's** page. This app NEVER sees, stores, or handles raw card data.
- We do NOT create the merchant account and do NOT move funds. The owner sets up the LiqPay account and provides `LIQPAY_PUBLIC_KEY` / `LIQPAY_PRIVATE_KEY`.
- The server-to-server callback is authenticated by **LiqPay signature verification** (HMAC-style over the private key), never by our auth guard.

### Standing constraints
pnpm; automation tests from `apps/automation` via `npm test`; **no live external/network in tests** (LiqPay signing/verify is pure + unit-tested with a fake key); secrets never logged/returned; additive-only; single-instance deployment fine; do not push/merge without an explicit ask.

## Goals / Non-goals

**Goals (SP3):**
- `ad_orders` table + repository (CRUD + `markPaid`).
- `LiqpayService` — pure, testable: `buildCheckout(order)` → `{ data, signature }`; `verifyCallback(data, signature)` → `{ valid, status, orderId }`.
- Guarded REST: create/list ad orders; `POST /api/ad-orders/:id/checkout` → returns `{ data, signature }` (+ the LiqPay form action URL) for the owner to send to the advertiser.
- Public, signature-gated webhook: `POST /api/payments/liqpay/callback` → verify → `markPaid` on success. Idempotent.
- "Schedule post" on a paid order → creates an SP2 `schedule_post` action (reuses SP2).
- Dashboard "Ad orders" surface.

**Non-goals (SP3 — deferred):**
- Handling card data / PCI scope (LiqPay hosts it).
- Refunds, payouts, invoicing PDFs, multi-currency beyond a configurable default.
- Auto-scheduling on payment (owner still approves the SP2 action).
- A public advertiser self-serve portal (owner creates orders; advertiser only pays the link).

## Architecture

New feature module `apps/automation/src/payments/` (+ a small `ad-orders` area). Reuses: `SecretsService` is not needed for the LiqPay keys (they're plain env, read via `ConfigService`); SP2 `AgentActionsRepository` to create the schedule action on paid; the public-controller pattern from `config/api/landing.controller.ts` (no `TrackingAuthGuard`).

```
Owner (dashboard)                 LiqPay (hosted)                  Advertiser
   │ create ad_order                                                   │
   │ POST /ad-orders/:id/checkout ──► {data,signature} ──► owner sends payment link ──►│ pays card on LiqPay page
   │                                                                                    │
   │                         POST /api/payments/liqpay/callback ◄── server-to-server ──┘
   │                              verifyCallback(signature) → markPaid(order_id)
   │ sees "paid" → "Schedule post" → SP2 schedule_post action → scheduled_posts → publish
```

### Components

**1. Migration `database/migrations/040_ad_orders.sql`** — see Data model.

**2. `LiqpayService`** (`apps/automation/src/payments/liqpay.service.ts`) — pure logic + ConfigService for keys.
- `buildCheckout(o: { orderId, amount, currency, description, resultUrl?, serverUrl? })` → `{ data, signature, actionUrl }` where:
  - `params = { public_key, version: 3, action: 'pay', amount, currency, description, order_id, result_url, server_url }`
  - `data = base64(JSON.stringify(params))`
  - `signature = base64(sha1(private_key + data + private_key))` (binary sha1 digest, base64-encoded)
  - `actionUrl = 'https://www.liqpay.ua/api/3/checkout'`
- `verifyCallback(data, signature)` → `{ valid, status?, orderId? }`: recompute the signature, constant-time compare; if valid, `JSON.parse(base64decode(data))` → extract `status`, `order_id`.
- The base64/sha1 helpers live in a pure `liqpay.util.ts` so they're unit-tested without ConfigService.

**3. `AdOrdersRepository`** (`payments/ad-orders.repository.ts`)
- `create(input)`, `list(status?)`, `findById(id)`, `findByLiqpayOrderId(orderId)`, `setStatus(id, status, patch?)`, `markPaid(liqpayOrderId)` (idempotent: only flips `awaiting_payment`/`draft` → `paid`, sets `paid_at`; a second call is a no-op), `attachAction(id, actionId)`.

**4. `AdOrdersService`** — orchestrates: `createCheckout(id)` (sets status `awaiting_payment`, returns LiqPay params), `schedulePost(id, {channelId, text, scheduledAt})` (only when `paid`; creates an SP2 `schedule_post` action via `AgentActionsRepository`, links `action_id`, sets status `scheduled`).

**5. Controllers:**
- `AdOrdersController` (`@Controller('api/ad-orders')`, `@UseGuards(TrackingAuthGuard)`): `GET /` (list?status), `POST /` (create), `POST /:id/checkout`, `POST /:id/schedule`.
- `LiqpayCallbackController` (`@Controller('api/payments/liqpay')`, NO guard): `POST callback` `{ data, signature }` → `LiqpayService.verifyCallback` → on valid+success `AdOrdersRepository.markPaid`; invalid signature → 400, no state change. Always returns 200 on a verified callback (LiqPay retries otherwise).

**6. Dashboard** — new `/app/ads` route + `api/ads.ts`:
- Create order (advertiser, channel, amount, description); list with status Badge (`draft`/`awaiting_payment`=neutral, `paid`=success, `scheduled`=accent, `canceled`=warning).
- "Get payment link" → calls checkout, shows a copyable LiqPay URL/`data`+`signature` (owner pastes into the SP2 reply to the advertiser).
- On `paid` → "Schedule post" form (channel + text + datetime) → calls `/schedule`.
- Sidebar nav "Ads".

## Data model

`database/migrations/040_ad_orders.sql`:
```sql
CREATE TABLE IF NOT EXISTS ad_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser       TEXT NOT NULL,
  channel_id       TEXT,                       -- target channel (nullable until decided)
  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'UAH',
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','awaiting_payment','paid','scheduled','canceled')),
  liqpay_order_id  TEXT UNIQUE,                -- our order_id sent to LiqPay (= id, stringified)
  action_id        UUID REFERENCES agent_actions(id) ON DELETE SET NULL,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_orders_status ON ad_orders (status, created_at DESC);
```
- `liqpay_order_id` is set to the order's `id` (stringified) when checkout is built, so the callback can map `order_id` → row. `UNIQUE` + idempotent `markPaid` makes duplicate webhooks safe.
- No card data, no tokens stored. LiqPay keys live only in env.

## Data flow
1. Owner `POST /ad-orders` → `draft`.
2. Owner `POST /ad-orders/:id/checkout` → status `awaiting_payment`, `liqpay_order_id = id`, returns `{ data, signature, actionUrl }`. Owner sends the payment link to the advertiser (often via an SP2 reply).
3. Advertiser pays on LiqPay. LiqPay POSTs `{ data, signature }` to `/api/payments/liqpay/callback`.
4. Controller verifies signature; on `status ∈ {success, sandbox}` → `markPaid(order_id)` → `paid` + `paid_at`. Invalid signature → 400.
5. Owner sees `paid`, fills channel/text/time, `POST /ad-orders/:id/schedule` → SP2 `schedule_post` action created + linked; status `scheduled`.

## Error handling / safety
- **No card data ever** — hosted checkout only.
- **Signature-gated callback**: the public endpoint changes state ONLY when `verifyCallback` returns valid; constant-time compare; a forged/garbage callback gets 400 and changes nothing.
- **Idempotent markPaid**: `UPDATE ... WHERE liqpay_order_id=$1 AND status IN ('awaiting_payment','draft')`; a duplicate webhook (LiqPay retries) is a no-op.
- **Secrets**: `LIQPAY_PRIVATE_KEY` read via ConfigService, never logged, never returned by any endpoint. The `signature` returned by `/checkout` is per-request and safe to expose (that's how LiqPay embeds work).
- **No auto-spend / auto-publish**: scheduling still goes through the SP2 action (owner-approved). Payment never triggers a post by itself.
- **Boot safety**: if LiqPay keys are unset, `/checkout` returns a clear 400 ("payments not configured"); the callback verify fails closed (no key → invalid).

## Testing (no live network)
- `liqpay.util.test.ts`: `sign(data, key)` deterministic for a fixed key; `buildData(params)` round-trips through base64+JSON; `verify` accepts a correct signature and rejects a tampered one.
- `liqpay.service.test.ts`: `buildCheckout` produces `order_id`/`amount` in the decoded data and a signature matching the util; `verifyCallback` returns `{valid:true,status,orderId}` for a self-signed payload and `{valid:false}` for a bad signature.
- `ad-orders.repository.test.ts` (fake pool): create/list/markPaid SQL + params; `markPaid` WHERE clause restricts to non-paid statuses (idempotency).
- `ad-orders.service.test.ts`: `schedulePost` only when paid (rejects otherwise); creates an `agent_actions` row via a stubbed `AgentActionsRepository` and links `action_id`.
- `liqpay-callback.controller.test.ts`: valid signature → markPaid called; invalid → 400, markPaid NOT called.

## Env (documented in `.env.example`)
- `LIQPAY_PUBLIC_KEY=` , `LIQPAY_PRIVATE_KEY=` (the owner's LiqPay merchant keys; private key is a secret).
- Callback URL is derived: `${DASHBOARD_URL}/api/payments/liqpay/callback` (DASHBOARD_URL already exists). `AD_ORDER_CURRENCY` (default `UAH`).

## Verification
- `cd apps/automation && npm run build && npm test` green incl. new payment tests.
- `verifyCallback` rejects a tampered signature (test); a forged callback can't mark an order paid.
- Dashboard `pnpm --filter dashboard build` clean; `/app/ads` create → payment link → (sandbox pay) → paid → schedule.
- `grep` confirms `LIQPAY_PRIVATE_KEY` is never passed to a logger or returned in a controller response.

## Risks
- **Callback reachability**: LiqPay must reach `${DASHBOARD_URL}/api/payments/liqpay/callback` publicly (Caddy vhost already fronts the stack). If unreachable, orders stay `awaiting_payment`; add a manual "mark paid" owner override only if needed (out of SP3 scope).
- **Sandbox vs live**: LiqPay `sandbox` mode returns `status:'sandbox'` — treated as paid for testing; document switching to live keys.
- **Amount/currency integrity**: amount is set server-side from the order row, not from the client, so the advertiser can't alter the price via the checkout payload.
