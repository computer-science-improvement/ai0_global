# 037 tasks (copied from Linear AI0-95…AI0-110 on 2026-10-15; Linear is the tracker, this file is the executor's copy)

Evidence: `channels - logs/` in the main checkout (`/Users/tupotavalentyn/CS/20-ai0/ai0-global/channels - logs/`, untracked,
Telegram Desktop HTML exports; never commit it, never commit images or raw HTML).

---

## T1 (AI0-95): Golden set from the three channels' logs + Telegram export audit — M, depends on —

**Why.** The 73 messages of the three DEV channels (07–14.10) hold real errors that neither lint nor the critic catches. Without a
golden set every new check is tuned blind. The owner reads exports by hand.

**Scope**
- Fixture `apps/automation/src/editor/post/testing/channel-logs-2026-10.json`: 73 messages from the HTML export. Per message:
  channel; publish time with zone; text with bold, links, buttons; media (type, count); poll (question, options, type).
  No images and no raw HTML in the repo.
- Labels: per post the expected check codes from T2–T11 (`story_repeat`, `date_relative_mismatch`, `text_replacement_char`,
  `quiz_answer_revealed`, `address_mixed`, …) or `clean: true`. Clean posts set the false-positive budget.
- Story-dedup pairs:
  - positive: Apple hub ×4; Out of Sight ×3; Steam 08.10 12:30 and 14:13; Qwen-Image digest 10.10 then post 12.10; Mistral Large 4
    07.10 then repeat with a poll 08.10; Gemini agent in both AI channels 09.10;
  - allowed follow-ups: Out of Sight + TerraScape 10.10 (a new game added); Epic giveaway reminder 08.10 09:18 (last 24 h);
  - negative: different stories with shared entities (different Epic giveaways, different Google models).
- Test `golden-set.test.ts` runs the deterministic checks over the fixture. Rows for rules not built yet are `todo`; each later task
  turns its rows on.
- Script `audit:tg-export` in `apps/automation/package.json`: reads a Telegram Desktop HTML export (incl. `rich_message`, polls and
  buttons), runs all deterministic checks, prints a markdown report per channel (code, date, excerpt).
- Critic cases in the 034-T9 eval format (written, not run): problem posts with context (previous story posts, publish date) and the
  expected verdict; clean posts with expected `pass`.

**Acceptance**
- [ ] Fixture and labels in the repo; no raw export or images.
- [ ] `golden-set.test.ts` green in CI (Node 20).
- [ ] `audit:tg-export` report over `channels - logs/` contains the epic's cases as soon as the checks exist.
- [ ] Critic cases written, not run.

---

## T2 (AI0-96): Story registry: one story — one post, return only with new facts — L, depends on T1

**Why.** Repeats: Apple hub ×4 (07, 09, 11, 12.10); Out of Sight ×3 (09, 10, 13.10); the same Steam deals twice in 1 h 43 min
(08.10); Qwen-Image in the 10.10 digest and as a post 12.10; Mistral Large 4 07.10 and again with a poll 08.10; Gemini agent in both
AI channels 09.10. `checkPublishGuards` (`role-tools.ts`) compares trigrams only (`SIMILARITY_LIMIT = 0.6`), the pairs are
0.19–0.58. `similarity.ts` leaves semantic repeats to the planner, which has no structured list of what went out. Entity overlap
(names, products, numbers) is 0.64–1.0 for repeat pairs, p95 = 0.29 for unrelated pairs.

**Scope**
- Migration 073 (with down): `editor_stories` (resource or network group, key, title, entities, status, first and last post,
  `event_at`, key facts jsonb); `editor_story_posts` (slot or published post, role `original` | `followup` | `reminder` | `roundup` |
  `repost` | `evergreen`).
- `src/editor/post/entities.ts` (pure): extracts brands, products with versions, game titles, names, numbers with units, domains;
  normalises case, hyphens, versions (`Qwen-Image-2.1-Turbo` → `qwen-image`); overlap as containment; threshold tuned on T1 pairs.
- Guard `story_repeat` in `checkPublishGuards`: candidates are the resource's posts of 14 days in statuses `published`, `shadowed`,
  `awaiting_approval`, `approved` (as `recentTexts`); overlap above threshold without `story.followup_of` → error listing the matches
  (date, lead, link) so the writer picks other material or writes a follow-up.
- PostSpec: `story { key?, followup_of?, kind?: followup | reminder | roundup | evergreen, new_facts?: string[] }`.
- Follow-up rules: `new_facts` non-empty and each (number or entity) absent from the original, else `followup_without_new_facts`;
  ≤ 1 follow-up per story per day; one giveaway/deal reminder, in the last 24 h before the end; a follow-up restating > half of the
  original gets warning `followup_restates` for the critic.
