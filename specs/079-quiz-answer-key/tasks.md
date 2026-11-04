# 079 tasks

- [ ] T1 Guard (FR-001, FR-002): `post/quiz-ground-truth.ts` — `resolveAnswerKey` by `num`, base detection (row + dataset `EXISTS` in the one query), `quiz_answer_key_invalid`, word-boundary prefix match for options over 100 characters, ambiguity details, new details wording; the code in `skip-reasons.ts` (`CONTENT_FAILURE_CODES`, `lint` rule) and the chat `CONFLICT` set; tests rewritten on `{num, text}` (unit + the two PG tests).
- [ ] T2 Row put-aside (FR-003): `silent/fallback-ladder.ts` — `quiz_answer_mismatch` into `NEVER_PASS` and `ROW_GUARD_CODES`, `quiz_answer_key_invalid` passes; `PublishProbe.wrap` wraps `skip_slot` and drops `ref` after a mismatch (`ref_kept`); doc comments of `shouldPassRow` and `silent/pass-row.ts`; `pass-row.071.test.ts`.
- [ ] T3 Migration 102 + down (FR-004): descriptions, `content_ledger_repairs`, the eight rows, stats refresh; PG migration test (apply, re-apply, down); README migration note.
- [ ] T4 Writer skill (FR-005): `editor-skills/format-poll-quiz.md` ПДР line.
- [ ] T5 Owner note (FR-006): `finish_orchestration` → `orchestrator_owner_attention` Inbox note (gate, alert on «ви»), tool description; dashboard `inbox-kinds.ts` rule + test.
- [ ] T6 Docs: `specs/README.md` row 079, spec status; the «Integration into feat/editor-agent» list stays for the merge.
