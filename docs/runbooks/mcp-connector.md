# Runbook: the Claude connector (remote MCP)

Spec [103](../../specs/103-mcp-connector/spec.md). The owner runs the network from Claude (claude.ai, Claude Desktop,
Claude mobile, Claude Code) as a **custom connector**: channels and the schedule, logs and problems, planning and
preparing posts, talking to the agents. Posts made or edited through the connector are **locked**: the automation
never replaces, replans or rewrites them.

```
Claude ──HTTPS──▶ host Caddy ──▶ dashboard nginx ──▶ automation:3000
                                   /.well-known/oauth-*        discovery (PRM, AS metadata)
                                   /api/oauth/*                OAuth 2.1 authorization server + consent API
                                   /api/mcp                    MCP (Streamable HTTP, stateless, JSON)
                                   /api/connector/*            Settings → Connectors (owner session)
                                   /app/oauth/consent          consent page (behind the dashboard login)
```

Sign-in is OAuth on the platform itself: Claude opens the dashboard, the owner signs in with the usual dashboard
login and presses **Allow**. No tokens are copied by hand. The connector URL is `<MCP_PUBLIC_URL or DASHBOARD_URL>/api/mcp`,
for example `https://dev.ai0.global/api/mcp`.

## 1. Enable

1. Deploy a build with spec 103. Migration `105_mcp_connector` runs with the deploy (`database/migrate.sh`, then the
   boot runner). The dashboard image carries the new nginx locations (`/.well-known/oauth-`, `/api/mcp`).
2. The host Caddy must forward every path to the dashboard (a plain `reverse_proxy 172.17.0.1:8080` site block does).
   Check: `curl -s https://dev.ai0.global/.well-known/oauth-authorization-server` returns JSON once the connector is on
   (404 `connector_off` before).
3. Settings → Configuration: `DASHBOARD_URL` must be the public https origin (`https://dev.ai0.global`). If the connector
   should live on another origin, set `MCP_PUBLIC_URL` (https, no path). The consent page always opens on the
   `DASHBOARD_URL` origin, where the owner's dashboard session lives.
4. Settings → Connectors: turn the connector on (`MCP_CONNECTOR`). The tab shows the URL and warns when it is not https
   or not configured.

## 2. Connect

**Claude (web, Desktop, mobile):** Settings → Connectors → Add custom connector → paste the URL → Connect → the dashboard
opens → sign in if asked → check the client name and the permissions → Allow. Untick "Write" for a read-only connector.

**Claude Code:**
```bash
claude mcp add --transport http ai0 https://dev.ai0.global/api/mcp
```
Then run `/mcp` in Claude Code, pick `ai0` and authenticate (a browser opens on the consent page).

Claude identifies itself with a Client ID Metadata Document (only Claude's two documents are accepted); the consent page
labels it "Verified Claude app". Dynamic client registration is a fallback restricted to Claude's callback URLs and
loopback (labelled "Self-registered app — its name is not verified"): 20 registrations per IP (IPv6: per /64) per hour,
100 clients in use; a registration that never got access is hidden and removed after 24 h. The authorize endpoint
allows 60 requests per minute per IP and 50 waiting requests per app.

## 3. What Claude can do

Read (`mcp:read`, no confirmation): `list_channels`, `get_channel`, `list_schedule`, `get_post`, `get_problems`,
`get_logs`, `get_run`, `list_agents`, `read_agent_chat`, `list_recent_posts`, `check_post`.

Write (`mcp:write`, Claude asks before each call): `prepare_post`, `plan_post`, `update_post`, `cancel_post`,
`reject_post`, `approve_post`, `replan_channel`, `talk_to_agent`, `apply_card`, `discard_card`.

- **prepare_post** writes a finished Telegram post for a time. In an approve-mode channel it waits for approval
  (dashboard, owner bot, or `approve_post` in Claude); in a live channel it goes out at its time. Shadow and off channels refuse.
- **plan_post** books a slot with a topic; the agent writes it at its time from the owner's brief. **update_post** on an
  agent slot makes the owner's topic the slot's topic (a live, series or idea driver is dropped) and locks it; moving a
  post to another day moves it into that day's plan.
- **talk_to_agent** posts to the owner chat (the chat shows a `Claude` badge in the dashboard). Publishing is disabled
  in these turns: `publish_draft` and `schedule_draft` refuse.
- **apply_card** applies only safe card kinds; network mode, agent creation, migrations, imports, schema edits,
  repurpose and slot regeneration stay in the dashboard.
- There is **no publish-now tool**. Publishing only happens through the schedule and the approval flow.

## 4. The lock

A slot with `locked_by` set (`connector` or `owner`) is the owner's:
- replans keep it and plan around it; the SLO controller never replaces it; pre-flight and the config gate never
  rewrite its topic or format; series/resource pauses, mode sweeps and bulk approve leave it; an approval reject writes
  no agent replacement;
- the agent never turns it into a story repost and the fallback ladder never changes its format or swaps in an
  evergreen post; a pin rule edit leaves a locked pin slot alone; bulk approve and the autonomy switch never approve it
  (the bulk result counts it as `skippedLocked`: approve it one by one);
- the publish-time guards still apply: a post on a channel that is off or shadow at its time is not sent
  (`mode_changed`), a post that missed its window closes as stale, dedup/similarity/daily cap still skip.

The dashboard shows `connector` and `locked` badges. **Unlock** on the slot page hands a planned slot back to the agent;
a written post stays as it is. API: `POST /api/editor/slots/:id/unlock` (and `/lock`).

## 5. Revoke and audit

- Settings → Connectors → Active access: revoke one grant or all. Connected apps: disconnect a client (its grants die).
- Recent activity: every tool call and OAuth event (`mcp_audit`), with ids only, never post text.
- Tokens are opaque and stored as SHA-256 hashes (`mcp_oauth_tokens`). Access lives 1 h, refresh 30 days (rotated on
  every use; a reused old refresh token revokes the grant). A connector token is never a dashboard session, and
  `TRACKING_TOKEN` is never accepted on `/api/mcp`.
- Disconnect really disconnects: an app stays out of Connected apps until the owner allows it again on the consent page.
- A tool call outside the grant's permissions (a read-only grant calling a write tool) is refused and shows in Recent
  activity as an error (`not_allowed_for_scope`).
- Kill switch: turn `MCP_CONNECTOR` off. Every connector route answers 404 at once; grants stay but cannot be used.

## 6. Troubleshooting

| Symptom | Check |
|---|---|
| Claude says the server is unreachable | `curl -si -X POST https://<host>/api/mcp` must be `401` with `WWW-Authenticate: Bearer resource_metadata=…`. A `404 connector_off` → turn it on. HTML → nginx or Caddy does not route `/api/mcp`. |
| Sign-in loops or "invalid redirect" page | The client is not Claude, or its callback is not allowlisted. Recent activity shows `register` / consent events. |
| "Not allowed from here" on the consent page | The decision needs a dashboard **session** (cookie login); a token bearer cannot approve. Sign in on the dashboard and retry. |
| Tools fail with `rate_limited` | 120 requests per minute per grant. |
| A post from Claude did not go out | `get_post` in Claude (or the slot page): approval still waiting, channel switched to shadow/off, stale, or a publish guard. |
| Token stops working after a deploy | It should not: the server is stateless and tokens live in Postgres. Check `MCP_PUBLIC_URL`/`DASHBOARD_URL` did not change — the token is bound to the resource URL. |
