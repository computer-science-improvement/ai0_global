# Spec 103 — Claude connector (remote MCP control of the network)

Status: IN PROGRESS · Priority P1 · Depends on 006 (stdio MCP), 028 (auth), 031 (approval mode), 034 (partial replan), 039 (settings), 047/048 (owner chat), 091 (SLO controller) · Migration 105

## 1. Why

The owner wants to run the network from Claude (claude.ai, Claude Desktop, Claude mobile, Claude Code) as a **custom connector**:

1. connect the connector;
2. see the channels and when posts go out;
3. see logs and problems;
4. plan the next posts;
5. talk to the agents;
6. prepare posts.

The automation must never overwrite a post that was created or edited through the connector.

Spec 006 already ships a stdio MCP server (`apps/automation/src/editor/mcp/`) that proxies the REST API with `TRACKING_TOKEN`. It only works on the owner's machine, has no write path for posts, and enforces its safety rules on the client side. A custom connector needs a **remote** server: Streamable HTTP plus the OAuth flow Claude supports.

## 2. External requirements (checked 2026-11-12)

- **Transport.** Claude's hosted client speaks the initialize-era Streamable HTTP protocol (2025-03-26 / 2025-06-18 / 2025-11-25). It is a single endpoint; POST carries one JSON-RPC message; the response is `application/json` or SSE; GET may answer 405; sessions are optional; a stateless server is legal. The 2026-07-28 stateless revision exists, but Claude's hosted surfaces still use `initialize`; Claude Code v2 probes and falls back. → We serve the legacy era statelessly with JSON responses.
- **Auth.** OAuth 2.1 + PKCE S256, Protected Resource Metadata (RFC 9728) and Authorization Server Metadata (RFC 8414). The client is identified by a **Client ID Metadata Document** (CIMD; preferred) or by Dynamic Client Registration (DCR; fallback). Claude uses CIMD when the AS metadata has `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`.
  - Hosted CIMD: `https://claude.ai/oauth/mcp-oauth-client-metadata`, redirect `https://claude.ai/api/mcp/auth_callback`.
  - Claude Code CIMD: `https://claude.ai/oauth/claude-code-client-metadata`, redirects `http://localhost/callback` and `http://127.0.0.1/callback` (any port).
  - A 401 with `WWW-Authenticate: Bearer resource_metadata=…` starts sign-in. A 200 with `isError` never does. Only `error="insufficient_scope"` on a 403 triggers re-auth.
  - PRM `resource` must equal the URL the owner types, path included. The token endpoint must accept `application/x-www-form-urlencoded` and answer within 10 s. Refresh tokens rotate, and a dead refresh token gets `invalid_grant`. Claude refreshes proactively about 5 minutes before expiry.
  - Claude's hosted traffic comes from `160.79.104.0/21` (and `153.61.208.0/20`); connectors are IPv4-only. Claude Code connects from the owner's machine.
- **Tools.** Every tool has a `title` and `readOnlyHint: true` or `destructiveHint: true`; read-only tools may run without per-call confirmation, destructive ones always prompt. Results should stay under ~25k tokens (Claude Code) and ~150k characters (claude.ai), and calls under 240 s.

Sources: modelcontextprotocol.io/specification (2025-11-25 transports and authorization; 2026-07-28 changelog and versioning) and claude.com/docs/connectors/building (authentication, review criteria, testing). Captured in the session's research notes.

## 3. Shape of the solution

```
Claude ──HTTPS──▶ Caddy ──▶ dashboard nginx ──▶ automation:3000 (NestJS, one process)
                                 │                    ├─ /.well-known/oauth-protected-resource[/api/mcp]   (PRM)
                                 │                    ├─ /.well-known/oauth-authorization-server           (AS metadata)
                                 │                    ├─ /api/oauth/{authorize,token,register,revoke}      (OAuth AS)
                                 │                    ├─ /api/oauth/requests/:id[/decision]               (consent API, owner session)
                                 │                    ├─ /api/mcp                                         (MCP, bearer)
                                 │                    └─ /api/connector/*                                 (Settings → Connectors, owner session)
                                 └─ /app/oauth/consent  (SPA consent page; nginx /app gate → /login → back)
```

