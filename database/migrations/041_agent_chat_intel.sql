-- SP4 chat intel: owner-selected allow-list of ALREADY-JOINED group chats the
-- agent monitors (read-only) + the opportunities feed extracted from them.
CREATE TABLE IF NOT EXISTS agent_monitored_chats (
  chat_id          TEXT PRIMARY KEY,
  title            TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  last_message_id  BIGINT NOT NULL DEFAULT 0,
  last_polled_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_opportunities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          TEXT NOT NULL,
  chat_title       TEXT,
  message_id       BIGINT NOT NULL,
  message_text     TEXT,
  kind             TEXT NOT NULL DEFAULT 'other'
                     CHECK (kind IN ('ad_offer','vp_request','pricing','other')),
  summary          TEXT,
  score            INT NOT NULL DEFAULT 0,
  suggested_action TEXT NOT NULL DEFAULT 'skip'
                     CHECK (suggested_action IN ('advertise','do_vp','skip')),
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','reviewed','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_opps_status ON agent_opportunities (status, score DESC, created_at DESC);
