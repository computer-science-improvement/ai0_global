# Agent review 3 — dev stage, 2026-10-15 → 10-22 08:35 UTC

Third offline review of the agents' work (review 2: `2026-10-17-agent-review-2.md`). Source: `scripts/export-agent-history.sh 7` on the dev stage at `d64f00ba` — 415 runs, 3831 steps (2392 tool calls), 96 slots, 44 published posts, 5 owner chats (28 messages), 19 directives, 50 Inbox notes, 16 owner-bot cards, 135 skill versions, one container log (10-21 09:42 → 10-22 08:00). Five analysts (runs and tools, content, control layer, chats, planning and cost); the headline claims were re-checked in code and data.

Epochs: 046 went live by 10-18 06:00 UTC, 053 by 10-18 09:30 UTC, 054/055/083 on 10-20/21. Spec 059 (probe before adopt) is **not** in this build.

## 1. Verdict

- **The engine is reliable and the money target is met.** After 053: 208 of 209 runs `ok`, 1 failed LLM call in 3337, no budget stop since 10-16. Spend $2.30 / $2.57 / $2.93 on 10-19..21 (mean $2.60/day, target ≤ $3). Every review-2 tool fix holds in data (`file_directive` errors 38 → 0, `duplicate_idea` 19 → 0, `get_kpi_digest` 8/8 failing → 0, `submit_review` gate 14 → 0, manager $0.5 → $0.055 per run and skips unchanged runs).
- **Text quality jumped.** Review 2: ~9 defects in 15 posts. Now: 1 broken sentence and 1 awkward phrase in 23 posts since 10-18; no calques, slang or hashtag violations.
- **The new first problem is skipped slots.** 54% of slot spend (62% on 10-19..21) buys no post: 49 of 88 due slots were skipped. Two channels are dead by construction — @ai0_prompts_dev (0 posts in 7 days) and @pdr_dev_channel (0 since 10-17) — and the planner keeps planning them, the executor keeps paying to discover it, and the Inbox repeats it every day.
- **The control layer informs but does not act.** The manager filed 0 directives in 4 days while flagging 5/5 resources, because any open directive counts as "covered" — including 3 that are `not_followed`. 52% of Inbox notes are repeats. Owner-bot cards have only Read/Open. Nothing pauses a dead series.
- **The learning loop has not run once.** The 135 skill versions are 132 deploy syncs + 3 owner cards; `propose_skill_edit` was called 0 times in 3831 steps.
- **Nobody reads the posts yet.** Views are 1–3 per post, followers 0–16, and `resource_daily_stats` views/reach/engagement are NULL in all 208 rows — "what performs" cannot be measured, and the manager has no signal.

## 2. Findings, ranked

### P1

