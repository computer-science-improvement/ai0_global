-- SP1 agent DM inbox: one row per peer (thread), upserted on a newer message.
-- last_text is operational message content (not a secret); the agent's session
-- string/credentials stay encrypted in mtproto_sessions and are never copied here.
CREATE TABLE IF NOT EXISTS agent_dm_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  peer_id          TEXT NOT NULL,
  peer_username    TEXT,
  peer_name        TEXT,
  last_message_id  BIGINT NOT NULL,
  last_message_at  TIMESTAMPTZ NOT NULL,
  last_text        TEXT,
  category         TEXT NOT NULL DEFAULT 'other'
                     CHECK (category IN ('ad','vp','question','spam','other')),
  summary          TEXT,
  fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_reply      TEXT,
  score            INT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','reviewed','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (peer_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_dm_status   ON agent_dm_threads (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_dm_category ON agent_dm_threads (category);

-- Poll high-water / last-polled per agent session. Keyed by the literal 'agent'
-- (single agent session in SP1), hence TEXT rather than a UUID FK.
CREATE TABLE IF NOT EXISTS agent_poll_cursor (
  session_id       TEXT PRIMARY KEY,
  last_message_id  BIGINT NOT NULL DEFAULT 0,
  last_polled_at   TIMESTAMPTZ
);
