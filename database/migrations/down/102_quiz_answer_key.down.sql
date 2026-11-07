-- Down for 102_quiz_answer_key.sql (spec 079). Puts the saved ledger rows back, drops the repair table when it is empty,
-- puts the two 058 descriptions back while they are still the 102 text (an owner's own wording stays).

DO $$
BEGIN
  IF to_regclass('content_ledger_repairs') IS NOT NULL THEN
    INSERT INTO content_ledger (resource_ref, source_ref, origin, status, published_post_id, platform_post_id, slot_id, used_at, note, anchor)
    SELECT r.resource_ref, r.source_ref, r.origin, r.status, r.published_post_id, r.platform_post_id, r.slot_id, r.used_at, r.note, r.anchor
      FROM content_ledger_repairs c, jsonb_populate_record(NULL::content_ledger, c.ledger_row) r
     WHERE c.repair = '102_quiz_answer_key'
    ON CONFLICT (resource_ref, source_ref, status) DO NOTHING;
    DELETE FROM content_ledger_repairs WHERE repair = '102_quiz_answer_key';
    IF NOT EXISTS (SELECT 1 FROM content_ledger_repairs) THEN
      DROP TABLE content_ledger_repairs;
    END IF;
  END IF;
END $$;

UPDATE data_schemas
   SET fields = (SELECT jsonb_agg(CASE
                    WHEN e->>'name' = 'answers' AND e->>'description' = 'Answer options: an array of {num, text}; num counts from 0.'
                      THEN e || jsonb_build_object('description', 'Answer options in order: an array of strings or of {text} objects.')
                    WHEN e->>'name' = 'correct_answer_num' AND e->>'description' = 'The num of the correct option in answers (num counts from 0). It is the official answer: never correct it from memory.'
                      THEN e || jsonb_build_object('description', '1-based number of the correct option in answers. It is the official answer: never correct it from memory.')
                    ELSE e END ORDER BY o)
                 FROM jsonb_array_elements(fields) WITH ORDINALITY x(e, o))
 WHERE key = 'pdr_questions'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(fields) e
                WHERE (e->>'name' = 'answers' AND e->>'description' = 'Answer options: an array of {num, text}; num counts from 0.')
                   OR (e->>'name' = 'correct_answer_num' AND e->>'description' = 'The num of the correct option in answers (num counts from 0). It is the official answer: never correct it from memory.'));

SELECT data_schema_stats_refresh();
DELETE FROM schema_migrations WHERE version = '102_quiz_answer_key';
