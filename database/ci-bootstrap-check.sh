#!/usr/bin/env bash
#
# Fresh-database bootstrap check (spec 007 T004). Used by CI (ci-feature.yml →
# job `schema-bootstrap`) and runnable locally against a THROWAWAY Postgres:
#
#     PGHOST=localhost PGPORT=5432 PGUSER=ai0 PGPASSWORD=… PGDATABASE=ai0_ci \
#       bash database/ci-bootstrap-check.sh
#
# 1. applies database/init.sql twice (it must be idempotent),
# 2. applies every database/migrations/*.sql in lexical order, each in a single
#    transaction with ON_ERROR_STOP, recording its version like migrate.sh does,
# 3. re-applies the migrations listed in REAPPLY (default: every migration from
#    042 onward, which the constitution requires to be idempotent) and fails if
#    any of them errors the second time.
#
# Connection comes from the standard libpq PG* env vars. Never point it at a
# database you care about: it creates the full schema in whatever it connects to.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

# Hide the "already exists, skipping" NOTICE noise; warnings and errors still show.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

run() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "bootstrap: init.sql (1st pass)"
run -1 -f database/init.sql
echo "bootstrap: init.sql (2nd pass — idempotency)"
run -1 -f database/init.sql

run -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64) PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);"

shopt -s nullglob
files=(database/migrations/*.sql)
[ "${#files[@]}" -gt 0 ] || { echo "bootstrap: no migrations found" >&2; exit 1; }

for f in "${files[@]}"; do
  v="$(basename "$f" .sql)"
  echo "bootstrap: apply   $v"
  run -1 -f "$f"
  run -c "INSERT INTO schema_migrations (version) VALUES ('${v}') ON CONFLICT (version) DO NOTHING;"
done

# Migrations that must survive a second application unchanged. Older ones are
# only ever applied once by the ledger (e.g. 020 adds a named CHECK without a
# guard), so they are not re-run here.
REAPPLY_FROM="${REAPPLY_FROM:-042}"
for f in "${files[@]}"; do
  v="$(basename "$f" .sql)"
  [[ "$v" < "$REAPPLY_FROM" ]] && continue
  echo "bootstrap: reapply $v (idempotency)"
  run -1 -f "$f"
done

count="$(psql -X -tAc "SELECT count(*) FROM schema_migrations")"
echo "bootstrap: OK — ${#files[@]} migration files applied, schema_migrations has ${count} rows"
