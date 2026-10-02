-- dev-agent-platform.sql — LOCAL / DEV ONLY. Never run on production.
--
-- Gives every own Telegram channel (tracked_channels.is_mine with a channel_key)
-- an editor card in SHADOW mode and a starter resource profile, so the agent
-- platform (specs 017–022) has something to show: on the next /api/agents call
-- (or the hourly registry sync) each card gets its orchestrator with planner,
-- executor, reviewer and idea-reviewer roles.
--
-- Shadow mode: agents plan and write previews, nothing is published.
-- Idempotent: existing cards and profiles are left untouched.
--
--   docker compose exec -T postgres psql -U "$POSTGRES_USER" -d <db> -f - < database/seeds/dev-agent-platform.sql

INSERT INTO editor_channels (channel_key, mode, title, brief, formats, hashtags, posts_per_day_min, posts_per_day_max)
SELECT t.channel_key, 'shadow', t.title,
       COALESCE(NULLIF(t.about, ''), 'Канал мережі ai0: ' || COALESCE(t.title, t.channel_key)),
       '{"text":0.6,"photo":1,"carousel":0.5,"longread":0.4}', '{}', 1, 4
  FROM tracked_channels t
 WHERE t.is_mine AND t.channel_key IS NOT NULL AND t.channel_key <> ''
ON CONFLICT (channel_key) DO NOTHING;

INSERT INTO resource_profiles (resource_ref, profile, updated_by)
SELECT 'telegram:' || t.channel_key,
       jsonb_build_object(
         'topic', COALESCE(NULLIF(t.about, ''), COALESCE(t.title, t.channel_key)),
         'audience', jsonb_build_object('who', 'читачі каналу «' || COALESCE(t.title, t.channel_key) || '»'),
         'language', 'uk',
         'goals', jsonb_build_array('growth', 'engagement'),
         'taboo', '[]'::jsonb, 'sources', '[]'::jsonb, 'examples', '[]'::jsonb,
         'ads_allowed', jsonb_build_object('allowed', true, 'categories', '[]'::jsonb),
         'notes', 'Стартовий профіль із dev-сіду — уточніть у чаті з @ai0 або на сторінці агента.'),
       'owner'
  FROM tracked_channels t
 WHERE t.is_mine AND t.channel_key IS NOT NULL AND t.channel_key <> ''
ON CONFLICT (resource_ref) DO NOTHING;
