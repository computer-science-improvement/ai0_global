# 034: Content quality and live planning: human voice, a pre-publish critic, fewer polls, fitting formats, live news slots, a readable plan

**Status:** DONE (evals written, not run) · **Priority:** P0 (above every open spec; owner request 2026-10-08) · **Depends on:** 017–025, 031, 033
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

## Implementation notes (T3)
- **Defaults (FR-005, the T5 half of FR-007 only for poll/quiz).** `makeDefaultCard` (`chat/default-card.ts`) starts with
  `DEFAULT_CARD_FORMATS` = text + photo, so a builder-made agent's card has no poll/quiz (weight 0 = absent; the card
  schema stores weights ≥ 0.01). The owner's chat keeps every format through `makeChatCard` (a card-less channel; the
  owner asks for the format himself, and a scheduled chat poll is stored and published with that card). The API card
  defaults (`CARD_DEFAULTS`) and the `editor_channels.formats` column default were text + photo already.
  `playbookBuildPrompt` and `editor-orchestrator-workflow`: poll/quiz weight 0 unless the brief asks or the resource is
  education/quiz (`content_kind`), the weekly cap is named. T5 owns the wider "fitting formats" wording.
- **Caps in the profile** (`post/audience-asks.ts`, no migration — `format_prefs` is JSON): three new `format_prefs`
  fields, lockable and versioned like the rest: `content_kind` (`general | news | education | quiz`),
  `polls_per_week` (0–70) and `questions_to_readers_per_day` (0–5). `audienceCaps(prefs, topic)` resolves the
  defaults: polls 1 a week (a `quiz` resource: no cap until the owner sets one), reader questions 1 per post, 0 on a
  news resource. "News" = `content_kind: news`, or — without `content_kind` — a profile topic matching
  `NEWS_TOPIC_RE` (новин / news / дайджест / зведенн). Nothing else is inferred. Agents (`update_resource_format`,
  `patchFormat` by `agent`) may only lower the two caps (to ≤ the default) and never set or clear `content_kind`
  (`owner_only` with a Ukrainian reason per field, `OWNER_ONLY_REASON`); the owner and the builder set anything.
  `get_resource_format` returns the effective `audience_caps`; `ResourceProfilesRepository.capsOf(ref)`.
- **Plan validators.** `roles/poll-cap.ts`: `pollCapErrors(slots, ctx, series)` is one line in `validatePlan` (new
  trailing optional `pollCap`) and in `validateNetworkPlan` (`o.pollCap`). Per resource: poll + quiz slots in the 7
  days ending on the plan date (`SqlPollCaps.load`: every status except skipped / failed / expired on the 6 days
  before; on the plan date only what a new plan keeps — published, running, written, pins, reserved/chat and
  repurposed slots) plus the plan's own > cap → «…опитувань і вікторин за 7 днів було б N (уже X, у плані Y) — ліміт
  ресурсу C на тиждень (polls_per_week)…». Instances of a series with origin owner / migration (or locked) do not
  count (e.g. the migrated pdr-quiz series), nor do they count in the window. Wired through `pollCaps` deps of
  `buildRoleTools` / `buildNetworkTools` (`editor.module.ts` → `SqlPollCaps`); the window uses the anchor card's zone.
