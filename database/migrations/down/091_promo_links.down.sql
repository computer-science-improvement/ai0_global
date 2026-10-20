-- Down for 091_promo_links.sql (spec 058).
DROP TABLE IF EXISTS map_link_events;
ALTER TABLE promo_pairs DROP COLUMN IF EXISTS linked_at;
DELETE FROM schema_migrations WHERE version = '091_promo_links';
