-- 024_strategy_binding_tiktok.sql — TikTok as a first-class binding destination.
ALTER TABLE strategy_bindings
  ADD COLUMN IF NOT EXISTS tiktok_account_id UUID REFERENCES tiktok_accounts(id);

-- Widen the platform CHECK to include 'tiktok'. The 020 CHECK is unnamed; drop it
-- by introspection (the platform-IN check references 'telegram' but not channel_id).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'strategy_bindings'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%platform%'
     AND pg_get_constraintdef(oid) ILIKE '%telegram%'
     AND pg_get_constraintdef(oid) NOT ILIKE '%channel_id%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE strategy_bindings DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE strategy_bindings
  ADD CONSTRAINT strategy_bindings_platform_check
  CHECK (platform IN ('telegram','instagram','facebook','threads','tiktok'));

ALTER TABLE strategy_bindings DROP CONSTRAINT IF EXISTS strategy_binding_destination_chk;
ALTER TABLE strategy_bindings
  ADD CONSTRAINT strategy_binding_destination_chk CHECK (
       (platform =  'telegram' AND channel_id IS NOT NULL AND meta_account_id IS NULL AND tiktok_account_id IS NULL)
    OR (platform IN ('instagram','facebook','threads') AND meta_account_id IS NOT NULL AND tiktok_account_id IS NULL)
    OR (platform =  'tiktok' AND tiktok_account_id IS NOT NULL AND meta_account_id IS NULL)
  );
