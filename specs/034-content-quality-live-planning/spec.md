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

## Implementation notes (T8)
- **Stale skills fixed** (`apps/automation/editor-skills/`): `agent-onboarding` (new agents start in approve, the
  brief drives the playbook build, only fitting formats with a one-line reason each, `format_prefs`/`format_locks`,
  auto-duplication continues until live, tone skills and the voice lock); `editor-orchestrator-workflow` (list at :25,
  fit-driven formats instead of «лонгрід/карусель/фото», 2–4 formats per section with reasons in `rationale`,
  Reels/TikTok video → 016, YouTube → 030); `editor-planner-workflow` (plans "the date in the prompt"; approval = the
  next day at 20:00); `editor-executor-workflow` (14 steps, 6 for a duplicate; live/approve/shadow outcome of
  `publish_post`; `format_prefs`; hashtags from the vocabulary only when it exists); `format-carousel`,
  `format-longread` (approve renders slides / the Telegraph page, only shadow previews as text); `format-carousel`,
  `format-poll-quiz` (`data://` refs); `format-hashtags` (vocabulary enforced only when non-empty; Telegram vs platform
  lint; `format_prefs.hashtags`); `format-emoji-typography` (`format_prefs.emoji` vs the card's `emoji_policy`);
  `format-links-attribution` (`format_prefs.links`); `platform-youtube`, `platform-instagram`, `platform-tiktok`
  (019b → 016/030, "not available now"); `idea-review` (format fit in `platform_fit`, playbook format check: all or
  > 4 formats, heavy formats on news, polls without a reason); `editor-reviewer-workflow` (no quiz-favouring example;
  an unfitting format is lowered even with < 3 posts). The capability notes of the unimplemented video formats
  (`platform/capabilities.ts`) say 016/030 instead of 019b.
- **Reviewer weights.** `set_format_weights` keeps its ±0.2 step and the repository clamps weights to ≥ 0.05, so the
  reviewer lowers an unfitting format by 0.2 a week to 0.05 and asks the owner to drop it. The one-step drop to 0 on
  owner or critic evidence (FR-007) is left to T5.
- **Resource tone skills.** The nine legacy `apps/automation/.claude/skills/channel-*` skills are ported to
  `editor-skills/tone-<channel>.md` (Ukrainian, `applies_to: [executor, composer]`; birthday-story's raw HTML frame
  became PostSpec blocks; hashtag vocabularies defer to the card; lengths defer to `format_prefs.length`). The prefix
  `tone-` (not `voice-`, so `voice-core` stays unambiguous) makes a skill opt-in: `SkillLibrary.list(role)` leaves it
  out and `SkillStore.listForAgent` defaults a builtin tone skill to off. `TONE_SKILL_BY_TYPE`
  (`migration/type-mapping.ts`) maps the strategy types that wrote with a channel skill (recipe-carousel shares
  recipes'); `StrategyMigrationService.writeDraft` attaches the tones of the mapped bindings to the orchestrator
  (`SkillStore.attachShared`: enabled + inline, role children inherit; an owner "off" is kept) and names them in the
  `playbook_pending` Inbox item. The legacy strategies still read `.claude/skills/channel-*` (unchanged).
- **Voice lock.** `PROTECTED_SKILLS` (`anti-slop`, `human-voice`, `voice-core`) in `skills/skill-library.ts`: parsed
  as `safety` by name (no frontmatter change, holds for `voice-core` as soon as T1 adds the file), so the builtin
  rows sync with `safety=true`; `writeAgentSkill` refuses agent writes by name too, and `write_skill` / `edit_my_skill`
  refuse to propose them. The owner can still override with force on the agent page (existing safety rule).
- **Skills test** (`skills/skills-audit.test.ts`), each rule with a failing fixture: backticked `verb_object`
  identifiers must be registered tools (registry scanned from `defineTool` in `src/`, including the
  `attach_skill`/`detach_skill` factory; allowlist: the directive kinds `pause_resource`, `pause_series`); no
  `library://`; no shadow as the default start (`shadow-режим`, "starts/працюватиме … shadow", "перші N днів … shadow");
  frontmatter parses, name = file name, unique; `applies_to` present, non-empty, known roles; inline sizes: role
  workflow skills ≤ 6 000, `editor-executor-workflow` ≤ 2 600, tone skills ≤ 4 000, `voice-core` ≤ 2 500. Plus the
  lock, the opt-in listing and the tone mapping; PG tests for the lock/attach (`agents.pg.test.ts`) and for the
  migration attaching `tone-recipes` (`strategy-migration.pg.test.ts`).
- **Left for T3** (poll/question pushes, untouched here): `platform-facebook` (description «заклик до обговорення»,
  `fb_text` «питання до аудиторії», «Закінчуй питанням…»), `platform-threads` («одне питання», «коротке питання до
  читачів»), `platform-instagram` (cover «обіцянка або питання», last slide «заклик»), `platform-tiktok` (slide 1
  «…питання»), `format-poll-quiz` («Залучення … через голосування», the «Як думаєте…?» intro).

## Implementation notes (T1, 2026-10-08)
- **FR-001 voice core.** `editor-skills/voice-core.md` (body 2 490 chars, Ukrainian, `applies_to: [executor, composer, reviewer, checker]`,
  no backticked identifiers). `roles/voice.ts` renders it into every writer prompt **outside** the 8k inline budget: the Telegram
  executor (`buildSystemPrompt`, role `executor` only; planner and reviewer prompts are unchanged), the composer
  (`buildComposerSystemPrompt`), the platform executor and the derived duplicate / adapt prompt (`derivedPrompts`). The body is read
  from the repo file (the builtin), so a disabled toggle or an agent override cannot drop it; voice-core is never also listed for
  `load_skill`. `human-voice` and `anti-slop` are attached in full from what is left of the budget (Telegram executor and composer:
  the 8k budget after the workflow and the channel's own skills; platform executor and adapt: `VOICE_SKILLS_BUDGET` = 4 000; a
  duplicate keeps the source text and gets voice-core only). Today `human-voice` (2.2k) fits everywhere and `anti-slop` (10.6k) does
  not; a skill that does not fit gets one reference line («Повні правила голосу (…) не вмістилися…») and stays loadable.
- **Prompt size (chars, `SkillLibrary` defaults, empty memory), before → after:** Telegram executor 8 259 → 12 780; platform
  executor (Instagram) 5 643 → 10 162; adapt 2 102 → 6 777; duplicate 2 295 → 5 025; composer 8 478 → 12 999 (≈ +1.1–1.3k tokens).
- **FR-002 humour / slang.** `format_prefs.humor: 'none' | 'light'` and `format_prefs.slang: boolean` (absent = off), in
  `FORMAT_PREF_FIELDS`, lockable via `format_locks`, rendered for prompts («Гумор: вимкнено», «Сленг: ні»). Owner-only: an agent
  patch (`update_resource_format`, `patchFormat` by `agent`) that would set `humor: light` or `slang: true` is refused with
  `owner_only` whether or not the field is locked; agents may switch them off (a locked field stays `locked_by_owner`). Owner and
  builder writes (`setProfile` / the owner PUT) are not restricted. Every writer prompt states the target's setting explicitly
  (Telegram: the card, which now joins `format_prefs.humor/slang/emoji` of `telegram:<key>` like `rich`; platform / derived targets:
  the new `voiceOf(ref)` runner port). Dashboard: the Formatting section shows a "Voice: No humour · no slang" chip on every resource
  and the edit modal has Humour and Slang selects with locks (English UI; checked against a local mock API).
- **FR-003 slop lint.** `post/slop-phrases.ts`: 148 normalised phrases from `anti-slop` (`*` = rest of a word, word-bounded,
  so «по суті» does not fire in «по сутінках»; `normalizeSlop` = lowercase, ʼ ’ ' ‘ ` unified to ʼ, commas dropped, whitespace
  collapsed). `GLOBAL_BANNED` is gone; `lintPost` (`banned_term`) and `lintPlatformPost` (`banned_phrase`) use `findSlopPhrases`,
  owner `bannedTerms` keep substring matching on the same normalisation. A few phrases from the skill were left out on purpose
  because they are ordinary news language («нове золото», «нова валюта», «це важливо», «у наш час»). `post/slop-lint.ts` adds
  warnings (never errors) shared by both lints: `slop_em_dash` (more than one dash per 400 chars, at least one allowed),
  `slop_exclamation` (> 1), `slop_rhetorical_qa` (a short or wh-question answered by the next sentence; reader-directed questions
  are left to T3), `slop_moral_closer` (last sentence «Тож…», «Отже…», «Памʼятайте…», «У світі, де…», «Це показує…», …),
  `slop_adjective_triple` (three agreeing adjectives), `slop_emoji_over_pref` (format_prefs.emoji none 0 / light 3 / rich 12; the
  card `emojiPolicy` stays the hard error), `slop_humor_off` and `slop_slang_off` (marker lists, while humour / slang are off).
- **For T2 (critic):** read `lintPost(spec, card).warnings` / `lintPlatformPost(...).warnings` and keep the ones with
  `isSlopWarning(code)`; messages are Ukrainian and quote the offending text. Approval cards already store warning messages in
  `lint_warnings`, so slop warnings also hold a post back from autonomy auto-approval (`autonomy.ts` skips posts with warnings).
  Success criterion «a joke on a humor:none resource fails before publishing» is a warning in T1 and becomes a failure through the
  critic (T2).
- No migration (format_prefs is JSON). `evals/lib/graders.ts` `bannedHits` now uses `findSlopPhrases`.

## Implementation notes (T2, 2026-10-10)
- **The critic run** (`src/editor/critic/critic.service.ts`): one AgentLoop run as the `checker` role with a single terminal
  tool `submit_critique` (zod: six scores 1–5 `ai_likeness` (5 = human), `sense`, `voice`, `grounding`, `audience_asks`,
  `format_fit`, the model's `verdict`, Ukrainian `notes` ≤ 800 chars), `maxSteps` 3. System prompt: the rubric skill
  `editor-skills/editor-critic-workflow.md` (`applies_to: [checker]`, read from the repo builtin, never an agent override) +
  `voice-core`. User prompt: resource ref and platform, the humour/slang line (`voiceSettingsLine`), card brief, resource
  profile, `format_prefs`, the playbook section (rules/examples once T5 adds them), slot format/topic/angle, the reader-visible
  text (Telegram: the rendered preview as plain text incl. poll / slide outline; platforms: caption + slides + first comment),
  the spec JSON, the source excerpt (the `web_fetch` / `fetch_feed` output the executor read, captured by wrapping those tools in
  the run; else the library row behind `library_ref`, `critic/critic-source.ts`), the `slop_*` lint warnings and, on pass 2,
  the first verdict's notes. Each attempt has a 90 s timeout; an error, a timeout or a run without a valid verdict is retried
  once; `budget_exceeded` / `disabled` are not retried.
- **Model** (`pickModel('checker', …)`): the owner's critic model (`app_settings` `ai.critic_model`, a second
  `ModelDefaultsStore`; Models page card "Critic model", `PUT /api/models/critic {model|null}`) → the channel card's legacy
  `models.checker` → env `EDITOR_MODEL_CHECKER` → the global default. Default stays the global default (owner decision in the
  task). `checker` max_tokens 2 000 → 3 000. `EDITOR_CRITIC=off` disables the critic (kill switch, logged at boot).
- **Thresholds** (`critic/critic.ts` `decideVerdict`, code decides; the model can only be stricter): any score ≤ 2 → reject;
  model verdict reject → reject; any score ≤ 3 → revise; ≥ 2 slop warnings → revise; a `slop_humor_off` / `slop_slang_off`
  warning → revise (so humour on a `humor: none` resource never passes; voice ≤ 2 rejects it); model verdict revise → revise;
  else pass.
- **Where it runs** (`critic/critic-gate.ts`, one `CriticGate` per executor run in `ctx.extras.critic`, built by
  `EditorRunnerService` for Telegram, platform and **adapt** runs; a **duplicate** keeps its source's reviewed text and has no
  gate): inside `publish_post` after every deterministic guard (`checkPublishGuards`: lint, quiz truth, verbatim, similarity,
  ledger dedup, schedule guards, live caps) and before media preparation, the approval card, shadow storage or the send; inside
  `publishPlatformNow` (new optional `review` hook) after lint, health, verbatim, dedup and similarity, before the approval row,
  the shadow row or the API call. Outcomes: pass → proceed (verdict stored on the slot, a `critic` summary in the tool result);
  first revise → tool error `critic_revise` with notes, scores and an instruction (the executor rewrites once in the same run);
  second revise → live/shadow: slot `skipped` with `critic_rejected: second revise — …`; approval: the post goes to the owner
  with `final: true` and the notes; reject → slot `skipped` with `critic_rejected: reject (sense 1): …`. A retry of the same spec
  after a later error (e.g. a media failure) is not reviewed again (spec hash).
- **Step limit**: a tool error may carry `_grantSteps`; the AgentLoop extends the run once per run by up to 3 turns
  (`MAX_GRANT_STEPS`). `critic_revise` grants 2: one turn with every tool (lint), then the terminal-only last turn, so a revise
  on the last step still ends in publish or skip, not `max_steps`. Publish tools get their own timeout
  (`EditorTool.timeoutMs`, `PUBLISH_TOOL_TIMEOUT_MS` = 2 × 90 s + 60 s) instead of the loop's 30 s.
- **Fail-safe**: after the retry, live and shadow slots end `failed` (`critic_failed: …`, verdict `error` stored) with an Inbox
  item (`kind: critic_failed`, severity `action`, English; the Telegram alert stays Ukrainian); nothing is stored or sent. A
  blocking cap that stops the critic (`budget_exceeded`) takes the same path, so the post does not publish live. Approval mode:
  the card is created with `verdict: 'error'` (the owner reviews every waiting post anyway).
- **Never auto-approved**: `heldByCritic` (verdict ≠ pass) — bulk approve and the autonomy switch skip such posts like posts with
  lint warnings (counted in `skippedWithWarnings` / `waitingWithWarnings`); the dashboard "Approve all (n)" count matches.
- **Spend**: the critic run's LLM rows land in the usage ledger as `editor.checker` (role `checker`, the slot's resource, the
  shadow flag, the executor's agent for agent caps); the critic run is its own `editor_runs` row (role `checker`, `slot_id`
  set), so its cost is not in the executor run's total. Measured prompt with typical inputs: ≈ 11 000 chars (system 4.9k: rubric
  + voice-core; user ≈ 6k) ≈ 4–4.5k input tokens + the tool schema, ≈ 300–600 output tokens. **Extra cost per post**: with
  the default `z-ai/glm-5.3-flash` ≈ $0.001 per pass; with a Sonnet-class critic ($3/$15 per M) ≈ $0.015–0.02 per pass; a
  revised post costs two passes (plus the executor's rewrite turn).
- **Storage** (`database/migrations/068_critic.sql`: guarded `DO` block, idempotent, records `068_critic`):
  `editor_slots.critic JSONB` and `editor_drafts.critic JSONB`, plus `idx_editor_slots_critic (channel_key, critic->>'verdict',
  updated_at DESC) WHERE critic IS NOT NULL`. Shape (`StoredCritic`): `{verdict: pass|revise|reject|error, scores, notes,
  model_verdict, reason, pass, slop_warnings, model, run_id, cost_usd, at, final?, history?: [pass-1 summary]}`.
  `EditorSlot.critic` / `SlotResultPatch.critic`; `ApprovalCard.critic`; `EditorDraft.critic`.
- **Trace / UI**: the executor trace shows the `publish_post` step with `critic_revise` (notes, scores) or the `critic` summary in
  its result, and a skipped/failed slot's `error`; the critic's own run is listed with role `checker`. Dashboard (English): a
  shared `CriticBlock` ("Critic: pass / revise / reject / unavailable", "revise (after one rewrite)", six score badges coloured by
  the thresholds, the notes as written, the first-pass notes) on the approval card and the chat draft card; Models page "Critic
  model" card. Checked in the browser against a local mock API (desktop and 375 px, no horizontal overflow).
- **Chat drafts (decision)**: advisory and on demand — a "Check with critic" button (`POST /api/editor/drafts/:id/critic`,
  `DraftsService.review`) stores the verdict on the draft; saving a changed draft clears it; publish and schedule never read it
  (the owner is the author). Not automatic on every `save_draft`, so the composer's iterations cost nothing extra.
- **Skills**: `editor-executor-workflow` gained one line on `critic_revise` (2 532 chars ≤ 2 600); the publish tool descriptions
  say the critic reads the post.
- **Tests** (scripted fake LLMs only): `critic/critic.test.ts` (thresholds; humour on `humor: none` → revise / voice ≤ 2 → reject;
  the run's prompt, model and tool; retry / cap / timeout; the `editor.checker` ledger row through `OpenRouterClient`; reject never
  sends; revise → exactly one rewrite and one send; second revise live/shadow → skip, approval → owner with notes; revise on the
  last step → publish; critic failure → failed + Inbox, never published, approval → card with the error; platform reject / revise
  / pass; the runner's gate; the approval card payload, bulk and autonomy; drafts; the Models setting), `critic.pg.test.ts`
  (migration re-apply, card payload from PG, reject skips with the verdict, draft round-trip), `agent-loop.test.ts` (grant once,
  capped; per-tool timeout), `derived-run.test.ts` (adapt has a gate, duplicate has none), dashboard `lib/critic.test.ts`.
- **For T4 (MANAGER)**: per resource and day read `editor_slots.critic` (`critic->>'verdict'`, `critic->'scores'`,
  `critic->>'notes'`, `critic->>'reason'`, `critic->>'final'`, `critic->'history'` for revise-then-pass); the resource is
  `COALESCE(resource_ref, 'telegram:' || channel_key)`; skipped-by-critic slots have `error LIKE 'critic_rejected:%'`, held ones
  `critic_failed:%`; critic spend is `llm_usage.feature = 'editor.checker'`. Drafts' verdicts are owner-side, leave them out.
- **For T7 (plan UI)**: `EditorSlot.critic` comes with every slot row (`rowToSlot`); show the verdict badge / notes from it
  (reuse `components/critic/CriticBlock.tsx` and `lib/critic.ts`); the on-demand dry-run Preview (FR-012) can run the executor
  with the gate in shadow mode to get a verdict with the draft.
