# Agent review 2 — dev stage, 2026-10-15 16:00 → 10-17 15:18 UTC

Second offline review of the agents' work (the first covered 10-07…10-16 and led to spec 040). Source: `scripts/export-agent-history.sh 2` on the dev stage at `85f3e7f8` — 143 runs, 1417 steps, 2 owner chats (18 turns), 15 published posts, 26 slots, 107 ideas, 16 directives, 58 manager reviews, 2 setup proposals (042), 1 steering set (045). Five analysts (tools, content, control layer, chats, planning/cost) plus one autonomy gap analysis; the key findings were re-checked in code.

Caveat: at 10-16 10:12 UTC `ai.workspace` was switched to `anthropic` (every role on Sonnet, manager / checker / weekly reviewers on Opus) — two hours **before** 040 went live (≈14:00). Before/after numbers mix both changes.

## 1. Verdict

- Spec 040 worked where it aimed: `file_directive` errors 35/41 → 2/4 (supersede path used correctly), `duplicate_idea` 16 → 0, idea reviewer `max_steps` 2 → 0, slots always have a topic, chat budget is separate, chat 2 was fully truthful.
- Money is now the first problem: $11.27 in 2 days (vs $4.88 in 9). Per published post ≈ $1.21 on Claude vs ≈ $0.06 on GLM. The Opus manager is a third of the spend and filed no directives in its last 4 runs; 43% of slot spend bought no post.
- The manager is half-blind: `get_kpi_digest` fails 8/8 and the digest in its prompt is cut mid-JSON.
- Content: ~9 of 15 posts carry a real language or rule defect; nothing checks Ukrainian grammar; the critic passes posts with its own unapplied fix notes; topic repeats slip past URL-level dedup.
- Owner data actions from review 1 were not done, so the config conflicts are still live (see §6).
- Autonomy: production on Telegram is good (Act 3/5, Verify 3.5/5); the learning loop, self-maintenance and growth/money are not closed (Sense 2, Decide 2, Self-maintenance 1.5, Owner interface 2, New channel 1.5).

## 2. Cost and budget

| Finding | Evidence | Root cause | Fix |
|---|---|---|---|
| Spend ×14 per post after the model switch | Kyiv day 10-15 $0.45, 10-16 $4.53, 10-17 $6.56 by 15:18; Sonnet executor $2.04, Opus manager $1.67, Opus checker $1.18 on 10-17 | global `ai.workspace=anthropic`, `ai.anthropic.critic_model=opus`, `agents.anthropic_model=opus` on manager + 3 reviewers; caps sized for GLM | choose a model per role on purpose (manager/checker Sonnet or risk-routed, orchestrator/idea reviewer GLM/Haiku), target ≈ $2.5–3/day; or keep and set caps on purpose + a `provider:anthropic` cap |
| Budget order is first-come; budget-stopped slots are lost | 10-16 10:59 global $2.04 ≥ $2 (manager $1.10 of it) → news_dev slot `016c1be9` failed; 15:00 channel cap → `b299c472` failed; neither retried after the cap was raised | `budget.service.ts:53` checks before each call; no reserve for writers; `agent-loop.ts:243` stops mid-run | reserve for `editor.executor`/`editor.checker`; manager + wake-ups skip above ~60% of cap; check headroom for a whole run before starting; `budget_exceeded` keeps the slot `planned` with `retry_at` |
| Rewrite chain: 43% of slot spend buys nothing | executor+checker on unpublished slots $1.88 of $4.37; slot `0c3fbe1d` 3 executor + 5–6 checker runs for an off-topic evergreen glossary | fallback ladder initial → revise → revise → next candidate → evergreen, each with an Opus check; 44/48 accepted ideas have one source | one revise then skip; no evergreen fallback on news channels; a critic-rejected sole source kills the idea; critic spend cap per slot |
| Manager runs twice after restarts; never skips | 6/16 runs off-schedule (same digest as the previous run); every review opens with a "posts" anomaly | in-memory `done` Set (`manager-runner.ts:125`); 28-day baseline includes pre-launch days (`kpi-math.ts:46`); `reviewSignature` includes per-post quality flags | persist due keys in the DB; baseline over the resource's lifetime only; signature from anomalies + uncovered flags; 1–2 runs/day after the audit |
| Swept run reports $0 | `fd7ec662` 25 steps, $0.009, shown as $0 | sweeper (`editor-plans.repository.ts:553`) does not sum step costs | sum steps on sweep |

## 3. Manager and directives

