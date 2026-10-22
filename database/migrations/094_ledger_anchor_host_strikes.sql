-- 094_ledger_anchor_host_strikes.sql — reference documents in the content ledger; host block strikes (spec 061).
--
-- • A reference document (a law: zakon.rada.gov.ua/laws/show/1306-2001-п) is cited by many posts, one clause each. The
--   ledger keyed it by URL, so the second post of @pdr_dev_channel was refused (`source_already_posted`, 10 runs in a
--   week). A source on a reusable host (setting LEDGER_REUSABLE_HOSTS) is now keyed by URL plus anchor:
--     content_ledger.anchor   — the normalised clause («п.1.10»), NULL for every ordinary row;
--     content_ledger.source_ref of such a row is `<canonical url>#<anchor>`.
--   The anchor is part of the ref, so the existing UNIQUE (resource_ref, source_ref, status) and every
--   `ON CONFLICT (resource_ref, source_ref, status)` (060 backfill, 075) keep working: the same clause cannot be recorded
--   twice, different clauses can. Rows written before this migration stay as they are (plain URL, no anchor); on a
--   reusable host a plain URL row blocks nothing, only a row of the same anchor does.
--   `content_url_canonical` still drops the fragment (migration 075), so a plain ref and an anchored ref never meet.
-- • content_anchor_norm / content_ref_anchored: the one normalisation of an anchor (trimmed, spaces collapsed, lower
--   case, at most 40 characters) and the ledger ref of URL + anchor (the anchor argument, else the URL's #fragment).
-- • content_ledger_record_anchored: records a use under the anchored ref (content_ledger_record itself is unchanged).
-- • source_host_failures.strikes: consecutive blocks of one host, kept when a block expires and reset only after a
--   successful fetch (1 d → 3 d → 7 d escalation); noted_at: when the owner was told about a 7-day host.
--
-- Additive and idempotent (CI re-applies it).

ALTER TABLE content_ledger ADD COLUMN IF NOT EXISTS anchor TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'content_ledger'::regclass AND conname = 'content_ledger_anchor_ref') THEN
    ALTER TABLE content_ledger ADD CONSTRAINT content_ledger_anchor_ref
      CHECK (anchor IS NULL OR (anchor <> '' AND right(source_ref, length(anchor) + 1) = '#' || anchor));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_content_ledger_anchor ON content_ledger (resource_ref, status) WHERE anchor IS NOT NULL;

-- The normal form of an anchor: NULL for blank.
CREATE OR REPLACE FUNCTION content_anchor_norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(btrim(left(lower(regexp_replace(btrim(COALESCE(p, '')), '\s+', ' ', 'g')), 40)), '')
$$;

-- The ledger ref of a source with an anchor: `<canonical url>#<anchor>`, the anchor being the argument or the URL's
-- own #fragment. NULL when there is no anchor (a plain ref is content_ref_canonical).
CREATE OR REPLACE FUNCTION content_ref_anchored(p_url text, p_anchor text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  a text := content_anchor_norm(COALESCE(NULLIF(btrim(COALESCE(p_anchor, '')), ''), substring(COALESCE(p_url, '') from '#(.*)$')));
  c text := content_ref_canonical(p_url);
BEGIN
  IF a IS NULL OR c IS NULL THEN RETURN NULL; END IF;
  RETURN c || '#' || a;
END $$;

-- content_ledger_record for a source with an anchor: the row is stored under `<canonical url>#<anchor>`. A separate
-- function, not a new overload of content_ledger_record: a rerun of 060 re-creates the 9-argument form, and two
-- overloads where one has only defaults would make every trigger call ambiguous.
CREATE OR REPLACE FUNCTION content_ledger_record_anchored(
  p_resource text, p_source text, p_anchor text, p_origin text, p_status text,
  p_published_post_id bigint DEFAULT NULL, p_platform_post_id bigint DEFAULT NULL, p_slot_id uuid DEFAULT NULL,
  p_used_at timestamptz DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_src    text := content_ref_anchored(p_source, p_anchor);
  v_anchor text := content_anchor_norm(p_anchor);
  v_res    text := NULLIF(btrim(COALESCE(p_resource, '')), '');
  v_new    boolean;
BEGIN
  IF v_src IS NULL OR v_anchor IS NULL OR v_res IS NULL THEN RETURN false; END IF;
  INSERT INTO content_ledger AS l (resource_ref, source_ref, origin, status, published_post_id, platform_post_id, slot_id, used_at, note, anchor)
  VALUES (v_res, v_src, p_origin, p_status, p_published_post_id, p_platform_post_id, p_slot_id, COALESCE(p_used_at, now()), left(p_note, 500), v_anchor)
  ON CONFLICT (resource_ref, source_ref, status) DO UPDATE SET
    used_at           = EXCLUDED.used_at,
    published_post_id = COALESCE(EXCLUDED.published_post_id, l.published_post_id),
    platform_post_id  = COALESCE(EXCLUDED.platform_post_id, l.platform_post_id),
    slot_id           = COALESCE(EXCLUDED.slot_id, l.slot_id),
    note              = COALESCE(EXCLUDED.note, l.note)
    WHERE EXCLUDED.used_at > l.used_at
  RETURNING (xmax = 0) INTO v_new;
  RETURN COALESCE(v_new, false);
END $$;

-- Host blocks escalate (spec 061 FR-004).
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS strikes  INT NOT NULL DEFAULT 0;
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS noted_at TIMESTAMPTZ;
-- The hosts already in the table: what they failed so far is what they have as strikes.
UPDATE source_host_failures SET strikes = GREATEST(failures, 1) WHERE strikes = 0;

INSERT INTO schema_migrations (version) VALUES ('094_ledger_anchor_host_strikes') ON CONFLICT DO NOTHING;