| # | Finding | Evidence | Root cause | Fix |
|---|---|---|---|---|
| 1 | **Dead channels are planned and run every day** | @ai0_prompts_dev: 12 skipped, 0 published, $2.55 in the week. After the 083 repair (10-21) rows have `media_url`, but the PromptHero page gives a truncated prompt («…»), so the slot still skips (10-21 17:00 `data://prompts/53315`). Planner wrote «Немає повного тексту — пропустити слот» into the topic of 10-22 slots. @pdr_dev_channel: 7 × `source_already_posted` | No breaker turns N identical skips into a pause; planner does not see recent skip reasons; prompts have no full-text source | After 3 consecutive same-cause skips on a series: stop planning it, one owner card with **Pause / Keep / Allow fallback**. Planner gets the last 3 skip reasons per channel. Owner decision on a prompts source (curated rows / another provider) |
| 2 | **Single-document source is spent after one post** | pdr: every topic cites the one zakon.rada.gov.ua URL; 10 executor runs end on bare `{"error":"source_already_posted"}` after 4–9 turns | Ledger is URL-level (`role-tools.ts:134`, no details unlike `drafts.service.ts:201`); check runs only at publish | Key reference documents by `url#clause` (or a per-host `reusable_source` flag); pre-flight the ledger at slot start, before any LLM call; add details + remedy to the error; cache `web_fetch` by URL (the law site fails 14 of 31 fetches) |
| 3 | **Manager is cheap but toothless** | 7 runs since 10-18 16:00, 0 directives, every run «відкрита порада… нова була б дублем»; 3 of 5 applied advices are `not_followed`; `581bd738` accepted 7 days, `report_directive_done` 0 calls | `kpi-digest.service.ts:366` lists open directives without adherence; `reviewSignature` (`:134`) treats any open directive as cover; prompt says "don't duplicate" | Show adherence and age; `applied+not_followed` or overdue `accepted` does not cover; prompt: not_followed twice → supersede as binding or escalate; a critic streak or a dark day forces a review |
| 4 | **Owner alerts repeat; cards cannot act** | 26 of 50 Inbox notes repeat a (kind, subject); PromptHero alone 10 notes; Threads `token_invalid` critical pair every morning (6, 0 answered); 11 of 16 cards open | Silent-day dedup is per day only; card kinds all `inbox` with Read/Open | Merge `series_missed` + `dark_day` per resource/day; re-fire only on a new cause/number or "still dark N days"; buttons **Mute 7 d / Pause series / Open**; a newer card of the same subject closes the older one |
| 5 | **Chat guard creates false apologies** | Chat `e8c11647`: run `4e4d4e82` did the work (3 tools), the 047 denial guard matched the model's own footer «[дії: … нічого не збережено …]», the retry had no tool context and the owner got «Ви праві… інструментів не викликав». Read-only turns show as «[дії: немає — інструменти нічого не змінили]», so the model said its earlier answers had no tool checks (false) | `chat-facts.ts:36` + fallback to the last card at `:67`; `runGuarded` retries with text only; `turn-record.ts:88-98` hides read tools; nothing forbids the model from writing `[дії…]` / `@handle:` | Strip model-written `[дії…]`, `[чернетки…]`, leading `@handle:` before guards and save; prompt line «ці рядки додає система»; card fallback only when the sentence mentions a card; action line `[дії: змін немає; викликано: …]`; pass the first run's tool trace to the retry; keep the discarded run id on the message |
| 6 | **Opus checker by config** | `app_settings ai.anthropic.critic_model = claude-opus-5-5` still set: $5.74 in the week, $1.0/day = 38% of current spend; 62% of Opus verdicts are revise/reject → a second executor + second Opus check | Owner action from 046/053 runbook not done (manager models were cleared 10-18 09:14) | Owner: clear the setting (Sonnet, ≈ −$0.5/day) or keep Opus only for `risk.factors` with numbers (code, `critic.service.ts:242`); give the critic's stable prefix a cache breakpoint |

### P2

