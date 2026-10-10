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

