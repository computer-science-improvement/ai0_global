# 037: Content integrity: one story one post, facts and dates from the source, resource style, visible errors

**Status:** IN PROGRESS · **Priority:** P0 (owner request 2026-10-14) · **Depends on:** 023, 025, 031, 034, 035
· **Linear:** epic AI0-94, T1–T16 = AI0-95…AI0-110 · **Migrations:** `073_story_registry.sql` (T2), `074_post_audit.sql` (T14)

**Owner request (2026-10-14):** read the Telegram Desktop exports of the three DEV channels (AI Шукає Новини, AI Технології,
Біржа Ігор; 07–14.10, 73 messages, `channels - logs/`, not committed) and say what to improve globally, as skills or rules.
Owner decisions of 2026-10-15 are recorded under *Decisions*.

## Why (from the logs and the code at 0194e9c)
Spec 034 fixed the voice (em-dash 5.3 → 1.2 per 1000 chars, reader questions 4 → 0, emoji 2 → 0 after the critic went live on
10.10 ~19:50), but neither lint nor the critic catches:

1. **Story repeats.** Apple hub ×4 (07, 09, 11, 12.10), Out of Sight ×3, Steam deals twice in 1 h 43 min (08.10), Qwen-Image in a
   digest then as a post, Mistral Large 4 twice, the Gemini agent in both AI channels. Text similarity of these pairs is 0.19–0.58
   against `SIMILARITY_LIMIT = 0.6` (`tools/role-tools.ts`); `post/similarity.ts` says semantic repeats are "the planner's job",
   but the planner has no structured list of what went out. Entity overlap separates them (0.64–1.0 for repeats, p95 0.29 for
   unrelated pairs).
2. **Announcement without a follow-up.** Apple Welcome Home (13.10 16:00) announced 4 times, never covered; Fitbit "release
   expected 12.10" never followed up.
3. **Facts.** RDR2 "539 of 1799 UAH" vs "649 of 2599"; Out of Sight "blind boy" vs "blind girl Sophie"; "90% of household
   tasks", "80% of Netflix" (from a "20 fun facts" page), "Gemini writes up to 1M tokens" (context confused with output).
   The critic gets the first 4000 chars of the page (`SOURCE_CAP`, `critic/critic-gate.ts`), not the passage the fact is from.
4. **Dates.** "already tomorrow, 12 October" in a post of 10.10 (US date in the source); "just announced" about a 2-day-old
   release; a giveaway "until 8 October" posted 8.10 at 19:00; game news from 3–5-day-old sources. The critic does not know the
   publish date.
5. **Broken text.** U+FFFD in a published post (11.10, after the critic), Latin inside a Cyrillic word ("Меркoff"), `#aiновини`.
6. **Polls.** All 5 polls are regular anonymous polls; two are knowledge questions whose answer is in the post next to them.
   The poll cap is checked only by plan validators (`roles/poll-cap.ts`), not before publishing.
7. **Process leak:** "no current promo codes found, so the post has only verified giveaways" (13.10).
8. **Style not held.** ти/ви mixed in Біржа Ігор; 32 distinct hashtags on 24 posts; "Разом AI", "АПІ", "КЛІ"; names in Latin and
   Cyrillic side by side; the bold lead has a median of 148 chars (30 of 55 over 140, max 280).
9. **Sources.** Homepages as the source (7 posts); MarkTechPost is 7 of 15 sources of AI Технології; "Джерело: …" duplicates the
   code-rendered "→ …" line.
10. **Media.** Posters "Prompt"/"Skill" on a course roundup, "Fine-tune / Model" on Qwen-Image news; stock photos from news sites.
11. **Silence.** Біржа Ігор had 0 posts on 11–12.10 right after the critic went live; the AI Технології 12:00 slot missed
    11–13.10; nobody was notified. Critic pass rates 33 / 67 / 50%.
12. **Conclusions on noise.** "Album is the strongest format over 30 days" at ~2 views per post.

Roots in the code: dedup by URL + trigram only; the critic sees no previous posts, no publish date, no resource style, no
resource/format/topic skills (`criticSystemPrompt` = `editor-critic-workflow` + `voice-core`); no deterministic date, number or
character checks; resource style is not formalised; no reaction to missed slots; KPI tools have no sample-size guard.

## Decisions (owner, 2026-10-15)
- **Critic model** stays the writer's model; quality comes from giving the critic the right skills (FR-012).
- **Images** only if the source news had one; otherwise no image; posters never on news (FR-011).
- **Address** «ви» for every resource (FR-008). **ШІ / AI** by context, no rule.
- **Follow-ups** only with a new fact, as a reply to the original, ≤ 1 per story per day; **giveaway reminder** one, in the last
  24 h; **freshness** news ≤ 36 h (else a "why now" angle), games ≤ 72 h.
