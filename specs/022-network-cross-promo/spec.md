# 022: Network cross-promo and reposts between own resources, tracked links, transitions KPI

**Status:** SPEC · **Depends on:** 019, 020, 021 · **Design:** [../017-agent-platform/design.md](../017-agent-platform/design.md) ·
**Migration:** `054_network_promo.sql`

## Why
The manager can see that resource A could feed resource B, for example a strong Instagram carousel that the Telegram
channel could share, or two related Telegram channels that could promote each other. External cross-promo with other
people's channels is 014 (the deal agent). This spec covers **our own resources**: no negotiation, but measured.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `054_network_promo.sql`.** <br>• `tracked_links(id uuid pk, kind text check in (tg_invite, utm), target_ref text, source_ref text, slot_id uuid null, directive_id uuid null, url text unique, tg_invite_name text, created_at, expires_at null)` <br>• `link_joins(id bigserial, link_id fk, joined_at, tg_user_hash text null, count int default 1)` <br>• `promo_pairs(source_ref, target_ref, last_promo_at, count_30d, primary key(source_ref, target_ref))` |
| FR-002 | **Tracked invite links** (Telegram). `TrackedLinkService.forPromo(targetChannel, sourceRef, slotId)` creates a named invite link with the Bot API `createChatInviteLink` (named `src:<platform>:<short>`; our bot must be an admin with invite rights) and stores it. <br>• Joins are counted from `chat_member` updates that carry `invite_link`. The bot's update handler gets the `chat_member` allowed update; only a salted hash of the user ID is stored, never the ID itself. <br>• **Fallback** when the update cannot be received: a daily MTProto `messages.getChatInviteImporters` count where the session has rights, otherwise `joins = unknown`. <br>• Non-Telegram targets get UTM links (`utm_source=<platform>&utm_medium=<format>&utm_campaign=<slot short id>`); clicks are counted only when the target is our landing (`/r/:code` redirect in the dashboard app, which logs and redirects). |
| FR-003 | **Promo slots.** An applied `cross_promo{source_ref, target_ref, window, format}` or `repost{post_ref, to_ref}` directive (021) leads the **source** resource's orchestrator to schedule a slot with `kind='reserved'` and `promo` metadata in the window: `promo_target`, `tracked_link_id`, `directive_id`. <br>• **Cross-promo:** the executor writes a native post about B on platform A with the tracked link (or "link in bio" plus a profile-link update where the platform allows only that; otherwise the matrix marks it unsupported). <br>• **Telegram → Telegram repost:** a native `forwardMessage` from B's post into A (keeps attribution), plus an optional one-line comment as a separate message. <br>• **Cross-platform repost:** a 019 native variant that credits the original and links back. |
| FR-004 | **Limits** (code, in settings): <br>• the same pair in either direction at most once per 14 days <br>• at most 1 promo slot per resource per day <br>• at most 3 promo slots per network per day <br>• no promo in the 2 h before or after a paid ad on the same resource <br>• **relevance:** topic overlap of the two resource profiles (018), computed once per pair by the idea reviewer (score 1–5, cached 30 days); pairs below 3 are refused, with the reason given back to the manager <br>• both resources must be `ok` in health |
| FR-005 | **Transitions KPI.** It feeds 021's digest: joins per tracked link, joins per 1k views of the promo post, and the 7-day retention of joined users where it is measurable (the share of hashed IDs still members, MTProto only, optional). The `promo_pairs` ledger is updated, and the evaluator uses it for `cross_promo` outcomes. |
| FR-006 | **Manager skill `network-promo`:** when cross-promo or a repost makes sense (B grows slower than A with overlapping audiences; A has a hit that B's audience would like), when it does not (low relevance, B is unhealthy, the pair is on cooldown), and how to set `expected` (joins ≥ N per 1k views). |
| FR-007 | **Dashboard:** a **Promo** tab on the network agent page, listing pairs, recent promos, joins and outcome badges. Tracked links are listed with their counts. |

## Corner cases
- **Our bot is not an admin with invite rights in B** → the link cannot be created. The slot falls back to a public
  `t.me/<username>` link with `joins = unknown`, and the owner is told once.
- **The invite link is revoked manually** → joins stop. The link is marked `revoked` on the next check.
- **A private channel B** → only the invite link works. The `t.me` fallback is not available, and the promo is refused
  without bot rights.
- **The forward source post is deleted before the repost slot** → the slot is skipped with `source_missing`.
- **Mass joins from one link in minutes** (bots) → an anomaly flag in the digest. The evaluator excludes the spike from
  `worked`.
- **Privacy:** no user IDs in plain text; hashes are salted and rotated yearly; nothing is exposed in the UI except
  counts.

## Success criteria
- Unit tests:
  - link naming and creation with a fake Bot API;
  - the join counter from `chat_member` fixtures;
  - limits (pair cooldown, daily caps, ad proximity, relevance threshold, health);
  - repost and cross-promo slot creation from an applied directive;
  - the UTM builder and the redirect logger;
  - transitions KPI math.
- PG e2e with a scripted LLM: a manager `cross_promo` → owner approve → source orchestrator schedules → the executor
  publishes in shadow with the tracked link → simulated joins → the evaluator marks `worked`.
- Live eval: `manager-cross-promo-relevance`. An irrelevant pair is refused with a reason; a relevant pair leads to a
  directive with an `expected` value.