| Finding | Evidence | Root cause | Fix |
|---|---|---|---|
| `get_kpi_digest` always fails; prompt digest cut | 8/8 `tool_failed` "Unterminated string in JSON at position 19991" | `renderDigest` slices to 20k and appends `…(обрізано)` (`kpi-digest.service.ts:133`); tool `JSON.parse`s it (`directive-tools.ts:291`); sections after `resources` (budget, directives, compliance, config_conflicts) are lost | drop whole sections instead of slicing; small keys first; return the object; `get_kpi_digest(resource)`; test that render always parses |
| `submit_review` gate costs 2 extra Opus turns per run | 14/30 errors; `quality_check_missing` for the new 042 channels, `quality_flags_ignored` for agentless facebook | the stubbed resources ("без аномалій…") still need numeric evidence (`directive-tools.ts:96`); returns the first problem only; the agentless exemption skips the flags check | exempt stubbed / young (<48 h or < N posts) / agentless resources; list required refs in the prompt; return all problems at once |
| `accepted` tasks still block new directives | 1 `directive_open` after 040; manager switched kind task → advice to get around it | `OPEN_FOR_DEDUP` includes `accepted` (`directives.repository.ts:77`); supersede works only on `applied`; the error has no remedy | allow `supersedes` on accepted; remedy in the error text |
| Applied ≠ followed | `fc1d552f` "оновлюю бриф" but playbook v4 still lists marktechpost (5 posts in 7 days); `a06cc971` wrote v8 from v6 and lost v7's fallback chain → "Роздача дня" skipped; 5/10 applied are `self_reported` only; `report_directive_done` called 0 times | verification trusts the agent; directive executor ignores pending drafts | mark applied only when a playbook/brief diff lands or the change is observed; rebase on / supersede pending drafts; planner gets open directives |
| Ambiguous audit code → wrong advice | GLM read `hashtags_disabled` as "turn hashtags on" (c38e43f4, fbdb30a5) | code name | rename to `hashtag_while_off` |
| Manager tool friction | `sql_readonly` 5/13 failed on guessed columns; `get_playbook` throws "network tools need an orchestrator context" | no column hints (`read-tools.ts:130`); `network-tools.ts:56` | schema hint + real columns on Postgres 42703; read-only `get_playbook(handle)` for the manager |

## 4. Tools and loop

- `sql_readonly` 12/78 and `query_data` 9/24 (`unknown_field`: 5/6 asked for `title`/`body`) — the errors do not list valid columns/fields; `data-tools.ts:48` and the tool description still say "title/body".
- `number_not_in_sources` is false in 18/19 critic mentions («5,120», «$2,599.99», «18-core», «3,552x3,840») and triggers rewrites (`post/grounding.ts:105-121`).
- The 040 repeat guard never fired (0 `repeat_blocked`); after 040 there were no verbatim repeats — unproven whether the guard or the stronger model did it.
- One misuse blocks a whole host for feeds for 24 h (gamerpower JSON API sent to `fetch_feed`); an oversized pcgamer RSS (>2 MB) throws instead of being remembered.
- Onboarder (042) `submit_channel_setup` fails 2/4 on nested objects sent as JSON strings, once with leaked tool-call XML (`setup/setup-analysis.ts:54`).
- `update_series` refused because the @ai0_global playbook still lists instagram/facebook platforms (`network/playbook.ts:106`).
- A critic-rejected attempt ends `ok` (`critic-gate.ts:361`) and the fallback starts a new executor run — by design, but it hides cost; show attempts per slot.

## 5. Content quality (spec 041 scope)

Posts (15): 1718 and 1716 clean; defects in ~9 — wrong case «у найвідоміших сервісів» (1713), calques «заточений» (1714), «на борту» (1715), «по перевернутій рампі» (1719), «У інших» (1721), «її» → licence (1724), gaming slang «ачівки», «синґл» (1726), hashtags while off (1712, 1714), rule #11 "keep it simple" broken by «816 млрд параметрів… MCP-Atlas…» (1717), evergreen glossary on a news channel (1721), a poll without the picture the brief asks for (1725).

