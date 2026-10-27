-- Down for 095_prompts_post_requires.sql (spec 068). Puts back the 083 rule for `prompts` when the 095 value is still in
-- place (an owner's own rule stays), takes the added sentence off the description, refreshes the stats. No rows change.

DO $$
DECLARE
  v_sid  uuid;
  c_old  constant jsonb := '[["page_url"], ["prompt_text", "media_url"]]'::jsonb;
  c_new  constant jsonb := '[["prompt_text"], ["media_url"]]'::jsonb;
  c_note constant text  := ' PromptHero rows have no prompt text and cannot be posted.';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'data_schemas' AND column_name = 'post_requires') THEN
    RETURN;
  END IF;
  SELECT id INTO v_sid FROM data_schemas WHERE key = 'prompts';
  IF v_sid IS NULL THEN RETURN; END IF;

  UPDATE data_schemas SET post_requires = c_old WHERE id = v_sid AND post_requires = c_new;
  UPDATE data_schemas SET description = left(description, length(description) - length(c_note))
   WHERE id = v_sid AND right(description, length(c_note)) = c_note AND post_requires = c_old;

  PERFORM data_schema_stats_refresh(v_sid);
END $$;

DELETE FROM schema_migrations WHERE version = '095_prompts_post_requires';