- Telegram: a follow-up is sent as a reply to the original if it is in the same channel and ≤ 14 days old.
- A digest (`roundup`) may include covered stories. A separate post on the same story after a digest needs `new_facts` (Qwen-Image).
- "Active stories (14 days)" block for planner and writer: key, title, last post date, post count, key facts, `event_at`.
  `fetch_feed` marks items matching an active story (`covered_by_story`).
- **Network (owner decision 15.10).** The registry is shared by the network group, so the channel agent (not only the manager) sees
  sibling posts. When the same story went out in another resource of the group within 24 h, the writer makes an explicit
  `story_decision`: `skip`; `own_angle` (warning `story_cross_channel` for the critic); `repost`: tool
  `request_story_repost(story_key, source_post_id, reason)` queues a native Telegram → Telegram forward through the existing
  `promo-executor` (same mechanism as the `repost` directive of the `network-promo` skill). Separate type `story_repost`, no 14-day
  promo cooldown, ≤ 1 forward per story per channel, ≤ 2 forwards per channel per day (configurable).
  - How to choose (new section in `network-promo` / T15): forward when the original already fits the audience and an own angle adds
    nothing; write your own when the channel has another view or level of explanation; skip when off-topic.
  - Decision and reason go to the trace and to `editor_story_posts` with role `repost` and a link to the original.
- **Stats and analytics (owner decision 15.10).** A repost is a separate category, not an own post:
  - receiving channel: counted separately from own posts in counters, in plan slots (a repost takes a slot) and in Analytics
    (`own` / `repost`). Excluded from T13 KPI samples.
  - repost metrics: views of the forwarded message, clicks and new subscribers of the source channel; attribution through the
    existing promo accounting (`promo-executor`); add `kind = story_repost` if its data is not enough.
  - source channel: sees how many times its post was forwarded and the reach it brought.
  - MANAGER: repost share per channel per week in the quality digest (`quality-digest.ts`), flag above 30 %.
  - Dashboard (English): "Repost from @…" badge in the channel's posts list; Analytics split Own vs Reposts.
- Critic gets the story's previous posts: date, lead, key facts.
- Backfill: on first run stories are built from published posts of 30 days.

**Acceptance**
- [ ] Every positive T1 pair gives `story_repeat` or a well-formed follow-up with new facts; false positives on negative pairs ≤ 5 %.
- [ ] A follow-up without new facts is blocked; with new facts it goes as a reply to the original (dry-run, no real channel).
- [ ] Planner prompt and `fetch_feed` show active stories (snapshot test).
- [ ] Migration up/down on a scratch PG.
- [ ] A sibling-channel story is shown to the writer; each of `skip`, `own_angle`, `repost` checked in dry-run without a real
      channel; decision and reason are in the trace.
- [ ] Reposts are separate in Analytics (Own vs Reposts) and in the posts list; T13 KPI samples exclude them (unit test).
- [ ] The manager digest shows the repost share and the flag above 30 %.

---

## T3 (AI0-97): Announcement → recap: a dated event gets a post after it — M, depends on T2, T5

**Why.** AI Шукає Новини announced Apple Welcome Home (13.10, 16:00) 4 times (07, 09, 11, 12.10); as of 14.10 morning no post about
the event. "Fitbit Edge release expected 12 October" (post 10.10), nothing after. Game dates are not tracked (CoD MW4 23.10,
Warhammer Survivors PS5 10.11, Phoenix Cyclops 02.11).

**Scope**
- An announcement records `story.event_at` and the event name; it must contain the date, checked by the T5 date parser.
- Before the event: 1 announcement + 1 reminder (≤ 24 h before). Another pre-event post without new facts → `story_repeat` (T2).
- 2 h after `event_at` a "recap needed" item appears in orchestrator and planner context (what event, how many times announced,
  what was shown); it has priority over ordinary feed items.
- No recap within 24 h after the event → owner Inbox note and `event_not_covered` row in the MANAGER digest.
- Release day: a reminder that day is allowed as `reminder`.

**Acceptance**
- [ ] On the Apple case of T1 the 3rd and 4th announcements are blocked, and after 13.10 16:00 the planner context has "recap needed".
- [ ] Fake-clock test: no recap after 24 h → one Inbox note per event.
- [ ] Event dates parse in the forms «13 жовтня о 16:00 за Києвом», «13.10», «23 жовтня».

---

## T4 (AI0-98): Facts and sources: numbers from the source, contradictions, critic context — L, depends on T2

