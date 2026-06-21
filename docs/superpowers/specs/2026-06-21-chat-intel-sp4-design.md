# Chat Intel (SP4) — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/strategy-improvements`
**Builds on:** SP1 (DM inbox, read-only MTProto client) + SP2 (actions) + SP3 (payments). Roadmap step 4.

## Context

The owner wants the agent to watch the admin / ВП / marketplace group chats the account already sits in, detect monetization/collaboration opportunities (ad offers, mutual-promotion "ВП" requests, pricing posts), and score where it's worth advertising or doing ВП. SP4 is the **read-only intelligence layer**: it produces an **opportunities feed**; any outward action still goes through SP2 (reply) or SP3 (ad order), owner-approved.

### Decisions (brainstorming)
1. **No auto-join.** The agent monitors ONLY chats the account is ALREADY a member of (the owner joins manually). There is no join capability — this avoids the auto-join "spam fingerprint" (the audit's #1 ban risk).
2. **Allow-list:** the owner explicitly enables monitoring per chat (not all joined chats automatically).
3. **Read-only feed:** SP4 surfaces opportunities; it never sends. Acting on an opportunity uses SP2/SP3.
4. **Cheap pre-filter before AI:** a message must pass a keyword/price heuristic before any Claude call — bounds AI cost on busy chats.

### Critical risk (carried from the audit)
Bulk reading on an MTProto user account is the top ban risk. Mitigations: dedicated `role='agent'` account (isolated from publishing/tracking); **no join method exists**; conservative cadence (rarer than the DM poller) + FLOOD_WAIT backoff; a hard cap on monitored chats (`AGENT_CHAT_MAX`); the whole poller is **off by default** (`AGENT_CHAT_ENABLED`).

### Standing constraints
pnpm; automation tests from `apps/automation` via `npm test`; **no live external/AI/network in tests**; tokens/secrets never logged/returned; additive-only; read-only (no send in this feature); single-instance fine; do not push/merge without an explicit ask.

## Goals / Non-goals

**Goals (SP4):**
- List the agent account's already-joined GROUP chats (for the allow-list UI). No join.
- An allow-list (`agent_monitored_chats`) the owner toggles per chat.
- A gated cron poller that, per enabled chat, reads new messages since a per-chat cursor, runs each through a cheap pure pre-filter, and only sends CANDIDATES to one cheap Claude classification → stores `agent_opportunities`.
- Classification: `kind ∈ {ad_offer, vp_request, pricing, other}`, summary, score, `suggestedAction ∈ {advertise, do_vp, skip}`.
- Dashboard "Chat intel": monitored-chats manager + opportunities feed (review/archive).

**Non-goals (SP4 — deferred/forbidden):**
- Auto-joining chats (forbidden).
- Sending/replying in chats (forbidden here; SP2 only, owner-approved).
- Autonomous acting on opportunities (owner reviews; acting goes through SP2/SP3).
- Full message archival — only candidate messages that become opportunities are stored.

## Architecture

Extends `apps/automation/src/agent/`. Reuses the SP1 read-only `AgentMtprotoClient` (adds two READ methods: `listGroups`, `fetchChatMessages`), the SP1 triage-style pure-helper pattern, and the dashboard `/app/agent` page.

```
Agent account's joined groups ──listGroups──► dashboard allow-list (owner toggles monitor)
                                                        │
AgentChatPoller (@Cron, gated, rare)                    ▼
  for each enabled chat: fetchChatMessages(chatId, > lastId)
     → isOpportunityCandidate(text)  [pure pre-filter; most messages dropped here]
        → candidates only → AgentTriage-style classify (1 cheap Claude call)
           → agent_opportunities (kind, summary, score, suggestedAction, status='new')
     → advance per-chat cursor
                                                        │
                                  dashboard /app/agent "Chat intel" feed (review/archive)
                                  acting → SP2 reply / SP3 ad order (owner-approved)
```

### Components

**1. Migration `database/migrations/041_agent_chat_intel.sql`** — see Data model.

**2. Pure helpers** `apps/automation/src/agent/chat-intel.helpers.ts`:
- `isOpportunityCandidate(text): boolean` — lowercase keyword/price heuristic (e.g. contains «реклам», «вп», «взаємн», «прайс», «розміщенн», «бартер», a price like `\d+\s?(грн|uah|\$|₴)`), so most chatter is dropped before any AI spend.
- `buildOpportunityPrompt(text): { system, user }` and `parseOpportunity(raw): Opportunity` (kind/summary/score/suggestedAction, fallback `other`/0/skip), mirroring SP1's triage helpers.

**3. `AgentMtprotoClient` (extend, still read-only)** — add:
- `listGroups(limit?)`: returns joined group/megagroup dialogs `{ chatId, title, isMonitorable }` (filters `d.isGroup || d.isChannel`, excludes DMs). No join.
- `fetchChatMessages(chatId, minId, limit?)`: `Api.messages.GetHistory` since `minId`, returns `{ messageId, text, date }[]`. Read-only. (Still NO send methods.)

**4. Repositories:**
- `AgentMonitoredChatsRepository` (`agent-monitored-chats.repository.ts`): `upsert(chatId, title)`, `list()`, `setEnabled(chatId, enabled)`, `enabled()` (the ones to poll), `lastMessageId(chatId)`, `setLastMessageId(chatId, id)`, `countEnabled()`.
- `AgentOpportunitiesRepository` (`agent-opportunities.repository.ts`): `upsert(chatId, msg, classification)` (dedup by `(chat_id, message_id)`), `list({status?, kind?})`, `setStatus(id, status)`.

**5. `AgentChatClassifier`** (`agent-chat-classifier.service.ts`) — thin wrapper over `ClaudeAgent` using the SP4 helpers (bounded `maxTokens`), like SP1's `AgentTriageService`.

**6. `AgentChatPoller`** (`agent-chat.poller.ts`) — `@Cron(AGENT_CHAT_POLL_CRON)`, gated by `AGENT_CHAT_ENABLED` + an active `role='agent'` session. For each enabled monitored chat (respecting `AGENT_CHAT_MAX`): fetch new messages since cursor → `isOpportunityCandidate` filter → classify candidates → `upsert` opportunities → advance cursor.

**7. API (extends `AgentController`)** — guarded:
- `GET /api/agent/chats` → joined groups merged with monitored flags.
- `POST /api/agent/chats/:chatId/monitor` `{ enabled }` (validates a title is captured via upsert).
- `GET /api/agent/opportunities?status=&kind=`.
- `PATCH /api/agent/opportunities/:id` `{ status }`.

**8. Dashboard** — extend `/app/agent` + `api/agent.ts`:
- "Chat intel" section: a **monitored-chats** manager (list joined groups, toggle monitor) and an **opportunities feed** (card-rows: kind Badge — `ad_offer`=accent, `vp_request`=success, `pricing`=neutral, `other`=neutral; summary; score; chat title; suggestedAction; review/archive actions). No send/act buttons here — acting is via the Agent inbox (SP2) / Ads (SP3).

## Data model

`database/migrations/041_agent_chat_intel.sql`:
```sql
CREATE TABLE IF NOT EXISTS agent_monitored_chats (
  chat_id          TEXT PRIMARY KEY,
  title            TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  last_message_id  BIGINT NOT NULL DEFAULT 0,
  last_polled_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_opportunities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          TEXT NOT NULL,
  chat_title       TEXT,
  message_id       BIGINT NOT NULL,
  message_text     TEXT,
  kind             TEXT NOT NULL DEFAULT 'other'
                     CHECK (kind IN ('ad_offer','vp_request','pricing','other')),
  summary          TEXT,
  score            INT NOT NULL DEFAULT 0,
  suggested_action TEXT NOT NULL DEFAULT 'skip'
                     CHECK (suggested_action IN ('advertise','do_vp','skip')),
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','reviewed','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_opps_status ON agent_opportunities (status, score DESC, created_at DESC);
```
- Only candidate messages that classify become rows; `UNIQUE(chat_id, message_id)` + cursor makes re-polling idempotent. `message_text` is operational content (not a secret).

## Data flow
1. Owner opens "Chat intel" → `GET /chats` lists joined groups → toggles monitor (`POST /chats/:id/monitor` upserts + enables).
2. Cron (if `AGENT_CHAT_ENABLED=true` + agent session): for each enabled chat, fetch messages `> last_message_id`.
3. Each message → `isOpportunityCandidate`? If not, skip (no AI). If yes → classify → `upsert` opportunity.
4. Advance `last_message_id`; stamp `last_polled_at`.
5. Owner reviews the feed; acts via SP2 (reply) or SP3 (ad order). Review/archive updates status.

## Error handling / safety
- **Read-only**: the chat client has only read methods; the SP2 read-only grep guard extends to SP4 — `sendMessage`/`sendFile` still appear ONLY in `agent-reply-sender.service.ts`.
- **No join**: there is no join/import-invite method anywhere in the agent module.
- **Cost bound**: `isOpportunityCandidate` drops the vast majority of messages before any Claude call; one bounded call per candidate; cursor + `UNIQUE` dedup prevent re-classifying.
- **Off by default**: `AGENT_CHAT_ENABLED=false`; no enabled chats / no agent session ⇒ poller no-ops. `AGENT_CHAT_MAX` caps how many chats are polled.
- **Cadence**: rarer than the DM poller; FLOOD_WAIT backoff (returns [] and backs off, like the DM client).
- **Secrets**: agent session decrypted in memory only; never logged/returned.

## Testing (no live network/AI)
- `chat-intel.helpers.test.ts`: `isOpportunityCandidate` true for ad/ВП/price texts, false for chatter; `parseOpportunity` valid/garbage/clamp/unknown-kind.
- `agent-monitored-chats.repository.test.ts` + `agent-opportunities.repository.test.ts` (fake pool): upsert/list/setEnabled/cursor; opportunity upsert dedup by (chat_id,message_id); status filter.
- `agent-chat.poller.test.ts`: stub client/classifier/repos — no-op when disabled / no enabled chats; pre-filter drops non-candidates (classifier NOT called); candidates classified + upserted; cursor advances; respects `AGENT_CHAT_MAX`.
- `agent.controller.test.ts` (extend): chats list/monitor + opportunities list/patch routes.
- Read-only guard test still passes (no new sender).

## Env (documented in `.env.example`)
- `AGENT_CHAT_ENABLED` (default `false`).
- `AGENT_CHAT_POLL_CRON` (default `*/15 * * * *`).
- `AGENT_CHAT_MAX` (default 20) — max monitored chats polled per tick.
- Reuses `AGENT_TRIAGE_MODEL` / `AGENT_TRIAGE_MAX_TOKENS`.

## Verification
- `cd apps/automation && npm run build && npm test` green incl. SP4 tests.
- `grep -rn "sendMessage\|sendFile" apps/automation/src/agent/` still returns ONLY `agent-reply-sender.service.ts`.
- No join method: `grep -rni "joinchannel\|importchatinvite\|joinChat" apps/automation/src/agent/` returns nothing.
- Dashboard `pnpm --filter dashboard build` clean; "Chat intel" shows joined chats + opportunities (owner verifies live).
- Off by default: `AGENT_CHAT_ENABLED=false`.

## Risks
- **Even read-only group polling adds MTProto read volume** on the agent account — bounded by allow-list + cap + rare cadence + dedicated account; revisit if Telegram pushes back.
- **Classification precision**: advisory only; the owner reviews. Pre-filter may miss creatively-worded offers — acceptable (false negatives are cheap; we can widen keywords later).
- **getHistory pagination**: SP4 reads only new messages since the cursor with a bounded page; a very active chat between polls could exceed one page — fetch the most recent page and advance; older missed candidates are acceptable for an opportunities feed (not an archive).
