# 067 — The critic reads what the author read

Status: planned · Builds on 037 (critic gate), 041 (passages, pass_with_edits), 046 (fallback ladder), 063 (critic precision), 065 (document reader) · No migration

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

## Why

Review 4 (`docs/reviews/2026-10-26-agent-review-4.md`, P1 #1, #2 and P2 #8, #9) found that the critic is the largest cause of lost posts. 31 of the 57 skipped slots begin with a critic kill. About 10–15 of the 23 kills after the deploy were not justified. Five things go wrong.

1. **The critic does not see the text the author read.**
   - `CriticGate.wrapTools` (`critic/critic-gate.ts:157-169`) captures only `web_fetch`, `fetch_feed` and `extract_images`. The output of `read_doc` and `find_in_doc` (spec 065) never reaches the critic.
   - For a document over 6,000 chars, `web_fetch` returns only the first 3,000-char chunk (`docs/doc-view.ts:12-14`, `docs/doc-fetch.ts:126`). That chunk is all the gate remembers.
   - A short page reaches the critic as ±400-char passages, not as the page. `source()` sets `excerpt = null` as soon as one passage is found (`critic-gate.ts:212`).
   - The rubric says «Факт, якого немає в джерелі, — не вище 2» (`editor-critic-workflow.md:14`). The critic reads "not in what I was shown" as "not in the source". The ladder then bans the source.
   - Example: run 9e85e21d. `find_in_doc` found «14.6. Обгін заборонено…» at offset 114,445 of the 269,683-char ПДР, and the critic answered «лише початок постанови».
2. **The verdict code overrides the model.**
   - `decideVerdict` (`critic/critic.ts:99-125`) turns any axis ≤ 2 into reject before it reads the model's verdict. 13 of 17 first-pass kills after the deploy were the model's own "revise", e.g. one typo «пікселькний» → language 2.
   - A reject means `isFixableRevise` is false (`silent/fallback-ladder.ts:159-164`), so the source is banned.
   - `quoted_problem` (the `QUOTED` regex) turned 16 of 39 all-≥4 passes into revise, often on praise in quotes.
   - `normalizeOwnerRules` forces `owner_rules` to 2 for any broken rule (`critic.service.ts:216`), so every «пост без картинки» against rule #13 was a reject.
3. **Pass 2 starts from scratch.** The pass-2 prompt says «оціни пост заново повністю» (`critic.service.ts:172-175`). Any new 3 means a second revise, which means skip in live mode. The in-run rewrite saved 2 of 28 posts.
4. **The critic model changes between passes.** `draftRisk` is recomputed for every draft (`critic-gate.ts:323`). In 4 of 29 pass pairs the model changed between passes (Sonnet ↔ Haiku), and all 4 slots were killed.
5. **The pass cap is 4, not 3.** Each attempt builds a fresh gate that allows revise + rewrite. The cap (`MAX_CRITIC_PASSES_PER_SLOT = 3`) is checked only before a ladder step (`roles/editor-runner.service.ts:525-529`), so 9 slots got 4 critic runs. The test `fallback-ladder.test.ts:180-195` asserts 4.

**Posters deadlock.** Code and critic disagree about posters, so no state passes:
- `isNewsPost` (`post/integrity/checks/media.ts:37-45`) treats any post with a cited URL as news, including library posts (`AuditPost` has no origin field), and news forbids posters;
- the critic is told to judge poster fit itself (`critic-media.ts:46`, rubric `:30`);
- owner rule #13 asks for an image.

The lead's code map is at `<scratchpad>/r5/map-067-critic.md` (path in the task prompt). It has file:line anchors for everything below. Where it and this spec differ, this spec wins.

## What

### FR-001 What the author read reaches the critic and lint

**Capture.**
- **New dependency.** `CriticGateDeps` gets `docs?: Pick<DocStore, 'get' | 'urlOf'>`, wired in `editor.module.ts` (runner critic deps, ~:1625) with the same shared store the tools use. The gate never calls `sharedDocStore()` itself: tests inject `new DocStore()`.
- **What is wrapped.** `wrapTools` also wraps `read_doc` and `find_in_doc`.
- **What is kept per `doc_id`.** `{ url, size, spans: [{ from, to, text, via }] }`, plus a map from URL to `doc_id`. The map is filled with the asked URL and the answer's URL from the `web_fetch` result, because an HTML answer carries `final_url` while the doc id hashes the asked URL. Never recompute `docIdOf` from the cited URL.
  - `web_fetch` with a `doc_id` gives the span `[0, next_from ?? text.length)`.
  - `read_doc` gives `[from, to)`.
  - `find_in_doc` gives one span per match: `[max(0, offset − 300), from + snippet.length)`.
- **Store the text, not only the offsets.** The critic then reads exactly what the executor read, even if the store evicted or replaced the doc (spec 070 changes the store's TTL rules).

**One builder, `readTextOf(url) → { text, coverage, size }`,** used by all three readers: `groundingSources` (lint `number_not_in_sources`), the critic's code grounding block (`textsRead` / `groundingCheckOf`) and the text shown to the critic. The three always agree. Coverage values:

| Case | Text | Coverage |
|---|---|---|
| A cited or read page whose whole text is ≤ `FULL_PAGE_MAX` = 12,000 chars (a short `web_fetch` page, or a doc in the store ≤ 12k) | the whole page | `full` |
| A larger doc | the merged read spans: first chunk + `read_doc` + `find_in_doc`, sorted, overlaps merged. Slices come from `doc.text` when the store still has the doc, else from the captured span texts. Capped at `PAGE_CAP` (60k). | `read` |
| A feed item | as today | `snippet` |
| A library row (`library_ref`) | as today | `full` |

**Never ground on the whole text of a large doc** (e.g. the 270k ПДР) that the author did not read. On a legal code nearly every number occurs somewhere, so that would hide invented numbers. Say this in a code comment.

**What the critic is shown** (`critic-passages.ts` / `critic.service.ts` source block):
- **`full`.** The whole page, with the line «Це весь текст сторінки: чого тут немає — немає в джерелі». No passages.
- **`read`.** The merged spans with their offsets, under the line «Що автор прочитав у документі (N з M знаків): … Чого тут немає, автор не читав — це не доказ, що факту немає в джерелі: grounding 3 з приміткою, не ≤ 2». The display cap is ~12k chars. Over the cap, show `sourcePassages` computed over the spans (as pages) first, then the other read pages.
- **Library rows.** `CAP.source` rises to 12k.

**Ratio claims.** In `post/grounding.ts`, «N з M», «N із M», «N out of M», «N of M» and «N/M» are one claim kind `ratio` with key `N/M`. Index them on both sides and match by key (like bills). Blank their span before the number scan, so the parts are not checked separately. Case a902605d: the post said «5 з 10» and the source «5/10»; today the source side reads 5/10 as the date 10 May, and the bare 5 is dropped. Dates like `10/19/2026` must not change.

### FR-002 The verdict contract

**Model output.** `CritiqueInput` gets two optional fields. `StoredCritic` keeps them, plus `source_coverage` (the lowest coverage among the cited sources).
- `issues: [{ quote?, fix, axis, blocking }]`, at most 8. `quote` ≤ 200 chars, `fix` ≤ 300 chars, `axis` is one of the score keys.
- `previous_checks: [{ n, fixed }]`, for pass 2 only.

**Old data.** Old stored critics have no issues; readers must accept that.

**`decideVerdict(c, slop, o)`** with `o = { pass, coverage, codeMissing, previousBlocking, hardLint }`. `QUOTED` and `quoted_problem` are removed. Any issue counted below as revise-worthy must have a quote found in the post (whitespace- and quote-normalised) and must not be fixed by an applied edit.

**Pass 1:**
1. Reject only for a model reject or `sense ≤ 2`.
2. Any other axis ≤ 2 (grounding, language, voice, ai_likeness, audience_asks, format_fit, owner_rules) → revise, reason `score_le_2_fixable: <axes>`.
3. Any axis ≤ 3 → revise.
4. A blocking issue → revise.
5. `owner_rules_missing`, slop ≥ 2 and `voice_off` → revise, as today.
6. A model revise → revise.
7. Otherwise pass. With no `issues`, a pass with 4s is a pass, and the notes stay as advice.

**Pass 2** (after an in-run rewrite):
1. A model reject → reject.
2. Any axis ≤ 2 → reject, with one exception: grounding ≤ 2 when coverage ≠ `full` and the code check found no missing number → revise.
3. A previous blocking issue with `fixed: false`, or missing `previous_checks` → revise.
4. A new blocking issue → revise.
5. A hard lint warning still present in the current lint (`poster_mismatch`, `number_not_in_sources`) → revise.
6. Slop ≥ 2 and `voice_off` → revise.
7. Otherwise **pass**, reason `pass2_advice: <axes at 3>`, with the notes kept. New 3s are advice, not a block.

**Pass-2 prompt.** It lists the previous blocking issues numbered [1..n] and asks for `previous_checks`. It says new remarks are advice (`blocking: false`) unless they are a factual error, a quoted language error or a broken owner rule. It no longer says «оціни пост заново повністю».

**`revise()` details** (the ToolError the executor gets) carry the blocking issues (quote + fix).

**`isFixableRevise`** also gets the stored coverage. Grounding ≤ 2 bans the source only when the coverage was `full` and the code grounding also listed missing numbers. Otherwise the revise is fixable and the source is kept (`revise_source` step).

**Rubric** (`apps/automation/editor-skills/editor-critic-workflow.md`):
- Resolve the contradiction between lines 14, 21 and 24: ≤ 2 for grounding only when the full text shown contradicts the claim, or the code check lists the number as missing.
- Add the `issues` guidance with examples of blocking vs advice.
- Add the pass-2 contract and the poster rule (FR-005).
- Keep every lint code name that `skills/skills-audit.test.ts:164` requires.

The slot error prefix `critic_rejected:` and the stored verdict values do not change. `skip-reasons.ts` and the ladder read them.

### FR-003 One critic level per slot

The critic model is pinned by **risk level**, not by model id, so a changed owner critic model is still honoured.
- **Within an attempt.** The gate keeps `pinned = max(level of the first pass's route, context pinLevel)`. When pinned is `high`, it passes a `CriticRequest.pinLevel: 'high'`, and `CriticService.review` then never picks the light model.
- **Across ladder steps and the 15-minute retry.** `FallbackStepRecord` gets `critic_level` (and `critic_model`, for reading), taken from `slot.critic.route` in `stepRecord`. The runner computes `pinLevel = 'high'` when any earlier step of the slot was high, and passes it into `criticGate(...)`.

Sticky-high removes the harmful Sonnet → Haiku flips. A Haiku → Sonnet upgrade still happens; the FR-002 pass-2 contract makes it harmless.

### FR-004 The real 3-pass cap

- **Budget.** `CriticGateContext.passBudget` (default 2) replaces the hard-coded `this.passes === 1` (in-run revise) and the `firstPass` of `edit()`.
- **Budget 1.** A first-pass revise is final:
  - in live and shadow mode the slot is skipped with `critic_rejected: cap_revise — …`, and the stored verdict stays `revise`, so the ladder's fixable classification still applies;
  - in approve mode the post proceeds with `final: true`.
- **Where the runner sets it.** The runner's `Attempt` gains `opts?: { passBudget, pinLevel }`.
  - The initial attempt, including after the 15-minute retry: `passBudget = min(2, 3 − prior passes)`. With 0 left, it skips with `critic_cap` as today.
  - Each ladder step, including the evergreen closure: `passBudget = min(2, 3 − passes so far)`. With 0 left, the ladder stops.
- **Other callers.** Preview, skill probe and adapt keep the default.
- **Test.** Update `fallback-ladder.test.ts:180-195` to 3.

### FR-005 Poster fit is decided by code

- **Library posts are not news.** `AuditPost` gets `fromLibrary`, set when `spec.origin === 'library'` or a `library_ref` is present. It is set in both builders, `post/integrity/from-post-spec.ts` and `audit/post-audit.ts` (`auditPostFromPlatformSpec`). `isNewsPost` returns false for such posts.
- **Ranking.** `posters.ts` gets `fittingPosters(input): AiPoster[]`, ranked by keyword hits, using the same stems as `posterFitsTopic`.
- **An off-topic poster** names the fitting posters in its `poster_mismatch` message, or says none fits and to post text only.
  - It is an **error before publishing**: a new `AuditContext.prePublish`, set by `checkPublishGuards` and the platform media findings.
  - It stays a **warning in the weekly audit**.
- **The critic** gets the code's decision in `CriticMediaContext`: `fits`, `news_no_poster` or `none_fits`. The critic prompt line (`critic-media.ts:46`) and the rubric (`:30`) say that poster fit is decided by code. The critic does not lower `format_fit` for a poster unless lint flagged `poster_mismatch`.
- **Owner media rules.** When the decision is `news_no_poster` or `none_fits`, `criticRules` (`critic.service.ts:198`) leaves out the owner's media rules, the same way `isTextRule` leaves out schedule rules. A media rule is a rule whose text matches картинк|зображен|постер|фото|медіа|image|picture. Keep the regex narrow and log what was left out.

## Out of scope

- `publish_post.evidence [{claim, quote}]` verified verbatim by code (a later spec, if 067 is not enough).
- Auto-swapping a poster inside the gate. `applySpecEdits` never touches media; lint names the right poster instead.
- Owner action: rewording rule #13 (runbook note).

## Acceptance

All with fakes (node:test, `FakeLlm` / captured `CriticRequest`, `docs/doc-tools.test.ts` rig with an injected `DocStore`). Use real review-4 texts where noted; the review export is in the scratchpad.

**Reader regression:**
- a 270k one-section doc with «14.6. Обгін заборонено…» at ~114k: `web_fetch` → `find_in_doc('14.6')` → `read_doc(from …)`. The `CriticRequest` source carries the clause with offsets, coverage is `read`, and `groundingSources` text contains it;
- a 1,713-char page (a902605d) → whole page, coverage `full`, no passages;
- a 6–12k doc in the store → whole page;
- a doc missing from the store → the captured span text.

**`decideVerdict` table:**
- language 2 + model revise → revise (pass 1);
- sense 2 → reject;
- owner_rules 2 → revise;
- praise in quotes and no issues → pass;
- pass-2 cases from review-4 notes (8b2e4bce, 5e038c5e, cca8be36, e80961f0, 13b8f814): all previous fixed + 4s → pass; one unfixed → revise; a new voice 3 without blocking → pass `pass2_advice`; `poster_mismatch` still in lint → revise; missing `previous_checks` → revise.

**Other tests:**
- `isFixableRevise` with coverage.
- Ratio claims both ways; dates unaffected.
- Runner cap: initial revise+pass 2, then a ladder step with budget 1 = 3 critic runs; a retry after 2 prior passes gets budget 1; budget 1 in live skips after one pass and in approve proceeds.
- Model pin: a high first pass and a low-risk rewrite → strong model; a ladder step after a high step → strong; `critic_level` recorded.
- Media: a library post with a source URL may carry a fitting poster; an off-topic poster is an error pre-publish and a warning in the audit; the media rule is left out of `criticRules` when the decision is `none_fits`.
- Prompt snapshots for the `full`, `read` and pass-2 blocks.

**Existing tests to update** (listed in the code map) stay green after the update. `npm test`, `npm run build` (automation) and the dashboard checks pass. The dashboard `lib/critic.ts` type gains the optional fields, and `CriticBlock` shows the issues list when present.

## Amendments after the builder check

The builder check (2026-10-27) found gaps. These rules override the body.

**A1. Pass-2 previous items (FR-002).**
- The "previous items" on pass 2 are pass 1's blocking `issues`.
- When pass 1 has none (an old-style verdict), code builds them from pass 1: one item per axis that scored ≤ 3, and one item per `edits_failed` entry.
- When the list is non-empty, `previous_checks` is required. A missing or partial answer counts as unfixed, and the verdict is revise.
- When the list is empty, the rule does not apply.
- On pass 2, a model revise that has neither an unfixed item nor a new blocking issue becomes `pass2_advice`. `critic.test.ts:274` must still end in a skip.
- Update the invariant in the header comment of `critic.ts` to match.

**A2. Where `decideVerdict` runs.**
- It stays in `CriticService.store()`.
- Its second argument `o` is optional. Without it, the defaults are pass 1, coverage `none`, no code-missing numbers, no hard lint and no previous items. This keeps the one-argument calls in `config-conflicts.040.test.ts:194/:241` working; update those tests where the expectation changes.
- `store()` derives `o` from the request:
  - `pass` from `r.previous`;
  - `coverage` from `r.source.coverage`;
  - `codeMissing` from `r.source.grounding.missing`;
  - `hardLint` from `r.lintWarnings`;
  - `previousBlocking` from `r.previous.issues`.
- `CriticRequest.previous` widens to carry `issues`. `CriticSourceContext` gains `coverage`.
- On `pass_with_edits`, a blocking issue does not count when its quote lies inside the `from` of one of the model's edits.
- `hardLint` is based on `codeMissing`.

**A3. Stored state for `isFixableRevise` (FR-002).**
- `StoredCritic` gains `grounding_missing` (at most 12) and `rules_skipped`.
- `SlotState.critic` gains `source_coverage` and `grounding_missing`.
- A source ban needs both coverage `full` and a non-empty `grounding_missing`.
- A stored critic without coverage (written before this spec) keeps today's rule.

**A4. Pin level (FR-003).**
- When the level is pinned, store `route.level = 'high'` and add `'pinned'` to `route.factors`, and to the `RiskFactor` type.
- `stepRecord` sets `critic_level: 'high'` when `route.level` or any `history[].route.level` is high.

**A5. Poster decision for every post (FR-005).**
- `CriticPost.poster` and `CriticRequest.posterDecision` are one of `news_no_poster | poster_fits | none_fits`. They are set for every post, with or without images.
- `criticRules(rules, posterDecision)` is called the same way at both call sites (`critic.service.ts:150` and `:305`). A rule dropped there never shows up as `owner_rules_missing`.

**A6. Library rows (FR-001).**
- A new `libraryRowText(row)` returns the whole row, retold fields first, capped at 12 000 chars.
- Coverage is `full` only when the text was not clipped.
- `SOURCE_CAP` for the library excerpt rises to 12 000. `libraryTextOf`'s 4 000-char retell stays as it is for the verbatim guard.

**A7. The `full` block (FR-001).** It shows the whole cited page, then passages from the other pages the author read, labelled as other pages.

**A8. Read capture details (FR-001).**
- The `read` text is built from the span texts captured at tool time. It slices from `doc.text` only when the store still has the doc and `doc.fetched_at` equals the `fetched_at` captured at tool time. Spec 070 lets `get(doc_id)` return a newer copy under the same id.
- Join spans with a `\n…\n` separator.
- Coverage order is `none < snippet < read < full`.
- `read_doc` called with a `doc_id` but no earlier `web_fetch` maps the id to its URL through `urlOf`.
- JSON answers carry no text.
- Keep `Pick<DocStore, 'get' | 'urlOf'>` as the dependency.
- In tests, simulate a missing doc with an empty `new DocStore()` or `max: 1` eviction, never with TTL expiry, because 070 changes the TTL.
- The runner passes `docs` in both the dry and the normal branch.

**A9. Ratio claims.** Add a lookbehind to the ratio regex. Treat a blank as missing only on the post side. Fall back to plain value matching.

**A10. Smaller calls.**
- Do not reword the «skip_slot з причиною» sentence at `critic-gate.ts:396`: 068 edits that area.
- The rubric rewrite also covers lines 35–38. Avoid the phrase `poster_filler`.
- Clip over-long issue fields; do not reject the verdict for them.
- A `pass2_advice` pass in approve mode stays auto-approvable.
- `lint_post` gains an optional `prePublish` flag.
- Log dropped rules with the Nest `Logger`, and store them in `rules_skipped`.
- Add a fake critic to the ladder test harness.
- Copy test fixtures from the export at `$EXPORT/editor_slots.jsonl` (the path is in the task prompt).

**Merge order.** 067 merges first, before 068, 070, 069 and 071.
