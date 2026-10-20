-- Down for 089_promo_pair_block.sql (spec 056 follow-up).
ALTER TABLE promo_pairs DROP COLUMN IF EXISTS blocked_at;
DELETE FROM schema_migrations WHERE version = '089_promo_pair_block';
