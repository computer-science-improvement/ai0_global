# Agent Actions (SP2) — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/strategy-improvements`
**Builds on:** SP1 (Agent DM Inbox — read-only triage). See `2026-06-21-agent-dm-inbox-design.md`.

## Context

SP1 gave the agent a read-only DM inbox: it triages incoming DMs and drafts replies, but sends nothing. SP2 adds the **action layer** — the agent can now *act*, but only on the owner's explicit approval (the "propose → approve" autonomy decision from brainstorming). Two action types: **reply** to a DM (from the agent account) and **schedule a sponsored/ВП post** into a channel (via the existing `scheduled_posts` queue). The owner approves/edits/rejects every action; nothing is autonomous.

### Decisions (brainstorming)
1. **Both action types in SP2:** `reply` and `schedule_post`.
2. **Unified action queue** (`agent_actions`): every outward action is a row the owner approves/edits/rejects. Extensible to SP3/SP4.
3. **Approval surface = dashboard** (`/app/agent`, a "Pending actions" section). Editable before approval.
4. **Reply daily cap** (`AGENT_REPLY_DAILY_CAP`, default 20) to bound ban risk.

### Critical risk (carried from the audit + SP2 brainstorming)
SP1 was read-only, so there was no ban-from-writing surface. SP2 **introduces sending** from the agent MTProto account (a reply must come from the account that received the DM). Mitigations baked into the design:
- The SP1 **poller and `AgentMtprotoClient` stay read-only** (no send methods). A NEW, separate `AgentReplySender` is the *only* place that can send, and it is invoked *only* from the approve endpoint — never from the poller, never autonomously.
- The agent account is dedicated/isolated (`role='agent'`), so a ban there never touches publishing or tracking.
- Sends are human-approved, low-volume, and capped per day.

### Standing constraints
pnpm; automation tests from `apps/automation` via `npm test`; **no live external/AI/network in tests**; tokens/secrets never logged/returned; additive-only to existing flows; never auto-send/auto-publish without owner approval; single-instance deployment is fine. Work continues on `feat/strategy-improvements`; do not push/merge without an explicit ask.

## Goals / Non-goals

**Goals (SP2):**
- An `agent_actions` queue with two types (`reply`, `schedule_post`), statuses `pending → approved/done | rejected | failed`.
- Create a `reply` action from an inbox thread (the SP1 draft is the editable starting text).
- Create a `schedule_post` action (text + channel + time) — from a thread or manually.
- Approve → execute: `reply` sends via `AgentReplySender` (agent MTProto account); `schedule_post` inserts a row into the existing `scheduled_posts` queue (no new publishing code).
- Reject → mark rejected. All editable before approve.
- Daily reply cap; every send recorded.
- Dashboard "Pending actions" UI on `/app/agent`.

**Non-goals (SP2 — deferred):**
- Autonomous sending/scheduling without approval (never).
- Online payment for ad placements (SP3).
- Joining/reading admin/ВП chats (SP4).
- Multi-message conversations / back-and-forth threading beyond a single approved reply (a reply re-opens the thread for the next poll; further replies are new actions).

## Architecture

Extends `apps/automation/src/agent/`. The SP1 read-only path is untouched.

```
Inbox thread (SP1)  ──"Queue reply"/"Queue post"──►  agent_actions (status=pending)
                                                          │  owner edits + Approve (dashboard)
                                                          ▼
                                  ┌────────────── approve endpoint ──────────────┐
                          type=reply                                    type=schedule_post
                              ▼                                                ▼
                     AgentReplySender                               AgentScheduleExecutor
            (agent MTProto session, sendMessage)             (ScheduledPostsRepository.create)
                              ▼                                                ▼
                    status=done, stamp thread                     row in scheduled_posts (pending)
```

### Components

**1. Migration `database/migrations/039_agent_actions.sql`** — see Data model.

**2. `AgentActionsRepository`** (`agent-actions.repository.ts`)
- `create(input)`, `list(status?)`, `findById(id)`, `setStatus(id, status, patch?)` (patch sets `executed_at`/`error`), `countRepliesSince(date)` (for the daily cap).

**3. `AgentReplySender`** (`agent-reply-sender.service.ts`) — the ONLY sender.
- Connects with the active `role='agent'` session (decrypt via `SecretsService`), resolves the peer (`getEntity(peerId)` / username), and `client.sendMessage(entity, { message })`. Mirrors `AgentMtprotoClient`'s connect/FLOOD_WAIT/disconnect, but with a single `sendReply(peerId, peerUsername, text)` method. Returns `{ ok, error? }`; never throws out of the caller. NOT injected into the poller.

**4. `AgentScheduleExecutor`** (`agent-schedule.executor.ts`)
- `schedule(payload)` builds a minimal text `ComposedPost` (`channelId`, `sender:'bot'`, `text`, `scheduledAt`, no media/buttons) and calls the existing `ScheduledPostsRepository.create`. Returns the created post id.

**5. `AgentActionsService`** (`agent-actions.service.ts`) — orchestrates approve:
- `approve(id)`: load action; if `reply` → check daily cap, call `AgentReplySender.sendReply`, on success set action `done` + stamp the thread (`replied_at`, `sent_reply`), on failure set `failed` + error; if `schedule_post` → call `AgentScheduleExecutor.schedule`, set `done` + store the resulting `scheduled_post` id in payload. `reject(id)` → `rejected`.