- **Same story in two network channels:** the channel agent sees the group's stories through the shared registry and decides
  `skip` / `own_angle` / `repost` (forward the sibling's original into its own channel). Reposts are a separate category in stats
  and analytics (Own vs Reposts), excluded from text-quality KPIs (FR-002).
- **Hashtags:** none in news channels (`style.hashtags: off`, all three DEV channels) (FR-008).
- **Evergreen fallback** for a failed slot: allowed, ≤ 1 per channel per day, full checks + critic, separate analytics category,
  the Inbox alert about the missed main post stays (FR-010).

## Functional requirements
| ID | Requirement |
|---|---|
| FR-001 | **Golden set + export audit.** A committed fixture of the 73 messages (channel, publish time with zone, text with bold/links/buttons, media type/count, poll question/options/type; no images, no raw HTML) with per-post expected check codes or `clean: true`, story pairs (positive, allowed follow-ups, negative). `golden-set.test.ts` runs every deterministic check over it; rules not built yet are `todo`. `audit:tg-export <dir>` parses a Telegram Desktop HTML export (incl. `rich_message`, polls, buttons), runs the checks and prints a markdown report per channel. Critic eval cases in the 034-T9 format (written, not run). |
| FR-002 | **Story registry.** Tables `editor_stories` + `editor_story_posts` (migration 073). Pure `post/entities.ts` (brands, versioned products, game titles, names, numbers with units, domains; normalised) and containment overlap with a threshold tuned on FR-001 pairs. Guard `story_repeat` in `checkPublishGuards` against the resource's posts of 14 days (statuses as `recentTexts`); PostSpec `story { key?, followup_of?, kind?: followup\|reminder\|roundup\|evergreen, new_facts? }`; follow-up rules (new facts absent from the original, ≤ 1/story/day, one reminder in the last 24 h, `followup_restates` warning); follow-up goes as a Telegram reply to the original (same channel, ≤ 14 days). An "Active stories (14 days)" block for planner and writer; `fetch_feed` marks `covered_by_story`. The registry is shared by the network group: a story published by a sibling in the last 24 h requires an explicit `story_decision` `skip` / `own_angle` (warning `story_cross_channel`) / `repost` (`request_story_repost` → the existing promo forward, type `story_repost`, no 14-day promo cooldown, ≤ 1 per story per channel, ≤ 2 per channel per day, configurable). Reposts are counted separately (Own vs Reposts in Analytics and the posts list, a "Repost from @…" badge, excluded from KPI samples, repost share in the MANAGER quality digest with a flag over 30 %). Critic gets the story's previous posts. Backfill from 30 days of published posts. |
| FR-003 | **Announcement → recap.** An announcement stores `story.event_at` (date parsed by FR-005). ≤ 1 announcement + 1 reminder (≤ 24 h before) per event; more → `story_repeat`. 2 h after `event_at` a "recap needed" item with priority over feed items appears in orchestrator/planner context; no recap within 24 h → one Inbox note per event and `event_not_covered` in the MANAGER digest. Release-day reminders allowed as `reminder`. |
| FR-004 | **Facts and sources.** Pure `post/grounding.ts`: extract and normalise numbers (prices, %, counts, units, dates; "1,05 трлн", "850 тисяч", "2 599", "$0.10", "−75%") and look them up in the full texts fetched in the run (keep ≤ 60k chars per page); missing → warning `number_not_in_sources` (critic + approval card); years, the post date, list numbering and product versions are ignored. The critic gets passages around the post's numbers/entities (±400 chars, ≤ 6, ≤ 6000 chars) plus page title and date instead of the page head. `fact_conflict` against previous posts of the story. `source_is_homepage` lint error (root or section index). Source tiers in data (`primary`/`media`/`aggregator`/`low`): aggregator with a primary link → warning, `low` with numbers → `low_tier_claim`. Source-tier share per resource in the MANAGER digest. |
| FR-005 | **Dates and freshness.** Pure `post/dates.ts` parses relative words, weekdays (all cases), "12 жовтня", "12.10", "12.10.2026", "до 15 жовтня 17:00", "з 16 жовтня", "о 16:00 за Києвом", relative to the scheduled publish time in `card.timezone`. Codes: `date_relative_mismatch` (error), `weekday_mismatch` (error), `relative_date_unanchored` (warning), `stale_now_word` (warning; source or first story post older than 24 h), `deal_expired` (error), `deal_expiring` (warning, < 6 h), `stale_source` (warning; news 36 h, games 72 h; explainers/evergreen exempt). Source `published_at` from `article:published_time`, JSON-LD `datePublished`, `<time datetime>`, RSS `pubDate`; `fetch_feed` items get `age_hours`. The critic prompt states the publish time, the source date and the story's first post date. |
| FR-006 | **Text hygiene.** `text_replacement_char` (U+FFFD, control chars, zero-width inside words, mojibake; find and fix the 11.10 source), `mixed_script_word` (Latin name + hyphen + Ukrainian ending allowed; homoglyph-only → auto-fix; real mix → error with a hint), `process_leak` (explicit → error, else warning), `duplicate_attribution` (auto-fix), `lead_too_long` (warning > 140, error > 220, threshold from style), verbatim 4+-word repeat inside a post (warning), new slop phrases (errors: «зберігайте собі», «признавайся», «здогадаєтеся», «панікувати не варто»; warnings: «це той випадок, коли», sentence-initial «коротко —», «мораль» in `MORAL_CLOSER`), an idempotent typography normaliser (ʼ between Cyrillic letters, «» quotes, double spaces; never touches URLs, code, hashtags, Latin), `decimal_mixed` warning. The critic gets every lint warning, not only `slop_*`. |
| FR-007 | **Polls and quizzes.** `knowledge_poll` warning (question word + name/number options, or the answer is in the text) → use `quiz` with `correct_index` + `explanation` ≤ 200 chars; `quiz_answer_revealed` error (correct option in the intro, the companion post, or a post of the same story in the last 24 h); `poll_cap_reached` in `checkPublishGuards` on actual published/waiting/approved polls+quizzes (live slots, chat, approval). Glossary (FR-008) applies to question and options. Opinion polls stay regular. |
| FR-008 | **Resource style sheet.** `style` block in `FormatPrefsSchema`: `address` (`ty`/`vy`/`impersonal`; `vy` everywhere) → `address_mixed` (error when both forms in one post, warning when the form differs; quotes ignored); `glossary {prefer, ban}` → `glossary_violation` (built on `findBannedTerms`; bans АПІ, КЛІ, Разом AI, спотифай; no ШІ/AI rule); `names` (`uk_translit`/`original`) → `name_script_mixed` warning; `headline.max_chars`; `numbers.decimal`; `units` (`words`/`latin`; model names untouched); `hashtags` (`off`/`vocabulary`; `off` for the three DEV channels) → `hashtags_disabled` error, `vocabulary` keeps `card.hashtags` + `hashtag_not_in_vocabulary`. Bootstrap proposal from 60 days of posts (names; hashtag frequencies only in vocabulary mode), applied after owner approval. UI (English): Resource → Formatting → "Style sheet" with "Hashtags: Off / Vocabulary". Writer and critic get the style as a compact block; `lintPlatformPost` gets address + glossary. |
| FR-009 | **Variety and audience level.** From the resource's last 20 posts: repeated openings (number + noun, «Що X:», same first word), shared 3–5-word phrases, same format+topic twice a day → `monotony_*` warnings and a "Already used" block (phrases/patterns to avoid) in the writer prompt. `style.audience.level` (`beginner`/`general`/`expert`) with an unexplained-jargon budget → `jargon_over_level`. MANAGER digest per feed: share of items with `jargon_over_level`, `revise` or `reject`, with a suggestion to replace/limit the feed. |
| FR-010 | **Silent days.** Read-only diagnosis of 11–13.10 (needs stage DB access; the conclusion goes to AI0-104). Fallback ladder for a failed slot within budget: rewrite → next candidate once → lighter allowed format → evergreen → skip with reason. Evergreen: ≤ 1 per channel per day, all checks + critic, topic registered in the story registry (30-day no-repeat), numbers only with a source, no "just/today/news" words, poster only by `use_for`, separate `evergreen` category in analytics, MANAGER flag over 25 % per week; the Inbox alert still fires. Inbox notes `dark_day` (no publication by 18:00 local for a resource planning ≥ 1/day), `series_missed`, `critic_reject_streak`; MANAGER digest: planned vs published per resource/day with skip reasons; flags `dark_day`, `series_missed`. |
| FR-011 | **Media.** Fetch keeps the page's main image (`og:image`, `twitter:image`, first article image). News posts (news, giveaways, deals with a source) may use only that image (`image_not_from_source` error); no source image → no media, format `text`. `ai_posters` only on non-news posts whose topic matches `use_for` (`poster_mismatch` warning; poster on news → error); the critic sees the poster name and `use_for`. |
| FR-012 | **Critic gets the writer's skills.** Same selection as the writer of the slot: resource skills (`card.skills`, tone), the post's format skill, topic skills (news → `news-followups`, `fact-check`; deals/giveaways → `deals-giveaways`), `proper-nouns-terms`; compressed deterministically to rules within a char budget (overflow listed by name). The critic model is not changed by code. |
| FR-013 | **KPI sample guard.** `get_format_performance` returns `n`, median views and `confidence` (`ok`: n ≥ 8 and median ≥ 30; `insufficient`: n < 3 or median < 10; else `low`) plus an "insufficient data" summary; `set_format_weights` returns `insufficient_data` when the change relies on an `insufficient` format (owner directive excepted); `add_memory` performance notes need `evidence {n, metric}` and are refused when insufficient; the KPI digest marks low-confidence numbers. Existing memory rows with such conclusions are listed for the owner, not deleted. |
| FR-014 | **Post audit + visibility.** Daily and on-demand audit of the resource's published posts of 7 days with every deterministic check, stored in `editor_post_audit` (migration 074), recomputed after a rule change. Network health → resource → "Notes and sample posts": issues grouped by code with count, the post (date, link, excerpt), rule explanation and fix (English, no horizontal scroll at 375 px). Approval card shows lint warnings, unsourced numbers, story matches with links and date checks. MANAGER digest flags `story_repeat`, `fact_conflict`, `date_issue`, `text_hygiene`, `style_violation`, `dark_day`. |
| FR-015 | **Skills.** New `news-followups`, `proper-nouns-terms`, `deals-giveaways`; updates to `format-poll-quiz`, `fact-check`, `editor-critic-workflow`, `voice-core`, `anti-slop`, `content-sources`, `source-licensing`, `kpi-reading`, `grammar-ua`, `format-hashtags`, `tone-gaming`, `network-promo` (skip / own angle / repost). A skill rule backed by a deterministic check names its code. The 034 skills test stays green. |
| FR-016 | **Bug: Steam duplicate passed the ledger** with the same `source.url` (08.10 12:30 and 14:13). Find the gap (path without ledger check/write, root canonicalisation, or a race of two slots written before the first published), fix it, regression test. |

## Non-goals
- A different critic model (owner decision).
- Semantic embeddings for story matching (entity overlap is enough on the golden set).
- Deleting existing memory rows or published posts.
- Starting the service against real data, publishing to real channels, running evals or paid calls.

## Order
T1 ∥ T15 ∥ T10 (alerts) ∥ T16 ∥ T13 → T5 ∥ T6 ∥ T8 → T2 → T4 ∥ T12 → T3 ∥ T7 ∥ T9 → T10 (evergreen step) → T14 → T11.

## Task breakdown
Each task maps 1:1 to FR-0NN and to its Linear issue (AI0-95 + N − 1), whose description holds the full scope and acceptance.

| Task | FR | Linear | Size | Depends on |
|---|---|---|---|---|
| T1 golden set + `audit:tg-export` | 001 | AI0-95 | M | — |
| T2 story registry, cross-channel decision, repost stats | 002 | AI0-96 | L | T1 |
| T3 announcement → recap | 003 | AI0-97 | M | T2, T5 |
| T4 facts and sources | 004 | AI0-98 | L | T2 |
| T5 dates and freshness | 005 | AI0-99 | M | T1 |
| T6 text hygiene | 006 | AI0-100 | M | T1 |
| T7 polls and quizzes | 007 | AI0-101 | M | T2 |
| T8 resource style sheet | 008 | AI0-102 | L | T1 |
| T9 variety and audience level | 009 | AI0-103 | M | T1, T8 |
| T10 silent days, fallback ladder, evergreen | 010 | AI0-104 | M | — (evergreen after T2, T12) |
| T11 media | 011 | AI0-105 | M | T4 |
| T12 critic gets the writer's skills | 012 | AI0-106 | S | T1 |
| T13 KPI sample guard | 013 | AI0-107 | S | — |
| T14 post audit + visibility | 014 | AI0-108 | L | T5, T6, T8 |
| T15 skills | 015 | AI0-109 | M | — |
| T16 ledger bug | 016 | AI0-110 | S | — |

## Verification
Per task: `pnpm --filter automation test` (Node 20, see `ci-feature.yml`), `npm run build` in `apps/automation`, dashboard
`tsc` + build for UI tasks, pg tests on a throwaway Postgres (`EDITOR_PG_TEST_URL`), UI checked in the browser preview on test
data. No service start against real data, no publishing, no paid API calls, evals written and not run.
