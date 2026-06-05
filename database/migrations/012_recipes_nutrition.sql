-- 012_recipes_nutrition.sql
-- Surface per-serving macros (БЖВ + калорії) as first-class columns. The data
-- already lives losslessly in recipes.raw.nutrition_per_serving — this is a
-- pure re-map (no AI). Full detail (per_100g, sodium, fiber, sugars, daily
-- values…) stays available in `raw`. Columns are nullable: ~9% of recipes
-- have no nutrition block.

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS kcal           NUMERIC,  -- calories per serving
  ADD COLUMN IF NOT EXISTS protein_g      NUMERIC,  -- Б
  ADD COLUMN IF NOT EXISTS fat_g          NUMERIC,  -- Ж (total_fat_g)
  ADD COLUMN IF NOT EXISTS carbs_g        NUMERIC,  -- В (total_carbs_g)
  ADD COLUMN IF NOT EXISTS serving_size_g NUMERIC;

-- Backfill from raw (existing local data). No-op on a fresh install where the
-- table is empty until the pipeline loads it.
UPDATE recipes SET
  kcal           = NULLIF(raw->'nutrition_per_serving'->>'calories',     '')::numeric,
  protein_g      = NULLIF(raw->'nutrition_per_serving'->>'protein_g',    '')::numeric,
  fat_g          = NULLIF(raw->'nutrition_per_serving'->>'total_fat_g',  '')::numeric,
  carbs_g        = NULLIF(raw->'nutrition_per_serving'->>'total_carbs_g','')::numeric,
  serving_size_g = NULLIF(raw->>'serving_size_g',                        '')::numeric
WHERE raw ? 'nutrition_per_serving';

INSERT INTO schema_migrations (version) VALUES ('012_recipes_nutrition')
  ON CONFLICT (version) DO NOTHING;
