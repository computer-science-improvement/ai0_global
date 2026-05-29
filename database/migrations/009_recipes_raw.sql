-- 009_recipes_raw.sql
-- Keep the full original recipe object losslessly. The normalized columns
-- (title/ingredients/instructions/…) stay the curated fields used for posting;
-- `raw` preserves everything the source provided (nutrition, servings, notes,
-- cultural suggestions, techniques, …) so future posts/features need no reload.

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS raw JSONB;

INSERT INTO schema_migrations (version) VALUES ('009_recipes_raw')
  ON CONFLICT (version) DO NOTHING;
