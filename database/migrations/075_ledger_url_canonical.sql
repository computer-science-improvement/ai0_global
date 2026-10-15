-- 075_ledger_url_canonical.sql — one URL, one ledger ref (spec 037 T16, AI0-110).
--
-- Біржа Ігор published the same Steam deals twice on 08.10 (12:30 and 14:13), both with the source
-- https://store.steampowered.com/. The 060 canonical form only lower-cased the scheme and host and dropped
-- utm_* and the fragment, so `https://store.steampowered.com` and `https://store.steampowered.com/` (and
-- http://, www., a trailing slash on a path) were different ledger refs and the second post passed the
-- publish guard. Telegram stores a link's href normalised (an empty path becomes "/"), so the channel and
-- its export show both posts with the same URL.
--
-- • content_url_canonical: https for http, host without `www.`, a default port or a trailing dot, the root
--   always "/", no trailing slash on any other path; utm_*, fbclid and gclid parameters and the fragment
--   dropped. The path's case and every other query parameter stay (`/search/?specials=1` is another page).
-- • Existing http(s) ledger rows are rewritten to the new form; rows that become one (resource, ref,
--   status) are merged keeping the latest use, its post / slot ids and note.
--
-- Additive and idempotent: a rerun finds nothing to rewrite.

CREATE OR REPLACE FUNCTION content_url_canonical(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m     text[];
  q     text;
  host  text;
  path  text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(btrim(p), '^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$');
  IF m IS NULL OR lower(m[1]) NOT IN ('http', 'https') THEN RETURN btrim(p); END IF;
  host := regexp_replace(regexp_replace(regexp_replace(lower(m[2]), ':(80|443)$', ''), '\.$', ''), '^www\.', '');
  path := regexp_replace(COALESCE(m[3], ''), '/+$', '');
  IF path = '' THEN path := '/'; END IF;
  IF m[4] IS NOT NULL AND length(m[4]) > 1 THEN
    SELECT string_agg(part, '&' ORDER BY n) INTO q
      FROM unnest(string_to_array(substr(m[4], 2), '&')) WITH ORDINALITY AS t(part, n)
     WHERE part <> '' AND lower(split_part(part, '=', 1)) NOT LIKE 'utm\_%'
       AND lower(split_part(part, '=', 1)) NOT IN ('fbclid', 'gclid');
  END IF;
  RETURN 'https://' || host || path || CASE WHEN q IS NULL OR q = '' THEN '' ELSE '?' || q END;
END $$;

-- Rewrite the URL rows written under the 060 form; merge the ones that now name the same ref.
DO $$
DECLARE
  n int;
BEGIN
  CREATE TEMP TABLE ledger_recanon ON COMMIT DROP AS
    SELECT l.*, content_url_canonical(l.source_ref) AS canon
      FROM content_ledger l
     WHERE l.source_ref ~* '^https?://' AND content_url_canonical(l.source_ref) <> l.source_ref;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    DROP TABLE ledger_recanon;
    RETURN;
  END IF;
  DELETE FROM content_ledger l USING ledger_recanon r WHERE l.id = r.id;
  INSERT INTO content_ledger AS l (resource_ref, source_ref, origin, status, published_post_id, platform_post_id, slot_id, used_at, note)
  SELECT DISTINCT ON (resource_ref, canon, status)
         resource_ref, canon, origin, status, published_post_id, platform_post_id, slot_id, used_at, note
    FROM ledger_recanon
   ORDER BY resource_ref, canon, status, used_at DESC
  ON CONFLICT (resource_ref, source_ref, status) DO UPDATE SET
    used_at           = EXCLUDED.used_at,
    origin            = EXCLUDED.origin,
    published_post_id = COALESCE(EXCLUDED.published_post_id, l.published_post_id),
    platform_post_id  = COALESCE(EXCLUDED.platform_post_id, l.platform_post_id),
    slot_id           = COALESCE(EXCLUDED.slot_id, l.slot_id),
    note              = COALESCE(EXCLUDED.note, l.note)
    WHERE EXCLUDED.used_at > l.used_at;
  RAISE NOTICE '075: % content_ledger URL rows rewritten to the canonical form', n;
  DROP TABLE ledger_recanon;
END $$;

INSERT INTO schema_migrations (version) VALUES ('075_ledger_url_canonical')
  ON CONFLICT (version) DO NOTHING;
