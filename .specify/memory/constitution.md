# ai0_global Constitution

Version 1.1.0 · Ratified 2026-10-01 · Amended 2026-10-01 (VIII)

ai0_global is an owner-operated, ad-monetized Ukrainian media network: Telegram channels first,
with Meta and TikTok mirrors. It is not a SaaS product and runs as a single instance.

## Core Principles

### I. Agents decide, code guarantees
Judgment work goes to LLM agents: what to publish, when, in which format, and what worked.
Every **side effect** goes through a deterministic tool that enforces its own invariants: escaping,
length limits, dedup, rate limits, quiet hours, budget and kill switch. A prompt is never the only
thing between a model and a public channel.

### II. Agent, skill or tool before hand-written pipelines
New capability starts as a **tool** (a typed function an agent can call), a **skill** (markdown
guidance an agent loads on demand) or an **agent role**, not as another hard-coded strategy. Content is
generated or fetched at decision time. Pre-generated content pools are a legacy pattern.

### III. Shadow first
Every autonomous behaviour ships with a `shadow` mode. In shadow mode it decides, renders and records
everything, but does not publish. A channel moves to `live` only when the owner flips it.

### IV. Everything observable, everything costed
Every LLM call and tool call is persisted with its input, output (truncated), tokens, USD cost and
duration. A per-channel and a global daily budget are checked **before** each LLM call.

### V. Least privilege for runtime agents
Runtime agents get no shell, no filesystem writes and no unrestricted network. Database access is
read-only, under a dedicated role that cannot see secrets. Web access is SSRF-filtered.
`bypassPermissions` with shell-capable settings is forbidden.

### VI. Test-first, offline
Logic is covered by `node:test` tests (`pnpm --filter automation test`) using fakes for LLM, Telegram
and HTTP. During development and verification nobody starts the service, triggers publishes, or calls
paid or external APIs. The owner runs live tests and applies migrations.

### VII. Simplicity
The project has one maintainer. Prefer a 200-line loop over a framework, Postgres over a new store,
and a migration over a new service. YAGNI.

### VIII. Honest automation toward people
Agents that talk to third parties on the owner's behalf write like restrained human professionals, but they never claim
to be human, never invent a personal identity or history, and never answer a sincere "are you a bot / AI?" with a lie.
Such a question pauses the conversation and hands it to the owner. Money, legal and identity questions always go to the
owner.

## Constraints

- Stack: NestJS 10 + `pg` (raw SQL) + Postgres 16 + BullMQ/Redis. The dashboard is React + TanStack.
- LLM access goes through OpenRouter (OpenAI-compatible) with a per-role model registry. The default model is
  `z-ai/glm-5.3-flash`.
- Language of published content: Ukrainian.
- Migrations: `database/migrations/NNN_name.sql`. They must be idempotent, never destructive, and each one
  records its own version in `schema_migrations`.
- Single instance. In-process locks are acceptable; never run more than one automation replica.

## Governance

This constitution takes precedence over the conventions of individual specs. Amendments bump the version and
are noted in the commit message. Every spec's `plan.md` contains a Constitution Check.
