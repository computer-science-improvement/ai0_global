-- 047_editor_chat.sql — editor chat (spec 010): conversations with the composer
-- agent and the post drafts it produces.
--
-- A draft is published either at once (owner click or explicit request) or at a
-- scheduled time through a reserved editor slot (008) without an order: the
-- reserved dispatcher publishes it deterministically and updates the draft.
--
-- Additive and idempotent: new tables only, safe to apply twice.

CREATE TABLE IF NOT EXISTS editor_chats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL DEFAULT 'Новий чат',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editor_chats_updated ON editor_chats (updated_at DESC);

CREATE TABLE IF NOT EXISTS editor_chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     UUID NOT NULL REFERENCES editor_chats(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  draft_ids   UUID[] NOT NULL DEFAULT '{}',
  run_id      UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editor_chat_messages_chat ON editor_chat_messages (chat_id, id);

CREATE TABLE IF NOT EXISTS editor_drafts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id            UUID REFERENCES editor_chats(id) ON DELETE SET NULL,
  channel_key        TEXT NOT NULL,
  spec               JSONB NOT NULL,
  preview            TEXT,
  lint               JSONB,
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','scheduled','published','failed','canceled')),
  scheduled_at       TIMESTAMPTZ,
  slot_id            UUID REFERENCES editor_slots(id) ON DELETE SET NULL,
  published_post_id  BIGINT,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editor_drafts_chat ON editor_drafts (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_editor_drafts_status ON editor_drafts (status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_editor_drafts_slot ON editor_drafts (slot_id) WHERE slot_id IS NOT NULL;

COMMENT ON TABLE editor_drafts IS
  'Posts drafted in the editor chat (spec 010); scheduled ones are linked to a reserved editor slot via slot_id';

INSERT INTO schema_migrations (version) VALUES ('047_editor_chat')
  ON CONFLICT (version) DO NOTHING;
