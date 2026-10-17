# 041 Content quality

**Epic:** AI0-179 · **Priority:** P0 · **Depends on:** 034, 037, 040, 042, 045, 046 · **Source:** [agent review 2](../../docs/reviews/2026-10-17-agent-review-2.md) §5

## Why

Review 2 read 15 published posts. About 9 had defects:

- **Language:** wrong case «у найвідоміших сервісів» (1713), calques «заточений» (1714), «на борту» (1715), «по перевернутій рампі» (1719), euphony «У інших» (1721), a pronoun pointing at the wrong noun «її» → licence (1724), gaming slang «ачівки», «синґл» with slang off (1726).
- **Style:** hashtags while off (1712, 1714).
- **Owner rule broken:** rule #11 «простіше» broken by «816 млрд параметрів… MCP-Atlas» (1717).
- **Format and media:** an evergreen glossary on a news channel (1721); a poll without the picture the brief asks for (1725).

The critic often named the fix, but nothing applied it. 7 of 15 passes carried fix notes that never reached the post: `critic-gate.ts` publishes any pass, and `decideVerdict` acts only on scores ≤ 3.

Nothing checks Ukrainian grammar. Topic repeats slip past dedup, because story matching needs 3 shared entities and explainers have none. Owner rules and style settings live in four places and contradict each other.

## Requirements

### FR-001 Language gate (T1, AI0-192)

**Lexicon** (`post/language/lexicon.ts`), run by `lintPost` on everything the reader sees:

- **Errors** (`language_calque`):
  - Unambiguous russisms and calques with the right word in the message: «приймати участь», «на протязі», «слідуючий», «являється», «заточений під», «в якості», «співпадати», «самий + adjective», «на рахунок» (= щодо), «у відповідності з», «прийняти міри», «міроприємство», «співставити», «по відношенню до», «дякуючи» (= завдяки), «працюючий», «оточуючий», «бажаючий», «вибачаюсь».
  - «на борту» outside a vehicle.
- **Warnings:**
  - `language_case`: a suspect case, e.g. «трапляється у …их» means «з …ими».
  - `language_suspect`: a contested calque: «вражаючий», «існуючий», «з точки зору».
  - `language_euphony`: у/в and і/й alternation with an exact replacement:
    - sentence start before a vowel → «В»;
    - between vowels → «в»;
    - between consonants or before в/ф → «у»;
    - «й» before і/ї/й/є/ю/я → «і»;
    - «Й» at sentence start → «І».
- **Exceptions:** `LEXICON_EXCEPTIONS` (phrases that are fine in context, e.g. «на борту літака»). The next word must be Cyrillic for any euphony rule to apply.
- **Domain slang:**
  - lists by domain: gaming (`ачівк*`, `синґл*`, `тімейт*`, `каточк*`, `нерф*`, `донатер*`, …) and IT (`юзер*`, `девайс*`, `апдейт*`, `фіч*`, …);
  - joined to `SLANG_MARKERS` and gated by `format_prefs.slang` (absent = off), as `slop_slang_off`.

**Critic:**

- `language` is a required axis: «5 — грамотна українська; 1 — русизми, кальки, помилки відмінка».
- A score ≤ 3 means revise, like every axis.
- The notes must quote the faulty words.
- The critic prompt lists the lexicon findings.

### FR-002 Pass with edits (T2, AI0-193)

**Verdict and edits:**

- The critic may answer `pass_with_edits` with `edits: [{from, to}]` (≤ 8).
- Code applies each edit to the spec's text leaves:
  - block text and list items;
  - slides;
  - poll question and options;
  - longread blocks.
- `from` must match exactly once across all leaves. If any edit fails, the verdict becomes `revise`, with the notes plus the failed edits.
- Lexicon findings that carry an exact replacement (euphony) are applied the same way on any pass, with no LLM turn.

**After editing:**

- Lint runs again, and the post is rendered again from the edited spec.
- Lint errors make it a revise. Otherwise the edited spec publishes, with no new critic call.
- The applied edits are stored on the slot critic (`edits`).

**Stricter scoring:**

- A score of 4 with a quoted problem in the notes, and no edits, becomes `revise` (`quoted_problem`).
- A pass whose notes only praise stays a pass.

### FR-003 One effective style (T3, AI0-194)

**Precedence:** owner rule > profile (`format_prefs.style`, which also holds what 042 setup applied) > card > inferred defaults. Steering (045) advises the critic only and never overrides.

**Owner-rule overlay** (`rules/owner-style-overlay.ts`) reads the active owner rules:

- «без хештегів» → `hashtags: off`;
- «без сленгу» → `slang: false`;
- «простіше / простими словами / для новачків» → `audience.level: beginner`.

**Where the style applies:**

- The overlay is merged by `resolveStyle`, used everywhere the style is read: card lint style, `voiceOf`, writer and critic prompts.
- The planner prompt gets a one-line style summary.
- No vocabulary means no hashtags: the effective `hashtagMin` is 0 and hashtags are off unless `card.hashtags` is non-empty.

**New config conflicts:**

