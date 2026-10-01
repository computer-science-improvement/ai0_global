# Postgres backup & restore runbook

Nightly logical backups of the `ai0global` database via the compose `backup`
profile (spec 001, FR-014). Paths below assume the box checkout at
`/opt/ai0_global`.

---

## What runs

`docker-compose.yml` → service `backup` (profile `backup`, image `postgres:16-alpine`):

- once every 24h: `pg_dump --no-owner --no-privileges | gzip` →
  `./backups/postgres/ai0-YYYY-MM-DD.sql.gz` (written to `.tmp` first, renamed on success)
- then deletes everything but the **14 newest** dumps
- a failed `pg_dump` logs `[backup] pg_dump FAILED` and leaves the previous dumps untouched

The first dump is taken as soon as the container starts. `backups/` is gitignored,
so `git reset --hard` during a release never touches it.

### Enable (one-time, on the box)

```bash
cd /opt/ai0_global
mkdir -p backups/postgres
docker compose --profile prod --profile backup up -d backup
docker compose logs --tail=20 backup          # expect: [backup] wrote /backups/ai0-…sql.gz (…)
ls -lh backups/postgres/
```

The release workflow only touches `automation` and `dashboard`, so the sidecar
keeps running across releases. After a box reboot `restart: unless-stopped`
brings it back.

### Take an extra dump right now

```bash
docker compose --profile backup exec backup \
  sh -c 'pg_dump --no-owner --no-privileges | gzip > /backups/ai0-manual-$(date +%F-%H%M).sql.gz'
```

(`ai0-manual-*` files also count toward the 14-file rotation.)

---

## Off-box copy (REQUIRED — on-box dumps die with the droplet)

The sidecar only protects against bad data / bad migrations, not against losing
the box. Pull the dumps somewhere else at least weekly. From your own machine:

```bash
rsync -av --ignore-existing root@$DO_HOST:/opt/ai0_global/backups/postgres/ ~/ai0-backups/
```

or, on the box, push to object storage (example: DigitalOcean Spaces via `s3cmd`):

```bash
# crontab -e   (runs 30 min after a typical dump)
30 4 * * * s3cmd sync --no-delete-removed /opt/ai0_global/backups/postgres/ s3://<bucket>/ai0-postgres/
```

Check a dump is readable before trusting it:

```bash
gunzip -t backups/postgres/ai0-2026-10-01.sql.gz && echo OK
zcat backups/postgres/ai0-2026-10-01.sql.gz | head -20     # starts with "-- PostgreSQL database dump"
```

---

## Restore

Dumps are plain SQL without owners/grants, so they restore into any role.

### A. Into a scratch database (verify / cherry-pick rows — safe)

```bash
docker compose exec -T postgres createdb -U ai0 ai0_restore
zcat backups/postgres/ai0-2026-10-01.sql.gz | \
  docker compose exec -T postgres psql -U ai0 -d ai0_restore -v ON_ERROR_STOP=1
docker compose exec postgres psql -U ai0 -d ai0_restore -c \
  "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;"
# … inspect / copy what you need, then:
docker compose exec -T postgres dropdb -U ai0 ai0_restore
```

### B. Replace the live database (disaster recovery — destructive)

Stop every writer first, keep a dump of the current state, then swap.

```bash
cd /opt/ai0_global
docker compose --profile prod stop automation dashboard
docker compose --profile backup stop backup

# safety copy of whatever is there now
docker compose exec -T postgres pg_dump -U ai0 --no-owner --no-privileges ai0global \
  | gzip > backups/postgres/pre-restore-$(date +%F-%H%M).sql.gz

docker compose exec -T postgres dropdb   -U ai0 ai0global
docker compose exec -T postgres createdb -U ai0 ai0global
zcat backups/postgres/ai0-2026-10-01.sql.gz | \
  docker compose exec -T postgres psql -U ai0 -d ai0global -v ON_ERROR_STOP=1

bash database/migrate.sh          # re-apply any migrations newer than the dump
docker compose --profile prod up -d automation dashboard
docker compose --profile backup up -d backup
```

Then verify: dashboard loads, `schema_migrations` shows the expected latest
version, and `docker compose logs --tail=50 automation` has no DB errors.

Notes:
- Use the `POSTGRES_USER` / `POSTGRES_DB` from `.env` if they differ from `ai0` / `ai0global`.
- Redis holds only BullMQ queues and caches — it is not backed up and does not need to be.
