# Agent DM Inbox (SP1) — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/strategy-improvements` (continues there unless told otherwise)

## Context

ai0_global is an **owner-operated Ukrainian Telegram media network** (decision 2026-06-20: not a SaaS; single-instance is the supported deployment). The owner wants to **partially delegate network operations to an agent** driven by an MTProto account: triage incoming DMs (advertiser inquiries, mutual-promotion / "ВП" proposals), eventually draft replies, schedule sponsored/ВП posts, monitor admin/ВП chats, and score opportunities (where to advertise, when to do ВП, expected audience growth). Online payment for ad placements is a later goal.

This is a multi-subsystem vision, decomposed into sub-projects. **This spec covers only SP1.**

### Sub-project roadmap (context, not scope)
- **SP1 — Agent DM Inbox (this spec):** read-only. Agent reads incoming DMs on a dedicated account, classifies/summarizes/scores them and drafts (but never sends) replies, surfaced in a dashboard "Agent" area.
- **SP2 — Action tools behind approval:** send drafted replies + schedule sponsored/ВП posts, each requiring explicit owner approval.
- **SP3 — Payments:** hosted checkout (LiqPay/WayForPay/Stripe Checkout) + webhook marks an ad request paid. No raw card handling.
- **SP4 — Admin/ВП chat intel + more autonomy** where trust is established.

### Decisions locked in brainstorming
1. **Autonomy = "agent proposes → owner approves".** Nothing outward-facing happens without an explicit owner action. (SP1 is therefore fully read-only — there is nothing to send yet.)
2. **Dedicated MTProto account for the agent**, separate from the publishing and tracking/stats accounts (ban isolation: an agent ban must not take down publishing or tracking). The agent needs its own management surface.
3. **First input source = DM inbox** (direct monetization, lowest risk — no joining chats).
4. **DM reading = cron poll** (approach A), consistent with the codebase's cron-based design; not a live update listener.
5. **Management/review surface = dashboard** (a new "Agent" area), not Telegram.
6. **Categories:** `ad | vp | question | spam | other`.

### Standing constraints
pnpm only; automation tests run from `apps/automation` via `npm test` (node:test + tsx); **no live external/AI/network in tests**; tokens/secrets never logged, returned, or rendered; additive-only to existing flows; never auto-send/auto-publish; single-instance assumption is fine.

## Goals / Non-goals

**Goals (SP1):**
- A dedicated agent MTProto session, isolated from tracker/stats.
- Poll incoming DMs to that account on a conservative cadence, with FLOOD_WAIT backoff.
- For each new DM thread, one cheap Claude call producing: category, summary, extracted fields (channel/budget/dates when present), a draft reply, and a priority score.
- Persist results; surface them in a dashboard "Agent" area as card-rows with local-only actions (mark reviewed / archive) plus an enable/disable + cadence control.

**Non-goals (SP1 — explicitly deferred):**
- Sending any message / any outward action (SP2).
- Joining or reading admin/ВП chats (SP4).
- Scheduling posts from the agent (SP2).
- Payments (SP3).
- Autonomous decisions without owner review.

## Architecture

New NestJS feature module `apps/automation/src/agent/`. Reuses: `mtproto_sessions` infra + `SecretsService` (encrypted session), the existing tracking MTProto client patterns (connect, FLOOD_WAIT backoff), `ClaudeAgent` + `AiLoggerService` (triage), `RunTracer` is not required. Dashboard gets a new route under the existing `/app` shell.

```
Dedicated agent MTProto session (role='agent', encrypted)
        │  (cron, ~5 min)
        ▼
AgentInboxPoller ──fetch new incoming DMs since cursor──► AgentTriageService
        │                                                   │ 1 Claude (Haiku) call / new thread
        │                                                   ▼
        └───────────────────────────────► AgentInboxRepository (agent_dm_threads)
                                                            │
                                              GET /api/agent/inbox  +  PATCH status
                                                            ▼
                                        Dashboard  /app/agent  (inbox + agent settings)
```

### Components

**1. Migration `database/migrations/037_mtproto_session_role.sql`**
- `ALTER TABLE mtproto_sessions ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'tracker' CHECK (role IN ('tracker','agent'));`
- Existing rows default to `tracker` (unchanged behavior).
- The tracker/stats "first active session" selectors are scoped to `role='tracker'`; the agent selects `role='agent'`. This keeps the two roles from stealing each other's session.

