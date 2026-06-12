-- 020_strategy_binding_destination.sql
-- A strategy binding can target a Meta account (instagram/facebook/threads)
-- as a first-class destination, instead of a Telegram channel. Existing rows
-- default to 'telegram' and keep their channel_id — no behavior change.

ALTER TABLE strategy_bindings
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'telegram'
    CHECK (platform IN ('telegram','instagram','facebook','threads')),
  ADD COLUMN IF NOT EXISTS meta_account_id UUID REFERENCES meta_accounts(id);

-- A Meta binding has no Telegram channel.
ALTER TABLE strategy_bindings ALTER COLUMN channel_id DROP NOT NULL;

-- Exactly one destination kind per binding.
ALTER TABLE strategy_bindings
  ADD CONSTRAINT strategy_binding_destination_chk CHECK (
       (platform =  'telegram' AND channel_id     IS NOT NULL AND meta_account_id IS NULL)
    OR (platform <> 'telegram' AND meta_account_id IS NOT NULL)
  );