- `hashtag_min_without_vocabulary`: `hashtag_min > 0` with an empty vocabulary.
- `rule_not_in_profile`: an owner rule about audience, tone or format that the stored style or profile contradicts. Its fix writes the rule into `format_prefs.style`.

Conflicts are returned when the profile or style is saved, and they show on the agent page.

### FR-004 Topic repeats (T4, AI0-195)

**Evergreen classification** (`story/evergreen-kind.ts`): code decides that a post is an explainer, how-to, glossary or listicle. A post counts as one when it has no external source, or when its title or lead matches «що таке», «як …», «N способів / порад / технік / помилок», «пояснюємо», «— це …». Such a post is evergreen even when the writer did not declare it.

**Topic key** (`story/topic-key.ts`):

- **Key:** normalised stems of the title and lead (6-letter Cyrillic stems, lowercase Latin words of 3+ letters, stop words dropped).
- **Same topic:** overlap / min ≥ 0.6 with ≥ 2 shared stems.
- **Checks:**
  - `topic_repeat` (error) for an evergreen post against the channel's posts of 30 days;
  - `story_cross_channel` against the network's posts of 72 hours (was 24) by story or by topic key.

**Ideas and planner:**

- `add_idea` refuses an idea whose title and angle hit a topic of the resource's last 30 days (`recent_topic`).
- Planners refuse a fixed slot whose topic hits one (`topic_recent`).
- Both prompts list the last 30 days' topics.

### FR-005 Owner rules are checked every time (T5, AI0-196)

- When the prompt lists owner rules, the critic must score `owner_rules` and return `rule_checks: [{id, kept, quote?}]` for every listed rule. A missing score or rule makes it a revise (`owner_rules_missing`).
- A broken rule must quote the offending words.
- Rules that cannot be checked on a post's text are left out of the critic prompt (`isTextRule`). These are rules about times, frequency, schedule, formats per week or approvals.

### FR-006 Passages and lint false positives (T6, AI0-197)

**Passages:**

- Source passages also anchor on claim sentences without numbers: quotes «…» and sentences with заявив / сказав / за словами / повідомив / каже. They anchor by the sentence's Latin words and proper names.
- Up to 8 passages.

**Lint fixes:**

- `slop_adjective_triple` skips relative adjectives (-ськ- / -цьк- / -зьк- / -ичн-: «англійська, французька й німецька»).
- `address_mixed` skips «зазвичай», «вкрай», «украй», «бодай».

**Overruled warnings:** the slot critic stores every lint warning code it read (`lint_warnings`). `overruledWarnings()` counts the codes on posts the critic passed in the last 7 days, and the KPI digest shows them as `lint_overruled`.

### FR-007 Risk-routed critic (T7, AI0-198)

**Risk score** `draftRisk(spec, text, kind)`:

| Factor | Points |
|---|---|
| External source | +2 |
| Numbers in the text | +1 |
| Quotes or attributed claims | +2 |
| Person names | +1 |
| News content kind | +1 |
| Library or evergreen post | −1 |

**Routing:**

- Risk ≥ 3 is **high**: the critic uses the owner's critic model or the role default.
- Risk below 3 is **low**: the critic uses the light model, then the lexicon:
  - in the Anthropic workspace, `ANTHROPIC_ROLE_MODELS.checker_light` = Haiku;
  - in OpenRouter, `EDITOR_MODEL_CHECKER_LIGHT`, or the normal checker model when it is not set.

**Logging on the slot critic:**

- `route {risk, level, factors, model}`;
- `cost_total_usd`, the critic spend across passes (history keeps each pass's cost).

### FR-008 Setup, brief and steering data (T8, AI0-199)

**Setup (042):**

- Fewer than 5 posts with text is a refusal: `insufficient_data`, with no LLM run.
- A span under 7 days is analysed, but the proposal drops posting rate and quiet hours and says why (`insufficient_span`).

**Brief media requirements** (`post/brief-media.ts`):

- The brief is parsed into which formats need a picture, for example «у форматі опитувань із картинкою», «кожен пост — одне фото».
- Lint error `brief_media_missing`.

**Steering (045):**

- A rule that states a count (emoji, length, hashtags) is checked against the computed metrics. A rule outside the observed range is refused: `rule_contradicts_metrics`, with the observed value.
- Metrics medians count only posts with text.
- The analysis prompt states how many reference posts have no text and that style conclusions must not come from them.

### FR-009 Regression set (T9, AI0-200)

- The 9 defective posts enter `post/integrity/testing/review2-regression.ts` with their expected codes. A unit test runs lint on each and expects its codes.
- Defects only the critic can see are listed as critic eval cases in `critic/evals/review2-cases.json`, for the eval runner of 051. They are not run here, since that would mean paid calls. These are case (1713), «по перевернутій рампі» (1719), the pronoun (1724) and rule #11 (1717).

## Out of scope

- Running critic evals (051).
- Learning the lexicon from owner edits.
- Morphological analysis: the lexicon is phrase and regex based, and the critic's language axis covers the rest.
