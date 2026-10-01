# Agent platform: named agents per resource, network orchestrators and a MANAGER (design, 2026-10-02)

**Status:** DESIGN (approved section by section in the 2026-10-02 session) · **Specs:** 017–022
**Builds on:** 003–006 (harness, roles), 009 (formats, mirrors), 010 (chat), 008 (reserved slots), 012 (owner cards)

## 1. Goal
The owner wants the network to run itself. Every resource has a **named agent** that owns its strategy. Agents decide
what to publish **natively per platform** instead of mirroring Telegram. A **MANAGER** sees the whole network several
times a day and steers the orchestrators with comments and tasks only when that is warranted.

Today:
- every Telegram channel has an editor card with planner, executor and reviewer roles;
- Instagram, Facebook and Threads get a **mirror** of each Telegram post, built in code;
- TikTok is prepared but not wired into the editor path;
- YouTube is absent;
- no agent sees non-Telegram stats.

## 2. Decisions taken with the owner
| # | Question | Decision |
|---|----------|----------|
| D1 | How autonomously do MANAGER directives apply? | **Mixed.** Advice (format shift, "continue", a task) is applied by the orchestrator itself. **Structural** directives need an owner card first: cross-promo between resources, a large frequency change, a new platform, pausing a resource, a strategy change. The default action after N hours of silence is configurable per kind. |
| D2 | How does the owner say what goes where? | **Brief → playbook.** The owner writes a free-text brief. The orchestrator turns it into a structured, versioned playbook. The idea reviewer checks it and the owner approves it once. Without a brief, the orchestrator proposes a playbook from stats. |
| D3 | Which KPIs does the MANAGER watch? | All four groups: **subscriber growth**, **reach and engagement**, **transitions between resources**, **revenue and ads**. |
| D4 | Architecture | **A: asynchronous agents plus a DB "mailbox".** Every agent runs on its own schedule as a short run. Agents communicate only through tables (directives, playbooks, ideas, plans), never by calling each other. |
| D5 | Agent identity | Each agent has a **name** and a unique **@handle**. Each has its own page with skills (view, edit, add), memory, history and playbook. The owner can talk to any agent in the chat via `@handle`. |
| D6 | Who changes skills? | **Agents may edit or create skills of their own scope.** Every change is a new version with a "why", and the owner is notified. A change auto-rolls back when the KPIs of its scope drop within 7 days. Owner-written or owner-locked skills and the system safety skills are never touched by agents. |
| D7 | Creating agents | Agents are created and changed **in the chat** through the system agent `@ai0`: list resources, inspect a resource, describe it, create or update the agent. Each mutation needs an explicit request plus a confirmation card. The owner must **describe the resource** (the resource profile) when an agent is created; `@ai0` drafts that description from the resource history. |

## 3. Vocabulary
- **Resource**: one publishable destination: a Telegram channel, an Instagram account, a Facebook page, a Threads
  account, a TikTok account or a YouTube channel. Its **ResourceRef** is the string `<platform>:<id>`, for example
  `telegram:@space_daily`, `instagram:<meta_account_id>`, `tiktok:<tiktok_account_id>` or `youtube:<youtube_account_id>`.
  Resources keep living in their existing tables (`tracked_channels`, `meta_accounts`, `tiktok_accounts`, and the new
  `youtube_accounts`).