**2. Migration `database/migrations/038_agent_dm_threads.sql`** — see Data model.

**3. `AgentMtprotoClient`** (`apps/automation/src/agent/agent-mtproto.client.ts`)
- Connects using the active `role='agent'` session (decrypted via `SecretsService`), mirroring the tracking client's connect + FLOOD_WAIT handling.
- `fetchNewIncoming(sinceCursor): Promise<RawDm[]>` — returns incoming user DMs newer than the cursor (peer id, peer username/name, message id, text, date). Bounded page size. No sending methods exist on this client (enforces read-only).

**4. `AgentTriageService`** (`apps/automation/src/agent/agent-triage.service.ts`)
- Pure prompt builder + `ClaudeAgent.chat` (Haiku, explicit `maxTokens`, JSON output). Returns `{ category, summary, fields: {channel?, budget?, dates?}, draftReply, score }`. Validates/parses defensively; on malformed output records the thread as `category='other'` with the raw note (never throws the poll).
- The prompt-building (`buildTriagePrompt`, `parseTriageResult`) lives in a pure helper file `agent-triage.helpers.ts` for unit testing without the live model.

**5. `AgentInboxRepository`** (`apps/automation/src/agent/agent-inbox.repository.ts`)
- `upsertThread(peer, lastMessage, triage)`, `list(filter)`, `setStatus(id, status)`, `getCursor()/setCursor()` (poll high-water mark per agent session).

**6. `AgentInboxPoller`** (`apps/automation/src/agent/agent-inbox.poller.ts`)
- `@Cron` (cadence from `AGENT_POLL_CRON`, default every 5 min). Gated by `AGENT_ENABLED` (default `false`) and by the presence of an active `role='agent'` session — otherwise it no-ops and logs once.
- Reads cursor → `fetchNewIncoming` → for each new thread runs triage → upserts → advances cursor. New-thread dedup by `(peer_id, last_message_id)`.

**7. API `AgentController`** (`apps/automation/src/agent/agent.controller.ts`, guarded by `TrackingAuthGuard`)
- `GET /api/agent/inbox?status=&category=` → threads (no secrets).
- `PATCH /api/agent/inbox/:id` `{ status }` → mark reviewed/archived.
- `GET /api/agent/status` → `{ enabled, hasAgentSession, lastPolledAt, cadence }`.

**8. Dashboard `/app/agent`** (`apps/dashboard/src/routes/app.agent.tsx` + `api/agent.ts`)
- Reuses the shared design system (PageHeader, SectionCard, Badge, card-rows, SegmentedTabs).
- **Inbox:** card-rows — peer (name/@username), a category Badge (`ad`=accent, `vp`=success, `question`=neutral, `spam`=warning, `other`=neutral), the summary, a score, and the draft reply shown read-only (collapsible). Row actions (icon-only, per CLAUDE.md): mark reviewed, archive. Filter tabs by category/status. **No "send" control in SP1.**
- **Agent settings panel:** which session is the agent (link to Connections → Sessions), enable/disable polling, cadence display; shows `hasAgentSession=false` guidance when no agent session exists.
- Add a sidebar nav entry "Agent".

## Data model

`database/migrations/038_agent_dm_threads.sql`:
```sql
CREATE TABLE IF NOT EXISTS agent_dm_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  peer_id          TEXT NOT NULL,                 -- tg user id of the sender
  peer_username    TEXT,
  peer_name        TEXT,
  last_message_id  BIGINT NOT NULL,               -- newest handled message id for this peer
  last_message_at  TIMESTAMPTZ NOT NULL,
  last_text        TEXT,                           -- newest message text (for context)
  category         TEXT NOT NULL DEFAULT 'other'   -- ad|vp|question|spam|other
                     CHECK (category IN ('ad','vp','question','spam','other')),
  summary          TEXT,
  fields           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {channel?, budget?, dates?}
  draft_reply      TEXT,
  score            INT NOT NULL DEFAULT 0,         -- 0..100 priority
  status           TEXT NOT NULL DEFAULT 'new'     -- new|reviewed|archived
                     CHECK (status IN ('new','reviewed','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (peer_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_dm_status   ON agent_dm_threads (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_dm_category ON agent_dm_threads (category);

CREATE TABLE IF NOT EXISTS agent_poll_cursor (
  session_id       UUID PRIMARY KEY,              -- the agent mtproto_sessions.id
  last_message_id  BIGINT NOT NULL DEFAULT 0,
  last_polled_at   TIMESTAMPTZ
);
```
- One row per peer (thread): re-triage on a newer message (upsert by `peer_id`).
- `last_text` is operational message content (not a secret); the session string/credentials remain encrypted in `mtproto_sessions` and are never copied here. No tokens or card data are ever stored here.
- `fields` is free-form extracted hints; never trusted as authoritative.

