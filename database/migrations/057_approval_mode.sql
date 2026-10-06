-- 057_approval_mode.sql — approval mode (spec 031).
--
-- A third working mode, `approve`, between shadow and live: the agent plans,
-- writes and schedules posts as in live, but every post waits for the owner's
-- approval before anything is sent. New resources and agents start in it.
--
-- • `approve` joins editor_channels.mode and agents.mode (off < shadow < approve < live).
-- • Slots get awaiting_approval / approved / expired, the approval columns and
--   the exact render the owner approves (render_messages, prepared_media).
-- • platform_posts get awaiting_approval (a written post that waits) and
--   canceled (a waiting post that was rejected, expired or dropped).
-- • approval_alerts dedupes the owner's Telegram batch alert across restarts.
--
-- Additive and idempotent: the CHECK constraints are dropped and re-added only
-- when the new value is missing; existing rows keep their modes.

-- ── modes ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'editor_channels'::regclass AND conname = 'editor_channels_mode_check';
  IF def IS NULL OR def NOT LIKE '%approve%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE editor_channels DROP CONSTRAINT editor_channels_mode_check;
    END IF;
    ALTER TABLE editor_channels ADD CONSTRAINT editor_channels_mode_check
      CHECK (mode IN ('off','shadow','approve','live'));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'agents'::regclass AND conname = 'agents_mode_check';
  IF def IS NULL OR def NOT LIKE '%approve%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE agents DROP CONSTRAINT agents_mode_check;
    END IF;
    ALTER TABLE agents ADD CONSTRAINT agents_mode_check
      CHECK (mode IN ('off','shadow','approve','live'));
  END IF;
END $$;

-- New agents start in approve (FR-002). Existing rows are untouched.
ALTER TABLE agents ALTER COLUMN mode SET DEFAULT 'approve';

-- ── slot statuses ────────────────────────────────────────────────────────────
DO $$
DECLARE
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'editor_slots'::regclass AND conname = 'editor_slots_status_check';
  IF def IS NULL OR def NOT LIKE '%awaiting_approval%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE editor_slots DROP CONSTRAINT editor_slots_status_check;
    END IF;
    ALTER TABLE editor_slots ADD CONSTRAINT editor_slots_status_check
      CHECK (status IN ('planned','running','published','shadowed','skipped','failed','awaiting_approval','approved','expired'));
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'platform_posts'::regclass AND conname = 'platform_posts_status_check';
  IF def IS NULL OR def NOT LIKE '%awaiting_approval%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE platform_posts DROP CONSTRAINT platform_posts_status_check;
    END IF;
    ALTER TABLE platform_posts ADD CONSTRAINT platform_posts_status_check
      CHECK (status IN ('published','shadowed','failed','awaiting_approval','canceled'));
  END IF;
END $$;

-- ── per-resource approval windows ────────────────────────────────────────────
ALTER TABLE editor_channels ADD COLUMN IF NOT EXISTS approval_hold_hours INT NOT NULL DEFAULT 6;
ALTER TABLE editor_channels ADD COLUMN IF NOT EXISTS approval_lead_hours INT NOT NULL DEFAULT 12;
DO $$
BEGIN
  ALTER TABLE editor_channels ADD CONSTRAINT editor_channels_approval_hours_chk
    CHECK (approval_hold_hours BETWEEN 1 AND 72 AND approval_lead_hours BETWEEN 1 AND 48);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── approval data on a slot ──────────────────────────────────────────────────
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS approved_by        TEXT;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS owner_edited       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS reject_reason      TEXT;
-- The exact payload the owner approves and the publisher sends: Telegram calls
-- ({messages, primary}) or the rendered platform post ({platform, rendered}).
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS render_messages    JSONB;
-- Media prepared at write time (hosted carousel slides, the longread's Telegraph page).
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS prepared_media     JSONB;
-- Lint warnings of the written post: bulk approval never includes a post with warnings.
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS lint_warnings      JSONB;
-- Time-sensitive posts (news, feed sources) expire at this deadline instead of the hold window.
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS freshness_deadline TIMESTAMPTZ;
-- A replacement written after a rejection (at most one per rejected slot).
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS replaces_slot_id   UUID;
-- The waiting platform_posts row of a non-Telegram slot.
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS platform_post_id   BIGINT;

DO $$
BEGIN
  ALTER TABLE editor_slots ADD CONSTRAINT editor_slots_approved_by_chk CHECK (approved_by IS NULL OR approved_by = 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Defence in depth for the safety invariant: an approved slot always carries its approval time.
DO $$
BEGIN
  ALTER TABLE editor_slots ADD CONSTRAINT editor_slots_approved_at_chk CHECK (status <> 'approved' OR approved_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_editor_slots_approval ON editor_slots (channel_key, status, scheduled_at)
  WHERE status IN ('awaiting_approval','approved');
CREATE UNIQUE INDEX IF NOT EXISTS uq_editor_slots_replaces ON editor_slots (replaces_slot_id) WHERE replaces_slot_id IS NOT NULL;

-- ── owner alert dedupe (T4) ──────────────────────────────────────────────────
-- One Telegram alert per resource per batch (the plan date of the waiting posts).
CREATE TABLE IF NOT EXISTS approval_alerts (
  channel_key TEXT NOT NULL,
  batch_date  DATE NOT NULL,
  posts       INT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_key, batch_date)
);

INSERT INTO schema_migrations (version) VALUES ('057_approval_mode')
  ON CONFLICT (version) DO NOTHING;
