# 034: Content quality and live planning: human voice, a pre-publish critic, fewer polls, fitting formats, live news slots, a readable plan

**Status:** SPEC · **Priority:** P0 (above every open spec; owner request 2026-10-08) · **Depends on:** 017–025, 031, 033
· **Migration:** `067_content_quality.sql` if needed (spec 030 moves to the next free number)

**Owner request (2026-10-08, after running the agents live on dev-stage):**
1. Posts sound like AI. The no-slop and human-voice skills are not used. Agents reach for slang and jokes and do them badly.
   The reviewer does not catch stupid texts.
2. The brief spreads every format (carousels, longreads, …) even where it does not fit; texts are often bad. The agent-creation
   chat should write content examples and warnings about potentially bad posts.
3. It is unclear what the planner planned and when. On news channels the planner plans the whole day in the morning, so news that
   appears during the day is never published.
4. The plan view should show either a scheduled tool call ("at 14:00: fetch news and write the post") or a post preview.
5. Fewer polls and questions to the audience by default. MANAGER does not catch this and says "no problems".
6. Review every skill and fix what is stale.

## Why (as-is, from the code at e1bb12a)
- **Voice skills never reach the writer.** `anti-slop` and `human-voice` exist in `editor-skills/`, but executors only see them as
  a one-line entry for an optional `load_skill` (`roles/prompts.ts:53-54`). `anti-slop` (7.8k chars) cannot be inlined: the inline
  budget is 8k and the executor workflow uses 2k of it (`prompts.ts:16,29`), the DB inline cap is 4k (`agents/skill-lint.ts:5`).
  Platform and derived (adapt/duplicate) executors get no voice line at all (`editor-runner.service.ts:316-338`,
  `network/derived-slots.ts:176-199`). In evals only 5 of 59 executor runs called `load_skill`. The channel-* tone skills used by
  the legacy strategies are not in `editor-skills/`, and strategy migration drops them.
- **No pre-publish review of the text.** The `reviewer` role is a weekly metrics analyst; the `checker` role is defined but unused.
  The only automatic slop check is 21 substrings (`post/lint-post.ts:12-18`), one with an ASCII apostrophe that never matches ʼ/’.
- **Polls and questions are pushed, never capped.** Builder-created cards get all 8 formats at weight 1, polls and quizzes included
  (`chat/default-card.ts:17`); the planner treats weights as frequency; no per-day/week cap exists. Playbook sections require a CTA
  (`network-prompts.ts:114`); `platform-facebook`, `platform-threads`, `platform-instagram` and `format-poll-quiz` tell the agent to
  end with a question or run a poll.
- **MANAGER cannot see quality.** Its digest has numbers only; `get_network_posts` returns titles, not texts; it never sees owner
  rejections or edits; its prompts say "continue" is the normal answer (`manager-runner.ts:64,143`, `manager-workflow.md:9,49`),
  and the run is skipped when the digest hash is unchanged.
- **Every format is offered to the playbook build** and nothing asks for a fitting subset; the format "when to use" rules
  (`format-longread`: "not for news, 1–2 per week") are invisible to the orchestrator and the builder. The playbook has no place for
  example posts or do/don't lists; `profile.examples` holds channel handles. `create_agent` with a brief does not start a playbook
  build (`AgentCreator` is built without `onBrief`, `editor.module.ts:618`).
- **News is planned once a day.** Live/shadow channels plan at `plan_hour` (06:00), approval channels at 20:00 the day before
  (spec 031). Every slot needs a fixed `topic` (min 5 chars) at planning time; there is no deferred-topic slot and no intra-day
  replanning; the manual replan throws the whole day away. Freshness ("≤ 48 h") is skill text only; `fetch_feed` has no age filter.
- **The plan is hard to read.** `editor_plans.created_at` and `run_id` are stored but never shown; slots show topic and format, a
  preview exists only after the executor ran; the Upcoming card lists series and pins only. Orchestrator `schedule.times` is
  editable but ignored.
- **Stale skills:** `agent-onboarding` (shadow instead of approve), `editor-orchestrator-workflow` (broken list at :25, heavy-format
  example, YouTube "after 019b"), `editor-planner-workflow` ("today" in approval mode), `editor-executor-workflow` (step count),
  `format-carousel` / `format-poll-quiz` (`library://` refs, shadow-only notes), `format-hashtags` (vocabulary claim),
  `format-emoji-typography` / `format-links-attribution` (ignore `format_prefs`), `platform-youtube` (019b → 030), `idea-review`
  (no format-fit check), `editor-reviewer-workflow` (rewards quizzes, ≥ 3-posts rule keeps unused formats).