**Why.** Contradictions between own posts: RDR2 «539 грн замість 1799» (08.10) vs «649 грн замість 2599» (09.10); Out of Sight «сліпий
хлопчик» (09.10) vs «сліпа дівчинка Софі» (10.10). Unsupported claims: «Цього достатньо для 90% побутових задач» (11.10); «Понад 80%
контенту на Netflix підбирає алгоритм» (14.10, source a "20 fun facts" page on `faktypro.com.ua`); «Gemini 4 Argon пише тексти
довжиною до 1 мільйона» (context confused with output length). Homepages as source: `marktechpost.com/` ×2, `ynab.com/`,
`elementsofai.com/`, `store.steampowered.com/` ×2, `itch.io`. One-sided sources: 7 of 15 in AI Технології are MarkTechPost; AI Шукає
Новини uses only TechCrunch (11), The Verge (11), dev.ua (2). The critic gets the first 4000 chars of the page (`SOURCE_CAP`,
`critic-gate.ts`), not the passage the fact came from.

**Scope**
- `src/editor/post/grounding.ts` (deterministic): extracts numbers from the post (prices, percentages, counts, units, dates);
  understands «1,05 трлн», «850 тисяч», «2 599», «$0.10», «−75%»; normalises and looks them up in the full texts of all pages read in
  this run (`fetched` keeps up to 60k chars, not 4000); not found → warning `number_not_in_sources` with the list, for the critic
  (grounding) and on the approval card; ignores years, the post date, list numbering and product versions.
- Critic context: instead of the page head, passages around the post's numbers and entities (±400 chars, ≤ 6 passages, ≤ 6000 chars),
  plus page title and publish date.
- `fact_conflict`: for previous posts of the story (T2) compare the same facts (game price and discount, character, date); mismatch →
  warning with both values and dates; the critic must verify or say explicitly that the price changed.
- `source_is_homepage` (lint error): `source.url` is a site root or a section index (`/`, `/search`, `/new-and-popular`). The ledger
  stops filling up with site roots too.