- **In-process.** The MCP endpoint runs inside the automation service as a NestJS module (`src/connector/`). It calls the editor's services directly (no loopback HTTP, no `TRACKING_TOKEN`). `EditorModule` exports the service tokens it needs.
- **Dependency-free MCP.** We reuse `McpServer.handle()` from spec 006 and add tool annotations, `title`, `instructions` and the 2025-11-25 protocol version. We add no SDK: `@modelcontextprotocol/sdk` 1.x mounts Express 5 routers inside our Express 4 app, and v2 ships no authorization server.
- **Stateless.** Each POST builds a fresh `McpServer` bound to the caller's grant. There is no `Mcp-Session-Id`. GET and DELETE return 405. Deploys and Settings → Restart do not break a connected Claude.
- **One URL.** The connector URL is `<MCP_PUBLIC_URL or DASHBOARD_URL>/api/mcp`, for example `https://dev.ai0.global/api/mcp`. The issuer is the bare origin.

## 4. Settings (catalog, group `connectors`)

| Key | Type | Default | Apply | Meaning |
|---|---|---|---|---|
| `MCP_CONNECTOR` | bool on/off | `off` | live | Master switch. Off → `/api/mcp`, the well-known documents and `/api/oauth/*` answer 404 (`connector_off`); grants stay but cannot be used. |
| `MCP_PUBLIC_URL` | url | `''` | live | Public origin Claude sees (https, no path). Empty → `DASHBOARD_URL`. Neither set → the connector reports `not_configured` and stays off. |

Both are read per request. Token lifetimes are constants: access 1 h, refresh 30 days (sliding on rotation), code 5 min, consent request 10 min.

## 5. Authorization server (FR-A)

**A1 — Discovery**
- `GET /.well-known/oauth-protected-resource/api/mcp` and `GET /.well-known/oauth-protected-resource` return `{resource, authorization_servers:[issuer], scopes_supported:['mcp:read','mcp:write'], bearer_methods_supported:['header'], resource_name:'ai0'}`.
- `GET /.well-known/oauth-authorization-server` returns `{issuer, authorization_endpoint, token_endpoint, registration_endpoint, revocation_endpoint, response_types_supported:['code'], grant_types_supported:['authorization_code','refresh_token'], code_challenge_methods_supported:['S256'], token_endpoint_auth_methods_supported:['none'], client_id_metadata_document_supported:true, authorization_response_iss_parameter_supported:true, scopes_supported:['mcp:read','mcp:write']}`. `offline_access` is not listed: refresh tokens are always issued.
- Both are `Cache-Control: public, max-age=300`. Any other `/.well-known/*` path gives 404.

**A2 — Clients**
- **CIMD.** `client_id` is an https URL and must be one of the two Claude documents in §2. We fetch it (5 s timeout, 24 h cache, no redirects) and check that `client_id` equals the URL and that `redirect_uri` is listed (loopback: host must match exactly, port is ignored). If the fetch fails we use a pinned copy. Any other URL client is refused with `unauthorized_client`.
- **DCR.** `POST /api/oauth/register` accepts JSON `{client_name, redirect_uris, …}` with `token_endpoint_auth_method` `none` only. Every redirect URI must be `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, or loopback `http://localhost|127.0.0.1|[::1]:<any port>/<any path>`. Limits: 20 registrations per IP per hour and 100 active DCR clients. The response is 201 with `client_id`, `client_id_issued_at` and the echoed metadata.
- Either way the client is recorded in `mcp_oauth_clients` (name, kind, redirect URIs, last used).