- **Lint.** `readerQuestions(text)` counts `?`-sentences that address the reader: the tested `READER_MARKERS` list
  (ви/вас/вам/ваш*, ти/тебе/твій…, «як думаєте», «а ви», «чи доводилось», «напишіть», «у коментарях», «згодні», …) plus
  second-person verb forms (-ете/-єте/-ите/-їте, -єш/-еш/-иш/-їш, imperative -іть/-йте; a few nouns/adjectives
  excluded); quoted speech («…», "…") is removed first; the poll's own question never counts. Error code
  `reader_questions` over the cap, **per post** (the "per day" name is the owner-facing cap; a per-day count across
  posts is not enforced). Telegram: `card.readerQuestionsMax` / `card.pollsPerWeek`, joined on read in
  `editor-channels.repository` (`format_prefs` + `topic` of `telegram:<key>`; a row read without the join keeps the
  card unchanged). Platform: `VoicePrefs.readerQuestionsMax` (the runner's `voiceOf` adds it; absent = 1). T1's
  `slop_rhetorical_qa` is unchanged (it still skips reader-directed questions).
- **CTA.** `PlatformSectionSchema.cta` was already optional; the playbook build prompt and the orchestrator skill no
  longer list «заклик» as a section field and say it is absent by default.
- **Skills.** `platform-facebook` (no «заклик до обговорення», no «Закінчуй питанням»; end on a fact, questions within
  the cap), `platform-threads` (no «одне питання», no «а ви знали» / «питання до читачів»), `platform-instagram` (cover
  is a promise or a fact; CTA optional, one, not a question), `platform-tiktok` (no question hook; humour only when
  the owner turned it on), `format-poll-quiz` (no «залучення через голосування»; only when planned or asked, the
  weekly cap; intro without extra questions; how to write a good poll/quiz kept), `editor-planner-workflow` (the cap),
  `editor-executor-workflow` (one line on reader questions; 2 518 chars), `agent-onboarding` (`content_kind`, caps).
  `agents/audience-caps.test.ts` fails if any skill pushes those phrases again.
- **Dashboard** (Formatting section, English): an "Audience asks" chip on every resource (effective caps from the
  server's `audience`, "(default)" for unset values, a lock icon when any of the three is locked) and Resource kind /
  Polls a week / Reader questions fields with locks in the edit modal (checked against a local mock API).
- **For T4 (MANAGER).** Poll share: count `editor_slots` with `format IN ('poll','quiz')` per
  `COALESCE(resource_ref, 'telegram:' || channel_key)` (or reuse `SqlPollCaps.load`, which also gives the cap).
  Posts with reader questions: run `readerQuestions(text)` (`post/audience-asks.ts`) over the stored
  `rendered_preview` / post text — nothing is stored per post. Caps: `ResourceProfilesRepository.capsOf(ref)`. A
  `format_mix` directive executor can lower the caps or set poll weights; raising caps stays owner-only.

## Implementation notes (T6, 2026-10-10)
- **Migration `067_live_slots.sql`** (additive, guarded, re-run is a no-op, records its version): `editor_slots.topic_mode`
  (`'fixed' | 'live'`, default `fixed`, named CHECK added only when missing), `editor_slots.live_spec` JSONB
  (`{ sources, brief, max_age_hours, origin: planner | news_watch | pin, item? }`), an index on the live item URL, and
  `news_watch_log` (`checked` / `added` / `ignored` rows with reason, item, feed, score, slot; SELECT for `editor_ro`).
- **FR-010 live slots.** `live/live-slot.ts`: `LIVE_SLOT_FIELDS` (`topic_mode`, `source`, `brief`, `max_age_hours`) in both
  `PlanSlotInput` and `NetworkSlotInput`; `topic` is optional. `resolveSlotTopic`: `fixed` needs a topic (≥ 5); `live`
  needs a source — its own, else its series' (`feed:<ref>` / `api:<name>`), else the card's RSS feeds; library sources are
  refused. Default mode: `live` when there is no topic or the slot realises a series with a `feed` source (the planner's
  topic then becomes the brief). The stored topic is a label («Свіжа новина з <site>»; a news-watch slot «Свіжа новина:
  <title>»). Network: a live slot needs no `idea_id` / `series` / `directive_id`, must be `unique` and realises no idea.
  Pins on a feed source are materialised live too; the Schedule projection marks series items `topicMode` (`live` for a
  `feed` source) and returns `topicMode` / `live` on slots.
- **Executor.** Before the LLM, `scanLive` (`live/feed-items.ts`) reads the slot's feeds (SSRF-safe GET), keeps items
  ≤ `max_age_hours` (default 6; undated items dropped), drops what the content ledger blocks on the resource, waiting /
  running posts with that source, items another planned live slot holds, and near-repeats of the resource's last 7 days
  (posts, shadow previews, waiting posts, today's fixed topics, platform captions; `containment` of the title in a post's
  head or Dice ≥ 0.6, calibrated on sample news; a second feed's copy of the same story counts too). Nothing fresh, at
  least one feed read and no `api:` source → the slot is skipped by code with `no_fresh_item: …` (no LLM call). Otherwise
  the prompt (Telegram and platform executor) has no «Тема:» but the brief, the sources, the rule, the skip code and up to 5
  candidates. `fetch_feed` gains `since_hours` and `exclude_posted` and returns `age_hours` (+ `dropped` counts);
  `skip_slot` gains `code: "no_fresh_item"` (error `no_fresh_item: <reason>`). Publish guard (in
  `ScheduleService.publishGuard`, shared by Telegram and platform publish, so the publish tools are untouched):
  `live_source_missing` when a live slot's post has no `source.url`.
- **Approval mode.** `isTimeSensitive` is true for every live slot, so it is written 2 h before its time with the
  `freshness_deadline` of spec 031 (unchanged path). A rejected live post's replacement stays live (without the item).
  Known limit: in approval mode a live slot with nothing fresh at its write time (2 h ahead) is skipped, not retried.
- **Defaults (news resources).** `isNewsCard`: RSS sources and the title / brief / profile topic says news (or a `news`
  format weight). The planner prompt tells a news resource to make news slots live; `editor-planner-workflow`,
  `network-planning`, `editor-executor-workflow` (2 555 / 2 600 chars) and `content-sources` say how; the network planner
  block marks feed series `[live]`.
- **FR-011 partial replan.** `replacePlan` (both planners, manual and scheduled) skips only the old plan's future
  `planned` content slots (more than 5 min ahead, not pins, not repurposed, not news-watch); every other slot that is still
  alive (`planned`, `running`, `awaiting_approval`, `approved`, `published`, `shadowed`, pins, reserved) moves to the new
  plan. Waiting approval posts are no longer dropped (the 031 test was updated). The planners see the kept slots as fixed
  points: `ScheduleRepository.keptOn` → `planContext` adds them to `pins` with `kept` (they count in `posts_per_day` /
  `per_day`, keep the min gap, cover a due series instance) and `scheduleBlock` lists them as «уже в плані». The planner
  prompt says "the rest of today". API `POST /api/editor/channels/:key/replan?date=tomorrow` (and the MCP `replan` tool)
  replans the next day. Dashboard: "Replan the rest of today" on `/app/editor` and the channel page, plus "Replan tomorrow"
  for channels in approval mode.
- **FR-011 news watch.** `live/news-watch.ts` (`NewsWatchService.check`, scheduler hook `newsWatch` after planning, never
  for a held channel; no LLM). Settings: profile `news_watch` (`enabled` absent = on for news resources, `every_hours` 2,
  `from_hour` 8, `to_hour` 22, `max_per_day` 3, `max_age_hours` 3); owner-only (agent / builder profile writes keep the
  stored value); edited in the dashboard Resource profile (Telegram resources: view + form, `NewsWatchFields.tsx`). A check
  runs only when the day has a real plan; items must be fresh, unused (same filters as above) and on topic (5-letter stems
  of the profile topic, brief and title; generic words ignored); score = freshness + topic fit (≥ 0.4). Room: under
  `max_per_day` news-watch slots, under `posts_per_day_max` (slots and publications), a time at now + 15/20/25/30 min outside
  quiet hours and ≥ `min_gap_minutes` from every slot and the last post. One slot per check (the best item); the slot's
  format is `text` or `photo` (whichever the card allows). Every fresh item gets one log row a day (`added`, or `ignored`
  with `off_topic` / `low_score` / `daily_cap` / `day_full` / `no_gap` / `no_format` / `not_best`) plus a `checked` summary.
  Scope: Telegram channels (card feeds); platform resources get live slots from the planners only.
- **Tests.** Unit: `live/live-slot.test.ts` (resolver, both validators, approval lead + freshness deadline, prompts),
  `live/feed-items.test.ts` (ages, freshness, ledger/repeat filter, `fetch_feed`, news-watch config, keywords, score),
  scheduler hook. PG `live/live-slots.e2e.pg.test.ts` on a fixed 2030 date (no hour-of-day dependence): a 14:50 feed item is
  picked by the 15:00 news watch and written the same day, a forced re-check adds nothing, the 16:00 planner live slot is
  skipped with `no_fresh_item` without an LLM call, the item is used exactly once; a replan keeps written / running / due
  slots, counts them (per day, gap) and skips only the future planned one; the news watch stays out of a full day and
  outside its hours. Dashboard `lib/news-watch.test.ts`.
- **For T7 (readable plan).** Slots from `/api/editor/plans` and the Schedule API carry `topicMode: 'live'` and `liveSpec`
  (`sources`, `brief`, `max_age_hours`, `origin`, `item`) only on live slots (dashboard type `EditorSlot.topicMode/liveSpec`);
  render a planned live slot as «At HH:MM: fetch {liveSpec.sources → site names} → pick the freshest item (≤ max_age_hours h)
  → write {format}», a news-watch slot with its `item.title` / link, and a skipped one with its `error` (`no_fresh_item: …`).
  Schedule series items have `topicMode` and `source`. Written live slots have `postSpec.source.url` (the chosen item).
  `news_watch_log` (per channel, newest first) can back a "why was this added / ignored" view.

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

## Implementation notes (T5, 2026-10-10)
- **FR-007 fitting formats.** `PlatformSectionSchema.format_reasons` (format → one line, ≤ 200) is stored in the section and
  rendered by `renderSection` («Чому ці формати: …»). `playbookWarnings(p)` (`network/playbook.ts`) returns soft checks, never
  errors: `too_many_formats` (> `MAX_FITTING_FORMATS` = 4 enabled formats in a section) and `format_reason_missing`; each has a
  Ukrainian line (back to the agent in `submit_playbook`'s result as `warnings`) and an English one (appended to the owner's
  Inbox item). `playbookBuildPrompt` asks for 1–4 formats that fit, one reason each in `format_reasons`, names the format skills.
  `format-longread`, `format-carousel`, `format-album-slider`, `format-video`, `format-poll-quiz` now apply to `builder`,
  `orchestrator`, `idea_reviewer` (listed for `load_skill`; `idea-review` already checks format fit since T8).
  `editor-orchestrator-workflow` points to `format_reasons` (1–4 per section) and keeps the owner's examples.
- **Reviewer one-step drop.** `set_format_weights` takes `drop_reasons` (format → evidence, ≥ 15 chars): a weight 0 is allowed
  only with a reason (owner edits / rejections on approval, critic notes) and removes the format from the card
  (`EditorChannelsRepository.setFormatWeights(key, weights, { drop })`; the last format is never removed — `last_format`); the
  reason is also written to the channel memory as `avoid`. Every other change keeps the ±0.2 step and the 0.05 floor
  (`drop_needs_reason`, `step_too_big`). `editor-reviewer-workflow` says when.
- **FR-008 examples and warnings — mechanism.** A new pending action kind `content_examples` (`agents/content-examples.ts`),
  proposed by @ai0's new tool `propose_content_examples` (builder): exactly 3 examples (`format`, `title`, reader `text` in the
  PostSpec markdown-lite, `why`) and 2–4 warnings (`pattern`, `why`, `bad_example`, `format`). Code turns each example into a
  real PostSpec (paragraph blocks, rendered as `text`), lints it with the resource's card (`exampleCard`: the Telegram card if
  any, every format allowed, no required hashtags) and renders it with `renderTelegram`; the card payload carries the
  `TgMessage[]`, so the chat shows the exact Telegram preview (`TelegramPreview`). A lint error (slop phrase, reader questions
  over the cap, an owner banned word) or a `slop_humor_off` / `slop_slang_off` warning refuses the call (`examples_rejected`,
  the model rewrites); other `slop_*` warnings travel to the owner as notes. `create_agent` and `set_brief` results carry a
  `next` hint to call it; the builder prompt and `agent-onboarding` (step 7) say so.
- **Apply with the owner's choices.** `POST /api/agents/actions/:id/apply` accepts `{ input }`; `PendingActionsService.apply(id,
  input)` passes it to the handler as a third argument. `ContentExamplesChoice` (strict): per example `verdict` good/bad, an
  edited `text`, a `note`; per warning `keep`. A new `KeepPendingError` (HTTP 400) leaves the card pending instead of failing
  it: a "good" example whose (edited) text has a slop phrase (`example_slop`), nothing kept, an unknown field, or the agent not
  created yet (`agent_not_created`: apply the Create agent card first). Warnings become `bad` examples with
  `note = "<pattern>: <why>"`; every example carries the resource ref.
- **Storage (no migration — the playbook body is JSON).** `PlaybookSchema.examples` = `[{format, text, verdict, note?,
  resource_ref?}]`, ≤ 12 (`MAX_PLAYBOOK_EXAMPLES`); `validatePlaybook` refuses a `good` example with a slop phrase and an
  example of a resource outside the network (so agent-written examples — T4's MANAGER — must be clean too). **Not
  structural** (`classifyPlaybookChange` ignores `examples` and `format_reasons`): the owner decided the examples on the card,
  and agent examples are slop-checked. `NetworkRepository.setExamples(agentId, examples)` merges (new first, deduped by
  normalised text, capped at 12): active playbook → a new active version `created_by owner` that keeps (and patches) a pending
  agent draft; only a pending draft → patched in place; no playbook yet (the usual case right after creation: the first build
  is still running) → held in a `draft` row with version 0 (status `draft` existed in 052 and was unused; `playbookHistory`
  hides it). `insertVersion`: an agent version (orchestrator / directive / migration) without examples carries them from the
  newest active / pending / held row; the holder is deleted by any new version. An owner PUT without an `examples` key keeps
  the current ones (an older editor); with `examples: []` it clears them.
- **Few-shot and the critic.** `renderExamples(examples, {resourceRef, format})`: up to 3 good + 2 bad of the resource, the
  slot's format first, alternating good/bad, each text ≤ 700 chars, block ≤ `EXAMPLES_PROMPT_BUDGET` 2 400 chars (≈ +600–800
  tokens when present; nothing when the playbook has none). `platformContext` returns `examples` (Telegram slots read their
  `telegram:<key>` section; the runner now reads the Telegram resource context once and hands it to the critic gate). The
  block (`examplesPromptSection`) sits right after voice-core in the Telegram executor (`buildSystemPrompt(..., { examples })`,
  executor role only), the platform executor and the adapt prompt (a duplicate keeps the source text). The critic gets
  `CriticRequest.examples` as «Приклади постів ресурсу (еталон власника)»: voice / format_fit are judged against the good ones,
  repeating a bad pattern scores ≤ 2; a profile with taboo topics adds «пост на табу-тему → sense ≤ 2».
- **FR-009 builder fixes.** `AgentCreator.setOnBrief` is wired in `editor.module.ts` to `AgentsService.onBrief` (the brief hook
  → `NetworkRunner.runPlaybookBuild`, in the background): `create_agent` with a brief starts the first playbook build with
  `buildBriefText` (the brief + «Формати, погоджені з власником: …» with the reasons). A brief for a resource whose card
  already exists is written to it (`EditorChannelsRepository.setBrief`). `create_agent` gains `formats` (1–4 `{format,
  reason}`; checked against the platform's formats; poll/quiz refused unless `content_kind` quiz/education or the brief asks
  for polls) — they become the new card's formats (absent = text + photo) — and `banned_terms` (only words the owner listed).
  `profile.taboo` is no longer copied into `card.bannedTerms`; it stays topics: `renderProfile` / `compactProfile` say
  «Табу-теми (не писати про них)», the critic reads it. The apply result reports `briefWritten` / `buildStarted`.
- **Dashboard** (English UI): `ActionCard` for `create_agent` shows agent, resource, topic, audience, goals, brief, tone, taboo
  topics, banned words, formats with reasons (or the text + photo default), the orchestrator schedule and "Starts in approval
  mode: every post waits for your approval" (the old "starts in shadow mode" line after Apply is fixed); `set_brief` shows the
  brief. The `content_examples` card (`ContentExamplesCard.tsx`, `lib/content-examples.ts`): each example as a Telegram
  preview with Good / Bad toggles, Edit (an edit is previewed client-side with the same markdown-lite), an optional "why bad"
  note, the warnings with Keep checkboxes; Apply sends the choices, a 400 shows the server's reason and the card stays
  pending; an applied card says where the examples went. The Playbook tab shows format reasons per section, a "> 4 formats"
  flag and an "Example posts" list.
- **Tests.** `agents/content-examples.test.ts` (scripted LLM: create_agent with ≤ 4 reasoned formats and no poll → a
  `content_examples` card with 3 rendered examples and the warnings streamed as chat events → apply with verdicts / edits /
  dropped warning stores them; slop / joke / reader-question examples refused; keep-pending cases; set_brief hint; builder
  prompt; AgentCreator: formats on the card, taboo not banned, brief starts the build, existing card gets the brief, poll rules),
  `network/playbook-examples.test.ts` (schema, slop check, warnings, not structural, merge, render budget, executor / platform /
  adapt / critic prompts, the runner wiring, build prompt, reviewer drop), `network/playbook-examples.pg.test.ts` (held → first
  version, pending patched, active + kept draft, rebuild carries, owner PUT keeps / clears / refuses slop), updated
  `agent-builder.pg.test.ts` (no taboo in bannedTerms, text + photo, build started, setBrief). Dashboard
  `lib/content-examples.test.ts`. Browser-checked against a local mock API (127.0.0.1): both cards at 1280 px and 375 px (no
  horizontal overflow), Good/Bad, edit preview, the 400 on a slop edit, apply.
- **For T4 (MANAGER).** A `voice_fix` / `format_mix` executor can write examples through the playbook body (validated: a good
  one must be slop-free; ≤ 12; not structural, so it applies at once) — prefer `NetworkRepository.setExamples`-style merging
  (new first) over replacing the owner's; give them a `note` naming the evidence. Lowering an unfitting format to 0 on a
  card is `setFormatWeights(key, {}, { drop: [format] })`; on a playbook section it is a structural change (the format set
  changes) and goes to the owner. The examples of a resource are `renderExamples(playbook.examples, { resourceRef })`.

## Implementation notes (T7, 2026-10-10)
- **Migration `070_plan_visibility.sql`** (guarded `DO`, idempotent, records `070_plan_visibility`; 069 stays reserved for T5):
  `editor_slots.preview_draft JSONB` — the owner's dry-run preview (`SlotPreview`: `status running|ready|rejected|skipped|failed`,
  `platform`, `preview` (Telegram HTML / caption), `spec`, `critic`, `reason`, `warnings`, `runId`, `costUsd`, `startedAt`, `finishedAt`).
  Kept apart from `rendered_preview` / `post_spec` / `critic` on purpose: the similarity and repeat guards (`recentTexts`,
  `feed-items` repeat check), derived slots and MANAGER's critic stats (T4) read those, and a preview must change none of them.
  `rowToSlot` → `EditorSlot.previewDraft`.
- **FR-012 Preview** (`POST /api/editor/slots/:id/preview`, `?wait=true` waits; default answers `running` at once and the
  dashboard polls every 4 s while a preview runs). `EditorOpsService.previewSlot`: editor enabled, channel not off, a planned
  content slot that is not live (`preview_live_slot`) and not a duplicate / adapt (`preview_derived_slot`); one at a time per slot
  (`preview_in_progress`: an in-memory guard plus `EditorPlansRepository.claimPreview`, an atomic UPDATE that refuses a `running`
  preview younger than 10 min, so a crashed one can be replaced). `EditorRunnerService.runPreview` is the only executor change:
  the slot runs exactly as at slot time (same prompts, tools, guards, series note, critic gate) with the card in shadow semantics
  and a `PreviewSink` (`roles/preview-run.ts`) in `ctx.extras.dryRun`: `publish_post` / `publish_platform_post` run every
  deterministic guard and the critic and then hand the rendered post to the sink instead of storing / sending / creating an
  approval card / inserting `platform_posts` (`publishPlatformNow({dry})` stops after review); `checkPublishGuards` accepts a
  `planned` slot only in a dry run; `skip_slot` is wrapped to record its reason; act tools (`repurpose_post`, `edit_data_schema`)
  are left out; the CriticGate gets the sink as its `plans` (its verdict and reject/fail writes land on the preview) and no Inbox.
  The slot keeps its status, run id, post, verdict and `updated_at`; nothing reaches the content ledger. Live caps (daily cap,
  quiet hours, min gap) are not checked (they depend on the publishing moment). The executor run is a normal `editor_runs` row
  with the slot id (the slot page marks it "preview (dry run)"); its outcome is stored with `setPreview`.
- **Preview spend**: `AgentLoopInput.usage` overrides the ledger attribution — the executor run is `editor.preview` (added to
  `EDITOR_FEATURE_ROLES`), never shadow; its critic passes stay `editor.checker`. Both count against the channel, agent and
  every blocking cap (the BudgetService gate sees `editor.preview`, so an `editor`/`editor.preview` feature cap stops it before
  the first call; tested). **Cost**: one executor run plus one critic pass (two with a revise) — the same as writing the slot:
  ≈ $0.003–0.006 with the default `z-ai/glm-5.3-flash` executor + critic, ≈ $0.02–0.03 with a Sonnet-class critic. The button
  shows the channel's own estimate (`previewEstimates`: mean of its last 20 finished executor runs + mean of its last 20 critic
  runs; "about one executor run" without history).
- **Payloads**: `GET /api/agents/:handle/plan` adds `planId`, `plannedAt` (`editor_plans.created_at`), `runId`, `runRole` (the
  run's role), `schedule {timezone, planHour, mode (effective), approval, batchHour: 20}`, `history` (the day's superseded plans:
  time, run, rationale, slot count), `previewEstimateUsd`, `feeds` (card feed id → URL) and per slot `sourceHints`, `seriesName`,
  `isExperiment`, `createdAt`, `pinned`, `topicMode`, `liveSpec`, `critic`, `previewDraft`. `GET /api/editor/plans` adds
  `runRole` per plan and `previewEstimates` per channel; `GET /api/editor/slots/:id` (`slotDetail`) adds the slot's `plan`
  (planned at / by which run, active or superseded) and `previewEstimateUsd`. The Schedule API adds `planning` (plan hour,
  approval, batch hour, feeds) and `topicMode` on series items. `GET /api/schedule/upcoming` lists ordinary future slots too
  (`kind: 'slot'`, statuses planned / running / awaiting_approval / approved; series / pin slots stay with their instance) with
  `topicMode` and `live` (card feed ids resolved to URLs).
- **Dashboard** (`lib/slot-plan.ts`, `components/editor/SlotPlan.tsx`, English): a live slot reads «At 14:00: fetch
  pravda.com.ua, rbc.ua → pick the freshest item (≤ 6 h) → write photo» (site names from feed URLs / card feed ids, `x API`),
  with a "live · planner / news watch / pinned" badge, the picked item's title + link for news-watch slots and the brief; a fixed
  slot shows angle, series, source hints (and the Idea link on the Plan tab); skipped / failed slots show a labelled reason
  (`no_fresh_item` → "Nothing fresh in the sources", `critic_rejected`, `critic_failed`, superseded, owner, agent) plus the
  system's detail; a written post shows the rendered post and the `CriticBlock` (new `where: 'slot' | 'preview'` footnotes);
  a planned fixed slot gets **Preview** (cost hint, spinner, "Preview again") and its last preview with the critic's verdict and
  "Dry run at … · $… · nothing was published"; a planned live slot says it has no preview before its time. `PlanStamp`:
  "Planned at 20:02 Kyiv by planner run →" (run trace link), "planned the evening before at 20:00" for an approval plan made the
  day before, how the agent plans, and "Earlier plans of this day (n)" collapsed (time, run link, slot count, rationale).
  Used on the Plan tab (timeline detail and the narrow list), `/app/editor` (rows + "Planned at … by … · plans at 06:00" per
  channel), the channel page and the slot page (which also labels the critic run and the preview run). Schedule tab: the plan
  note, a live legend item, every slot entry links to its slot page and a live entry's tooltip is its scheduled call. Overview
  Upcoming lists ordinary slots ("Live: fetch … → freshest → photo", a news-watch slot's item title) linking to the slot page.
- **FR-013 schedule truth — decision: remove, not wire.** Orchestrator / role-agent `schedule.times` never drove anything (the
  orchestrator runs before planning at the card's `plan_hour`; approval channels plan the next day at 20:00); wiring a second
  clock would make two settings disagree. The agent Overview now shows the Schedule editor only for **@manager** (whose times do
  drive its runs); every other agent shows read-only "Planned daily at 06:00 Kyiv …" (or the approval wording) from its channel
  card with "Change on the card →", and its PATCH no longer sends `schedule`. The stored value is untouched (API / builder still
  accept it; harmless). The plan hour and the 20:00 batch are shown next to the plan on the Plan tab, Schedule tab, `/app/editor`,
  the channel page and the slot page. **Zone fix**: `maybeOrchestrate` keys the day by the card zone and checks `editor_runs`
  with `(started_at AT TIME ZONE <card tz>)::date = <card-zone date>` (was Kyiv's date vs `now()`). **"Today" wording** when
  planning tomorrow: `## Серії за розкладом на <date>`, schedule rule errors / frequency lines name the plan date, and the
  `submit_plan` / `submit_network_plan` descriptions say "the plan day (today; in approval mode in the evening — tomorrow)".
  `/app/editor` empty state names approval mode (planned the evening before at 20:00) and that off channels are not planned.
