-- 102_quiz_answer_key.sql — the quiz answer key comes from the data (spec 079, AI0-256).
--
-- The guard read `answers[correct_answer_num - 1]`, but the real pdr_questions rows are {num, text} options, num counts
-- from 0, and correct_answer_num is the num of the correct option. So key 0 passed any option, and keys 1–3 refused the
-- right answer. Spec 071 put a row aside for the round whenever the guard said `quiz_answer_mismatch`; eight rows of
-- round 2 on @pdr_dev_channel were put aside this way.
--
--   descriptions           the two 058 texts of pdr_questions say what the data really is (only while still the 058
--                          text: an owner's own wording stays; description edits keep the schema version, as in 083)
--   content_ledger_repairs the rows this file takes out of content_ledger are kept here whole, so the undo can put them back
--   the eight rows         `passed` ledger rows of 57829, 57245, 57827, 57258, 57433, 57758, 57242, 57256 are removed
--
-- Additive and idempotent (CI re-applies it): the descriptions change only from the 058 text, and the rows are moved
-- once (a second run finds none). On a database without these rows nothing is moved.

-- ─── Honest descriptions ─────────────────────────────────────────────────────

UPDATE data_schemas
   SET fields = (SELECT jsonb_agg(CASE
                    WHEN e->>'name' = 'answers' AND e->>'description' = 'Answer options in order: an array of strings or of {text} objects.'
                      THEN e || jsonb_build_object('description', 'Answer options: an array of {num, text}; num counts from 0.')
                    WHEN e->>'name' = 'correct_answer_num' AND e->>'description' = '1-based number of the correct option in answers. It is the official answer: never correct it from memory.'
                      THEN e || jsonb_build_object('description', 'The num of the correct option in answers (num counts from 0). It is the official answer: never correct it from memory.')
                    ELSE e END ORDER BY o)
                 FROM jsonb_array_elements(fields) WITH ORDINALITY x(e, o))
 WHERE key = 'pdr_questions'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(fields) e
                WHERE (e->>'name' = 'answers' AND e->>'description' = 'Answer options in order: an array of strings or of {text} objects.')
                   OR (e->>'name' = 'correct_answer_num' AND e->>'description' = '1-based number of the correct option in answers. It is the official answer: never correct it from memory.'));

-- ─── The eight rows come back ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS content_ledger_repairs (
  id          BIGSERIAL PRIMARY KEY,
  repair      TEXT NOT NULL,
  ledger_row  JSONB NOT NULL,
  removed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_ledger_repairs_repair ON content_ledger_repairs (repair);

DO $$
DECLARE
  v_n int;
BEGIN
  WITH gone AS (
    DELETE FROM content_ledger
     WHERE status = 'passed'
       AND source_ref IN ('data://pdr_questions/57829', 'data://pdr_questions/57245', 'data://pdr_questions/57827', 'data://pdr_questions/57258',
                          'data://pdr_questions/57433', 'data://pdr_questions/57758', 'data://pdr_questions/57242', 'data://pdr_questions/57256')
    RETURNING *
  ), saved AS (
    INSERT INTO content_ledger_repairs (repair, ledger_row)
    SELECT '102_quiz_answer_key', to_jsonb(g) FROM gone g
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM saved;
  RAISE NOTICE '102_quiz_answer_key: % passed ledger row(s) taken back', v_n;
END $$;

SELECT data_schema_stats_refresh();

INSERT INTO schema_migrations (version) VALUES ('102_quiz_answer_key')
  ON CONFLICT (version) DO NOTHING;