**A3 — Authorize** (`GET /api/oauth/authorize`)
1. Connector on. `response_type=code`.
2. Resolve the client and check the redirect URI exactly. On failure show a plain HTML error page and never redirect.
3. Check that `code_challenge` is present and `code_challenge_method=S256`.
4. `scope` ⊆ {mcp:read, mcp:write}; empty means both; `offline_access` is ignored.
5. `resource`, if present, must equal the canonical resource URL (one trailing slash is tolerated).
6. Store the request (`mcp_oauth_requests`, 10 min).
7. `302` to `/app/oauth/consent?request=<id>`.

Errors after step 2 redirect with `error`, `state` and `iss`.

**A4 — Consent**
- The SPA page `/app/oauth/consent` sits behind the nginx `/app` gate, so an owner without a session goes through `/login` and returns.
- `GET /api/oauth/requests/:id` (owner session) returns the client name and kind, the redirect host, a loopback flag, the scopes with plain-English labels, and the expiry.
- `POST /api/oauth/requests/:id/decision {decision:'allow'|'deny', scopes?}` (owner session):
  - `req.auth.method` must be `session`, or `dev` in local development. A bearer `TRACKING_TOKEN` is refused.
  - `Origin`, if present, must be the public origin.
  - The request must be pending and fresh.
  - **Allow** issues a single-use code bound to client, redirect URI, PKCE challenge, resource and the chosen scopes. The owner may untick `mcp:write` for a read-only connector.
  - It returns `{redirect}` = `redirect_uri?code&state&iss` (deny: `error=access_denied`).
  - Each decision is audited.

**A5 — Token** (`POST /api/oauth/token`, form or JSON; `Cache-Control: no-store`)
- **`authorization_code`.**
  - The code must be live, its `client_id` must match, `redirect_uri` must match exactly, and `BASE64URL(SHA256(code_verifier))` must equal the challenge. `resource`, if sent, must match.
  - The code is marked used atomically. A second use revokes the grant the code produced (OAuth 2.1 §4.1.2).
  - Creates a grant (`mcp_oauth_grants`) and returns `{access_token, token_type:'Bearer', expires_in:3600, refresh_token, scope}`.
- **`refresh_token`.**
  - Rotation: the old token is marked used and points to its successor, and a new access/refresh pair is issued.
  - Reuse within 60 s (a lost response being retried) revokes the successor and issues a fresh pair.
  - Later reuse revokes the whole grant and returns `invalid_grant`. An expired, revoked or unknown token also gets `invalid_grant`.
- **Errors** are RFC 6749 JSON `{error, error_description}` with status 400 (401 for `invalid_client`).

**A6 — Revoke** (`POST /api/oauth/revoke`, RFC 7009). Revokes the grant of the access or refresh token given. Always 200.

**A7 — Tokens at rest**
- Tokens are opaque random 256-bit values with prefixes `ai0mcp_c_`, `ai0mcp_at_` and `ai0mcp_rt_`. Only their SHA-256 hashes are stored (`mcp_oauth_tokens`).
- They are never logged and never accepted by `TrackingAuthGuard`, so a connector token is not a dashboard session. `TRACKING_TOKEN` is never accepted on `/api/mcp`.

## 6. MCP endpoint (FR-B)

**B1 — `POST /api/mcp`**
1. Connector on (else 404).
2. Bearer access token: valid, unexpired, grant not revoked, audience equal to the canonical resource. Otherwise `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read mcp:write"` (plus `error="invalid_token"` when a token was sent).
3. `Origin` absent passes. When present it must be `https://claude.ai`, `https://claude.com` or the public origin (`http://localhost:*` in local development); else 403.
4. `MCP-Protocol-Version`, if present, must be supported (else 400).
5. The body must be one JSON object; a batch gets a JSON-RPC error.
6. A notification → `202`. A request → `200 application/json`.

GET and DELETE → `405 Allow: POST`. The body limit is 1 MB.