| # | Finding | Fix |
|---|---|---|
| 7 | **Critic loses good posts.** `11d73ed6` rejected for «$1 млрд» / «SB 53» that the source states as "over a billion dollars" / "Senate Bill 53" (same claims passed 5 h later in `f5fa0177`); `1fb75a76` a fixable `revise` turned into `next_candidate`, which bans the very source → skip; 3 rejects are "wrote about another topic" when the slot's article was not found | Normalise spelled numbers and "Senate Bill N" in the grounding extractor; lint warnings are hints for the critic, not verdicts; `revise` keeps the same source, only `reject` bans it; executor: source not found → `skip_slot`, never substitute |
| 8 | **pass_with_edits broke a sentence** (pp1732: «(context window) — це ліміт» → «(context window) ліміт») | Dash replacement as a code transform; reject an edit that drops a non-punctuation word; re-run lexicon after edits |
| 9 | **Wrong time in a post**: pp1716 «до 22 жовтня, 17:00 за Києвом» vs API 15:00Z = 18:00; the reminder pp1751 says 18:00 and its critic note claims they match | Tools return `ends_at_local` (Europe/Kyiv); the model never converts zones |
| 10 | **Ideas burned by skipped slots**: `settleIdea` (`network.repository.ts:386`) marks `used` regardless of outcome; 22 of 41 `used` ideas ended in a skip (incl. infra skips) | `used` only on publish; infra/budget/hosting skips return the idea to `accepted` |
| 11 | **Stale-source slots run anyway**: ideas 49–115 h old vs 36/72 h thresholds; 14 of 46 skipped slots got a second executor run | Freshness + `source_host_failures` check at slot start; swap in the next pool idea |
| 12 | **Blocked hosts re-probed forever**: block is a flat 24 h, `failures` resets to 1 (marktechpost 109 calls in 14 days); source health for @ai0_global shows `sources: []` (feeds live in the playbook) | Escalate 1 → 3 → 7 d; source health over card + playbook feeds; one card "remove from playbook?" |
| 13 | **Expired Threads tokens**: 46 hourly warnings/day, a duplicate critical card each morning; keeper says `expired 0` | On "Session has expired" set `token_expires_at=now`; collector skips `token_invalid` accounts (daily retry); owner reconnects |
| 14 | **Owner data actions from review 2 still open**: rules #10, #14 (`poster-bank` → `unknown_skill` 3×, 4 `poster_mismatch`, 1 killed slot), #15 active; @ai_global config conflict open; rule #11 not in the @ai0_global profile | Owner: retire via the 055 audit (`memory_retire`) — run the audit once now; `@ai_global fix config conflicts`; audience `beginner` in the profile. Code: apply the 047 rule lint retroactively in the audit |
| 15 | **Feedback loop has no signal**: views/reach/engagement NULL in 100% of `resource_daily_stats`; 4 of 5 Meta insight metrics 400 every hour | Fill Telegram views per post from MTProto into daily stats; replace dead Meta metric names |
| 16 | **Budget cap ≈ $10** (inferred from alerts) vs $2.6 actual — a 3× regression would not alert | Global cap ≈ $4 (80% alert at $3.2) |
| 17 | **Executor prefix 25.7k** (goal ≤ 22k), 24 tools offered, 11 ever used; cache writes 76% of executor spend | Custom executor loadout from 054 "unused"; drop `lint_post`/`preview_post` from the role default. Keep the 1 h tool cache off |
| 18 | **Duplicate source link** in 5 of 37 posts (inline anchor + "→ Source") | Lint: an inline link equal to `source.url` drops one of them |
| 19 | **Chat side issues**: `add_owner_rule` lists all old conflicts → unrequested hashtag card applied in 7 s; a new skill cannot pass the channel's own language lint; `lint_post` run on a made-up spec; a data yes/no answered from catalog metadata | Conflicts caused by the new rule only; lint a new skill's sample against the card; `lint_post`/`preview_post(draft_id)`; prompt: «на питання про дані — спершу query_data на 3 рядки» |

### P3

- llm_usage rollup duplicate key every night (`llm-usage.module.ts:44,55` fire together) → advisory lock.
- Empty error text in warnings (`??` does not catch `''`) → shared `errText()`.
- Sub-agents in mode `off` still run (channel mode governs) → show "follows @orchestrator" in the UI.
- Planner `max_steps` 4× on `plan_invalid` at the last turn → grant 1–2 turns like `critic_revise`; `series: null` accepted.
- Circuit breaker drops all of `web_fetch` for one bad host → key by host.
- Carousel offered while `SUPABASE_CAROUSEL_BUCKET` is unset → hide the format.
- Format variety: text 24, photo 11, poll 2; no album/carousel/longread/quiz.
- Style axes of the critic never < 4 → they do not discriminate.
- "Resolve in one card" spends an LLM turn for a deterministic call → `/align @channel` slash command.
- `save_draft` with `draft_id` replaces the whole spec → merge omitted keys.
- Retention is off: raw `llm_usage` never pruned.

