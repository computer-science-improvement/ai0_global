-- 008_recipes_translation.sql
-- Cache Claude's Ukrainian translation of each recipe directly on the row so a
-- publish retry never re-pays for translation. Columns are NULL until the
-- recipes strategy translates the row on first post; an empty title_uk is a
-- "skip this row" sentinel for recipes Claude refused to translate.

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS title_uk        TEXT,
  ADD COLUMN IF NOT EXISTS ingredients_uk  TEXT,
  ADD COLUMN IF NOT EXISTS instructions_uk TEXT,
  ADD COLUMN IF NOT EXISTS translated_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recipes_untranslated
  ON recipes (created_at) WHERE title_uk IS NULL;

INSERT INTO schema_migrations (version) VALUES ('008_recipes_translation')
  ON CONFLICT (version) DO NOTHING;