- **Tests**: `roles/preview-run.test.ts` (Telegram / approval / platform dry run: nothing stored, sent, notified, ledgered or put
  up for approval; act tools absent; revise → one rewrite; reject → `rejected`; critic failure → `failed` without Inbox; skip;
  `editor.preview` ledger row not shadow; channel budget and a blocking feature cap stop it before any call; live / derived
  refused), `api/editor-ops.preview.test.ts` (wait vs background, one at a time, crash → failed preview, refusals, slot page and
  plans payload), `roles/preview-run.e2e.pg.test.ts` (migration 070 idempotent; real repos + publish tools on a live card: the
  preview lands in `preview_draft`, the slot row stays planned with no run / post / verdict, no ledger / publication / approval
  rows; claim one at a time + stale; Plan tab payload: planned at / by, history, schedule, fixed / live / news-watch / skipped /
  written + critic; `/api/editor/plans` run roles and estimates), scheduler zone test (New York card near Kyiv midnight),
  Upcoming ordinary slots, controller routes; dashboard `lib/slot-plan.test.ts`, `schedule-grid` (slot links, live) and
  `critic` footnotes. Browser-checked against a local mock API (127.0.0.1) at 1366 px and 375 px: Plan tab (stamp, history,
  fixed with preview + critic, live, news watch, skipped no_fresh_item, critic reject, running preview, Preview click → spinner
  → result), Schedule tab, `/app/editor`, channel page, slot page, Overview Upcoming; no horizontal page overflow.

