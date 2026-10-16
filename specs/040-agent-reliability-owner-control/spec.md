# 040: Agent reliability and owner control

**Status:** DONE · **Priority:** P1 · **Linear:** AI0-126 (T1–T13: AI0-127…AI0-139) · **Depends on:** 017–022 (agents), 023 (schedule cards), 025
(directives), 029 (llm_usage / budgets), 034 (live planning), 037 (integrity) · **Migration:** `079_agent_reliability.sql`

**Owner request (2026-10-16):** analyse all agent logs, chats, skills, rules, directives and posts and say where the system is weak;
then fix it. Analysis of the dev-stage export 2026-10-07…16 (416 runs, 5490 steps, 96 chat messages, 73 posts, 52 skills, 14
directives, 51 manager reviews, $4.88). This spec covers waves 1–2 of that analysis: production stoppers and owner control. Content
quality (critic, repeats, language) is spec 041.

## Findings this spec answers
| # | Finding (evidence) | FR |
|---|---|---|
| 1 | Chat on Opus/Sonnet spent $1.84 in 47 min on 10-16; the shared $2 `editor.%` cap then blocked 5 production runs (a slot failed) | 001 |
| 2 | 161 tool calls repeated an input that had just failed; one run: 71× `duplicate_idea` from 4 inputs, 1.1 M prompt tokens; 18 % of spend answered all-error batches | 002 |
| 3 | Runs with no successful terminal tool and empty finals end `ok`; slot failed with error text "ok"; chat showed "Something went wrong: ok." | 003 |
| 4 | @ai0_global idea reviewer: 0 reviews since 10-12 — `list_ideas` output truncated at 16 K, no paging, 20+ SQL pages per run, `finish_idea_review` summary > 1000 rejected; 60 ideas `new`, 40 expired | 004 |
| 5 | `submit_plan` 45/75 and `submit_network_plan` 16/19 rejected: idea slots without topic resolved as live ("live-слот без джерела" ×95), `""` / nil UUID placeholders, identical resubmissions ×9 | 005 |
| 6 | 103 of 105 `web_fetch` 404s are guessed URLs; marktechpost.com 403 on 48/48; gamerpower RSS failed 7 days running while `api:gamerpower_giveaways` works | 006 |
| 7 | `file_directive` 65/79 errors: `applied` advice counts as open for 7 days (`directive_open` ×32), missing `kind`/`binding` ×19, `not_executable` for changes already in place ×10; manager on Opus re-runs while the anomaly set is unchanged | 007 |
| 8 | `lint_post` `{ok:false}` is recorded as success (51); a retry overwrites `scheduled_at`, hiding 16–18 min delays | 008 |
| 9 | The intent gate refused «так», «+», «переплануй», «скасуй»: create_agent took 5 turns; replanning failed 5 times | 009 |
| 10 | `add_owner_rule` compares only with the last owner message: precise 8-point rule rejected (9 %), content-free «Ці правила завжди виконуються…» saved; rule points to a non-existent skill | 010 |
| 11 | Playbooks/profiles contradict owner rules (slang, audience, hashtags max 3 while off, polls 2/week vs 1); both 10-16 posts broke owner rules and the critic gave 5/5 | 011 |
| 12 | Owner-written skills never reach the post writer (`applies_to` without executor, `agent_skills` empty, 0 loads); 31/52 skills never loaded | 012 |
| 13 | The chat cannot list, skip, move or regenerate today's slots across channels; multi-mention reaches only the first agent | 013 |
| 14 | Agents claim actions they did not take («Записав правило» with 0 tool calls; «картки не існує» when it was applied) — history has no authors and no action results | 014 |
| 15 | Messages without @mention in an agent chat lose the agent when a channel is picked (`kind: 'legacy'`): `edit_my_skill` → `no_agent` | 015 |
| 16 | `explain_decision` returns nothing for `telegram:@x` (stored as `@x`); `add_idea` silently drops paused / unusable resources | 016 |

## FRs

### Wave 1 — production keeps running
- **FR-001 Budget pools.** Chat turns (composer, named agents, @ai0, @manager in `EditorChatService`) record usage under
  `editor.chat.<role>`; scheduled runs keep `editor.<role>`. The agents' daily cap (`editor.%` / `llm_budgets` global editor row)
  counts scheduled runs only (`editor.%` minus `editor.chat.%`); chat has its own cap — `llm_budgets` `feature_prefix` `editor.chat`,
  seeded by migration 079 at **$1.00/day**, editable in Spend → Budgets. A chat turn also stops at **$0.30** (setting
  `EDITOR_CHAT_TURN_MAX_USD`, catalog 039): the loop ends with `budget_exceeded` and the reply says the turn hit the per-turn cap and
  what was done so far. The total AI cap still applies to both.
