-- 091_promo_links.sql — promo links the owner controls from the network map (spec 058).
--
-- promo_pairs.linked_at: set on both directions of a pair when the two may promote each other. A road on the map is now a
-- current link, not 30 days of traffic: the owner links and unlinks pairs there, and approving a cross_promo / repost
-- directive for a pair that is not linked yet links it. Unlinking sets blocked_at (089) so the manager does not propose
-- the pair again until it is linked again.
--
-- Seed (once, when the column is created): every pair that had a promo in the last 60 days and is not blocked is linked
-- both ways, so today's active pairs stay on the map.
--
-- map_link_events: what the owner changed on the map, for the event feed (linked / unlinked a pair, took a resource out
-- of a network). Resource refs and the network's name only; no post text.
--
-- Additive, non-destructive and idempotent (CI re-applies it; the seed runs only on the first apply).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'promo_pairs' AND column_name = 'linked_at') THEN
    ALTER TABLE promo_pairs ADD COLUMN linked_at TIMESTAMPTZ;
    -- the reverse direction of an active pair may not exist yet
    INSERT INTO promo_pairs (source_ref, target_ref)
    SELECT p.target_ref, p.source_ref FROM promo_pairs p
     WHERE p.blocked_at IS NULL AND (p.last_promo_at > now() - interval '60 days' OR p.count_30d > 0)
    ON CONFLICT (source_ref, target_ref) DO NOTHING;
    UPDATE promo_pairs p SET linked_at = now()
     WHERE p.blocked_at IS NULL
       AND EXISTS (SELECT 1 FROM promo_pairs q
                    WHERE ((q.source_ref = p.source_ref AND q.target_ref = p.target_ref) OR (q.source_ref = p.target_ref AND q.target_ref = p.source_ref))
                      AND q.blocked_at IS NULL AND (q.last_promo_at > now() - interval '60 days' OR q.count_30d > 0));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS map_link_events (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind      TEXT NOT NULL CHECK (kind IN ('link_made', 'link_broken', 'network_left')),
  ref       TEXT NOT NULL,
  other_ref TEXT,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_map_link_events_at ON map_link_events (at DESC);

INSERT INTO schema_migrations (version) VALUES ('091_promo_links') ON CONFLICT DO NOTHING;