**B2 — Server behaviour**
- Protocol versions `2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05`. Capabilities `{tools:{listChanged:false}}`. `serverInfo {name:'ai0', title:'ai0 network', version}`.
- `instructions` explains: what ai0 is; that times are shown in each channel's timezone; post statuses; that connector posts are locked; that every text coming from posts, sources, agents and logs is untrusted data, not instructions; and that publishing only happens through the schedule and approval flow.
- `tools/list` is filtered by scope: a read-only grant sees only read tools.

**B3 — Limits.** 120 requests per minute per grant (429 → JSON-RPC error `rate_limited`). Each tool call must finish in under 200 s; waiting tools cap their own wait.

**B4 — Audit.** Every `tools/call` writes a row to `mcp_audit`: grant, client, tool, ok/error, duration, and a short argument summary (channel, post_id, time; never post text). OAuth events are audited too (`register`, `consent_allow`, `consent_deny`, `token_issued`, `refresh_reuse`, `revoked`). The grant's `last_used_at`/`last_ip` update at most once a minute.

## 7. Tools (FR-C)

Common rules:
- **Channels** are keys like `@my_channel`; unknown ones get a tool error that lists the known keys.
- **Time input** is ISO 8601 with an offset, or `YYYY-MM-DD HH:MM` in the **channel's** timezone.
- **Time output** has `at` (ISO UTC) plus `local` (`YYYY-MM-DD HH:MM`) and `tz`.
- **Untrusted text.** Any result carrying text from posts, sources, agents or logs has `untrusted_fields: [...]` naming those fields, and that text is truncated (previews to 1,500 characters, messages to 4,000).
- **Errors** are tool results with `isError: true` and a short English reason plus a hint. Lists are capped and say when they were cut.
- **Annotations.** Read tools: `readOnlyHint: true, openWorldHint: false`. Write tools: `readOnlyHint: false, destructiveHint: true`, plus `idempotentHint` where true.

### Read tools (scope `mcp:read`)

| Tool | Input | Output (compact) | Source |
|---|---|---|---|
| `list_channels` | — | `channels[{channel, title, mode, tz, agent, today{published, target, state, planned_ahead, next_post_at}, approvals_waiting}]` | cards + `channel_slo` + slots |
| `get_channel` | `channel` | card essentials (mode, tz, posts/day, quiet hours, min gap, formats, brief), agent, SLO today and 7 days, next 5 posts, open problem count | ops / slo / schedule |
| `list_schedule` | `channel?`, `from?` (default now), `hours?` (1–336, default 48), `include_closed?` (default false), `limit?` (≤200, default 100) | `items[{post_id, channel, at, local, status, origin, locked, title, format, needs_approval}]`, `truncated` | `editor_slots` (content + reserved, every lane) ∪ legacy `scheduled_publications` |
| `get_post` | `post_id` | status, reason (catalogue text and fix), topic, angle, format, origin, locked, preview, spec, lint warnings, critic verdict, approval fields, runs, published link | slot + reasons catalogue |
| `get_problems` | `channel?` | `problems[{severity, channel, kind, title, detail, since, ref}]`, critical first | network health, SLO, inbox (action/critical unread), slots closed without a post in 24 h grouped by reason, approvals waiting or expired, open pauses, readiness blockers, global flags |
| `get_logs` | `channel?`, `since?` (default 24 h), `until?`, `level?` (`info`\|`warn`\|`error`), `kinds?` (`run`\|`slot`\|`inbox`\|`decision`\|`publish`), `limit?` (≤200) | `entries[{at, level, kind, channel, title, ref}]` | runs, slot outcomes, inbox, `autonomy_decisions`, `published_posts` |
| `get_run` | `run_id` | run row plus steps (≤60; input and output cut to 1,000 characters) | runs repository |
| `list_agents` | — | `agents[{handle, name, kind, channel, mode, paused}]` | agents handles |
| `read_agent_chat` | `chat_id`, `after_message_id?`, `wait_seconds?` (0–90) | `{chat_id, agent, running, messages[{id, role, agent, text, at, cards[{id, kind, summary, status}], drafts[...]}]}` | chat repository |
| `list_recent_posts` | `channel`, `limit?` (≤30) | recent published posts (time, preview, link) | read tool `get_recent_posts` |
| `check_post` | `channel`, `post` | lint result plus rendered preview; nothing is saved, no LLM | lint + render |

