-- 074_post_audit.sql — the post audit: every deterministic integrity check over the published posts (spec 037 FR-014, T14).
--
-- (073 is reserved for spec 037 T2 story registry; 075 is T16 ledger_url_canonical, 076 T10 silent_days.)
--
-- • editor_post_audit: one row per finding of the audit over a resource's published posts of the last 7 days
--   (Telegram slots with a post spec, native platform posts). The post is `post_kind` + `post_id` (the slot id or
--   the platform_posts id) with its publish time, a link when one can be derived and a short excerpt; the finding
--   is its code, level, message (the check's own words, for the agents), excerpt and any extra fields a check adds
--   (links or ids of the matched posts, …) in `extra`. `fingerprint` tells two findings of one code on one post
--   apart, so a rerun upserts the same rows (idempotent) and deletes the ones the rules no longer find.
-- • editor_post_audit_runs: per resource, when the audit last ran and with which rules (`rules_hash`: a hash of the
--   registered check ids and their codes). A different hash recomputes the last 7 days at the next tick.
--
-- Additive and idempotent: CI re-applies this file.

CREATE TABLE IF NOT EXISTS editor_post_audit (
  id            BIGSERIAL PRIMARY KEY,
  resource_ref  TEXT NOT NULL,
  channel_key   TEXT,
  post_kind     TEXT NOT NULL CHECK (post_kind IN ('slot','platform')),
  post_id       TEXT NOT NULL,
  slot_id       UUID,
  message_id    BIGINT,
  post_url      TEXT,
  post_excerpt  TEXT,
  format        TEXT,
  code          TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('error','warning')),
  message       TEXT NOT NULL,
  excerpt       TEXT,
  extra         JSONB,
  fingerprint   TEXT NOT NULL,
  published_at  TIMESTAMPTZ NOT NULL,
  audited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rules_hash    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_editor_post_audit_finding
  ON editor_post_audit (resource_ref, post_kind, post_id, code, fingerprint);
CREATE INDEX IF NOT EXISTS idx_editor_post_audit_resource_time
  ON editor_post_audit (resource_ref, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_editor_post_audit_slot
  ON editor_post_audit (slot_id) WHERE slot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS editor_post_audit_runs (
  resource_ref  TEXT PRIMARY KEY,
  rules_hash    TEXT NOT NULL,
  audited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_from   TIMESTAMPTZ NOT NULL,
  posts         INT NOT NULL DEFAULT 0,
  findings      INT NOT NULL DEFAULT 0,
  error         TEXT
);

INSERT INTO schema_migrations (version) VALUES ('074_post_audit')
  ON CONFLICT (version) DO NOTHING;