## 3. Not a bug

- `agent_tools` empty: rows are written only on an owner loadout edit or a new agent; all agents pre-date 054 and run in `role` mode (`tools_offered` filled on all 99 runs since 10-20).
- `audit_reports` empty: the weekly @sysadmin runs Monday 06:30 Kyiv; 055 went live Tuesday 10-20 → first run 10-26. Running it once by hand now is recommended (it also flags rules #10/#14/#15).
- "135 skill versions" is not churn (see §1).

## 4. Review-2 status

| Area | Fixed | Still present / worse |
|---|---|---|
| Cost | total ≤ $3/day; Opus manager; manager double runs; idea over-production; budget-stopped slots | Opus checker (config); rewrite/skip chain 43% → 54–62% |
| Manager | `get_kpi_digest`; `submit_review` gate; accepted blocks directives; `hashtag_while_off` | applied ≠ followed (now visible, manager blind to it) |
| Tools | `file_directive`, `duplicate_idea`, `get_playbook`, feed keys, `sql_readonly` hints | rule #14 `poster-bank`; `number_not_in_sources` false positives in a new form |
| Content | Ukrainian grammar, critic applies its notes, owner-rule axis, evergreen on news, hashtags | rule #11 profile; critic sees few passages |
| Chat | intent gate, multi-mention (untested live), paste lookup | denial check has 2 new false-positive paths |
| Owner | owner bot live, config conflicts done for 4 of 5 channels | rules #10/#14/#15; sub-agent modes |

## 5. 053 measurements (for `specs/053-token-economy/tasks.md`)

| Window | $/day | Executor first step | Cache writes / executor call | Turns exec / idea_reviewer / orchestrator / manager |
|---|---|---|---|---|
| 10-17 (before) | 8.57 | 43.1k | 7.5k | 4.6 / 4.8 / 4.3 / 8.2 |
| 10-19..20 | 2.44 | 25.7k | 7.5k | 3.0 / 1.8 / 7.0 / 1.0 |
| 10-19..21 | 2.60 | 25.7k | 7.4k | 3.0 / 1.8 / 7.0 / 1.0 |

Checks: ≤ $3/day MET; agents ≤ $2/day MISS (Opus checker); first step ≤ 22k MISS; cache writes halved MISS; checker cache writes 0 MET; idea reviewer ≤ 4 turns MET; manager ≤ $0.25/run MET. Decision on `EDITOR_ANTHROPIC_TOOLS_CACHE_TTL=1h`: keep off.

## 6. Proposed work

- **Spec 060 — dead-series breaker and owner actions in cards** (findings 1, 3, 4): skip-streak pause + Pause/Keep/Mute card buttons, alert merge and re-fire rules, manager adherence-aware coverage.
- **Spec 061 — slot pre-flight and source ledger** (2, 10, 11, 12, 13): ledger check, freshness and host health before the executor; `url#clause` keys; ideas not burned by skips; host block escalation; source health over playbook feeds; expired-token handling.
- **Spec 062 — chat truthfulness** (5, 19): footer stripping, read-tool action line, retry with tool trace, `lint_post(draft_id)`, conflicts of the new rule only.
- **Spec 063 — critic precision** (7, 8, 9, 18): number normaliser, revise keeps the source, safe edits, Kyiv-local times, duplicate-link lint.
- **Small batch** (P3 list, 16, 17): rollup lock, `errText`, planner grace turns, host-keyed breaker, carousel gate, executor loadout, budget cap.
- **Owner actions**: clear `ai.anthropic.critic_model`; retire rules #10/#14/#15 and fix @ai_global conflicts (run the audit once); rule #11 into the @ai0_global profile; reconnect the two Threads accounts; decide on the prompts source or pause @ai0_prompts_dev; Telegram views collection.