## Data flow
1. Cron fires (if `AGENT_ENABLED=true` and an active `role='agent'` session exists).
2. Poller loads `agent_poll_cursor` for that session.
3. `AgentMtprotoClient.fetchNewIncoming` returns incoming DMs with `message_id > cursor`.
4. Per new thread: `AgentTriageService.triage(text, peer)` → one Haiku call → parsed result.
5. `AgentInboxRepository.upsertThread` writes/updates the thread; cursor advances to the max message id seen.
6. Dashboard reads `GET /api/agent/inbox`; owner reviews/archives.

## Error handling / safety
- **Read-only**: `AgentMtprotoClient` exposes no send methods. SP1 cannot message anyone, so there is no auto-reply ban surface and no risk of a wrong message to a real client.
- **Ban isolation**: dedicated `role='agent'` session; publishing/tracking unaffected by an agent ban. Conservative cadence + FLOOD_WAIT backoff (reuse tracking patterns). Document agent account as a low-value, dedicated number.
- **Off by default**: `AGENT_ENABLED=false`; no agent session ⇒ poller no-ops. Turning the agent on is a deliberate step.
- **AI cost bounded**: one Haiku call per *new* thread only (cursor + per-peer dedup), explicit `maxTokens`; logged via `AiLoggerService` (subject to the retention prune already shipped).
- **Resilience**: a triage parse failure downgrades that thread to `category='other'` and never aborts the poll; a poll error logs and retries next tick.
- **Secrets**: session decrypted in-memory only; never logged or returned by the API. API projections expose only non-secret thread fields.

## Testing (no live network/AI)
- `agent-triage.helpers.test.ts`: prompt builder shape; `parseTriageResult` handles valid JSON, code-fenced JSON, and malformed → `other`; category/score clamping.
- `agent-inbox.repository.test.ts` (fake pool): upsert-by-peer SQL + params; status filter; cursor get/set.
- `agent-inbox.poller.test.ts`: stubbed MTProto client + stubbed triage + fake repo — asserts new-message cursor advance, per-peer dedup, no-op when disabled / no agent session.
- `agent.controller.test.ts`: list/patch shape; status validation.
- Reuse the `TrackingAuthGuard` (already tested) on the controller.

## Env (documented in `.env.example`)
- `AGENT_ENABLED` (default `false`) — master switch for the poller.
- `AGENT_POLL_CRON` (default `*/5 * * * *`).
- `AGENT_TRIAGE_MODEL` (default the Claude Haiku id), `AGENT_TRIAGE_MAX_TOKENS` (default ~800).

## Verification
- `cd apps/automation && npm run build && npm test` green incl. new agent tests.
- Dashboard `pnpm --filter dashboard build` clean; `/app/agent` renders inbox + settings (login-gated — owner verifies live).
- Read-only proof: grep confirms `AgentMtprotoClient` has no `sendMessage`/`sendFile`.
- With `AGENT_ENABLED=false` (default), no polling occurs.

## Risks
- **MTProto DM reading is still automated reads** on a user account — lower risk than scraping/joining, but keep cadence conservative; if Telegram tightens, the agent account (not publishing) is what's exposed.
- **Triage quality**: the owner reviews everything; the score/category are advisory. Misclassification is low-cost in read-only mode.
- **Cursor correctness**: a bug could re-triage or skip threads; per-peer upsert + max-id cursor make re-triage idempotent and skipping recoverable on the next message.