- **Network**: an existing account group (`meta_account_groups`), which gets a new `mode`: `mirror` (today's behaviour)
  or `orchestrated`. The "one account per platform per group" constraint stays.
- **Scope**: `system` (the whole network of networks), `network:<group_id>` or `resource:<ResourceRef>`.
- **Agent**: a row in `agents` (017) with a kind, a scope, a name and handle, a model, a schedule, a budget and a status.

## 4. Hierarchy
```
                        @manager  (kind=manager, scope=system)
                 3–4 runs/day · KPI digest · directives · "continue"
                               │  agent_directives (mailbox)
        ┌──────────────────────┼─────────────────────────┐
  @kira (orchestrator,               @chef (orchestrator,
         network:Космос)                     resource:telegram:@recipes)
   ├─ playbook (versioned, owner-approved)   └─ today's editor roles
   ├─ ideator → content_ideas                   (planner/executor/reviewer)
   ├─ idea_reviewer (verdicts)
   ├─ network planner → network_slots (what · how · where · when)
   └─ per-platform executors → guards → publishers
                                  (telegram · instagram · facebook · threads · tiktok · youtube)
  @ai0 (kind=builder, scope=system): creates and changes agents from the chat
```
**Precedence:** owner rule > MANAGER directive > orchestrator's own judgment.
- The MANAGER never publishes.
- Orchestrators never direct the MANAGER.
- Directives never form cycles: only `manager → orchestrator` and `orchestrator → its own sub-roles`.

## 5. Schedules (defaults, editable per agent)
| Agent | When |
|-------|------|
| MANAGER | 08:00, 13:00, 18:00, 22:30 Kyiv |
| Orchestrator | 06:30 daily (playbook upkeep and idea pool), plus an event run on a new directive or an owner-approved structural directive |
| Network planner | 07:00 daily (day plan); re-plan on an accepted directive that changes today |
| Executors | Per slot (the existing per-minute scheduler) |
| Reviewer | Weekly (as today), plus the 7-day evaluation of directives and skill versions |
| `@ai0` | On demand in the chat only |

## 6. Data flow of one day
1. **06:30** The orchestrator reads its inbox (new directives, owner rules) and resolves each directive: `accepted` with
   a plan, or `rejected` with a reason. It tops up the idea pool from live sources, series and stats. The idea reviewer
   scores the new ideas.
2. **07:00** The network planner builds the day: it picks accepted ideas and series instances, and expands each idea into
   native variants per platform with staggered times. It respects reserved slots (ads, cross-promo). Code validates the
   plan (capability matrix, frequency, gaps, quiet hours, API limits, resource health).
3. **Through the day** each slot runs its platform executor, which writes a native post spec, runs the guards and
   publishes, or shadows in shadow mode.
4. **08:00 / 13:00 / 18:00 / 22:30** The MANAGER reads the KPI digest: trends against baseline, code-flagged
   anomalies, today's plans, the outcomes of earlier directives. It answers `continue`, or files up to 3 directives.
   Structural directives raise an owner card.
5. **Weekly** the reviewer updates memory and format weights. The directive evaluator measures every directive and
   self-edited skill on its review date: `worked | no_effect | hurt`. `hurt` on a self-edited skill rolls it back.

## 7. Specs
| # | Spec | Delivers | Depends on | Migration |
|---|------|----------|-----------|-----------|
| 017 | [Agent registry](spec.md) | `agents`, names and handles, the agent page, DB skills with versions and self-edit with auto-rollback, run history per agent | 003–010 | 049 |
| 018 | [Agent chat and builder](../018-agent-chat-builder/spec.md) | `@handle` routing in `/app/chat`, `@ai0` with agent-management tools, the onboarding skill, resource profiles | 017 | 050 |
| 019 | [Native multi-platform publishing](../019-native-multiplatform/spec.md) | Capability matrix, per-platform PostSpec variants and executors, the TikTok editor fix, YouTube accounts, per-platform stats; 019b covers video publishers | 009, 017 (019b: 016) | 051 |
| 020 | [Playbook, ideas, day planner](../020-playbook-ideas-planner/spec.md) | Brief → playbook, series, idea pool, idea reviewer, network day plan | 017, 019 | 052 |
| 021 | [MANAGER and directives](../021-manager-directives/spec.md) | KPI digest, the `@manager` agent, the directive lifecycle, owner cards for structural kinds, effect evaluation | 020 | 053 |
| 022 | [Network cross-promo and tracking](../022-network-cross-promo/spec.md) | Internal cross-promo and reposts between resources, tracked invite links and UTM, the transitions KPI | 021 | 054 |

**Order:** 017 → 018 → 019 → 020 → 021 → 022. 019 can start in parallel with 018. The 019b video publishers wait for 016.

## 8. Cross-cutting safety
- **Code guarantees** (constitution I): every side effect still goes through deterministic tools. Lint, dedup, rate
  limits, quiet hours, budgets and kill switches are checked per platform.
- **Shadow first** (III): a new agent starts in `shadow` for 3 days, then the owner gets a "go live" card. A network in
  `orchestrated` mode starts in shadow too, while the old mirror keeps running until the owner flips it.
- **Kill switches:** pause one agent, one network, or everything (`agents_paused` in settings, and from the 012 bot).
- **Budgets:** one per agent, plus network roll-ups and the global daily cap that exists today. The MANAGER has its own
  budget line.
- **Prompt injection:** fetched text is data. Tools that change agents, skills, playbooks or directives run only on an
  explicit owner request in the latest chat message plus a confirmation card, or from an agent run of the right kind and
  scope. They are never triggered from fetched content.
- **Skill self-edit:**
  - the skill linter blocks guard-bypass, secret-reveal and "ignore previous" patterns;
  - each agent may make at most 1 self-edit per day;
  - system safety skills and owner-locked skills are immutable for agents;
  - auto-rollback when the KPIs drop.
- **Honesty** (VIII): agent names are internal. Agents never present themselves as people in published content.

## 9. Cost envelope [E]
| Run | Estimated cost |
|-----|----------------|
| Post (GLM 5.3 Flash) | about $0.002–0.005 |
| Idea-review batch | about $0.005–0.02 (GLM 5.3) |
| MANAGER run | about $0.01–0.05 |

**Network of 10 resources** at 3–6 posts per resource per day: roughly **$3–10 per month** of LLM spend, well inside the
existing budget gate. Video spend (016/019b) is separate.