## Implementation notes (T4, 2026-10-10)
- **Migration `071_manager_quality.sql`** (guarded `DO`, idempotent, records `071_manager_quality`): the `agent_directives.kind`
  CHECK gains `voice_fix` and `format_mix` — every single-column CHECK on `kind` that does not already allow both is dropped
  and the named `agent_directives_kind_check` is added, so a re-run never narrows a list a later migration widened;
  `manager_reviews.quality_check JSONB`. 072 stays reserved.
- **Digest quality block** (`manager/quality-digest.ts`, `SqlQuality`; `ResourceDigest.quality`, 7 days, best effort — a read
  error leaves `quality: null`): per resource `critic` (pass / revise / reject / failed(`error`) counts from
  `editor_slots.critic`, `revised_then_passed` from `history`, `pass_rate` = pass / (pass + revise + reject), mean score
  per axis, the 3 newest non-pass notes incl. the first-pass note of a revise → pass, ≤ 200 chars), `polls` (poll + quiz
  content slots of the window, planned ones too, against `polls_per_week` from `audienceCapsOfProfile`; `over`),
  `reader_questions` (`readerQuestions()` over every written post's text vs the per-post cap; posts over the cap and 2 quoted
  examples), `owner` (approval decisions: `approved_at` → clean / edited, `skipped` + `rejected by owner` → rejected with
  `reject_reason`; an edit's before/after note from `editor_channel_memory` (`evidence.slotId`, `action: edit`); top 3
  each, `rejection_rate`), `samples` (3 newest written posts — published, shadowed, awaiting approval, approved — first 400
  chars from the post spec's caption/blocks, else the rendered preview), `flags` (`critic_reject`, `critic_low_pass` (< 70 %
  with ≥ 3 verdicts), `critic_failed`, `polls_over_cap`, `reader_questions_over_cap`, `owner_rejections`, `owner_edits`) and
  a `signature` (newest critic issue, newest owner rejection/edit, flags). Quality metrics for `expected`:
  `critic_pass_rate`, `owner_rejection_rate`, `poll_share` (%; added to `KPI_METRICS`, never flagged as anomalies;
  `metricValue`, the runner's `metricFor` and `stale_metric` read them from the block). Bound: `DIGEST_LIMIT_CHARS` 12k →
  20k; `renderDigest` slims in steps — samples of unflagged resources, then ≤ 1 short sample, then quiet resources (no
  anomaly, no flag) collapse, then cut. `get_network_posts` also returns `text` (first 400 chars of the slot the agent wrote,
  via `published_posts.editor_slot_id` / `platform_posts.slot_id`); the excerpt stays the title.
- **No skip when quality changed**: `digestHash()` = KPIs + open directives + the quality signatures; `canSkip(last, digest)`
  (same hash and no anomaly). A new critic reject/revise, a new owner rejection/edit or a new flag (cap overflow, low pass
  rate) changes the hash. A clean approval or another pass does not.
- **Prompts / skill / quality_check**: `managerSystemPrompt` (two audits, KPI + quality; `continue` only after the checklist
  with evidence; quality problems → `voice_fix` / `format_mix`; no micromanaging single posts), the run's user prompt, the
  chat prompt (`buildManagerChatPrompt`: "no problems" only when the checklist shows it), `file_directive` / `submit_review`
  descriptions and `manager-workflow` (4.8k chars: the six-item checklist — AI-likeness, sense, voice/humour, polls and
  questions vs caps, owner rejections/edits, format fit — the two kinds, escalation-only directives for them) no longer say
  "continue is the normal / frequent answer"; `kpi-reading` explains the block. `submit_review` requires
  `quality_check: [{resource_ref, status ok|issue, evidence (20–400, a number or a quote), issues[], note?}]`;
  `checkQualityReview` refuses (tool error, nothing stored): a resource with activity in the block left out
  (`quality_check_missing`), an unknown ref, evidence without a number/quote, `issue` without items, `ok` on a resource with
  code flags without a note ≥ 20 chars (`quality_flags_ignored`), `continue` over an `issue` without a note
  (`quality_issue_unaddressed`). Stored in `manager_reviews.quality_check`.
- **`voice_fix`** (`executors/quality-executors.ts`; params `resource_ref`, `rules` ≤ 3 (10–240 chars, stored as
  «Голос (<ref>): …»), `bad_slot_ids` ≤ 3, `good_examples` ≤ 2 `{text, note, format?}`): bad examples must be real posts of
  the resource from the last 14 days that the owner rejected or the critic rejected / revised (`SqlQuality.evidencePosts`,
  loaded into `ExecContext.evidence`), with the owner's reason or the critic's notes as `note`; good ones pass
  `findSlopPhrases` and the reader-question cap and use a format of the section. Examples are tagged `[@manager]`, merged new
  first; when over 12 only older `[@manager]` examples make room (the owner's are never pushed out; full → not executable).
  Needs an active playbook (no card fallback). **Not structural** — deviation from the literal `classifyPlaybookChange` rule
  "rules changed": the voice rules are append-only (dry-run classification runs with the old rules list; any other change to
  rules stays structural). Apply: `applyDirectivePatch` (version `created_by directive`, re-apply no-op). Verify: pending
  for 3 days and until ≥ 3 posts were judged (critic or owner); then verified when the pass rate rose ≥ 10 points, the
  owner rejection rate fell, or the week is clean after a bad one; not followed otherwise or after 10 days without posts;
  violated when a rule was removed from the active playbook. `directive_lock`: removing one of its rules is a revert.
- **`format_mix`** (params `resource_ref`, `weights {format: lower 0–1}`, `drop [formats]`, `polls_per_week`,
  `questions_to_readers_per_day`): only lowers — a higher weight (`format_shift`), a cap ≥ the current one or above the
  default, an owner-locked cap field are not executable; raising stays owner-only (and `patchFormat` by `agent` refuses it
  too). Target: the playbook section, or the card for a single-channel orchestrator without a playbook, or `resource` for
  caps only. **Structural only when a format is dropped from a playbook section** (owner decides); lowering weights (any
  step) and caps, and a drop on the card apply at once. Caps are written with `ResourceProfilesRepository.patchFormat` as an
  agent change (versioned; skipped when they already hold). Verify over the next 3 plans: a dropped format planned →
  violated; poll + quiz slots over the new weekly cap → violated; a lowered weight whose share did not fall → not followed.
  `directive_lock`: raising a cut weight again is a revert.
- **Matrix**: `voice_fix`, `format_mix` = `either` (advice by default). Quality metrics never carry anomaly flags, so a
  binding directive of these kinds is admitted only by the FR-003 escalation (declined advice of the same kind in 14 days
  and the quality metric moved ≥ 5 % further against `expected`), by the owner, or as structural (a playbook drop).
- **Wiring**: `editor.module.ts` (`directiveExecution`: `SqlQuality` evidence / audience readers in `executionContextOf`,
  `voiceFixExecutor`, `formatMixExecutor`), `evals/lib/stack.ts` the same.
- **Dashboard** (English): Network health tiles get a "Content quality · 7 d" block (critic pass rate, polls / cap, your
  rejections and edits with tones, flag badges, "Notes and sample posts" with the critic notes, your reasons/edits and the
  samples as written); header "quality flags on N resources"; on phones flagged resources stay visible. Directives board:
  kind labels "voice fix" / "format mix", quality metric labels, `describeChange` lines; Reviews tab shows each run's
  quality check. `lib/quality-view.ts`. Browser-checked against a local mock API (127.0.0.1) at 800 px and 375 px (no
  horizontal overflow): tiles with flags / calm / no posts, notes and samples, kind filter, the quality check list.
- **Tests** (scripted fakes, no LLM): `manager/quality.test.ts` (block assembly, slot text, hash/skip for reject / revise /
  owner rejection / edit / poll overflow, a changed signature calls the LLM, render bound, `quality_check` rules and the
  stored review, prompts and skill without "continue is normal", quality metrics + escalation, `stale_metric`),
  `executors/quality-executors.test.ts` (plan / refusals / apply idempotent / verify for both kinds, example room,
  `directive_lock`), `directive-kinds.test.ts` (matrix cells), `manager/quality.pg.test.ts` (block from real slots +
  memory, hash on a new rejection, migration 071 re-apply and CHECK, voice_fix filed → accepted → applied quoting a real
  rejected post, format_mix caps through the profile, quality_check stored, `get_network_posts` text); dashboard
  `lib/quality-view.test.ts`, `directive-view.test.ts`.
- **For T9 (`manager-flags-quality`)**: seed a network whose last 7 days have ≥ 3 critic verdicts with a reject and notes,
  2 poll slots on a resource with the default cap 1, a post with two reader questions, an owner rejection with a reason
  (`skipped` + `rejected by owner` + `reject_reason`) and an owner edit (`owner_edited` + a memory row with `evidence.slotId`),
  sloppy sample texts; KPIs flat (no anomaly). Pass when the MANAGER files `voice_fix` (bad_slot_ids = the rejected slot)
  and/or `format_mix` (poll weight/cap down) as **advice**, or `continue` only with `quality_check` status `issue` + a
  note — never `continue` with "ok" on the flagged resource (the tool refuses it; count refusals as a soft failure). Use
  the `evals/lib/stack.ts` stack (it already registers both executors); grade with the stored `manager_reviews.quality_check`
  and `agent_directives` rows.

## Implementation notes (T9, 2026-10-10)
- **Cases** (`apps/automation/evals/cases/quality.ts`, registered in `run-evals.ts` as `QUALITY_CASES`; each on its own
  `@eval_*` key, the two critic cases share `@eval_critic`). Real LLM through the production wiring; fixture web only;
  nothing reaches Telegram, Meta or the internet. **Written, not run** (paid calls are the owner's to start).
  - `executor-voice-plain`: a news resource (`content_kind: news`, `humor: none`, `slang: false` set by the owner) and a
    story that invites jokes (a delivery robot stuck in snow). Hard: written (shadowed), no listed slop phrase
    (`findSlopPhrases`), no humour / slang marker (`humorHits` / `slangHits`), reader questions ≤ the card cap (0),
    `lintPost` ok, Ukrainian, numbers grounded. Soft: no `slop_*` warning, critic `pass` without `critic_revise`. Judge input.
  - `critic-rejects-slop`: `CriticService.review` on two fixed posts about one news item (request built like the gate's:
    card, voice, brief, source excerpt, the lint's `slop_*` warnings). The AI-sounding post has no listed phrase (so only
    the critic can stop it, as in production) but a rhetorical Q&A, a moral closer, a triple, dashes and exclamations.
    Hard: its verdict is `revise` / `reject`, the model's own verdict is not `pass` or `ai_likeness` ≤ 3 (so code
    thresholds alone cannot pass the case), and the clean post is `pass`.
  - `critic-rejects-nonsense`: a fluent, lint-clean post that contradicts its source (city, 2000 vs 200 MW, storage that
    "generates", "the whole country", "this week") → `reject` with `sense` ≤ 2 or `grounding` ≤ 2.
  - `planner-poll-cap`: poll and quiz in the card formats, polls best by views, a published poll 2 days ago, default cap 1.
    Hard: the final plan has no poll / quiz. Soft: no `polls_per_week` refusal from `submit_plan` (FR-015: a refusal is a
    soft failure).
  - `builder-fitting-formats`: "@ai0 create an agent for my short IT-news channel" → a `create_agent` card with 1–4
    `formats`, each with a reason ≥ 10 chars, no poll / quiz, no longread / carousel; nothing created before Apply.
  - `builder-examples-and-warnings`: the same conversation (one neutral follow-up turn allowed, soft) → a
    `content_examples` card: 3 examples that pass `checkExample` with the resource card, no listed phrase, no humour /
    slang, ≤ 1 reader question each, Ukrainian; 2–4 distinct warnings with a reason and a bad example ≥ 20 chars.
  - `manager-flags-quality`: the T4 "Notes for T9" week, seeded relative to the eval clock — flat KPIs, a critic reject,
    a revise → pass, 2 polls (cap 1), a waiting post with two reader questions, an owner rejection with a reason, an owner
    edit with its memory note, sloppy samples, an active playbook with `poll`. Hard: not skipped, a review stored, the
    resource never `ok` in `quality_check`, and either a `voice_fix` / `format_mix` directive or `quality_check` status
    `issue` with a note ≥ 20 chars. Soft: advice binding, `voice_fix` quotes a rejected slot, `format_mix` lowers polls,
    no `quality_check_*` refusal, evidence with a number or a quote.
  - `executor-live-news-fresh`: two live slots on fixture feeds dated against the eval clock. Feed A: posted today
    (0.5 h), fresh (1.5 h), older fresh (4.5 h), stale (30 h). Feed B: posted + stale only. Hard: A is published (fake
    Telegram) citing the 1.5 h item, never the posted or the stale one; B is skipped `no_fresh_item:` with no run and
    no LLM call.
- **Harness changes.** `evals/lib/stack.ts` now mirrors the spec 034 production wiring: `pollCaps` (`SqlPollCaps`) in
  both plan validators, the runner's `voiceOf`, the `live.scan` (`scanLive` through the fixture web and the fixed clock),
  `buildReadTools({ now })` so `fetch_feed` ages use the same clock, `propose_content_examples` (+ the
  `content_examples` card kind), and the **critic** (`CriticService` on the same loop, `EvalStack.critic`, the runner's
  gate; `EDITOR_CRITIC=off` disables it as in production). Every executor case therefore also pays one critic pass
  (≈ $0.001 on the default model). `EvalCase.web(now)` receives the eval clock; `CaseOutcome.extraRunIds` adds the cost of
  further runs (critic passes, a second chat turn); `run-evals.ts --list [--case …]` prints the registered cases without
  a DB, key or LLM call. `agents.ts` exports `resetAgents`, `ownChannel`, `trace`, `sendAgentChat` for reuse.
- **Fixture sanity** (`evals/cases/quality.fixtures.test.ts`, no DB / LLM / network; run with
  `npx tsx --test evals/cases/quality.fixtures.test.ts`, 7 tests pass): the 8 FR-015 ids registered once; the clean post
  lint-clean and grounded; the slop post with no listed phrase but `slop_rhetorical_qa` + `slop_moral_closer` (≥ 2
  warnings); the nonsense post lint-clean with the ungrounded 2000; feed ages 0.5 / 1.5 / 4.5 / 30 h against the clock,
  the posted title a repeat (`closestRecent` ≥ 0.6), the weekly feed with nothing fresh and unposted; the MANAGER texts
  (two reader questions, a listed cliché).
- **Run (owner)**: `cd apps/automation && EVAL_DB_URL='postgres://ai0@localhost/ai0?host=/tmp&port=54329' npx tsx
  --env-file=../../.env evals/run-evals.ts --case executor-voice-plain,critic-rejects-slop,critic-rejects-nonsense,planner-poll-cap,builder-fitting-formats,builder-examples-and-warnings,manager-flags-quality,executor-live-news-fresh --reps 3 --max-usd 1`
  (add `--judge` for the two executor posts). **Estimated cost** on the default `z-ai/glm-5.3-flash` (critic on the
  same model): ≈ $0.05 per pass of the 8 cases, ≈ $0.15 for `--reps 3` (+ ≈ $0.004 per pass with `--judge`); with a
  Sonnet-class critic via `EDITOR_MODEL_CHECKER` add ≈ $0.1 per pass. The per-case table is in `evals/README.md`.
- **Checks run**: `npx tsc --noEmit -p evals/tsconfig.json`, `npx tsc --noEmit -p tsconfig.json`, `npm run lint`
  (0 errors), `npm run build`, the unit suite on Node 20 (2155 tests, 0 failures), the fixture sanity test and `--list`.
  No live eval was run.
