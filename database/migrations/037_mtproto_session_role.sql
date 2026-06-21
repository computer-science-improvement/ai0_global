-- A session belongs to a role so the tracker/stats clients and the agent each
-- pick their OWN account and never steal the other's session. Existing rows
-- become 'tracker' (unchanged behavior).
ALTER TABLE mtproto_sessions
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'tracker'
  CHECK (role IN ('tracker', 'agent'));