## Functional requirements
| ID | Requirement |
|---|---|
| FR-001 | **Voice core always in the writer's prompt.** A compact `voice-core` block (≤ 2 500 chars: the strongest anti-slop bans, human-voice rules, Ukrainian typography, "no slang, no jokes unless the resource allows humour", "facts over adjectives") is inlined for every role that writes reader text: executor (Telegram, platform, derived/adapt), composer and the critic (FR-004). The full `anti-slop` and `human-voice` skills are auto-attached to the executor's context budget-aware (not via optional `load_skill`). Budget: `voice-core` does not count against the 8k inline budget. |
| FR-002 | **Humour and slang are opt-in.** `format_prefs.humor: 'none' \| 'light'` (default `none`) and `format_prefs.slang: boolean` (default false), owner-lockable. With `none` the prompts forbid jokes, wordplay, memes and slang; the critic fails a post that uses them. The builder asks the owner before enabling them. |
| FR-003 | **Deterministic slop lint.** `lintPost` gets a normalised (apostrophes ʼ’' and case) banned-phrase list built from `anti-slop` (≥ 80 entries), plus counters: em-dash density, exclamation marks, rhetorical question answered in the next sentence, moralising last sentence patterns, three-item adjective lists, emoji over policy. Hard errors for banned phrases; warnings for the rest, fed to the critic. Shared by Telegram and platform lint. |
| FR-004 | **Pre-publish critic.** Before `publish_post` (live), before shadow storage and before an approval card is created, a `critic` run (the `checker` role, its own model, default stronger than the executor) scores the post: `ai_likeness`, `sense` (coherent, not stupid, matches the topic/source), `voice` (fits the resource tone, humour/slang rules), `grounding` (facts in the source), `audience_asks` (questions/poll fit), `format_fit`. Verdict `pass` / `revise` (notes go back to the executor for one rewrite, then a second critic pass) / `reject` (slot skipped with the reason). The verdict, scores and notes are stored on the slot, shown in the run trace and on the approval card. Fail-safe: a critic error never publishes silently in live mode (retry once, then hold as `failed` with an Inbox entry). Daily critic budget counts in spec 029. |
| FR-005 | **Fewer polls and audience questions by default.** New cards and playbooks: poll and quiz weight 0 unless the owner asks or the resource is a quiz/education resource; per resource caps `polls_per_week` (default 1) and `questions_to_readers_per_day` (default 1), owner-editable in the profile. Plan validators (single-channel and network) refuse a plan over the poll cap; lint counts reader-directed questions (`?` sentences addressed to "ви/вас/ваш/як думаєте/а ви") and fails over the cap; news posts default to 0 questions. Playbook `cta` becomes optional and defaults to none. Skills stop telling agents to end with a question. |
| FR-006 | **MANAGER quality audit.** The digest gains per resource for 7 days: critic verdict counts and mean scores, top critic notes, poll/quiz share, posts with reader questions, owner rejections and edits from approval (031) with their reasons, and 3 sample post texts (first 400 chars). `manager-workflow` gets a "content quality" checklist; "continue" is allowed only after the checklist is answered with evidence; a run is not skipped when quality signals changed. MANAGER files advice (or a directive on repeated failure) of new kinds `voice_fix` and `format_mix` with an executor that writes playbook `rules`/`examples` or caps (spec 025 framework). |
| FR-007 | **Fitting formats only.** `makeDefaultCard` enables `text` and `photo` only; other formats are added on purpose. `playbookBuildPrompt`, `editor-orchestrator-workflow` and `agent-onboarding` require choosing a subset that fits the topic and audience, with a one-line reason per format; the format "when to use" skills (`format-longread`, `format-carousel`, `format-album-slider`, `format-video`, `format-poll-quiz`) become visible to builder, orchestrator and idea reviewer. `validatePlaybook` warns when a section enables more than 4 formats; `idea-review` checks format fit. Reviewer weight rules let an unused, unfitting format drop to 0 in one step on owner or critic evidence. |
| FR-008 | **Content examples and warnings in the creation chat.** While creating an agent (and on `set_brief`), @ai0 writes 3 example posts for the resource (rendered as Telegram previews in the chat, using the existing `TelegramPreview`) and 2–4 warnings: concrete "bad post" patterns for this topic (e.g. clickbait, forced humour, polls nobody answers) with a short bad example each. The owner can mark examples good/bad and edit them. Approved examples and warnings are stored in the playbook as `examples[{format, text, verdict: good\|bad, note}]` (≤ 12) and used as few-shot by the executor and as reference by the critic. |
| FR-009 | **Builder fixes.** `create_agent` with a brief starts the playbook build (wire `onBrief`); a brief for an existing card is written to it. `ActionCard` for `create_agent` shows brief, tone, taboo, formats and schedule and says "starts in approval mode". Profile `taboo` stays topics (prompt + critic), not literal lint terms; literal banned words go to `bannedTerms` only when the owner lists words. |
| FR-010 | **Live news slots.** A slot gets `topic_mode: 'fixed' \| 'live'`. A `live` slot has a source (feeds/API/series source) and a brief instead of a fixed topic; the executor at slot time fetches, filters items by age (`max_age_hours`, default 6 for news) and by the content ledger + semantic dedup against the resource's last 7 days, picks the best item and writes; nothing fresh → `skip_slot` with reason `no_fresh_item`. News resources and series with a feed source default to `live`. `fetch_feed` gains `since_hours` and returns item age. Approval mode: live slots are written at the existing 2 h lead with `freshness_deadline` (031). |
| FR-011 | **Intra-day refresh without throwing the day away.** A partial replan replaces only future `planned` slots (not running, written, approved, pinned or reserved). News resources get an optional `news_watch` cadence (e.g. every 2 h within active hours): a cheap code check of the feeds; if a high-score new item appears and the day has room under caps, a `live` slot is added (no LLM planner run). The UI "Replan" becomes "Replan the rest of today" (and "tomorrow" in approval mode). |
| FR-012 | **Readable plan.** Plan tab, Schedule tab and `/app/editor` show per slot: time, resource, `fixed` topic with a preview button or `live` "At 14:00: fetch {source} → pick the freshest item → write {format}"; series, source hints, idea, critic verdict once written. "Planned at {time} by {planner run →}" on every plan (link to the trace); plan history (superseded plans, collapsed); approval channels say "planned the evening before at 20:00". The Overview Upcoming card lists ordinary slots too. On-demand **Preview** for a fixed slot runs the executor in dry mode (no publish, stored as the slot draft, critic included) and counts in spend. |
| FR-013 | **Schedule settings tell the truth.** Orchestrator `schedule.times` either drives the orchestrator/planner run or is removed from the UI; the card's `plan_hour` and the approval batch hour are shown where the plan is. Fix the zone mismatch in `maybeOrchestrate` (card zone vs Kyiv date) and "today" wording in prompts when planning tomorrow. |
| FR-014 | **Skills audit.** Fix every stale skill listed in *Why*; bring the legacy `channel-*` tone skills into `editor-skills/` as optional resource voice skills and attach them on strategy migration; make `anti-slop`, `human-voice` and `voice-core` locked (agents cannot override them); add a skills test: every backticked tool exists, no `library://`, no "shadow" as the default start, `applies_to` roles exist, size limits for inlined skills. |
| FR-015 | **Evals (written, not run).** `executor-voice-plain` (no slang/jokes, no banned phrases), `critic-rejects-slop`, `critic-rejects-nonsense`, `planner-poll-cap`, `builder-fitting-formats`, `builder-examples-and-warnings`, `manager-flags-quality`, `executor-live-news-fresh`. |

## Non-goals
- A different default writer model (owner decision; the critic model is separate).
- Learning a style model from the owner's posts (beyond examples and approval feedback).
- Real-time (push) news ingestion; FR-011 polls feeds on a cadence.

## Open questions (defaults used unless the owner says otherwise)
1. Critic model: default `anthropic/claude-sonnet` class via OpenRouter (≈ $0.01–0.03 per post) vs the cheap executor model. **Default: a stronger model, owner can switch.**
2. Poll cap default 1 per week per resource, questions to readers 1 per day (0 for news). **Default: yes.**
3. Humour off by default everywhere, including entertainment resources, until the owner turns it on. **Default: yes.**
4. `news_watch` default cadence 2 h, 08:00–22:00 local, max 3 added slots a day. **Default: yes.**

## Task breakdown
### T1: Voice core in every writer prompt, humour/slang opt-in, deterministic slop lint
FR-001, FR-002, FR-003. **Size:** M
### T2: Pre-publish critic (pass / revise / reject) for live, shadow and approval
FR-004. **Size:** L · Depends on T1
### T3: Fewer polls and audience questions: defaults, caps in validators and lint, skills
FR-005. **Size:** M
### T4: MANAGER content-quality audit
FR-006. **Size:** M · Depends on T2, T3
### T5: Fitting formats, examples and warnings in the creation chat, builder fixes
FR-007, FR-008, FR-009. **Size:** L · Depends on T1
### T6: Live news slots and intra-day refresh
FR-010, FR-011. **Size:** L
### T7: Readable plan: live-slot descriptions, previews, planned-at/by, history, schedule truth
FR-012, FR-013. **Size:** M · Depends on T6 (live slot rendering), T2 (critic verdict)
### T8: Skills audit and skills test
FR-014. **Size:** M · first, unblocks T1/T3/T5 wording
### T9: Evals (written, not run)
FR-015. **Size:** S · Depends on T1–T6

**Order:** T8 → (T1 ∥ T3 ∥ T6) → (T2 ∥ T5) → (T4 ∥ T7) → T9.

## Success criteria
- Every executor/platform/derived run's system prompt contains `voice-core` (unit test on the built prompts).
- A post with a banned phrase, a joke on a `humor:none` resource, or a second reader question fails before publishing.
- A critic `reject` never reaches the channel; a `revise` produces exactly one rewrite; verdicts are visible on the approval card.
- A new builder-made agent has ≤ 4 formats with reasons, 3 example posts and warnings in the chat, and poll weight 0.
- On a news resource, a feed item published at 15:00 can be posted the same day (live slot or news_watch), with no repeats.
- The Plan tab says when and by which run the plan was made, and every slot shows either a live-slot description or a preview.
- MANAGER's digest shows critic and poll stats; an eval with deliberately sloppy posts makes it file advice instead of "continue".
