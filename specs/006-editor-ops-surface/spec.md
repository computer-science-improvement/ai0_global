# 006: Editor ops surface: REST, dashboard, MCP

**Status:** In progress · **Depends on:** 005

## Why
The owner needs to see and steer the editor: cards, today's plans, slot outcomes, run traces, spend and memory.
Following principle II, the same operations should also be available to agents (Claude Code or ops agents)
through an MCP server, so the network can be operated conversationally.

## Requirements and tasks
### REST (`api/editor`, behind `TrackingAuthGuard`)
- [x] T001 `GET /api/editor/channels` returns the cards plus today's spend and slot counts.
  `PUT /api/editor/channels/:key` upserts a card (zod-validated; `mode` changes are audited in `editor_channel_memory` as owner `rule`).
- [x] T002 `GET /api/editor/plans?date=YYYY-MM-DD&channel=` returns plans and slots.
  `POST /api/editor/channels/:key/replan` runs the planner now.
- [x] T003 `POST /api/editor/slots/:id/run` executes a slot now, subject to the normal guards; `POST /api/editor/slots/:id/skip` skips it.
- [x] T004 `GET /api/editor/runs?channel=&limit=` lists runs; `GET /api/editor/runs/:id` returns a run with its steps (trace viewer).
- [x] T005 `GET/POST/DELETE /api/editor/channels/:key/memory` manages owner-created memory entries.
- [x] T006 `GET /api/editor/spend?days=30` returns USD per day per channel.

### Dashboard (`/app/editor`)
- [ ] T007 Channel list with a mode switch (off/shadow/live, with confirmation for live), today's slots timeline and spend.
- [ ] T008 Slot detail: rendered preview (`rendered_preview`), PostSpec JSON, link to the run trace.
- [ ] T009 Run trace viewer: steps with tool name, args, result, tokens and $.
- [ ] T010 Card editor form (brief, formats/weights, hashtags, limits, sources, skills) and memory list.
- [ ] T011 Global `onError` toast for mutations (also fixes the audit finding "56 mutations without onError").

### MCP server (`apps/automation/src/editor/mcp/`)
- [ ] T012 stdio MCP server (`pnpm --filter automation editor:mcp`) that reuses the same `EditorTool` registry.
  - Exposes the read tools, `preview_post` and `lint_post`, plus owner tools: `list_plans`, `replan`, `run_slot` (shadow only unless a flag is set), `set_mode` (off/shadow only; live stays dashboard-only).
  - Authenticates with `TRACKING_TOKEN` against the REST API, so it does not touch the DB directly.
- [ ] T013 `.mcp.json` example and a skill `operate-ai0-network` for Claude Code.

Constitution Check:
- I: owner actions go through the same guards.
- V: MCP has no publish-to-live capability, and `set_mode live` is human-only.
