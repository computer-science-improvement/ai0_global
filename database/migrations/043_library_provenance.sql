-- 043_library_provenance.sql
-- Spec 007 T008: provenance + licensing columns on the editor library tables.
--
--   source_name TEXT   — where the row came from (site/dataset), e.g. 'faktypro.com.ua'
--   source_url  TEXT   — canonical URL of the original, when known
--   license     TEXT NOT NULL DEFAULT 'unknown'
--               CHECK (license IN ('unknown','permitted','own','cc-by','pd'))
--
-- The `source-licensing` editor skill (spec 004) tells the executor to write
-- original text and attribute the source when license = 'unknown'.
--
-- Additive and idempotent: every table is guarded with to_regclass, columns use
-- ADD COLUMN IF NOT EXISTS (assets/tg_posts already have source_url — kept as is),
-- and the CHECK is added only when its name is absent. Backfills touch only rows
-- whose source_name is still NULL, so a re-run is a no-op. Licenses are NOT
-- guessed: everything stays 'unknown' until the owner marks it.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'recipes','facts','quotes','prompts','on_this_day','articles','pdr_questions',
    'birthdays','assets','tg_posts','jokes','name_days'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS source_name TEXT', t);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS source_url TEXT', t);
      EXECUTE format($f$ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS license TEXT NOT NULL DEFAULT 'unknown'$f$, t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = to_regclass('public.' || t) AND conname = t || '_license_chk'
      ) THEN
        EXECUTE format(
          $f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (license IN ('unknown','permitted','own','cc-by','pd'))$f$,
          t, t || '_license_chk');
      END IF;
    END IF;
  END LOOP;
END $$;

-- ─── Cheap, obvious backfills (source_name IS NULL only) ────────────────────
-- Host of a URL without "www.", e.g. https://www.treatfield.com/x → treatfield.com.
-- Inlined per statement (no helper function, so the migration adds no objects).

DO $$
BEGIN
  -- faktypro.com.ua scrape (loaders/facts.js)
  IF to_regclass('public.facts') IS NOT NULL THEN
    UPDATE public.facts
       SET source_name = 'faktypro.com.ua',
           source_url  = COALESCE(source_url, article_url)
     WHERE source_name IS NULL;
  END IF;

  -- Epicure gallery dump (parsers/recipes-epicure.js keeps the raw record);
  -- other recipes fall back to the host of their url.
  IF to_regclass('public.recipes') IS NOT NULL THEN
    UPDATE public.recipes
       SET source_name = 'epicure.kaikaku.ai'
     WHERE source_name IS NULL AND raw ? 'recipe_name';
    UPDATE public.recipes
       SET source_name = substring(url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:www\.)?([^/:?#]+)'),
           source_url  = COALESCE(source_url, url)
     WHERE source_name IS NULL AND url IS NOT NULL;
  END IF;

  -- pdr-online.com.ua tickets (loaders/pdr.js)
  IF to_regclass('public.pdr_questions') IS NOT NULL THEN
    UPDATE public.pdr_questions SET source_name = 'pdr-online.com.ua' WHERE source_name IS NULL;
  END IF;

  -- daytoday.ua: the only loader for these date tables is loaders/daytoday.js
  IF to_regclass('public.on_this_day') IS NOT NULL THEN
    UPDATE public.on_this_day SET source_name = 'daytoday.ua' WHERE source_name IS NULL;
  END IF;
  IF to_regclass('public.name_days') IS NOT NULL THEN
    UPDATE public.name_days SET source_name = 'daytoday.ua' WHERE source_name IS NULL;
  END IF;
  IF to_regclass('public.birthdays') IS NOT NULL THEN
    UPDATE public.birthdays SET source_name = 'daytoday.ua' WHERE source_name IS NULL;
  END IF;

  -- URL-bearing tables: source_url = url, source_name = its host.
  IF to_regclass('public.articles') IS NOT NULL THEN
    UPDATE public.articles
       SET source_name = substring(url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:www\.)?([^/:?#]+)'),
           source_url  = COALESCE(source_url, url)
     WHERE source_name IS NULL AND url IS NOT NULL;
  END IF;
  IF to_regclass('public.quotes') IS NOT NULL THEN
    UPDATE public.quotes
       SET source_name = substring(url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:www\.)?([^/:?#]+)'),
           source_url  = COALESCE(source_url, url)
     WHERE source_name IS NULL AND url IS NOT NULL;
  END IF;
  IF to_regclass('public.jokes') IS NOT NULL THEN
    UPDATE public.jokes
       SET source_name = substring(url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:www\.)?([^/:?#]+)'),
           source_url  = COALESCE(source_url, url)
     WHERE source_name IS NULL AND url IS NOT NULL;
  END IF;
  IF to_regclass('public.prompts') IS NOT NULL THEN
    UPDATE public.prompts
       SET source_name = substring(page_url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:www\.)?([^/:?#]+)'),
           source_url  = COALESCE(source_url, page_url)
     WHERE source_name IS NULL AND page_url IS NOT NULL;
  END IF;

  -- assets: host of its own link/source_url, else the dataset id.
  IF to_regclass('public.assets') IS NOT NULL THEN
    UPDATE public.assets
       SET source_name = COALESCE(
             substring(COALESCE(source_url, link) from '^[A-Za-z][A-Za-z0-9+.-]*://(?:www\.)?([^/:?#]+)'),
             data_source)
     WHERE source_name IS NULL;
  END IF;

  -- tg_posts: LLM-adapted posts; name the upstream (host of source_url, else
  -- the loader's dataset id such as 'daytoday-self-development').
  IF to_regclass('public.tg_posts') IS NOT NULL THEN
    UPDATE public.tg_posts
       SET source_name = COALESCE(
             substring(source_url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:www\.)?([^/:?#]+)'),
             source)
     WHERE source_name IS NULL;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('043_library_provenance')
  ON CONFLICT (version) DO NOTHING;
