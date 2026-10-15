-- Down of 073_story_registry.sql (spec 037 T2). Not applied by migrate.sh (it only reads database/migrations/*.sql);
-- run by hand to roll the registry back. The 'repost' rows of published_posts stay (they are real forwards).

DROP TABLE IF EXISTS editor_story_posts;
DROP TABLE IF EXISTS editor_stories;
DELETE FROM schema_migrations WHERE version = '073_story_registry';
