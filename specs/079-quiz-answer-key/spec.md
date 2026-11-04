# 079 — The quiz answer key comes from the data

Status: done (AI0-256, hotfix/079-086) · P0 hotfix · Builds on 032 (data store), 071 (`passed` rows, `skip_slot` `ref`), 060 (Inbox note gate) · Migration 102

> Source: review 5 (`docs/reviews/2026-11-04-agent-review-5.md` §3 #7, §5 «079»; the review lives on `feat/editor-agent`). This hotfix is built on `develop` (branch `hotfix/079-086`) so it can ship without wave 1. The section «Integration into feat/editor-agent» at the end lists what changes when it is merged there.

## Why

`checkQuizGroundTruth` (`apps/automation/src/editor/post/quiz-ground-truth.ts:30`) takes the correct answer as `answers[correct_answer_num - 1]`. The real `pdr_questions` rows are different:

- every option is `{num, text}`, and `num` counts from 0;
- `correct_answer_num` is the `num` of the correct option.

Checked in `apps/pipeline/src/data/normalized/pdr/tickets.json` (1 640 questions) and on stage rows 57256 and 57555: in every question `correct_answer_num` is one of the `num` values, and the `num` values start at 0.

What the guard does with that:

| `correct_answer_num` | guard reads | effect |
|---|---|---|
| 0 (510 of 1 640 questions) | `answers[-1]` = undefined | returns null: **any** marked option passes |
| 1–3 | the option after the right one | a quiz that marks the right answer is refused (`quiz_answer_mismatch`); a quiz that marks the next, wrong option passes |

The tests pin the wrong base: they use bare string arrays and a 1-based key. The `data_schemas` description (`058_data_store.sql:954`) says "1-based number of the correct option", so agents read the same wrong rule.

The refusals cost real material. Spec 071 puts a library row aside for the round (`content_ledger` status `passed`) when the publish guard says `quiz_answer_mismatch`, on the theory that "the row's answer key is wrong". It was the guard that was wrong. Eight rows of round 2 on @pdr_dev_channel were put aside this way: 57829, 57245, 57827, 57258, 57433, 57758, 57242, 57256.

Two smaller things from the same review:

- Telegram allows 100 characters per poll option; 473 of the 1 640 correct answers are longer. The writer must cut them, and an exact match then never succeeds.
- The orchestrator wrote «УВАГА ВЛАСНИКУ: …» lines into its `finish_orchestration` summary. Nobody reads that summary: the line never reached the owner.

## What

### FR-001 The answer key is read by `num`

`checkQuizGroundTruth` resolves the correct option of the row like this:

1. **Options with `num`.** When the options are objects with a numeric `num`, the correct option is the one with `num === correct_answer_num`. The array position does not matter.
2. **Options without `num`** (bare strings, `{text}` objects). The base is decided:
   - `correct_answer_num = 0` → base 0;
   - else `correct_answer_num = options.length` → base 1;
   - else any row of the same dataset has `correct_answer_num = 0` → base 0 ("any 0 means base 0");
   - else base 1 (the old documented rule).

   The dataset-wide check is one `EXISTS` in the same query as the row (no second round trip).
3. **A key that names no option is an error, not a pass.** `correct_answer_num` missing, not an integer, or not one of the options (no option with that `num`; or outside `0..n-1` / `1..n` for the decided base), or an empty `answers` → the guard returns

   ```json
   { "error": "quiz_answer_key_invalid", "details": "<row id>: correct_answer_num = 5, варіантів з таким num немає (є num 0, 1, 2). Ключ відповіді в рядку зламаний: візьми інший рядок або skip_slot з ref цього рядка." }
   ```

   Today such a row returns null and any option passes.

The resolver is a pure exported function (`resolveAnswerKey(row, { zeroBased })` or similar) so the tests can hit it without a pool.

### FR-002 Matching the marked option

The option marked by `poll.correct_index` matches the correct option when:

- **exact:** the normalised texts are equal (case, punctuation and spacing ignored — today's `norm`); or
- **cut to the limit:** the correct option is longer than 100 characters and the marked option, after a trailing `…` / `...` is dropped, is a prefix of it **at a word boundary**: its words are the first words of the correct option, the last one whole (`«…змінити напрямок»` matches, `«…змінити напря»` does not). Words are compared case-insensitively, apostrophes (`'`, `’`, `ʼ`) inside words ignored.

A cut option that is a word-boundary prefix of **another** option too is ambiguous: the reader cannot tell the options apart. The guard refuses it as `quiz_answer_mismatch` with a details line that says so («варіант обрізано так, що він збігається з початком іншої відповіді — обріж довше або інакше»).

`quiz_answer_mismatch` details name the option by its `num` and text, and say how to cut a long option:

> правильна відповідь у базі — варіант num=2: "…". Познач саме його як correct_index; довгий варіант (понад 100 символів) обріж по межі слова, можна з «…». Не виправляй базу власними знаннями.

The guard runs in both places it runs today: the executor's publish guards (`tools/role-tools.ts`) and the chat drafts (`chat/drafts.service.ts`). `quiz_answer_key_invalid` joins `quiz_answer_mismatch` wherever the code lists the guard codes: `CONTENT_FAILURE_CODES` and the `lint` group rule in `silent/skip-reasons.ts`, the `CONFLICT` set in `api/editor-chat.controller.ts`.

### FR-003 What puts a row aside

- **`quiz_answer_mismatch` never puts the row aside.** It means the writer marked the wrong option; the row is fine. `shouldPassRow` lists it with the other guard codes that say the attempt was wrong (`NEVER_PASS`). `PublishProbe` forgets the row after it (`ROW_GUARD_CODES`), like the other row guards: a later critic reject of a post without a row must not inherit it.
- **`quiz_answer_key_invalid` puts the row aside** (`shouldPassRow` → true): the row really cannot be posted as a quiz this round.
- **`skip_slot` with `ref` after a mismatch.** When the run's last publish-tool error was `quiz_answer_mismatch`, `skip_slot` with `ref` does not put the row aside. The slot is skipped as before; the tool result says `ref_kept: "quiz_answer_mismatch"` so the run log shows why. Implemented where the run's last publish error is known: `PublishProbe.wrap` also wraps `skip_slot` and drops `ref` from the input in that case. A run without a probe (none today for the executor) behaves as before.

### FR-004 Migration 102

`database/migrations/102_quiz_answer_key.sql` (+ `down/102_quiz_answer_key.down.sql`). Additive and idempotent (CI re-applies it).

1. **Honest descriptions.** In `data_schemas` key `pdr_questions`, only while each is still the 058 text (an owner's own wording stays; description edits keep the schema version, as in 083):
   - `answers`: «Answer options in order: an array of strings or of {text} objects.» → «Answer options: an array of {num, text}; num counts from 0.»
   - `correct_answer_num`: «1-based number of the correct option in answers. …» → «The num of the correct option in answers (num counts from 0). It is the official answer: never correct it from memory.»
2. **The eight rows come back.** `content_ledger` rows with `status = 'passed'` and `source_ref` in `data://pdr_questions/{57829, 57245, 57827, 57258, 57433, 57758, 57242, 57256}` are deleted. Each deleted row is first copied, whole (`to_jsonb`), into a new table

   ```sql
   content_ledger_repairs (
     id          bigserial PRIMARY KEY,
     repair      text NOT NULL,          -- '102_quiz_answer_key'
     ledger_row  jsonb NOT NULL,         -- the content_ledger row as it was
     removed_at  timestamptz NOT NULL DEFAULT now()
   )
   ```

   so the undo can put them back. Nothing else is touched: published rows of the eight refs stay, other refs stay. On a database without these rows (CI, local) the step does nothing. The migration raises a NOTICE with the count.
3. `SELECT data_schema_stats_refresh();` at the end.

**Undo** (`down/102_quiz_answer_key.down.sql`):
- re-insert the saved ledger rows of repair `102_quiz_answer_key` (same columns, `ON CONFLICT (resource_ref, source_ref, status) DO NOTHING`), delete their repair rows, drop `content_ledger_repairs` when it is empty;
- put the two 058 descriptions back while they are still the 102 text;
- `DELETE FROM schema_migrations WHERE version = '102_quiz_answer_key'`.

Number 102: 097–101 are taken by wave 1 on `feat/editor-agent` (075 → 099, 077 → 101); `migrate.sh` applies any file not yet recorded, so 102 landing on `develop` first is safe.

**Owner step (stage):** `bash database/migrate.sh` before the new automation image starts (the code does not need 102, but the eight rows only come back with it). The lead does not touch stage.

### FR-005 The writer's instructions

`editor-skills/format-poll-quiz.md`, the ПДР line: the correct option of a `pdr_questions` row is the one whose `num` equals `correct_answer_num` (num counts from 0; it is not `correct_index` of the post, which counts the post's own options); a correct option longer than 100 characters is cut at a word boundary, «…» allowed.

### FR-006 «УВАГА ВЛАСНИКУ» becomes an Inbox note

`finish_orchestration` (`network/network-tools.ts`) reads its `summary`:

- Every line that starts with «УВАГА ВЛАСНИКУ» (any case; leading emoji, `*`, `#`, `-`, `!` and spaces allowed; «УВАГА, ВЛАСНИКУ», «Увага власнику:», «УВАГА ВЛАСНИКОВІ» count) is an owner note. The text after the marker (and a `:` / `—` / `-`) is the note.
- All such lines of one call become **one** Inbox note: kind `orchestrator_owner_attention`, severity `action`, `agentId` = the orchestrator, `refType: 'agent'`, `refId` = its handle.
  - Dashboard copy (English): title «@<handle> asks for your attention», body = the lines as written (they are the agent's words).
  - Telegram alert (Ukrainian, «ви»): title «@<handle> просить вашої уваги», body = the lines.
  - Gate (spec 060): subject `owner_attention:<orchestrator id>`, parts = the normalised lines, so the same words are not re-sent every day. Posted with `postOnce` when the inbox dependency has it, else `post` (the dep type widens to `Pick<OwnerInbox, 'post'> & Partial<Pick<OwnerInbox, 'postOnce'>>`).
  - Best-effort: a failed post never fails the tool. The result gains `owner_note: true` when a note was posted.
- The tool description tells the orchestrator: «Рядок, що починається з «УВАГА ВЛАСНИКУ:», стане нотаткою власнику в Inbox — лише для того, що потребує його рішення.»
- The dashboard knows the kind: `apps/dashboard/src/lib/inbox-kinds.ts` gets a rule for `orchestrator_owner_attention` (primary: open the agent; English labels) and the kind list in `inbox-kinds.test.ts`.

## Not in this spec

- The 075 publish profile (`base: 0` / `match_by: 'num'`, migration 099 refusing base 1 when a 0 exists) — 075, on `feat/editor-agent`.
- Any change on stage. The lead never touches stage data; migration 102 is the repair.

## Tests

- `quiz-ground-truth.test.ts` rewritten on the real shape: options `[{num:0,text}, …]`, `correct_answer_num` 0 and 3; row 57256-like and 57555-like fixtures (the shape of those rows; texts from `tickets.json` are fine); options in a shuffled array order still match by `num`; bare strings with base 0 (a 0 present, dataset `zero_based`) and base 1; `correct_answer_num` = 5 / null / `"x"` / empty answers → `quiz_answer_key_invalid`; a 140-character correct option cut at a word boundary (with and without «…») passes, cut mid-word fails, a cut prefix shared with another option fails with the ambiguity details; the data:// and library:// refs as today.
- `pass-row.071.test.ts`: `quiz_answer_mismatch` keeps the row (no `passRow`), `quiz_answer_key_invalid` passes it; `shouldPassRow` pure cases; `skip_slot` with `ref` after a mismatch keeps the row and says `ref_kept`, after another error still passes it.
- PG: `data-tools.pg.test.ts` and `data-store.migration.pg.test.ts` use `{num, text}` rows; a migration test for 102 (fresh migrated DB): the eight `passed` rows go to `content_ledger_repairs`, a `published` row of the same ref and a `passed` row of another ref stay, the descriptions change only from the 058 text, re-applying changes nothing, the down file restores rows and descriptions.
- `network-tools` test: a summary with «⚠️ УВАГА ВЛАСНИКУ: …» posts one note (kind, severity, gate, Ukrainian alert on «ви»), a summary without it posts nothing, a throwing inbox still returns ok.
- Dashboard: `inbox-kinds.test.ts` covers the new kind; `no-cyrillic-ui` stays green.

## Integration into feat/editor-agent

`feat/editor-agent` is local to the owner's machine (wave 1: 072, 073, 076; specs 072–077; review 5). When this branch is merged or cherry-picked there:

- **`silent/fallback-ladder.ts`** — 073 already stopped `quiz_answer_mismatch` from putting rows aside (AI0-251). Keep 073's shape and add `quiz_answer_key_invalid` as the one quiz code that passes the row.
- **073 retry text** (`specs/073-*/spec.md:47`, `:52` and its code): the retry that re-sends the guard's text for `quiz_answer_mismatch` either goes or says «познач варіант, у якого num = correct_answer_num». `reasons/catalogue.ts:66-67`: the reason must not tell the owner the author is wrong (stage 2, item 073).
- **Reason catalogue**: `quiz_answer_key_invalid` goes into the server catalogue and `apps/dashboard/src/lib/reasons.ts` together (the divergence test).
- **075 spec** — `base`, its tests and its explanation: the «off-by-one» it describes is the other way round (the data is 0-based, the guard was 1-based). **077 `spec.md:20`** — the same sentence.
- Migration numbers: 102 stays; 097–101 belong to wave 1.