- Source tiers in data, not only prompts: `primary` (official blogs, stores, docs, press releases, authors' arXiv and GitHub), `media`,
  `aggregator` (MarkTechPost, GamerPower), `low` ("fun facts" lists, content farms). `aggregator` with a link to a primary source on
  the page → warning "take the primary"; `low` with numbers → `low_tier_claim`.
- MANAGER digest: source share by tier per resource.

**Acceptance**
- [ ] On T1: «90%», «80% Netflix» and «1 мільйона» → warnings; RDR2 and Out of Sight → `fact_conflict` with both values; all 7
      homepage posts → `source_is_homepage`.
- [ ] Snapshot test of the critic prompt: passages around claims, not the page head.
- [ ] Unit tests for number normalisation; on synthetic sources that contain the numbers there is no false `number_not_in_sources`.

---

## T5 (AI0-99): Dates and freshness: deterministic check and the publish date for the critic — M, depends on T1

**Why.** «Реліз очікується вже завтра, 12 жовтня» in a post of 10.10 (the source wrote US «10.12.26»). «Mistral щойно показала Le
Chonk» (08.10) though the channel wrote about it 07.10 and the article is 2 days old. «з завтра» copied from The Verge without checking
the article date (08.10). Giveaway «до 8 жовтня» published 08.10 at 19:00. Source age: Біржа Ігор 4 PlayStation Blog posts on 3–5-day
old articles; "game of September" vote 5 days after start; AI Шукає Новини all 11 TechCrunch articles 1–2 days old. The critic does
not know the publish date/time.

**Scope**
- `src/editor/post/dates.ts` (pure) parses: «сьогодні», «завтра», «післязавтра», «вчора»; weekdays in all cases; «12 жовтня»,
  «12.10», «12.10.2026»; «до 15 жовтня 17:00», «з 16 жовтня», «о 16:00 за Києвом». Relative dates resolve from the scheduled publish
  time in the resource zone (`card.timezone`).
- Rules: `date_relative_mismatch` error (relative word and explicit date disagree with the publish date); `weekday_mismatch` error
  («у вівторок, 14 жовтня» when 14.10 is Wednesday); `relative_date_unanchored` warning («завтра»/«з завтра» in news without an
  explicit date); `stale_now_word` warning («щойно», «тільки-но», «прямо зараз» when the source or the story's first post is older
  than 24 h); `deal_expired` error (giveaway/deal deadline not after publish time); `deal_expiring` warning (< 6 h left);
  `stale_source` warning for planner and critic (source older than the resource freshness threshold: news 36 h, games 72 h;
  explainers and evergreen exempt).
- Source date: `published_at` from `article:published_time`, JSON-LD `datePublished`, `<time datetime>` or RSS `pubDate`; stored with
  the fetched text; `fetch_feed` items get `age_hours`.
- Critic prompt contains the publish time, e.g. «Публікація: середа, 08.10.2026 14:00 (Europe/Kyiv)», the source date and the
  story's first post date.

**Acceptance**
- [ ] On T1 flagged: Fitbit (10.10); Mistral «щойно» (08.10); OpenAI «з завтра» (08.10); giveaway until 8.10 published 08.10 19:00;
      PlayStation Blog posts. Clean posts stay clean.
- [ ] Unit tests: genitive months; weekday cases; «до 15 жовтня 17:00»; historical dates («у листопаді 2024 року») do not fire; IANA
      zone incl. around 25.10.2026 (DST end).
- [ ] Snapshot test: the critic prompt contains the publish date.

---

## T6 (AI0-100): Text hygiene and typography — M, depends on T1

**Why.** «пе��еважно» (U+FFFD) in the Ledger post 11.10, published after the critic. Latin inside a Cyrillic word «Меркoff» (08.10,
twice); mixed hashtag `#aiновини` (13.10). Process leak (Біржа Ігор 13.10): «Актуальних промокодів … на сьогодні не знайшлось, тому
в пості лише перевірені роздачі». «Джерело: …» in the text plus the code-added «→ …» line (09.10 both AI channels). Bold lead: median
148 chars, 30 of 55 over 140, max 280. Slop missing from 034 lists: «той випадок, коли»; «Мораль для всіх, хто…»; «Панікувати не
варто»; «Коротко — що анонсували»; «Зберігайте собі»; «Здогадаєтеся, який?»; «Признавайся». Apostrophe «з'явились» and «зʼявиться»
in one channel.

**Scope**
- `text_replacement_char` (error) in lint and in critic-gate: U+FFFD, control chars, zero-width inside words, typical mojibake
  sequences. Separately: find where the 11.10 U+FFFD came from (page encoding or a cut model stream) and fix it there.
- `mixed_script_word` (error): Cyrillic and Latin in one word or hashtag. Latin name + hyphen + Ukrainian ending («iPhone-ом») allowed;
  homoglyphs only (Latin o, a, e, i, c, p, x, y in a Cyrillic word) → auto-fix to Cyrillic; real mix («Меркoff») → error with a hint
  (Murkoff or Меркофф).
- `process_leak`: sentences about the agent's work: «не знайшлось, тому», «у пості лише», «я перевірив», «за моїми даними»,
  «інструмент повернув», «згідно з брифом», «на жаль, не вдалося знайти». Explicit → error, otherwise warning.
- `duplicate_attribution` (auto-fix): a trailing «Джерело: X» or «За даними X» line is removed when the code renders a footer or button
  with the same domain.
- `lead_too_long`: warning over 140 chars, error over 220; threshold from the resource style (T8). The lead is one hook sentence.
- Repeated thought inside a post (OnePlus 16, 13.10): mainly the critic rubric (T15); deterministically only a verbatim 4+-word repeat.
- Slop: errors in `slop-phrases.ts`: «зберігайте собі», «признавайся», «здогадаєтеся», «панікувати не варто»; warnings in
  `slop-lint.ts`: «це той випадок, коли», sentence-initial «коротко —»; add «мораль» to `MORAL_CLOSER`.
- Typography normaliser, auto-fix before render: apostrophe between Cyrillic letters → ʼ (U+02BC); straight quotes in Ukrainian text →
  «»; double spaces. Idempotent; never touches URLs, code, hashtags, Latin.
- Decimal separator: warning `decimal_mixed` only, when a post has both «1,05» and «0.10». Which one is right is the style's call (T8).
- The critic gets every lint warning, not only `slop_*` ("Lint warnings" block in `criticUserPrompt`).

**Acceptance**
- [ ] On T1 flagged: U+FFFD, «Меркoff», `#aiновини`, the 13.10 process leak, the 09.10 duplicate source, long leads and all 7 slop
      phrases.
- [ ] Normaliser idempotent; tests for URLs, code, hashtags, Latin.
- [ ] No new error on clean T1 posts.

---

## T7 (AI0-101): Polls and quizzes — M, depends on T2

**Why.** All 5 polls are regular anonymous. Two are knowledge questions with one right answer that is already in the text: «Який
офісний пакет заявив, що відсутність ШІ — це фіча?» (07.10 19:00; the post of the same minute says «LibreOffice»); «Скільки параметрів
Mistral Large 4 реально активні на кожен токен?» (08.10 12:30; answer in the same-minute post and the 07.10 post). Transliteration in
options: «Хмара через АПІ», «Агенти й КЛІ» (07.10). Біржа Ігор: 2 polls a week (07.10, 10.10) with cap 1; the cap is only in plan
validators (`roles/poll-cap.ts`), not before publishing.

**Scope**
- `knowledge_poll` warning for writer and critic: question word («який», «скільки», «хто», «коли», «де») and options are names or
  numbers; or the answer is already in the text. Fix: `format: quiz` with `correct_index` and `explanation` (≤ 200 chars).
- `quiz_answer_revealed` (error): the normalised correct option appears in the poll intro, in the companion post, or in a post of the
  same story in the last 24 h (T2). Revealing goes to `explanation`.
- `poll_cap_reached` in `checkPublishGuards`: the same logic as `pollCapErrors` but on actual data (published, waiting and approved
  polls and quizzes in the window); covers live slots, chat and approval.
- Glossary (T8) applies to question and options (lint already takes them into `plain`).
- Opinion polls stay regular anonymous polls.

**Acceptance**
- [ ] On T1 both knowledge polls get `knowledge_poll` and `quiz_answer_revealed`.
- [ ] A 2nd poll in a week with cap 1 is blocked before publishing, incl. through a live slot (pg test).
- [ ] A quiz with an explanation renders and passes the existing publisher in dry-run.

---

## T8 (AI0-102): Resource style: address, glossary, names, units, hashtags off — L, depends on T1

**Why.** Біржа Ігор mixes ти and ви, also after the critic (ти: «Висаджуєшся», «перевіряй», «граєш», «Розставляєш», «Признавайся»;
ви: «Ви граєте», «заходите», «Забирайте», «Голосуйте»). Names/terms: translated brands «Разом AI випустила Together Link» (09.10),
`#спотифай` (07.10); transliteration «АПІ», «КЛІ»; ШІ/AI mixed is NOT an error (owner). Names: «Mustafa Suleyman» in Latin (13.10) and
«Ендрю Фелдман» in Cyrillic (14.10). Units: «49B», «270M», «3B», «600M», «12B», «27B» in a channel for ordinary people. Hashtags:
AI Шукає Новини 32 distinct on 24 posts; AI Технології `#ші`/`#ai`, `#open_source`/`#opensource`, `#ainews`; Біржа Ігор
`#роздача`/`#роздачі`. `card.hashtags` is empty so `hashtag_not_in_vocabulary` never fires. **Owner decision 15.10: no hashtags in
news channels.**

**Scope**
- `style` block in `FormatPrefsSchema` (`resource-profile.ts`):

  | Field | Values | Check |
  |---|---|---|
  | `address` | `ty`, `vy`, `impersonal`; `vy` for all resources (owner) | `address_mixed` |
  | `glossary` | `{ prefer, ban }` | `glossary_violation`, error with hint, built on `findBannedTerms` |
  | `names` | `uk_translit` or `original` | `name_script_mixed` warning |
  | `headline.max_chars` | number | threshold for `lead_too_long` (T6) |
  | `numbers.decimal` | `comma` or `dot` | decimal separator |
  | `units` | `words` or `latin` | units for beginners |
  | `hashtags` | `off` or `vocabulary`; `off` for the three DEV channels | `hashtags_disabled` |
  | `audience.level` | `beginner`, `general`, `expert` (used by T9) | — |

  - `address_mixed`: error when both forms are in one post; warning when the form does not match the resource; markers are pronouns and
    2nd-person singular/plural verb forms; quotes ignored.
  - `glossary`: bans transliterations and translated brands: «АПІ», «КЛІ», «Разом AI», «спотифай». ШІ/AI not checked.
  - `units: words`: «3 млрд параметрів» instead of «3B». Model names (d1-3B) untouched.
  - `hashtags: off`: the writer prompt says no hashtags; lint `hashtags_disabled` is an error when the text has `#word` (not in links,
    not in code); `vocabulary` stays for channels that want hashtags later (existing `card.hashtags` + `hashtag_not_in_vocabulary`).
- Bootstrap is a proposal, not applied: from 60 days of posts compute name usage; hashtag frequencies only for `hashtags: vocabulary`
  resources. The owner confirms in the UI; nothing blocks before that.
- UI (English): Resource → Formatting, section "Style sheet" with a "Hashtags: Off / Vocabulary" switch; proposals can be accepted or
  rejected; the vocabulary (Vocabulary mode only) goes to `card.hashtags`.
- Prompts: writer and critic get the style as a compact block (executor prompt and `criticUserPrompt`).
- Other platforms: `lintPlatformPost` (IG, FB, Threads) gets the same address and glossary rules.
- Default for the three DEV channels: `address: vy`, the glossary bans above, `hashtags: off` (via the data/migration path the
  project uses for card defaults, or a documented one-off owner action — never by writing to a real DB from dev work).

**Acceptance**
- [ ] On T1: every ти post in Біржа Ігор gets `address_mixed` with `vy`; «Разом AI», `#спотифай`, «АПІ», «КЛІ» → `glossary_violation`;
      Suleyman → `name_script_mixed` with `uk_translit`; every post with a hashtag in the three DEV channels → `hashtags_disabled`.
- [ ] The style proposal for the three DEV channels shows in the UI; rules act only after confirmation.
- [ ] Quotes and impersonal posts give no false `address_mixed`.

---

## T9 (AI0-103): Variety and audience level — M, depends on T1, T8

**Why.** Listicles "5 X", three in 3 days in AI Технології («5 термінів ШІ простими словами» 10.10; «Пʼять готових шаблонів» 12.10;
«пʼять безкоштовних ресурсів» 12.10). Subheading «Що X:» 9 times in 43 AI posts («Що сталося:», «Що це означає для вас:», «Що
всередині:», «Що ще вміє Turbo:»…). Phrase repeat «назавжди в бібліотеці» in 3 giveaway posts. Jargon: AI Технології writes for
"ordinary people" but retells a research feed without explanations: «Matryoshka-трюнкація: 768d → 256d», MTEB, decision models, MoE.

**Scope**
- Monotony signals, deterministic, from the resource's last 20 posts: repeated opening pattern (number + noun, «Що X:», same first
  word); shared 3–5-word phrases across posts; same format and topic twice a day. Output: `monotony_*` warnings for the critic; an
  "Already used" block in the writer prompt (phrases and patterns to avoid).
