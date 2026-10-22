-- Down for 093_series_pauses.sql (spec 060). The pauses are dropped: the planner plans every series again.
DROP TABLE IF EXISTS series_pauses;
DELETE FROM schema_migrations WHERE version = '093_series_pauses';
