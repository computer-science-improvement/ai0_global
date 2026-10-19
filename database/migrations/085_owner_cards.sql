-- 085_owner_cards.sql — the owner control bot (spec 012 part A).
--
-- • owner_cards: one Telegram card per thing that waits for the owner (a post to approve, a directive, an agent card,
--   a steering set, a setup proposal, a playbook, an inbox note). `ref_id` names the item (and its state when one item
--   can wait twice); the buttons are stored here and the callback data only points at the card and a button index.
-- • owner_reports: the daily summary and the weekly report, claimed once per period so a restart never repeats one.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS owner_cards (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'open', 'done', 'closed', 'failed')),
  critical     BOOLEAN NOT NULL DEFAULT false,
  title        TEXT NOT NULL,
  body         TEXT,
  buttons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  link         TEXT,
  chat_id      TEXT,
  message_id   BIGINT,
  outcome      TEXT,
  resolved_by  TEXT,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_cards_ref ON owner_cards (kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_owner_cards_live ON owner_cards (status, created_at) WHERE status IN ('queued', 'open');
CREATE INDEX IF NOT EXISTS idx_owner_cards_sent ON owner_cards (sent_at) WHERE sent_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS owner_reports (
  kind     TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
  period   TEXT NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period)
);

INSERT INTO schema_migrations (version) VALUES ('085_owner_cards')
  ON CONFLICT (version) DO NOTHING;