- Audience level in the resource style (T8): `audience.level`. Jargon density: terms from a list (MoE, embedding, токени, параметри,
  fine-tune, inference, бенчмарк, MTEB, LoRA, RAG, API, CLI…) that the post does not explain. Over the level budget → `jargon_over_level`
  for the critic.
- Feed fit: in the MANAGER digest per feed the share of items that got `jargon_over_level`, `revise` or `reject` from the critic, and a
  suggestion to replace or limit the feed (e.g. MarkTechPost for AI Технології).

**Acceptance**
- [ ] On T1: the third "5 X" in 3 days → warning; the third «назавжди в бібліотеці» → warning; EmbeddingGemma (07.10) →
      `jargon_over_level` for `beginner`.
- [ ] Snapshot test: the writer prompt contains the "Already used" block.
- [ ] Negative T1 cases (different formats and topics) give no monotony warnings.

---

## T10 (AI0-104): Silent channels: diagnosis, fallback steps, alerts — M, depends on — (evergreen step after T2 and T12)

**Why.** Біржа Ігор: 0 posts on 11 and 12.10, right after the critic went live (10.10 ~19:40); before that 2–4 a day. AI Технології:
the 12:00 slot (09.10, 10.10 «Три новини дня», 14.10) missed 11–13.10. Critic pass rate 33 %, 67 %, 50 % (Network health); `revise`
gives one rewrite, `reject` skips the slot; a strict critic + one attempt = silent days. Nobody was notified.

