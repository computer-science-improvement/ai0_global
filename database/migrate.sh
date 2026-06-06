#!/usr/bin/env bash
#
# Apply pending SQL migrations from database/migrations/ in lexical order.
#
# Forward-only, fail-fast, and safe to re-run. Each file is applied in a single
# transaction; the version (filename without .sql) is recorded in the
# schema_migrations table so it's skipped on the next run. Files 001–003 don't
# self-record their version, so the runner records every applied file itself.
#
# psql runs INSIDE the compose `postgres` service (trust auth there), so no DB
# password handling is needed. Run from anywhere — the script cd's to the repo
# root, where docker-compose.yml lives. Intended to run on the deploy host
# BEFORE (re)starting the automation container, and usable locally too:
#
#     bash database/migrate.sh        # or: pnpm db:migrate
#
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root (database/.. )

PGUSER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2- || true)"
PGDB="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2- || true)"
PGUSER="${PGUSER:-ai0}"
PGDB="${PGDB:-ai0global}"

# Make sure Postgres is up (a deploy may have just (re)created it).
docker compose up -d postgres >/dev/null 2>&1 || true

echo "migrate: waiting for postgres ($PGDB as $PGUSER)…"
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1; then
    break
  fi
  [ "$i" = 30 ] && { echo "migrate: postgres never became ready" >&2; exit 1; }
  sleep 2
done

psql() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"; }

# Ledger table (idempotent; matches 001_stats.sql's definition).
psql -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64) PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);"

shopt -s nullglob
applied=0; skipped=0
for f in database/migrations/*.sql; do
  v="$(basename "$f" .sql)"
  exists="$(psql -tAc "SELECT 1 FROM schema_migrations WHERE version = '${v}'" | tr -d '[:space:]')"
  if [ "$exists" = "1" ]; then
    echo "  skip   $v"
    skipped=$((skipped + 1))
    continue
  fi
  echo "  apply  $v"
  psql -1 -f - < "$f"
  # Record the version ourselves — 001–003 don't, and re-recording 004+ is a
  # harmless no-op thanks to ON CONFLICT.
  psql -q -c "INSERT INTO schema_migrations (version) VALUES ('${v}') ON CONFLICT (version) DO NOTHING;"
  applied=$((applied + 1))
done

echo "migrate: done — applied=${applied} skipped=${skipped}"