| Finding | Root cause | Fix |
|---|---|---|
| A pass ignores the critic's own fix notes (7/15 passes) | `critic-gate.ts:330` publishes any pass; `decideVerdict` (`critic.ts:76-91`) only acts on scores ≤ 3 | `pass_with_edits`: exact `{from,to}` replacements applied by code, lint again; a 4 with a quoted problem → revise |
| Nothing checks Ukrainian grammar | no lexicon; `slop-lint.ts:151 SLANG_MARKERS` has no gaming slang; the critic asks about tone | deterministic russism/calque/case/у-в lexicon + domain slang lists; required `language` axis, ≤ 3 → revise |
| Topic repeats invisible to dedup | `story-match.ts:31` needs ≥ 3 shared entities (explainers have none); `CROSS_CHANNEL_HOURS = 24`; ledger is per URL — "image prompt formula" ×3 in 3 days on @ai0_global, Muse Spark on two channels 31 h apart | explainers/how-tos are evergreen in code; semantic topic key (30 d own channel, 72 h network); idea generator checked against it |
| Owner rules don't reach the style; sources contradict | rule #11 not in the @ai0_global profile (audience "розробники"); loko tone "сленг" vs `format_prefs.slang` off; @pdr `hashtag_min 1` with an empty vocab → invented #пдр | one resolved style (owner rule > profile > card > 042 > 045) with conflict detection; owner rules write through to the profile |
| Owner rules checked only when the model chooses | `owner_rules` axis optional (`critic.ts:55`); GLM returned none | required when rules are in the prompt; quote the rule |
| Critic sees ≤ 6 passages of ±400 chars | `critic-passages.ts:5-7` | passages for claims without numbers too; fix lint false positives (thousands separators, ranges, enumerations, «зви») |
| Opus checker: worth it for grounding, not for language | Opus caught Riot «у липні», a Cyberpunk quote, Steam Frame RAM, a post on the wrong topic; GLM passed 5 defective finals | route by risk: Opus for external-source posts with numbers/quotes; cheaper model + lexicon for evergreen/library posts |
| 042 proposals from thin data | @pdr: 20 test posts in one day, one with text → `posts_per_day_max 10`, quiet hours 02–11 | refuse or mark "insufficient data" when span < 7 days or text posts < 5; enforce brief media requirements in lint |
| 045 steering set (AI HOUSE → @ai0_global) | mostly sound; 7/20 reference posts without text incl. the top one; s6 "0–2 emoji" vs source median 3; s7 weekly digest may clash with the daily series | show text-less posts as such; check numbers against computed metrics; conflict check against series |

Regression set: add the 9 defective posts to the golden set so lint and the critic must flag them.

## 6. Owner chats and rules

- 040 worked live in chat 2 (all claims backed by steps, no posing as human). Untested live: the publish fix, the replan card, @manager in chat.
- Intent gate still blocks clear choices: «хай буде ім'я — Машина» → `needs_explicit_request`, the owner had to add «давай» (`mentions.ts:32-57`, `owner-intent.ts:19-55`, `builder-tools.ts:58`). Tools that only propose a card should not be verb-gated — the Apply click is the confirmation.
- False denials are not checked: the claim guard (`turn-record.ts:96-130`) checks only positive claims; review 1 had «нічого не застосовано» while card `a657a845` was applied. Put the chat's card statuses and the handle roster in context; re-prompt on denials that contradict `pending_actions`.
- A message with several @mentions reaches only the first (`editor-chat.service.ts:211-224`).
- Rule lint at write time: #15 has no content, #14 names a skill that does not exist (`poster-bank` → executor error 10-17 06:30), #10 is a meta-request. Reject pointer-only rules and unknown skill names; let the owner card store multi-point rules (the 8-point rule was lost).
- Composer critiques a pasted post without looking it up first («Я не бачу цього поста в даних», found one turn later).
- @pdr cannot run quizzes: the onboarder allowed only poll/text/photo though the dataset is `quiz_question`.

**Owner data actions still pending (from review 1)** — do them in the UI or let the new rule tools do them:
1. deactivate rules #10, #14, #15; re-add the 8-point rule via the card;
2. merge @loko v7's fallback chain and grounding rule into v8, then discard v7; discard nova v2;
3. resolve the config conflicts: nova hashtag vocab vs hashtags off (13/13 posts flagged), nova poll/quiz formats vs `polls_per_week=0`, loko "Опитуйка" twice a week vs `polls_per_week 1`, loko "сленг" vs rule #9, @ai0_global audience vs rule #11, rule #3 health feeds vs topic rule #1;
4. 042 @pdr proposal: reject `posts_per_day_max 10` and the 02–11 quiet hours.

## 7. Planning and ideas

- Planned vs published: 10-16 6/10, 10-17 6/11 due (game_exchange 1/4, prompts_dev 0/1 — the library has no prompt text).
- nova_dev over-produces (38 accepted vs ~3 slots/day; 27 expire 10-18…20); ai_global backlog keeps `pool_full` (limit 30, reviewer drains ≤ 15/day). Fix: ~4 adds per run at 3 slots/day; no wake-up orchestrator run unless a directive needs ideas; a second review batch when the backlog > 15.
- `schedule.times` on orchestrators is read only for the manager (`manager-runner.ts:144`) — remove it from the orchestrator UI or honour it.
- Sub-agent modes mislead: @pdr / @ai0_prompts_dev planner/executor/ideas are `off` but ran and published; older channels' sub-agents are `approve` but publish live.