**Scope**
1. Diagnosis on the stage DB, read-only; the service is never started against real data. For the slots of 11–13.10 of the three
   resources: statuses; critic verdicts and notes; lint errors and `failed` reasons; live-slot decisions; budgets (029) and poll caps.
   Conclusion as a comment on AI0-104. (Executors without stage DB access: diagnose from the code paths and state what the owner must
   query.)
2. Fallback ladder for a slot whose post failed, within budget: `revise` → rewrite (exists); repeated failure → the next candidate for
   the same slot, once; then a lighter allowed format; then an evergreen post; else skip with a recorded reason.
   **Evergreen** (owner decision 15.10: allowed): a post without a date anchor: explainer, guide, glossary, roundup within the channel
   topic. ≤ 1 evergreen per channel per day (configurable). Same checks: lint, guards, critic with resource skills (T12); a rejected
   evergreen → the slot is skipped. No repeated topic: evergreen is registered in the story registry (T2); repeating a topic within 30
   days is blocked by `story_repeat`. Numbers and claims only with a source (T4); without a source no specific numbers. No «щойно»,
   «сьогодні», «новина» (T5). Image per T11: a poster only with a matching `use_for`, else none. In stats and Analytics evergreen is
   marked separately (`evergreen`); the manager digest shows the evergreen share per channel per week and flags it above 25 % (lack of
   fresh sources). The Inbox alert still fires: evergreen fills the slot, but the reason the main post was skipped is visible.
3. Inbox alerts (`owner-inbox.ts`): `dark_day` (a resource planning ≥ 1 post a day has no publication by 18:00 local);
   `series_missed` (a series or fixed slot did not go out); `critic_reject_streak` (N rejections in a row).
