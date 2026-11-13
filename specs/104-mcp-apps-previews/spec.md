# Spec 104 — Previews in Claude (MCP Apps) and get_draft

Status: built 2026-11-13 on `feat/mcp-apps-widgets` (not deployed). Builds on [spec 103](../103-mcp-connector/spec.md).
Runbook: [mcp-connector.md §6](../../docs/runbooks/mcp-connector.md).

## Why

Through the connector the owner could not see what agents write: a draft from `talk_to_agent` was an id and a title,
and posts came back as JSON. The owner asked for a display format: "show me drafts and other artifacts the agents
generate, right in Claude".

## What

1. **One MCP Apps view** (`@modelcontextprotocol/ext-apps` 2.0.4, pinned; extension `io.modelcontextprotocol/ui`):
   resource `ui://ai0/preview-<hash>.html`, MIME `text/html;profile=mcp-app`, dashboard look (Geist, #0A0C0B, #3DDC97),
   English UI. It draws four kinds of view (`structuredContent.view`, or `_meta["ai0/view"].view`, see 3):
   - `post`: a post (`get_post`, `prepare_post`, `update_post`, `plan_post`), a draft (`get_draft`) or a check
     (`check_post`) as Telegram shows it: photo, album, poll, caption (code block with Copy, italics, links, hashtags),
     inline buttons, status, time, lint errors and warnings, critic, the reason it did not go out, the published link.
   - `schedule` (`list_schedule`) and `channel` (`get_channel`: today against the target, problems, next posts).
   - `chat` (`talk_to_agent`, `read_agent_chat`): the agent's messages, cards, and the newest 4 drafts drawn.
2. **`get_draft`** (read tool): one chat draft in full (spec, preview, lint, critic, the post it became), with
   `untrusted_fields`. The chat tools' descriptions point to it; their results are unchanged.
3. **Text results are byte-identical.** The view is built by a separate `view` hook after the call (at most 50k
   chars; a failure, a 10 s timeout or an oversized view leaves the call text-only). Tools carry
   `_meta.ui.resourceUri` (plus the legacy `ui/resourceUri` key); clients without MCP Apps ignore both.
   **Where the view goes** (fix after the first deploy): a plain MCP client (Claude Code) shows the model
   `structuredContent` *instead of* the text, so after ca5a22a9 it saw view JSON. Now only a client that advertised
   `extensions["io.modelcontextprotocol/ui"]` in `initialize` gets the view as `structuredContent`; the stateless
   server marks it with an `Mcp-Session-Id` ending in `.ui`, which the client sends back on every request. Everyone
   else gets the view in the result's `_meta["ai0/view"]` (ignored by plain clients). The view reads both.

## Security

- **No publishing from a view.** Every connector tool has `_meta.ui.visibility: ["model"]` (hosts refuse view-initiated
  calls). The view script never calls `callServerTool`, `sendMessage` or `updateModelContext` (a test greps for them);
  links go through `app.openLink`, http(s) only.
- **Untrusted text.** Captions are parsed on the server into an allowlisted tree (Telegram's tags only; links keep an
  http(s) href, nothing else; depth, node and length caps); the view builds DOM with `createElement`/`textContent` and
  never parses HTML. Media and button URLs are http(s) only; images load only from the CSP list.
- **CSP.** `_meta.ui.csp.resourceDomains` = Google Fonts + image hosts (built-in list, the site, `SUPABASE_URL`,
  `MCP_APP_IMAGE_HOSTS`); no `connectDomains`, no `frameDomains`. The page adds its own meta CSP: inline script only,
  `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`.
- No `ui.domain` (Claude's format is `sha256(connector URL)[0:32].claudemcpcontent.com`; not needed: no CORS, no OAuth).
- The SDK bundle is inlined; the build refuses a bundle with `</script`, `<!--`, imports or `import.meta`.

## Settings

`MCP_APPS` (on|off, default on) and `MCP_APP_IMAGE_HOSTS` (list), group Connectors, live. The resource URI hash covers
the page and its CSP, so a change shows after the connector is reconnected.

## Verified (2026-11-13)

- Unit tests: parser (hostile markup, schemes, entities, caps), view builders, tool wiring and visibility, `get_draft`,
  resource registration (`resources/list`, `resources/read`, `-32002`), server `_meta`/`structuredContent`/fallbacks,
  endpoint, Nest module resolution; lint, `tsc`, `nest build` and the full suite on Node 20.19.6 (CI's flow).
- The page in a local MCP Apps host harness (sandboxed `srcdoc` iframe answering `ui/initialize`, sending
  `tool-input`/`tool-result`): post with photo and prompt code block, schedule, channel, chat with a draft, a hostile
  caption (shown as inert text), an error result; a link click arrives at the host as `ui/open-link`.
- Not verified: rendering inside claude.ai itself (needs a deploy and a reconnect).