- **FR-002 Circuit breaker.** In `AgentLoop`, a tool call whose `(tool, canonical args)` equals a call that errored earlier in the
  same run is not executed; it returns `{error:'repeated_failed_call', details:'<previous error>; change <field> or stop'}`. After 3
  errors with the same `(tool, error code)` in a run, the tool is dropped from the specs for the rest of the run and the model gets one
  line saying so. Terminal tools are never dropped. Counts go to the run record (`repeat_blocked`, `tools_dropped`).
- **FR-003 Honest endings.** A run of a role that has terminal tools ends `no_terminal` (not `ok`) when no terminal tool succeeded;
  slots treat it like `max_steps` (one retry, then failed with the reason). A completion with 0 tokens and no content is retried once.
  In chat, `failureText` never prints a raw status: with no final text it shows the last streamed assistant text, else a plain
  "The agent stopped without an answer (<reason>)".
- **FR-004 Idea review unblocked.**
  - `list_ideas` returns compact rows (`id, title ≤ 120, status, resource refs, source host, created_at`) with `offset` and `total`,
    sized so a page never hits the truncation limit.
  - The idea reviewer's user prompt carries the next batch (≤ 15 `new` ideas, oldest first) so it can start reviewing at once.
  - `finish_idea_review`: summary up to 4000 chars (longer is cut, not rejected); refused with `nothing_reviewed` when the run made
    0 `review_idea` calls while ideas were waiting.
  - `add_idea`: at most 12 successful adds per run; refused with `pool_full` when the network has ≥ 30 ideas in `new`;
    `duplicate_idea` returns the matching idea's id and title and "already in the pool — do not resubmit".
- **FR-005 Planner inputs.**
  - Before validation, optional string / uuid fields that are `""` or the nil UUID are treated as absent (`submit_plan`,
    `submit_network_plan`, slot inputs).
  - A slot with `idea_id` and no `topic` is `fixed`: topic = the idea's title, brief = the idea's brief, sources = the idea's sources.
  - Resubmitting a payload identical to one rejected in the same run returns `same_plan_rejected` with the earlier errors as a
    numbered checklist (FR-002 covers the generic case; this adds the checklist).
- **FR-006 Sources.**
  - Host failure memory (migration 079 `source_host_failures`): 401/403/451/429, DNS and TLS failures mark a host for 24 h;
    `web_fetch`, `extract_images` and `fetch_feed` answer a marked host at once with `host_blocked` (+ alternative when known)
    without a request. 404 says "this URL did not come from a feed, listing or search result — do not guess paths".
  - Known alternatives in code: `gamerpower.com` → `fetch_api gamerpower_giveaways`; a host whose article pages are blocked but whose
    feed is in the card → "use the feed item text".
  - Feed parse failures return `feed_unparseable` (not `tool_failed`) and count as a host failure.
- **FR-007 Directives and manager runs.**
  - Open for dedup = `new`, `awaiting_owner`, `accepted`, `contested`. `applied` advice no longer blocks a new directive; a new one on
    the same target + kind while one is `applied` must name it in `supersedes` (it is then closed as `superseded`).
  - `file_directive`: `kind` first in the schema, `binding` defaults to `advice`, `min_change_pct` has a default; a change already in
    place returns `{ok:true, already_satisfied:true}` instead of `not_executable`.
  - The manager prompt lists the open directives (target, kind, status, review date).
  - A scheduled manager review is skipped when the anomaly set and quality flags equal the last review's (at most one forced review a
    day). Resources without an agent are exempt from `quality_check`.
  - Digest wording: `hashtags_disabled` → "hashtags present while the channel has them off".
- **FR-008 Honest metrics.** `lint_post` / `lint_platform_post` with `ok:false` are recorded as errors (`lint_failed`). A slot retry
  keeps `scheduled_at`; the retry time lives on the run.

### Wave 2 — owner control
- **FR-009 Intent.** Change verbs gain «переплан», «скасу», «відмін», «перенес», «пропусти», «перезапусти», «перегенеруй» and
  en `cancel`, `reschedule`, `skip`, `move`, `regenerate`. A short affirmative reply («так», «+», «ок», «давай», «yes», «yes, do it»,
  «nfr» = «так» in the en layout) to an assistant turn that proposed a change counts as intent for that change. Negation still wins.