### Write tools (scope `mcp:write`)

| Tool | Input | Effect |
|---|---|---|
| `prepare_post` | `channel`, `at`, `post`, `needs_approval?` | Creates a **connector post**: an `editor_slots` content row in the approval lane, with `created_via='connector'`, `locked_by='connector'` and `owner_edited=true`. The text is linted and rendered exactly as an owner edit is (`prepareAndRender`). Status is `awaiting_approval` when `needs_approval`, otherwise `approved` (`approved_by='owner'`). Default (**D1**): `needs_approval = (channel mode is approve)`. A channel in shadow or off mode is refused with a hint. The time must be 5 min to 60 days ahead and outside quiet hours; min-gap or daily-cap clashes come back as warnings. |
| `plan_post` | `channel`, `at`, `topic`, `angle?`, `format?`, `notes?` | Creates a **locked planned slot** (`kind='content'`, `status='planned'`, `topic_mode='fixed'`, `created_via='connector'`, `locked_by='connector'`). The agent writes it at its time from the owner's brief. Replans, the SLO controller and pre-flight leave it alone (§8). |
| `update_post` | `post_id`, `post?`, `at?`, `topic?`, `angle?`, `format?` | Edits a post that has not gone out. A planned slot takes topic, angle, format and time; an awaiting or approved post takes text and time (up to 2 min before the time). Editing an **agent** post locks it (`locked_by='connector'`, `owner_edited=true` for text edits); status is kept. Changes are re-linted and re-rendered. |
| `cancel_post` | `post_id`, `reason?` | Skips a planned, awaiting or approved post with `skipped by owner (connector)[: reason]`. Never triggers an agent or SLO replacement. |
| `reject_post` | `post_id`, `reason?` | Existing approval reject of a waiting **agent** post (the agent may write a replacement). Refused for connector posts: use `cancel_post`. |
| `approve_post` | `post_id` | Existing approval approve of a waiting post (**D2**). |
| `replan_channel` | `channel`, `day` (`today`\|`tomorrow`), `instruction?` (≤600) | Starts the planner in the background (LLM, ~$0.01–0.05), passing the owner's instruction to the planner prompt. Locked posts stay. Returns `started`, or `replan_in_progress` / `editor_disabled` / `channel_off`. |
| `talk_to_agent` | `message` (≤8,000), `agent?`, `chat_id?`, `channel?`, `wait_seconds?` (0–100, default 60) | Posts to the owner chat. A new chat is created with `created_via='connector'`, so the dashboard shows it. The turn runs in the background with **publishing disabled**: `publish_draft` and `schedule_draft` refuse. The tool waits up to `wait_seconds` and returns the reply (messages, cards, drafts), or `running` with `chat_id` for `read_agent_chat`. Cost caps are the chat's own (`EDITOR_CHAT_TURN_MAX_USD`). |
| `apply_card` | `card_id`, `input?` | Applies a pending card an agent proposed, for allowlisted kinds only (§7.1). |
| `discard_card` | `card_id` | Discards a pending card. |

There is no publish-now tool, and nothing can change a mode, settings, models, budgets or skills directly. These stay in the dashboard.

### 7.1 Card kinds `apply_card` accepts

- **Allowed:** `slot_change`, `replan_today`, `series_change`, `schedule_rule`, `owner_rule`, `set_brief`, `update_artifact`, `fix_config_conflicts`, `series_pause_resume`, `content_examples`, `write_skill`, `attach_skill`, `detach_skill`, `change_source`, `set_resource_profile`, `update_agent` (which already refuses mode changes), `file_directive`.
- **Refused (apply them in the dashboard):** `slot_regenerate` (it can publish on a live channel), `create_agent`, `set_network_mode`, `migrate_strategies`, `strategy_cutover`, `strategy_rollback`, `import_list`, `resync_import`, `edit_data_schema`, `repurpose`, and any unknown kind.

