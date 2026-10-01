# Specs (Spec Kit layout)

Source: re-audit of 2026-10-01 (5 parallel audits) plus the editor-agent design session.
Principles: [.specify/memory/constitution.md](../.specify/memory/constitution.md).

Each feature directory has `spec.md` (what and why), `plan.md` (how, plus Constitution Check) and
`tasks.md` (ordered, checkable tasks; `[P]` means it can run in parallel). Larger features also have
`data-model.md` and `contracts/`.

| # | Feature | Priority | Depends on | Status |
|---|---------|----------|------------|--------|
| 001 | [Audit critical fixes](001-audit-critical-fixes/spec.md): security, ops, CI | P0 | — | DONE |
| 002 | [Publish correctness](002-publish-correctness/spec.md): legacy strategies | P1 | 001 | TODO |
| 003 | [Editor harness core](003-editor-harness/spec.md): LLM client, loop, tools, budget, trace | P0 | — | DONE |
| 004 | [PostSpec, renderers, lint, format skills](004-post-spec-and-skills/spec.md) | P0 | 003 | DONE |
| 005 | [Editor roles](005-editor-roles/spec.md): planner, executor, reviewer, scheduler, shadow mode | P0 | 003, 004 | DONE (shadow-ready; live after owner review) |
| 006 | [Editor ops surface](006-editor-ops-surface/spec.md): REST API, dashboard page, MCP server | P1 | 005 | DONE (shadow-safe; owner verifies in a live session) |
| 007 | [Data hygiene](007-data-hygiene/spec.md): repo bloat, retention, backups, licensing | P1 | — | DONE (T002 partial: raw data still tracked) |
| 008 | [Revenue path](008-revenue-path/spec.md): ad label, order→post→report | P1 | 001, 005 | DONE (T007 partial: invoice drafts stay manual) |
| 009 | [Strategy retirement](009-strategy-retirement/spec.md): migrate channels to the editor | P2 | 005 + shadow results | T001–T003 DONE; T004–T006 owner-gated |
| 011 | [Deal agent](011-deal-agent/spec.md): real Telegram profile, DMs, deals ([threat model](011-deal-agent/threat-model.md), [scenarios](011-deal-agent/scenarios.md)) | P1 | 008, 010 | SPEC |
| 012 | [Owner control bot](012-owner-control-bot/spec.md): notify, stop, resume, take over, approve | P1 | 011 | SPEC |
| 013 | [Group presence](013-group-presence/spec.md): admin / ad-exchange chats | P2 | 011, 012 | SPEC |
| 014 | [Cross-promo engine](014-cross-promo/spec.md): evaluate, negotiate, verify ВП | P2 | 011, tracking | SPEC |
| 015 | [Deal → paid post](015-deal-to-post/spec.md): quote, hold, invoice, creative, schedule | P1 | 008, 011 | SPEC |
| 016 | [Video bridge](016-video-bridge/spec.md): shorts-studio → editor video posts | P2 | 009 | SPEC |

Suggested order for the next wave: 012 → 011 (phases 0–1) → 015 → 013 → 014; 016 is independent.

Order of execution (first wave): 001 ∥ 003 → 004 → 005 → 006 → 002 (only for strategies still live) → 007 → 008 → 009.

**Standing constraint for executors:** no service start, no publishes, no paid API calls.
Verification is limited to `pnpm --filter automation test`, `tsc --noEmit` and lint.