- **FR-010 Owner rules capture.**
  - `add_owner_rule` compares the rule with the owner's last 5 messages in the chat (best match).
  - Below the threshold it no longer refuses: it proposes an `owner_rule` card with the rule text and the owner quotes it came from;
    the rule is stored on Apply.
  - Every stored rule keeps `source_text` (the owner's words, migration 079 column on `editor_channel_memory`).
  - A rule that names a skill must name an existing one (`unknown_skill`).
- **FR-011 Rules reach the writers.**
  - Code check `rules-vs-config` runs when a rule is stored, when a playbook / profile changes, and nightly. It compares owner rules
    and the resource style with the active playbook and profile for checkable conflicts: hashtags off ⇒ playbook `hashtag_policy.max`
    0 and no hashtag advice in `format_prefs`; `polls_per_week` ⇒ series cadence of poll / quiz series; slang off ⇒ no «сленг» in the
    tone; audience rule ⇒ profile audience text.
  - Conflicts show on the agent page and in the manager digest. @ai0 gets a `fix_config_conflicts` tool that proposes one card
    updating the playbook / profile to match the rules.
  - The checker (critic) and executor prompts carry the channel's owner rules; the critic scores an `owner_rules` axis (≤ 2 rejects
    with the broken rule named).
- **FR-012 Owner skills reach the writers.** A skill written by the owner or the channel agent for a channel defaults to `applies_to`
  [executor, composer, checker]; such skills are inlined for that agent within the inline budget (an `agent_skills` row is created on
  write). The resource profile's tone attaches the matching `tone-*` skill.
- **FR-013 Slot control from chat.** `get_schedule` and `propose_slot_change` are available to @manager (any resource) and channel
  agents (their resource) in chat; `propose_slot_change` gains `regenerate` (re-run the executor for the slot now). A new
  `propose_replan_today` card re-runs the planner for a resource's remaining slots today. @manager may cover several resources in one
  turn (one card each). Cards keep the Apply confirmation.
- **FR-014 Truthful history.**
  - Each assistant turn in the history carries its author (`@handle:`) and a one-line action record from that turn's tool results:
    cards proposed (kind, status now), rules written, drafts saved, skills changed.
  - After a turn, a claim of an action («записав», «зберіг», «оновив», «надіслав картку», «застосовано») with no matching successful
    tool call this turn triggers one re-prompt: "you claimed X but no tool did it — either do it or correct the reply". If the second
    reply still claims it, a visible note is appended: "(Not done: no tool call recorded this action.)"
- **FR-015 Routing.** In a chat bound to an agent, a message without a mention goes to that agent even when a channel is picked in the
  composer; the legacy composer route is used only by chats without an agent.
- **FR-016 Small fixes.** `explain_decision` accepts `telegram:@x`, `@x` and `x`. `add_idea` errors list the valid resource refs,
  and the network context lists dropped resources with the reason (paused / not usable).

## Owner actions (data, no code)
- Deactivate owner rules #10 (meta-request "онови бриф"), #14 (points to the non-existent `poster-bank`) and #15 («Ці правила завжди
  виконуються для всіх постів»: refers to nothing); re-add the 8-point rule through the FR-010 card.
- Do **not** approve playbook draft Loko v7: it is built on v6 and would roll back the active v8. Discard it and nova v2
  (`pending_owner` since 10-08).
- After FR-011 ships, apply @ai0's `fix_config_conflicts` card (slang in Loko v8, audience in ai_global, hashtag max, poll cadence).

## Decisions
- Separate chat budget instead of a cheaper chat model: the owner chose the Anthropic workspace (spec 038); the cap protects
  production without overriding that choice.
- Circuit breaker in the loop, not per tool: one place covers every tool and role.
- Low-overlap owner rules become cards, not refusals: the owner's intent is never lost, and injected text still cannot write a rule
  (Apply is the owner's).
- Out of scope (spec 041): critic model / language axis / full-article grounding, blocking repeats and fact conflicts, evergreen
  fallback for empty live slots, per-post Telegram views.

## Verification
Unit: budget pools (chat vs production sums, per-turn cap), loop breaker (identical args, same error ×3, terminal never dropped),
`no_terminal` and 0-token retry, list_ideas paging + size bound, finish_idea_review rules, add_idea caps, plan input normalisation and
idea-slot topic, host failure memory, directive open set / supersedes / already_satisfied, manager skip, lint error accounting, intent
verbs + affirmative replies, rule overlap over 5 messages + card fallback, rules-vs-config conflicts, skill defaults, slot cards for
manager, history authors + action line, claim guard, routing, explain_decision keys. PG: migration 079 twice, budget sums on a scratch
DB, host failure TTL, memory `source_text`. Replays: the export's failing runs (`8c07c1c1`, `de987190`, `79124a8a`, `09e2bf82`,
`65cccb1b`) as FakeLlm scripts must now stop early or succeed. No real data, no real channels, no paid calls.
