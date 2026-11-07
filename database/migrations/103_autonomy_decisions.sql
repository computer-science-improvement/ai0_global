-- 103_autonomy_decisions.sql — the autonomy contract (spec 090 FR-010).
--
-- autonomy_decisions   every decision the system made because the owner stayed silent at a gate (spec 090 FR-001 registry):
--                      a directive applied on timeout, a card applied or dropped, a playbook version activated, a safe audit
--                      or readiness fix applied, a pause resumed, setup sections applied. `undo` is a typed record of how to
--                      reverse it (null = code cannot undo it); `POST /api/autonomy/decisions/:id/undo` runs it and writes
--                      an `undone` row. Read by the daily report («Зроблено без вас»), /app/health and the owner-bot sweep.
--
-- Additive and idempotent. Apply it with the deploy: writers swallow their errors, so without it the decisions are not logged.

CREATE TABLE IF NOT EXISTS autonomy_decisions (
  id          BIGSERIAL PRIMARY KEY,
  gate        TEXT NOT NULL,
  ref_type    TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  channel_key TEXT,
  action      TEXT NOT NULL CHECK (action IN ('applied','dropped','resumed','failed','undone')),
  summary     TEXT NOT NULL,
  undo        JSONB,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at   TIMESTAMPTZ,
  undone_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_at      ON autonomy_decisions (decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_channel ON autonomy_decisions (channel_key, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_ref     ON autonomy_decisions (ref_type, ref_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    EXECUTE 'GRANT SELECT ON public.autonomy_decisions TO editor_ro';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('103_autonomy_decisions') ON CONFLICT DO NOTHING;