## 8. Autonomy gap analysis

Done well: code-enforced guardrails (binding vs advice, experiment quotas, owner-only autonomy switch, copy guard, host-failure memory); the quality pipeline (critic, lint, story registry, audit; agents skip rather than invent); measurement (digest, directive outcomes with confounders, skill rollback on KPI drop); owner direction tools (rules, playbooks, 042, 045, approval mode, spend caps).

Ranked gaps:
1. **Connections do not heal** — both Threads tokens expired in August and nobody noticed; no cron refreshes Threads tokens, `meta_accounts.token_expires_at` is never read, health alerts fire once. → connection keeper (S–M).
2. **Budget can starve publishing** (§2) (S).
3. **The learning loop has not closed** — 16 directives, all advice, outcome `None`; `agent_memory` empty; 0 agent skill edits; goals are a priority enum with no numbers; audiences of 3–14 followers never reach the sample guard. → numeric targets per channel, weekly retrospective writing versioned playbook/skill proposals, real experiment units, honest "insufficient data" (M–L).
4. **No two-way owner channel or periodic report** — `OwnerInbox` is one-way; spec 012 is blocked behind 011. → owner control bot split from 011: one-tap cards + daily/weekly report (M).
5. **No audience feedback** — no tool reads or answers comments/DMs (epic 044) (M–L).
6. **Growth and money not built** — 011, 013–016 are SPEC; discovery/teleads not exposed to agents; ad prices static (L).
7. **Native platforms and media unproven** — `platform_posts` empty, no image generation, TikTok `SELF_ONLY` (M).
8. **No eval gate** — last eval results 2026-10-01, evals not in CI; the model switch shipped with no behaviour check (M).
9. **Source maintenance manual** — a dead host is blocked for 24 h but never replaced and the owner is not told (S–M).
10. **New channel needs much owner work** — create channel, admin bot, `is_mine`, card mode `off`, Meta tokens; setup needs ≥ 5 posts; graduation is a weekly suggestion card (M).

Suggested order: ops autonomy → owner control bot → goals & learning loop → eval/replay gate → native platforms live + image generation → audience feedback (044) → growth & monetisation (011 → 015 → 014, discovery) → zero-to-running channel launch.

## 9. Owner requests in this round (2026-10-17)

- Setup from history and steering become **chat commands** handled by the agent in the conversation; the separate `/app/setup` and `/app/steering` pages go away.
- A single **Artifacts** page with a type filter (setup, steering, then memory, skills, rules, playbooks…); each agent page gets an **Artifacts** tab with the same list for that agent.
- What a command produces is an **artifact in the chat** that the owner can open, edit by hand or ask the agent to update; every change is a new version.
- The chat UI looks like Claude: the app's side menu hides, the chat list and the thread take the screen.

## 10. Work items

Linear epics (team ai0, project ai0_project):
- **041 Content quality** (AI0-179; T1–T9 AI0-192…200) — language gate, pass-with-edits, one resolved style, topic-level dedup, critic economics, grounding coverage, 042 data gate, regression set.
- **046 Engine fixes from review 2** (AI0-178; T1–T10 AI0-182…191) — KPI digest, review gate, directives lifecycle, manager schedule/cost, budget reserves and slot retry, rewrite chain, ideas pipeline, tool hints, loop details.
- **047 Owner chat and rules** (AI0-180; T1–T7 AI0-201…207) — intent gate, denial check, multi-mention, rule lint and multi-point rules, config-conflict resolver for the pending owner actions.
- **048 Chat workspace and artifacts** (AI0-181; T1–T8 AI0-208…215) — Claude-like chat, slash commands, artifacts in chat, Artifacts page, agent Artifacts tab, setup/steering pages removed.
- **049 Ops autonomy** (AI0-216; T1–T5 AI0-221…225) — connection keeper, repeat alerts, source health and replacement proposals.
- **050 Goals and learning loop** (AI0-217, tasks after a brainstorm) — numeric targets, weekly retrospective, experiment units, insufficient-data policy.
- **051 Agent eval gate** (AI0-218) — nightly evals + replays, gating model/skill/prompt changes.
- **012 Owner control bot (split from 011)** (AI0-219, tasks after a brainstorm) — cards and daily/weekly report.
- **052 Channel launch** (AI0-220, tasks after a brainstorm) — zero-to-running flow with auto-graduation.

Existing epics that stay: 043 (setup for IG/FB/Threads), 044 (conversation agents), 030 (YouTube/LinkedIn); 011, 013–016 remain specs.
