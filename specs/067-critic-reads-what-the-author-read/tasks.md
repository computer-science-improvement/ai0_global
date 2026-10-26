# 067 tasks

- [x] T1 Read capture: `docs` dep on the gate (wired in editor.module.ts), `read_doc` / `find_in_doc` wrapped, per-doc spans with text, URL→doc_id map from `web_fetch` results, `readTextOf` with `full` / `read` / `snippet` coverage shared by `groundingSources`, the code grounding and the critic prompt; `FULL_PAGE_MAX` 12k; the `full` / `read` prompt blocks; library rows up to 12k; ratio claims in `grounding.ts`; reader regression tests.
- [ ] T2 Verdict contract: `issues` / `previous_checks` in `CritiqueInput` and `StoredCritic` (+ `source_coverage`), `decideVerdict` pass-1 / pass-2 rules, `QUOTED` removed, pass-2 prompt, `revise()` details with blocking issues, `isFixableRevise` with coverage, rubric rewrite (codes kept); dashboard `lib/critic.ts` type + issues list in `CriticBlock`; tests incl. the review-4 table.
- [ ] T3 One level per slot and the real cap: `pinLevel` on `CriticRequest` and the gate, `critic_level` / `critic_model` on `FallbackStepRecord`, `passBudget` on the gate context, the runner passes both to the initial attempt, the retry and every ladder step; tests (cap = 3, pin).
- [ ] T4 Posters by code: `AuditPost.fromLibrary` in both builders, `isNewsPost` false for library posts, `fittingPosters`, `poster_mismatch` error pre-publish (`AuditContext.prePublish`) and warning in the audit, the code's decision in `CriticMediaContext`, media owner rules left out of `criticRules` when no poster applies; tests; docs (runbook § 26, specs README row 067 DONE, spec status done).

## Status

- T1 done — what the author read reaches the critic and lint: `read_doc` / `find_in_doc` wrapped, `ReadCapture` with `readTextOf` (coverage `full` / `read` / `snippet`), `full` and `read` prompt blocks, library rows whole up to 12k, ratio claims in `grounding.ts`, reader regression tests (one commit, see `git log`).

## Deltas from the spec

- T1: the capture and `readTextOf` live in a new file `critic/read-capture.ts` (class `ReadCapture`, `mergeSpans`, coverage order); the gate only delegates to it.
- T1: a document up to 12k is `full` only when the author got some text of it (a web_fetch chunk or a read); a JSON answer (doc_id and no text) stays unread. A new copy of a document under the same `doc_id` seen at tool time starts the captured spans again (offsets of two copies never mix).
- T1: `libraryRowText(key, row)` takes the table key as well (the retold fields go first); nested values are compact JSON, so a recipe ingredient list is in the text. `libraryTextOf` itself now returns that text (the verbatim guard never used it: it reads `retellSource` directly, so it is unchanged). The gate keeps its `libraryText` dependency type and reads a clipped row from its length (at the 12,000 cap = `read`).
- T1: the other pages the author read get their passages under the `read` block too (not only under `full`), labelled as other pages; over the 12k display cap the critic gets passages computed over the read parts first and, when nothing of the post is in them, the first 3,000 characters of what was read (not 12,000).
- T1: a ratio is a claim only when one of its parts is a claim on its own (not under 10, not a year), so «3 з 5» stays unchecked as before; «5 з 10 млн», «5 з 10%» and «5 з 10 травня» are not ratios. A ratio whose key is missing from the source falls back to the parts as plain numbers (today's reading).
