# 049 Ops autonomy — tasks

- [x] T1 (AI0-221) Connection keeper: `config/connection-keeper.ts` holds the logic, with every port injected. `config/connection-keeper.upkeep.ts` is the cron at 05:40 and is disabled by `CONNECTION_KEEPER=off`.
  - Threads tokens are refreshed 10 days before expiry, or when the expiry is unknown, and stored encrypted with the new expiry.
  - An expired token is stated with the date in `verify_error`.
  - `debug_token` metadata is stored for Facebook and Instagram.
  - Bots and Telegraph accounts are verified with one retry and get one Inbox note a day while broken.
  - TikTok tokens are kept fresh.
  - MTProto sessions are reported from stored state.
  - The catalog reads `token_expires_at` and `token_valid`:
    - an expired or invalid token → `token_invalid` ("token expired on D");
    - a token expiring within 7 days → `token_expiring` ("N d left").
- [x] T2 (AI0-222) Repeat alerts and skipped slots:
  - `ResourceHealthService` keeps `since`, `expiresAt` and `dismissedAt`.
  - It posts a daily reminder (`resource_health_daily`, dedup `resource_day`), a recovery note (`resource_health_ok`) and `blocked(ref)` with a 30-minute re-check.
  - The scheduler skips due slots on a blocking resource with `resource_unavailable: …`, and the plan shows "Connection broken".
  - New endpoint: `POST /api/agents/:handle/health/dismiss`.
  - `ConnectionBanner` on the agent page.
  - Tests: `editor/platform/ops-health.049.test.ts` and `config/connection-keeper.049.test.ts`.
- [ ] T3 (AI0-223) Source health per resource.
- [ ] T4 (AI0-224) Replacement source proposals.
- [ ] T5 (AI0-225) Network health view and weekly report section.

## Deltas from the spec

- **MTProto sessions are not reconnected.** A second live connection with the same auth key risks `AUTH_KEY_DUPLICATED`. The keeper alerts on the `verify_error` the session code stores.
- **A failed Threads refresh is not marked as a broken connection.** A token under 24 hours old cannot be refreshed, and a network blip is not a dead account. The health check flags the token as `token_expiring` and then `token_invalid` as the expiry nears.
- **The Meta collector already verifies accounts every hour,** so the keeper only inspects token metadata for Facebook and Instagram.
- **The "daily summary of 012" does not exist.** The once-a-day reminder note stands in for it.
- **Slots are skipped, not paused.** A paused slot would wait for a fix that may never come, and the plan already shows a skip with its reason. Paused promo and reserved slots are unchanged.
- **The Chat menu counter changed (shipped with this work).** It and the new "Waiting for you" list (`GET /api/nav/attention`) count only cards that can still be applied, i.e. those under the 24-hour TTL.

## Owner actions after deploy

1. Reconnect both Threads accounts in `/app/connections`. Their tokens expired in August and cannot be refreshed. From then on the keeper keeps them fresh.
2. Keep `TOKEN_ENCRYPTION_KEY` set. Without it the keeper cannot store a refreshed token.
