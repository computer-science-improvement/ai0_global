# 049 Ops autonomy

**Epic:** AI0-216 (T1–T5 = AI0-221…225) · **Priority:** P1 · **Depends on:** 012, 017, 040, 046 · **Status:** done 2026-10-18 (T1–T5; deltas in [tasks.md](tasks.md))

## Why

Review 2 (`docs/reviews/2026-10-17-agent-review-2.md` §8, gaps 1 and 9) rates self-maintenance at 1.5 out of 5.

- **Threads tokens.** Both Threads tokens expired in August ("Session has expired on 17-Aug-26 / 18-Aug-26") and were still dead on 10-17.
  - Threads refresh exists only as a manual endpoint. No cron calls `refreshThreadsToken`.
  - `meta_accounts.token_expires_at` is stored but never read, so no resource ever reaches `token_expiring`.
  - The Meta collector logs the failure every hour, and nobody acts on it.
- **Health alerts.** `ResourceHealthService` alerts once, on the state change. There is no reminder.
- **Slots on a broken resource.** These slots still run the writer, which pays for a post that cannot go out, and then fail.
- **Dead source host.** It is blocked for 24 h, never replaced, and the owner is not told.

## Requirements

### FR-001 Connection keeper (T1, AI0-221)

A daily cron (`ConnectionKeeperUpkeep`, 05:40 server time) runs before the resource health check (06:10). It does this:

- **Threads:** refreshes the long-lived token when it expires within 10 days (`THREADS_REFRESH_DAYS`) or its expiry is unknown.
  - The new token is stored encrypted, with its new expiry.
  - An expired token cannot be refreshed. The account gets `verify_error` "Threads token expired on D — reconnect the account in /app/connections", and the health check turns that into `token_invalid`.
  - Without `TOKEN_ENCRYPTION_KEY` there is no refresh: a refreshed token that cannot be stored would be lost.
- **Facebook / Instagram:** `debug_token` stores the expiry and validity. The catalog maps them to health states:
  - expired or invalid → `token_invalid`;
  - expiring within 7 days → `token_expiring`.
- **Bots and Telegraph accounts:** verified with `getMe` / `getAccountInfo`, with one retry.
  - A failure is stored and gets one Inbox note per account per Kyiv day.
  - A recovery clears the error.
- **TikTok:** the token service refreshes active accounts.
- **MTProto sessions:** reported from their stored state, never reconnected (see deltas).

`CONNECTION_KEEPER=off` disables the cron.

### FR-002 Repeat alerts and skipped slots (T2, AI0-222)

**The stored health record** (`resource_profiles.resource_health`) gains three fields:

- `since`: when the bad state began;
- `expiresAt`: for an expiring token;
- `dismissedAt`: when the owner muted reminders.

**Inbox notes:**

- A change into a bad state posts one note, as before.
- While the state stays bad, a reminder "… (since D, N d)" goes out at most once per Kyiv day (`resource_day` dedup). The reminder:
  - skips the day of the change;
  - skips `rate_limited`;
  - for `token_expiring`, comes only in the last 2 days.
- A fix posts "✅ … connection works again".
- `POST /api/agents/:handle/health/dismiss` mutes the reminders until the state changes.

**Slots and the agent page:**

- **Slot skip.** The scheduler skips a due slot whose resource is `no_access` or `token_invalid`. The slot ends `skipped` with `resource_unavailable: <state> — <detail>`, and the plan shows "Connection broken". A stored state older than 30 minutes is checked again first, so a reconnect counts at once.
- **Agent page.** It shows a banner with:
  - "Connection broken since D (N d)";
  - the detail and what it means for posts;
  - "Fix the connection", which links to the Meta account, the TikTok section or the Telegram section;
  - "Mute reminders".

### FR-003 Source health per resource (T3, AI0-223), done

Per resource:

- the success rate of each source;
- the last good fetch;
- blocked hosts;
- the slots skipped because of each source.

### FR-004 Replacement source proposals (T4, AI0-224), done

When a source keeps failing, the channel agent proposes a new or an extra source as an owner card.

### FR-005 Network health view (T5, AI0-225), done

One place that shows:

- connections;
- sources;
- budget headroom;
- stuck work.

The weekly report gains a section with the same data.

## Out of scope

- Reconnecting expired accounts automatically. An expired Meta token needs the owner's OAuth.
- Paging outside Telegram.