## 8. Connector posts are never overwritten (FR-D)

**D0 — New columns (migration 105)**
- `editor_slots.created_via` (`'connector'` or NULL).
- `editor_slots.locked_by` (`'connector'`, `'owner'` or NULL). A slot is **locked** when this is not NULL.
- `editor_slots.locked_at`.
- `editor_chats.created_via`.

The lock protects a slot from the automation, not from the owner: the owner can still edit, move, skip, approve, reject, run or unlock it from the dashboard, the owner bot or the connector. Unlock is `POST /api/editor/slots/:id/unlock`. After an unlock a planned slot is the agent's again; a written post stays as it is.

**Every automation path that writes slots, and what the lock does there**

| # | Writer (file) | Today | With the lock |
|---|---|---|---|
| 1 | `replacePlan` REPLACEABLE / KEPT (`repo/editor-plans.repository.ts`): daily planner, plan-ahead, replan API / card / connector, network planner, SLO dark recovery, launch plan-ahead, switch-on replan | future planned content slots are skipped as `superseded by a new plan` | locked slots are never REPLACEABLE and always KEPT (moved to the new plan) |
| 2 | `keptOn` (planner context, `schedule/schedule.repository.ts`) | a planned slot is not shown to the planner as a fixed point | locked planned slots are shown as fixed points, so the planner plans around them |
| 3 | `TAG_SERIES_SLOTS` | can tag a kept slot with a series | skips locked slots |
| 4 | pre-flight `retopicSlot` (`preflight/slot-preflight.ts`) | rewrites topic, angle, idea and hints | refused for locked slots (SQL guard plus caller) |
| 5 | config gate `patchSlotConfig` | rewrites format and hints of a running slot | refused for locked slots; the gate's normal skip path applies instead |
| 6 | series / resource pause `skipPlanned` (`series-pause/series-pauses.repository.ts`) | skips matching planned slots | leaves locked slots; publish-time pause checks still apply |
| 7 | `dropWaitingPosts` (approval tick, card approve→off/shadow, strategy migration) | skips awaiting and approved posts as `mode_changed` | leaves locked posts; at publish time the approval publisher still skips them if the channel is off or shadow |
| 8 | approval reject → `insertReplacement` | the agent writes a replacement | no replacement for a locked post |
| 9 | approvals bulk | skips flagged waiting posts | leaves locked posts |
| 10 | SLO `handleClosed` / `replaceLatest` (`slo/slo-controller.ts`) | replaces closed slots unless approved, owner-edited or rejected; owner skips (`skipped by owner…`, `skipped by the owner (chat)`) are misread as misses | locked slots are never replaced; the owner and connector skip prefixes are classified as owner closes (`silent/skip-reasons.ts`) |
| 11 | `markDirectiveSlot` (`manager/executors/task-report.ts`) | sets `slo` on a slot | skips locked slots |
| 12 | `cancelCopies` (`map/map.actions.ts`) | skips derived copies | skips locked slots (defensive) |
| 13 | executor `claimDue` + `updateSlot` | writes planned content slots | unchanged by design: a locked *planned* slot (`plan_post`) is written from the owner's brief. Awaiting and approved posts are never claimed; a test proves it. |
| 14 | `skipStale`, off→on past-due skip, `expire`, approval publisher re-checks (pause, dedup, similarity, daily cap), `sweepStuck` | outcomes, not overwrites | unchanged: a post that missed its window or failed a publish guard is closed with a reason that `get_problems` and `get_post` show. Tests pin this behaviour. |

