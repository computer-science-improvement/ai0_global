-- 010_curated_prompts.sql
-- Extend prompts to store curated GitHub-sourced prompts (nanobanana images,
-- seedance videos) inline. `provider` discriminates these from the existing
-- prompthero rows (which store no text and are scraped at post time).

ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS provider    TEXT NOT NULL DEFAULT 'prompthero',
  ADD COLUMN IF NOT EXISTS title       TEXT,
  ADD COLUMN IF NOT EXISTS prompt_text TEXT,
  ADD COLUMN IF NOT EXISTS source      TEXT,
  ADD COLUMN IF NOT EXISTS media_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_type  TEXT;

UPDATE prompts SET provider = 'prompthero' WHERE provider IS NULL;

CREATE INDEX IF NOT EXISTS idx_prompts_provider ON prompts (provider);

INSERT INTO schema_migrations (version) VALUES ('010_curated_prompts')
  ON CONFLICT (version) DO NOTHING;
