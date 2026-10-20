-- 089_promo_pair_block.sql — the owner can stop cross-promo between two resources (spec 056 follow-up).
--
-- promo_pairs.blocked_at: set on both directions of a pair when the owner blocks it from the network map. The promo
-- planner refuses a cross_promo or repost directive for a blocked pair (pair_blocked) until the owner allows it again.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

ALTER TABLE promo_pairs ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('089_promo_pair_block') ON CONFLICT DO NOTHING;
