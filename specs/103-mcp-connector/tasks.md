# Spec 103 — tasks

Branch: `feat/mcp-connector`, cut from `feat/editor-agent` at 125eba1c. Migration 105. PG test DB prefixes: `p103a_`, `p103b_`, `p103c_`.

## T0 — Foundation (lead, one commit)

- Migration `105_mcp_connector.sql` plus its down file.
- Slot fields `createdVia`, `lockedBy`, `lockedAt` in `EditorSlot` / `rowToSlot`.
- `src/editor/repo/slot-lock.ts`: SQL fragments, the `isLocked` helper and the skip-prefix constants.
- `McpTool` gains `title` and `annotations`; `McpServer` gains `instructions` and protocol 2025-11-25.
- `src/connector/` skeleton:
  - `connector.module.ts` and `types.ts` (contracts below);
  - the `CONNECTOR_TOOLS` token;
  - registration in `AppModule`.
- `EditorModule` exports the service tokens the connector needs.
- Catalog settings `MCP_CONNECTOR` and `MCP_PUBLIC_URL` in group `connectors`.
- Placeholder controller `src/editor/lock/slot-lock.controller.ts`, registered.

## Contracts shared by the work packages

```ts
// src/connector/types.ts
export type ConnectorScope = 'mcp:read' | 'mcp:write';
export interface ConnectorPrincipal { grantId: string; clientId: string; clientName: string; scopes: ReadonlySet<ConnectorScope> }
export interface ConnectorTool extends McpTool { scope: ConnectorScope }
/** WP-C implements it; WP-A calls it per request. */
export interface ConnectorToolsFactory { tools(p: ConnectorPrincipal): Promise<ConnectorTool[]> }
export const CONNECTOR_TOOLS = 'CONNECTOR_TOOLS';
export interface ConnectorUrls { origin: string; resource: string; issuer: string; prm: string }
```

The Settings → Connectors admin API (WP-A serves it, WP-D calls it). Every route is under `TrackingAuthGuard`.

| Route | Response |
|---|---|
| `GET /api/connector/status` | `{enabled, configured, url, issuer, httpsOk, reason}` |
| `GET /api/connector/clients` | `{clients:[{id, clientId, kind, name, redirectHosts, createdAt, lastUsedAt, activeGrants}]}` |
| `DELETE /api/connector/clients/:id` | `{ok, revoked}` |
| `GET /api/connector/grants` | `{grants:[{id, clientId, clientName, scopes, createdAt, lastUsedAt, lastIp, expiresAt}]}` |
| `DELETE /api/connector/grants/:id` | `{ok}` |
| `POST /api/connector/grants/revoke-all` | `{ok, revoked}` |
| `GET /api/connector/activity?limit=50` | `{items:[{id, at, event, tool, clientName, ok, error, durationMs, summary}]}` |

The consent API (WP-A serves it, WP-D calls it):
- `GET /api/oauth/requests/:id` returns `{id, client:{clientId, name, kind, redirectHost, loopback}, scopes:[{scope, label}], expiresAt}`. A request that is unknown, expired or already decided gets 404 or 410 with `{error}`.
- `POST /api/oauth/requests/:id/decision {decision, scopes?}` returns `{redirect}`.

Slot lock: `POST /api/editor/slots/:id/unlock` returns `{slot}` (WP-B). The slot JSON carries `createdVia`, `lockedBy` and `lockedAt` (T0).

## WP-A — OAuth, transport, admin API (backend)

Files it owns:
- `src/connector/oauth/**`, `src/connector/http/**`, `src/connector/admin/**`, `src/connector/audit/**`;
- `src/main.ts` (a 1 MB JSON parser for `/api/mcp`);
- `apps/dashboard/nginx.conf`, `apps/dashboard/vite.config.ts`.

Tasks:
- **A1** Discovery documents (§5 A1).
- **A2** CIMD resolver (allowlist, fetch + pinned copy) and DCR register with its limits.
- **A3** Authorize.
- **A4** Consent API.
- **A5** Token (code, refresh rotation, reuse handling).
- **A6** Revoke.
- **A7** Hashed token store: an `OAuthStore` interface with a PG implementation and an in-memory one.
- **B1–B4** `/api/mcp` controller: auth gate with `WWW-Authenticate`, Origin and protocol checks, stateless `McpServer` per request, scope-filtered tools, audit wrapper, per-grant rate limit, 405 for GET and DELETE.
- Admin API.
- nginx and vite.

Tests:
- unit tests for every OAuth rule (PKCE, redirect matching, scope, resource, code reuse, refresh rotation, grace reuse, family revoke, DCR limits, CIMD validation);
- an in-process HTTP e2e of the whole dance: discovery → register or CIMD → authorize → consent → token → `tools/list` → refresh → revoke, with a fake tools factory;
- a PG test of the store.

## WP-B — the lock (§8)

Files it owns: the writers in §8 rows 1–12 and their tests, `src/editor/lock/**`, and `src/editor/silent/skip-reasons.ts`.

Tasks:
- **B1–B12** One change per row in §8.
- **B13** The unlock endpoint and repository method.
- **B14** A PG test for every row 1–14, plus the "cannot reach" assertions. Files: `src/editor/lock/slot-lock.103.pg.test.ts` and others, all style A, prefix `p103b_`.

## WP-C — tools (§7)

Files it owns:
- `src/connector/tools/**`, `src/connector/posts/**`, `src/connector/queries/**`, `src/connector/chat/**`;
- in `src/editor/api/editor-ops.service.ts`, `replan(…, {instruction})`;
- in `src/editor/chat/editor-chat.service.ts` and `src/editor/repo/editor-chat.repository.ts`, `SendOptions.via` (connector: `userIntent=false` on every turn) and `createChat({createdVia})`.

Tasks:
- **C1** Read tools.
- **C2** `prepare_post`, `plan_post`, `update_post`, `cancel_post`, `approve_post`, `reject_post`.
- **C3** `replan_channel` with the instruction.
- **C4** `talk_to_agent` and `read_agent_chat` (background turn with a bounded wait).
- **C5** `apply_card` / `discard_card` with the allowlist.
- **C6** Make the `CONNECTOR_TOOLS` provider real.

Tests:
- unit tests per tool with fakes;
- a PG e2e (`p103c_`): `prepare_post` → replan → the post stays → the approval publisher sends the stored render (fake publisher) at its time; `plan_post` → replan keeps it → the executor (FakeLlm) writes it; `talk_to_agent` with a scripted LLM cannot publish.

## WP-D — dashboard (§9)

Files it owns: `apps/dashboard/src/**`.

Tasks:
- **D1** Settings → Connectors tab plus `api/connectors.ts`, a nav entry and the registry tests.
- **D2** Consent route `/app/oauth/consent`.
- **D3** Badges and Unlock: `lib/slot-origin.ts` with a test, then SlotPlan, EditorUi, the slot page, AgentPlan, ApprovalCard, the calendar tip, and the chat list badge.
- **D4** Regenerate `routeTree.gen.ts`.

Checks: `tsc`, tests, `vite build`.

## T9 — Integration (lead)

- Merge the work packages.
- Wire `editor.module.ts` and `connector.module.ts`.
- Update the runbook `docs/runbooks/mcp-connector.md`, the specs README row, and the skill `operate-ai0-network` (a remote section).
- Run the full checks on Node 26 (CI) and Node 20.19.6: lint, tsc, `nest build`, unit tests, the PG suite on a scratch cluster, and the dashboard tsc, tests and build.
- Run an adversarial review of auth and the lock.

## Deltas

(filled during implementation)
