---
name: operate-ai0-network
description: Operate the ai0 editor network (per-channel planner/executor/reviewer agents) through the ai0-editor MCP tools — inspect channels, plans, slots, run traces, memory and spend; replan, run shadow slots, pause channels. Use when the owner asks how a channel is doing, why a post was (not) written, what is planned today, how much the agents cost, or to replan / pause / dry-run a channel.
---

# Operate the ai0 editor network

The editor runs every channel with three agents (spec 003–005, runbook `docs/runbooks/editor-agent.md`):
the **planner** builds the day's plan of slots, the **executor** turns one slot into a post (or skips it),
the **reviewer** turns weekly stats into channel memory. You operate it through the `ai0-editor` MCP server,
which calls the automation REST API (`/api/editor/*`) — never the database.

## Setup (once)

1. The automation service must be running and reachable (`EDITOR_API_URL`, default `http://localhost:3000`).
2. `TRACKING_TOKEN` must be set in the repo-root `.env` (the server loads it).
3. Copy `.mcp.json.example` to `.mcp.json` at the repo root and restart Claude Code. The server is started with
   `pnpm --silent --filter automation editor:mcp` (`--silent` matters: stdout carries the protocol).

## Hard limits — do not try to get around them

- **Never make a channel live.** `set_mode` accepts `off` and `shadow` only. Going live is a human decision
  in the dashboard (`/app/editor`). If the owner asks you to go live, give them the checklist below and stop.
- **`run_slot` is shadow-only.** In shadow mode the executor renders and stores the post (`rendered_preview`)
  but publishes nothing. On a live channel the tool refuses; the owner runs it from the dashboard.
- There is no publish tool and no write access to cards, memory or the database. Do not call the REST API
  with curl to bypass the MCP tools.
- `replan` and `run_slot` spend real LLM money (about $0.006 per executor run; budgets are enforced
  server-side). Do them when asked, not speculatively.

## Tools

| Need | Tool |
|---|---|
| Overview: every channel, mode, today's slots, today's $ | `list_channels` |
| One card (brief, formats/weights, hashtags, limits, sources, skills) | `get_channel` |
| Owner rules, reviewer insights, mode-change history | `list_memory` |
| Today's (or any day's) plans and slots | `list_plans` (`date` = `YYYY-MM-DD`, Kyiv) |
| One slot: status, PostSpec, preview, error, `runId` | `get_slot` |
| Recent agent runs | `list_runs` (`channel`, `slot_id`, `limit`) |
| Why did the agent do X: full trace | `get_run` |
| Spend per day per channel | `get_spend` (`days`, default 7) |
| Re-plan today | `replan` |
| Dry-run one planned slot now | `run_slot` (shadow channels) |
| Pause a channel / keep it planning but not posting | `set_mode` `off` / `shadow` |
| Check or preview a draft PostSpec against a card | `lint_post`, `preview_post` |
| The agents' own read tools (stats, recent/top posts, library search, feeds, `sql_readonly`, skills) | same names, plus a `channel` argument |

## Playbooks

**"How is the network doing?"** `list_channels` → for any channel with `failed` slots or high spend,
`list_plans` for that channel → `get_slot` on the failures → `get_run` on the slot's `runId`. Report
per channel: mode, slots by status, spend vs budget, and the one-line cause of each failure.

**"Why was this post written / skipped?"** `get_slot` → `get_run(runId)`. Read the steps in order: which
tools the executor called, what `lint_post` said, and the `publish_post`/`skip_slot` result.
Guard errors (`too_similar`, `source_already_posted`, `daily_cap_reached`, `quiet_hours`, `min_gap`,
`lint_failed`) are the code doing its job, not bugs.

**"Re-plan today."** `replan(channel)` → `list_plans(channel)`; summarise the new slots (time, format,
topic) and the rationale. The old plan's planned slots become `skipped`.

**"Try a slot in shadow."** Make sure the channel is `shadow` (`get_channel`), `list_plans` → pick a
`planned` slot → `run_slot(slot_id)` → `get_slot` and show the `renderedPreview`.

**"Stop channel X."** `set_mode(channel, "off")`. To keep planning and drafting without posting:
`set_mode(channel, "shadow")`. Both are recorded in channel memory as a mode-change audit entry.

**Going live (owner only).** Before the owner flips a channel to live in the dashboard, check over the
last 7 days of shadow: ≥ 80% of slots `shadowed` (not `failed`), previews read well (Ukrainian, no AI
clichés, correct facts, sources linked), spend per day under the cap, and no legacy strategy still posting to
the same channel.

## Reading the data

- Times are UTC in the API; plans are dated by the channel's local day (`Europe/Kyiv` by default).
- Slot statuses: `planned → running → shadowed | published | skipped | failed`. A failed slot is retried
  once 15 minutes later unless budget or quiet hours prevent it.
- Spend comes from finished runs (`editor_runs.cost_usd`); a run still in progress shows $0 until it ends.
- Memory entries with `createdBy: owner` are owner rules; the reviewer can never retire them.
