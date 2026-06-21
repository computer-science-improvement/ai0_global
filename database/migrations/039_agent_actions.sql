-- SP2 agent actions: every outward action (reply / schedule_post) is a row the
-- owner approves/edits/rejects. Nothing executes without an explicit approve.
CREATE TABLE IF NOT EXISTS agent_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL CHECK (type IN ('reply','schedule_post')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','done','rejected','failed')),
  thread_id    UUID REFERENCES agent_dm_threads(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- reply:{text}; schedule_post:{text,channelId,scheduledAt,scheduledPostId?}
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions (status, created_at DESC);

-- Record that a thread was replied to (so the inbox can show it + dedup re-asks).
ALTER TABLE agent_dm_threads
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_reply TEXT;