4. MANAGER digest (`quality-digest.ts`): per resource and day planned, published, skip reasons (critic, lint, cap, nothing fresh,
   budget); new flags `dark_day` and `series_missed` in `QUALITY_FLAGS`.

**Acceptance**
- [ ] AI0-104 has a comment with the cause of the Біржа Ігор silence 11–12.10 and the missed AI Технології 12:00 slot.
- [ ] Fake-clock tests: `dark_day` and `series_missed` give one note per resource per day.
- [ ] The digest shows planned / published and skip reasons.
- [ ] Dry-run: a slot with two critic rejections is filled by an evergreen post; a second one the same day in the same channel is not
      created; a topic repeat within 30 days is blocked.
- [ ] Evergreen is separate in Analytics and in the manager digest.

---

## T11 (AI0-105): Media: image only from the source news, posters not on news — M, depends on T4

**Owner decision (15.10):** an image only if the source news had one; otherwise the post has no image.

**Why.** Posters from `ai_posters` (`docs/data/ai-posters.json`) were used as fillers and off topic: «Prompt» and «Skill» on a free
course roundup (12.10); «Fine-tune / Model» on Qwen-Image image-generation news (12.10).

**Scope**
- Source image: when reading the page, together with the text (`fetched`) store its main image: `og:image`, `twitter:image` or the
  first article image.
- News posts (news, giveaways, deals with a source): `media` only the image from this source; anything else → `image_not_from_source`
  (error); no image in the source → no media, format `text`.
- Posters `ai_posters`: only for non-news posts (explainer, glossary, roundups); topic must match `use_for`, else `poster_mismatch`
  (warning); the critic sees the poster name and `use_for`; a poster on a news post → error.
- Update `source-licensing.md` (T15).

**Acceptance**
- [ ] News with an image in the source gets exactly it; news without gets no media; a foreign image → `image_not_from_source`.
- [ ] The 12.10 cases reproduced by a test → `poster_mismatch`; a poster on news → error.

---

## T12 (AI0-106): The critic gets resource, format and topic skills (same model as the writer) — S, depends on T1

**Owner decision (15.10):** the critic model is the writer's; quality comes from the right skills.

**Why.** `criticSystemPrompt` (`critic.service.ts`) gives the critic only the `editor-critic-workflow` rubric and `voice-core`. It
does not see the resource tone (`tone-gaming`, `tone-ai0-news`…), format (`format-poll-quiz`, `format-longread`…) or topic skills
(`fact-check`, new `deals-giveaways`, `news-followups`, `proper-nouns-terms`), so it checks by general rules — and passed a knowledge
poll instead of a quiz, mixed address and a giveaway after its deadline.

**Scope**
- The same skills as the writer: by the writer's selection rules for this slot: resource skills (`card.skills`, tone); the post's
  format skill; topic skills by content type (news → `news-followups`, `fact-check`; giveaways and deals → `deals-giveaways`);
  `proper-nouns-terms`.
- Prompt budget: skills compressed to rules (no examples) with a char limit; what does not fit is listed by name. Deterministic.
- Model unchanged: `ai.critic_model` stays an optional setting of the Models page.
- T1 critic cases (written, not run) cover these skills.

**Acceptance**
- [ ] Snapshot test: for a poll in Біржа Ігор the critic prompt contains `tone-gaming`, `format-poll-quiz`, `deals-giveaways`.
- [ ] The critic prompt stays within the limit.
- [ ] Code does not change the critic model.

---

## T13 (AI0-107): KPI: no conclusions on a small sample — S, depends on —

**Why.** An agent concluded «Альбом — найсильніший формат за 30 днів» at ~2 views per post. `get_format_performance`
(`role-tools.ts`) returns median views per hour per format without sample size or confidence. `set_format_weights` and `add_memory`
accept such conclusions unchecked.

**Scope**
- `get_format_performance` returns per format `n`, median views and `confidence`: `ok` (n ≥ 8 and median ≥ 30 views); `low` (between);
  `insufficient` (n < 3 or median < 10). If every format is `insufficient`, the tool adds a summary "not enough data".
- `set_format_weights` returns `insufficient_data` (with the numbers) if the change relies on an `insufficient` format. Exception: a
  direct owner directive.
- `add_memory`: a performance note requires `evidence { n, metric }`; refused when `insufficient`.
- `kpi-reading.md`: sample-size rules and the "not enough data" wording (T15).
- KPI digest (`kpi-digest.service.ts`) marks low-confidence numbers.

**Acceptance**
- [ ] Unit tests: n = 3 with 2 views → `insufficient` and `set_format_weights` refuses; n = 10 with 50 views → `ok`.
- [ ] Existing memory rows with such conclusions are listed for the owner (a query in the PR/merge description). Not deleted.

---

