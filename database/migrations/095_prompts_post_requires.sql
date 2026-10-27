-- 095_prompts_post_requires.sql — the prompts rule: a post needs the prompt text and the picture (spec 068, review 4).
--
-- Migration 083 set `prompts.post_requires` to [["page_url"], ["prompt_text", "media_url"]]: a page, and a text or a picture.
-- PromptHero rows have a page and a picture and no prompt text, so they passed that rule, and the Prompt series kept
-- picking them: 13 `query_data` tries and a skip a day (agent review 4, 2026-10-21…26). A post of this series is the
-- prompt itself with its example, so the rule is now [["prompt_text"], ["media_url"]] (both fields, every group needs
-- one filled field). PromptHero rows become not postable: the catalog's `not_postable` counts them, `unposted_here`
-- and `query_data` drop them, the slot pre-flight (spec 068 FR-006) stops a slot that names one, and the write path
-- refuses a new PromptHero load («required for posting: prompt_text») until the pipeline loads prompt text with it.
--
-- Data only. No row changes, no schema version bump (`post_requires` is not structural).
-- • The rule is replaced only while it is exactly the 083 value: an owner's own rule stays.
-- • The description gets one sentence about it, only while it is still the 083 text.
-- • The whole block is guarded by the column: a database that has not had 083 yet (the 083 migration test applies every
--   other migration before it) is left alone, and 083 then sets its own rule.
--
-- Idempotent (CI re-applies it).

DO $$
DECLARE
  v_sid  uuid;
  c_old  constant jsonb := '[["page_url"], ["prompt_text", "media_url"]]'::jsonb;
  c_new  constant jsonb := '[["prompt_text"], ["media_url"]]'::jsonb;
  c_desc constant text  := 'Prompts for image and video generators. PromptHero rows (provider prompthero) store the link to the prompt''s own page (page_url) and its example image (media_url); their prompt text is not stored. Curated GitHub rows (other providers) store the full prompt text and an example output.';
  c_note constant text  := ' PromptHero rows have no prompt text and cannot be posted.';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'data_schemas' AND column_name = 'post_requires') THEN
    RETURN;
  END IF;
  SELECT id INTO v_sid FROM data_schemas WHERE key = 'prompts';
  IF v_sid IS NULL THEN RETURN; END IF;

  UPDATE data_schemas SET post_requires = c_new WHERE id = v_sid AND post_requires = c_old;
  UPDATE data_schemas SET description = c_desc || c_note
   WHERE id = v_sid AND description = c_desc AND post_requires = c_new;

  PERFORM data_schema_stats_refresh(v_sid);
END $$;

INSERT INTO schema_migrations (version) VALUES ('095_prompts_post_requires') ON CONFLICT DO NOTHING;