**6. API (extends `AgentController`)** — all guarded by `TrackingAuthGuard`:
- `GET /api/agent/actions?status=` → list.
- `POST /api/agent/actions` `{ type, threadId?, payload }` → create pending (validated by DTO).
- `POST /api/agent/actions/:id/approve` → `service.approve`.
- `POST /api/agent/actions/:id/reject` → `service.reject`.

**7. Dashboard** — extend `/app/agent` + `api/agent.ts`:
- "Pending actions" `SectionCard`: card-rows per action — type Badge, target (peer / channel), editable payload (textarea for text; channel + datetime for schedule_post), **Approve** (primary) + **Reject** (danger) via `RowActions`.
- Inbox rows gain a "Queue reply" action (creates a `reply` action from the thread's draft) and "Queue post" (opens the schedule form prefilled).

## Data model

`database/migrations/039_agent_actions.sql`:
```sql
CREATE TABLE IF NOT EXISTS agent_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL CHECK (type IN ('reply','schedule_post')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','done','rejected','failed')),
  thread_id    UUID REFERENCES agent_dm_threads(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- reply: {text}; schedule_post: {text, channelId, scheduledAt, scheduledPostId?}
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions (status, created_at DESC);

ALTER TABLE agent_dm_threads
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_reply TEXT;
```
- The daily cap counts `agent_actions WHERE type='reply' AND status='done' AND executed_at > now()-interval '1 day'`.
- `payload` is free-form per type; validated by DTO on create and re-checked at approve.

## Data flow
1. Owner clicks "Queue reply" on an inbox thread → `POST /actions {type:'reply', threadId, payload:{text: <editable draft>}}` → pending row.
2. Owner reviews the "Pending actions" list, edits text/channel/time if needed (PATCH not required for MVP — edit happens in the create payload or a future edit endpoint; for MVP the create captures the final text and approve sends it as-is). Owner clicks **Approve**.
3. `approve`: `reply` → cap check → `AgentReplySender.sendReply(peerId, peerUsername, text)` → on ok: action `done`, thread `replied_at`/`sent_reply` set; `schedule_post` → `AgentScheduleExecutor.schedule` → `scheduled_posts` row created, action `done`.
4. Failures set `failed` + `error`, surfaced in the UI; owner can re-queue.

## Error handling / safety
- **Read-only poller preserved**: `AgentMtprotoClient` and `AgentInboxPoller` keep zero send methods. Only `AgentReplySender` sends, only from the approve path. A grep test (`sendMessage` only appears in `agent-reply-sender.service.ts`) guards this.
- **No autonomous action**: actions only execute via the owner-triggered approve endpoint.
- **Daily cap**: `approve` rejects a `reply` with a clear error when `countRepliesSince(24h) >= AGENT_REPLY_DAILY_CAP` (default 20).
- **Ban isolation**: sends use the `role='agent'` session only.
- **Idempotency**: approve is a no-op (returns the current state) if the action is not `pending` — prevents double-send on a double click.
- **Secrets**: agent session decrypted in memory only; never logged or returned. Action payloads contain message text only, never tokens.

## Testing (no live network/AI)
- `agent-actions.repository.test.ts` (fake pool): create/list/setStatus SQL + params; `countRepliesSince` query shape.
- `agent-actions.service.test.ts`: approve(reply) calls sender + marks done + stamps thread (stub sender/repo); approve over the daily cap → rejected with error, sender NOT called; approve(schedule_post) calls executor + stores scheduled id; reject → rejected; approve on a non-pending action is a no-op.
- `agent-reply-sender` — pure peer/text validation extracted to a helper if any; the network method itself is thin and untested (like `AgentMtprotoClient`).
- `agent.controller.test.ts` (extend): actions list/create/approve/reject routes call the service.
- Read-only guard test: assert no `sendMessage`/`sendFile` outside `agent-reply-sender.service.ts`.

## Env (documented in `.env.example`)
- `AGENT_REPLY_DAILY_CAP` (default 20).
- (`AGENT_ENABLED` from SP1 still gates the read poller; sending is gated by the explicit approve action, which is always owner-initiated.)

## Verification
- `cd apps/automation && npm run build && npm test` green incl. new SP2 tests.
- `grep -rn "sendMessage\|sendFile" apps/automation/src/agent/` returns ONLY `agent-reply-sender.service.ts`.
- Dashboard `pnpm --filter dashboard build` clean; `/app/agent` shows Pending actions with Approve/Reject (owner verifies live).
- No autonomous send: the poller has no path to `AgentReplySender`.

## Risks
- **Sending fingerprint**: bounded by dedicated account + human approval + daily cap; revisit cadence/cap if Telegram pushes back.
- **Peer resolution**: sending by numeric `peerId` may need `getEntity` first; prefer `peerUsername` when present. The sender returns a clear error if resolution fails (surfaced as a failed action).
- **scheduled_posts coupling**: the executor builds a minimal text post; richer media/buttons for sponsored posts are out of SP2 scope (text-only first).