Other writers act only on their own rows or lanes and cannot reach a connector slot (`kind='content'`, `resource_ref IS NULL`, no promo, no rule, not derived): promo, sponsor, news watch, SLO inserter (insert only), drafts (reserved lane), and `moveSlot` / `skipSlot` from the chat card (an owner action). The paths that could reach a locked slot are lock-aware: pins `dropFuturePins` keeps a locked pin slot (`AND locked_by IS NULL`; the `(schedule_rule_id, rule_date)` unique index stops `materialise` duplicating it), the executor tool `request_story_repost` refuses a locked slot (and its UPDATE carries `locked_by IS NULL`; the story guard's hint then offers only `own_angle` or `skip_slot`), the fallback ladder's `formatLocked` is true for a locked slot (no `lighter_format`, no evergreen), `bulk()` counts locked posts in `skippedLocked`, and the autonomy switch's `approve_waiting` never approves a locked post (it counts in `skippedWithWarnings` and `leftWaiting`). The test files say so and assert it for each.

**D1 — The SLO counts connector posts.** Approved and awaiting connector posts are content slots with `resource_ref IS NULL`, so `plannedAhead` and the day's capacity count them. A connector post for today keeps dark recovery from piling posts on top.

## 9. Dashboard (FR-E), all text in English

- **Settings → Connectors tab** (`?tab=connectors`), modelled on the Security tab:
  - the on/off switch (`MCP_CONNECTOR`) with confirmation;
  - the connector URL with a Copy button, and an https / not-configured warning;
  - how to add it in Claude;
  - **Connected apps** (clients, with Disconnect);
  - **Active access** (grants: scopes, last used, expiry, Revoke, Revoke all);
  - **Recent activity** (the audit, last 50).
  - There is a nav registry entry `settings-connectors`.
- **Consent page** `/app/oauth/consent?request=…`:
  - outside the app shell, in the `au-*` look;
  - names the client and the redirect host, with a loopback note;
  - scopes in plain English, with a "Read only" toggle;
  - Allow and Deny buttons, plus expired / unknown states.
- **Badges.** Slot views (SlotDescription, editor slot row, slot page, agent plan list and dialog, calendar chip tooltip, approval card) show a `connector` badge and a `locked` badge. The slot page has **Unlock** (hand back to the agent). Chats created through the connector show a `Claude` badge.

## 10. Deploy path

- **nginx** (`apps/dashboard/nginx.conf`, baked into the dashboard image):
  - `location ^~ /.well-known/oauth-` → automation;
  - `location ^~ /api/mcp` → automation with HTTP/1.1, `proxy_buffering off` and 300 s read/send timeouts.
  - Mirrored in `vite.config.ts`.
- **Migration 105** runs with the deploy (`database/migrate.sh`, then the boot runner).
- **Owner steps:**
  1. push and deploy;
  2. in Settings → Configuration check `DASHBOARD_URL` (or set `MCP_PUBLIC_URL`);
  3. turn on Settings → Connectors;
  4. in Claude: Settings → Connectors → Add custom connector → URL → Connect → sign in → Allow;
  5. Claude Code: `claude mcp add --transport http ai0 https://dev.ai0.global/api/mcp`, then `/mcp`.
- The host Caddy must pass `/.well-known/*` and `/api/mcp` (it forwards everything to the dashboard container on stage, per the runbook).

## 11. Non-goals (v1)

No publish-now; no mode, setting, model, budget or skill writes outside cards; no generic read-tool proxy (`sql_readonly` and `web_fetch` stay local-only on the stdio server); no Meta/TikTok connector posts (Telegram channels only); no MCP resources, prompts or SSE; no 2026-07-28 modern-era protocol; no multi-user.

## 12. Decisions

- **D1** — In approve-mode channels connector posts wait for approval; in live channels they go out at their time. Default as described; owner question.
- **D2** — `approve_post` and `apply_card` are available in Claude. Claude asks before every call (destructive hint). Default as described; owner question.
- **D3** — CIMD plus a restricted DCR, so Claude web, Desktop and Code all connect. No other clients. Lead decision.
- **D4** — Same host as the dashboard (`/api/mcp`), so no DNS work is needed. Lead decision.
- **D5** — Opaque hashed tokens, not JWTs: `JWT_SECRET` falls back to a dev secret outside production, which includes dev-stage. Lead decision.
