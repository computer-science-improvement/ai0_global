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
| 010 | [Editor chat](010-editor-chat/spec.md): Claude-style chat with the agent, publish now or schedule | P1 | 003–006, 008, 009 | DONE (owner runs live evals and verifies live) |
| 011 | [Deal agent](011-deal-agent/spec.md): real Telegram profile, DMs, deals ([threat model](011-deal-agent/threat-model.md), [scenarios](011-deal-agent/scenarios.md)) | P1 | 008, 010 | SPEC |
| 012 | [Owner control bot](012-owner-control-bot/spec.md): notify, stop, resume, take over, approve | P1 | 011 | SPEC |
| 013 | [Group presence](013-group-presence/spec.md): admin / ad-exchange chats | P2 | 011, 012 | SPEC |
| 014 | [Cross-promo engine](014-cross-promo/spec.md): evaluate, negotiate, verify ВП | P2 | 011, tracking | SPEC |
| 015 | [Deal → paid post](015-deal-to-post/spec.md): quote, hold, invoice, creative, schedule | P1 | 008, 011 | SPEC |
| 016 | [Video bridge](016-video-bridge/spec.md): shorts-studio → editor video posts | P2 | 009 | SPEC |
| 017 | [Agent registry](017-agent-platform/spec.md): named agents, agent pages, DB skills with versions and self-edit ([platform design](017-agent-platform/design.md)) | P1 | 003–010 | DONE (shadow-safe; owner verifies live) |
| 018 | [Agent chat and builder](018-agent-chat-builder/spec.md): `@handle` in the chat, `@ai0` creates and changes agents, resource profiles | P1 | 017 | DONE (shadow-safe; owner verifies live) |
| 019 | [Native multi-platform publishing](019-native-multiplatform/spec.md): capability matrix, per-platform variants, TikTok fix, platform stats; 019b video | P1 | 009, 017 | DONE (019b waits for 016) |
| 020 | [Playbook, ideas, day planner](020-playbook-ideas-planner/spec.md): brief → playbook, series, idea reviewer, network plan | P1 | 017, 019 | DONE (shadow-safe; owner verifies live) |
| 021 | [MANAGER and directives](021-manager-directives/spec.md): KPI digest, directives, owner cards, effect evaluation | P1 | 020 | DONE (shadow-safe; owner verifies live) |
| 022 | [Network cross-promo](022-network-cross-promo/spec.md): own-resource promo and reposts, tracked links, transitions KPI | P2 | 021 | DONE (shadow-safe; owner verifies live) |
| 023 | [Agent-owned content](023-agent-owned-content/spec.md): strategies become agent tools, the agent sets the schedule (chat, manual override), content ledger (Linear AI0-17) | P1 | 009, 018, 020, 021 | DONE except T7 phase B (owner-gated: delete strategy modules) |
| 024 | [Independent resources](024-independent-resources/spec.md): per-resource duplicate / adapt / unique decisions and per-resource time zones (AI0-25) | P1 | 019, 020, 021 | DONE (paid evals not run) |
| 025 | [MANAGER directive vs advice](025-manager-directive-vs-advice/spec.md): binding directives vs optional advice, code executors per directive kind (AI0-33) | P2 | 020, 021, 022 | SPEC |
| 026 | [Landing: AI network + white label](026-landing-ai-network-white-label/spec.md): AI-run network positioning, white-label offer, ads via Telegram DM (AI0-41) | P2 | 008, 017–022 | BUILDING (T1–T2 done; English only) |
| 027 | [Navigation constructor](027-navigation-constructor/spec.md): menu constructor, badges, IA cleanup; `ui.nav` in app_settings (AI0-9) | P2 | 017, 018, 021 | DONE |
| 028 | [Auth hardening](028-auth-hardening/spec.md): route guard, server-side gating of /app, revocable sessions, no dev mode in production (AI0-48) | P1 | 001 | DONE (live browser flows to verify on deploy) |
| 029 | [Agent and AI spend analytics](029-agent-and-ai-spend-analytics/spec.md): every LLM call in a usage ledger, prices, budgets, `/app/spend` (AI0-1) | P2 | 006, 017, 021 | DONE |
| 030 | [YouTube + LinkedIn](030-youtube-linkedin/spec.md): Shorts via the video bridge with quota, LinkedIn pages and 5 formats (AI0-56) | P3 | 016, 019, 020 | SPEC (future) |
| 031 | [Approval mode](031-approval-mode/spec.md): every agent post waits for the owner while a resource is tested; default for new resources, switch to autonomous per resource | P1 | 010, 017–020 | DONE (023/024 hooks in approval-policy.ts) |
| 032 | [Unified data store](032-unified-data-store/spec.md): one `data_items` table + editable `data_schemas`, CSV/JSON import without migrations, agents read schemas first | P1 | — | DONE (eval executor-picks-dataset not run yet) |
| 033 | [Telegram rich messages](033-telegram-rich-messages/spec.md): headings, lists, tables, formulas via Bot API 10.1 `sendRichMessage`, HTML fallback, agent control via `format_prefs.rich` | P2 | 004, 019, 024, 031 | DONE (owner live smoke pending) |

Suggested order for the next wave: 012 → 011 (phases 0–1) → 015 → 013 → 014; 016 is independent.

Agent platform wave: 017 → 018 ∥ 019 → 020 → 021 → 022 (019b after 016).

**UI language (owner rule 2026-10-06):** all interface text is English. Ukrainian button and label texts quoted in specs 023–032 give the meaning; implement them in English (see `apps/dashboard/CLAUDE.md` → Language).

Migration numbers in specs 023–032 are assigned in merge order (landed: 055 auth, 056 llm_usage, 057 approval, 058 data store; landed: 059–060 and 063 spec 023, 061–062 and 064 spec 024; planned: 065 spec 025, 066 spec 026, 067 spec 030) and are renumbered if the order changes.

BRD-comments wave (2026-10-06): 028 ∥ 029 ∥ 031 → 032 → 023 ∥ 024 → 025 → 029 → 027 → 026; 030 after 016.

Order of execution (first wave): 001 ∥ 003 → 004 → 005 → 006 → 002 (only for strategies still live) → 007 → 008 → 009 → 010.

**Standing constraint for executors:** no service start, no publishes, no paid API calls.
Verification is limited to `pnpm --filter automation test`, `tsc --noEmit` and lint.
