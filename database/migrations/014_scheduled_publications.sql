-- 014_scheduled_publications.sql — operator-composed one-off scheduled posts.
CREATE TABLE IF NOT EXISTS scheduled_publications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL CHECK (sender IN ('bot','mtproto_user')),
  bot_id          UUID REFERENCES my_bots(id),
  text            TEXT NOT NULL DEFAULT '',
  media_type      TEXT NOT NULL DEFAULT 'none' CHECK (media_type IN ('none','photo','video')),
  media_url       TEXT,
  media_placement TEXT NOT NULL DEFAULT 'above' CHECK (media_placement IN ('above','below')),
  buttons         JSONB NOT NULL DEFAULT '[]',
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','canceled')),
  message_id      BIGINT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sched_pub_due     ON scheduled_publications (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sched_pub_channel ON scheduled_publications (channel_id);

INSERT INTO schema_migrations (version) VALUES ('014_scheduled_publications')
  ON CONFLICT (version) DO NOTHING;