## T14 (AI0-108): Post audit and error visibility: Network health, approval card, digest — L, depends on T5, T6, T8

**Why.** The owner asked how to see what exactly is wrong; Network health shows only counters and pass rate. Everything in the epic
was found by reading the export by hand.

**Scope**
- Post audit: all deterministic checks (T2–T9, T11) over the resource's published posts of 7 days (`editor_slots` with spec,
  `published_posts`); runs daily and on demand; results in table `editor_post_audit` (post, code, level, message, time), migration 074;
  after a rule change the audit recomputes the last 7 days.
- Network health → resource → "Notes and sample posts": issues grouped by code with count; for each the post (date, link, excerpt);
  rule explanation and how to fix; UI in English.
- Approval card (`ApprovalCard.tsx`, `CriticBlock.tsx`) shows before the owner approves: lint warnings; numbers without a source; story
  matches with links to previous posts; date checks.
- MANAGER digest: new flags from the audit table: `story_repeat`, `fact_conflict`, `date_issue`, `text_hygiene`, `style_violation`,
  `dark_day`.

**Acceptance**
- [ ] On a scratch DB with the T1 posts the audit stores the expected flags.
- [ ] The UI shows the flags with links and explanations; checked in the browser preview on test data, no real channels.
- [ ] UI in English, no horizontal scroll at 375 px.

---

## T15 (AI0-109): Skills: story follow-ups, names and terms, giveaways; updates — M, depends on — (prompts only)

**Scope**
- New skills in `editor-skills/`:
  - `news-followups.md`: one story — one post; return only with new facts, as a reply to the original, framed «Оновлення:»;
    announcement → event → recap; never re-announce; how to read the active stories list; cross-channel: skip / own angle / repost.
  - `proper-nouns-terms.md`: brands and products in Latin (Together AI, Spotify); names per resource policy; abbreviations without
    transliteration (API and CLI, not «АПІ» and «КЛІ»); ШІ/AI by context (no rule); gender of companies («Apple оголосила», «OpenAI
    випустила»); units for beginners.
  - `deals-giveaways.md`: one giveaway — one post and at most one reminder in the last 24 h; exact end date and time with zone; the
    source is the game's store page, not the homepage; prices from the store page at publish time; no remarks like «промокодів не
    знайшлось».
- Updates: `format-poll-quiz.md` (knowledge question → quiz with explanation; never reveal the answer in the intro or a fresh post;
  opinion → anonymous poll); `fact-check.md` (every number must be in the source; from an aggregator go to the primary; "fun facts"
  lists need a second source); `editor-critic-workflow.md` (dates vs publish date; story's previous posts; resource style; process
  leak; repeated thought; U+FFFD and mixed scripts); `voice-core.md`, `anti-slop.md` (new slop; one address form per resource);
  `content-sources.md` (source tiers; no homepages; freshness thresholds); `source-licensing.md` (photo policy, T11);
  `kpi-reading.md` (sample size); `grammar-ua.md` (apostrophe ʼ, decimal separator, «» quotes); `format-hashtags.md` (hashtags off by
  default in news channels; vocabulary mode uses canonical forms only); `tone-gaming.md` (address from the resource style);
  `network-promo.md` (story repost: when to forward vs own angle vs skip).
- Link to checks: when a skill rule has a deterministic check, the skill names its code.

**Acceptance**
- [ ] 3 new skills and all listed updates in the repo; the skills test (034-T8) is green.
- [ ] Skills do not contradict each other (skills test or a grep in the merge).

---

## T16 (AI0-110): Steam deals duplicate passed the ledger with the same source.url — S, depends on —

**Why.** Біржа Ігор 08.10 12:30 and 14:13: the same deals (Skyrim −90 %, The Outlast Trials −90 %, Cyberpunk 2077 −70 %), both with
source `https://store.steampowered.com/`. The second must have been blocked: `checkPublishGuards` calls `sourceAlreadyPosted`
(`role-tools.ts` → `ledger.used(…, {waiting: true})`, `editor-plans.repository.ts`). The third (09.10 18:01, `…/search/?specials=1`)
passing is expected: a different URL.

**Scope**
- Stage DB (read-only): `spec.source` of both slots; ledger (060) rows for `store.steampowered.com`; which path published each post
  (editor slot, live slot, chat, platform post); ledger write time vs check time. (Without stage DB access: find the gap from code.)
- Fix the gap. Possible causes: a publish path without the check or the ledger write; root canonicalisation; a race of two slots
  written before the first published.
- Regression test.

**Acceptance**
- [ ] The cause is described (comment on AI0-110 / merge message).
- [ ] Fix + regression test. T4 bans homepages anyway, but the ledger gap must be closed for ordinary URLs too.
