# Production release runbook

How a release reaches the **prod** DigitalOcean droplet, the one-time setup the
box needs, and the gotchas (most discovered the hard way on dev-stage).

Prod is touched **only** by `.github/workflows/release-prod.yml`, which fires on
a semver tag (`v*.*.*`) whose commit is reachable from `main`. Untagged pushes
to `main` run `snapshot-main.yml` (build-only canary, no deploy).

---

## Release flow (what the tag triggers)

```
git tag v1.2.3 (on a main commit) → push
  └─ verify-tag   — refuses if the commit isn't on main
  └─ build        — builds + pushes BOTH images, versioned + :latest
                      ghcr.io/<owner>/ai0_global-automation:v1.2.3 (+ :latest)
                      ghcr.io/<owner>/ai0_global-dashboard:v1.2.3  (+ :latest)
  └─ deploy (SSH to DO_HOST as root)
        git fetch --tags / checkout main / reset --hard
        docker login ghcr.io
        bash database/migrate.sh                    # auto-applies pending migrations
        export AUTOMATION_IMAGE/DASHBOARD_IMAGE = …:v1.2.3   # pinned, immutable
        docker compose --profile prod pull automation dashboard
        docker compose --profile prod up -d automation dashboard
        docker compose --profile prod restart automation
```

Migrations run **before** the new image starts (`set -e` aborts the release on a
bad migration rather than booting against a half-migrated DB). Prod is pinned to
the exact `:v1.2.3` tag, not `:latest` — immutable, trivially rollback-able.

---

## One-time prod-box prerequisites

These mirror what bit us on dev. Do them once on the prod droplet (`DO_HOST`).

### 1. git can read the repo (box → GitHub)
The deploy runs `git fetch` **on the box**. The `DO_SSH_KEY` secret only lets CI
SSH *into* the box — it does nothing for box→GitHub. The box needs its own
read-only **deploy key**:

```bash
git config --global --add safe.directory /opt/ai0_global   # if "dubious ownership"
ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N "" -C "ai0-prod-box"
cat /root/.ssh/github_deploy.pub        # → GitHub repo → Settings → Deploy keys (read-only)
printf 'Host github.com\n  IdentityFile /root/.ssh/github_deploy\n  IdentitiesOnly yes\n' >> /root/.ssh/config
chmod 600 /root/.ssh/config
ssh -T git@github.com                   # must greet with the repo name
git -C /opt/ai0_global remote -v        # confirm origin is git@github.com:… (SSH)
```

### 2. Postgres running, schema present
The deploy assumes Postgres is up. `migrate.sh` does `docker compose up -d
postgres` and waits, then applies `database/migrations/*.sql`. On a long-lived
prod box the schema may predate the migration ledger — that's fine, migrations
are idempotent (`IF NOT EXISTS` + `ON CONFLICT DO NOTHING`) and self-record.

### 3. GitHub repo Secrets / Variables
| Kind | Name | Value |
|---|---|---|
| Secret | `DO_HOST` / `DO_USER` / `DO_SSH_KEY` | prod droplet IP / `root` / CI's SSH private key |
| Secret | `GH_PAT` (optional) | fine-grained PAT, `packages:read` (falls back to GITHUB_TOKEN) |
| **Variable** | `VITE_AUTH_MODE` | `token` — **required**, see §5 |
| Variable | `VITE_TG_BOT_USERNAME` | only if using Telegram login |

`VITE_*` are read from Variables **or** Secrets (the workflow falls back), and are
**baked into the dashboard bundle at build time** — they are NOT runtime env.

---

## Prod `.env` (`/opt/ai0_global/.env`)

```ini
NODE_ENV=production            # ChannelConfigService refuses any other value here
# AUTOMATION_IMAGE / DASHBOARD_IMAGE — NOT needed; the release sets them inline (:v1.2.3)

# Postgres (inside the compose network)
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=ai0global
POSTGRES_USER=ai0
POSTGRES_PASSWORD=<prod-password>

# Dashboard / API auth — REQUIRED in prod (no dev-bypass)
TRACKING_TOKEN=<openssl rand -hex 32>   # the token you paste to log in; also gates the API

# Telegram
TELEGRAM_BOT_TOKEN=<prod bot>
TELEGRAM_OWNER_ID=<your numeric id>
TELEGRAM_API_ID=<my.telegram.org>
TELEGRAM_API_HASH=<my.telegram.org>
TELEGRAM_SESSION_STRING=<single unbroken line>          # publisher/stats session
TELEGRAM_TRACKING_SESSION_STRING=<single line>          # tracker session (or share via TELEGRAM_TRACKING_SHARE_SESSION=true)

# AI
ANTHROPIC_API_KEY=sk-ant-...
REDIS_URL=redis://redis:6379
```

Generate session strings with `apps/automation/scripts/generate-telegram-session.ts`
(see the dev runbook §5). Keep each on **one line** — verify length:
```bash
awk -F= '/^TELEGRAM_SESSION_STRING=/{print length($2)" chars"}' /opt/ai0_global/.env   # expect 300+
```

---

## 5. Auth + HTTPS — the two prod-only traps

1. **`VITE_AUTH_MODE` must be set before the release build.** If it's empty, the
   dashboard ships the **dev-bypass** build — a public, unauthenticated UI that can
   control bots/strategies. Set the repo Variable to `token` (or
   `VITE_TG_BOT_USERNAME` for Telegram login).

2. **Prod cookies are `Secure` → the dashboard MUST be served over HTTPS.** The
   auth cookie is set with `secure: NODE_ENV==='production'`, so a browser will
   **silently drop it over plain `http://`** — login appears to do nothing. Put the
   dashboard behind HTTPS. If the box already runs Caddy:

   ```caddyfile
   dash.yourdomain.com {
       reverse_proxy localhost:8080
   }
   ```
   Caddy auto-provisions the Let's Encrypt cert. With a real HTTPS domain you can
   also enable Telegram login (BotFather `/setdomain` + `VITE_TG_BOT_USERNAME`).

   Do **not** rely on `http://<ip>:8080` for prod login — it won't keep you signed in.

---

## Cutting a release

```bash
git checkout main && git pull
git tag v1.2.3            # semver; must be a commit already merged to main
git push origin v1.2.3
```
Watch **Actions → Release → production**. `verify-tag` blocks tags not on `main`.

### Verify on the box
```bash
docker compose --profile prod ps                       # automation + dashboard + postgres + redis Up
docker compose --profile prod logs --tail=40 automation | grep -i NODE_ENV   # =production
curl -I https://dash.yourdomain.com                    # 200
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT version FROM schema_migrations ORDER BY version;"   # confirm migrations applied
```

### Rollback
Re-deploy a prior version by pushing the old tag's pinned image, or set
`AUTOMATION_IMAGE`/`DASHBOARD_IMAGE` to the previous `:vX.Y.Z` on the box and
`docker compose --profile prod up -d`. Migrations are forward-only — a rollback
of code does not roll back schema (additive migrations are backward-compatible;
avoid destructive ones, or use expand→contract).

---

## ⚠️ Cost / safety

A prod deploy starts the scheduler — strategies fire on cron and call the Claude
API (real cost) and publish to the **production** channels. Before releasing,
confirm which strategies are enabled (they live in the DB now — manage on the
Strategies page), and that channels point at the right (prod) bots.

---

## Troubleshooting (all seen on dev)

| Symptom | Cause / fix |
|---|---|
| `fatal: detected dubious ownership` | `git config --global --add safe.directory /opt/ai0_global` |
| `git@github.com: Permission denied (publickey)` | box has no deploy key — do §1 |
| `error from registry: unauthorized` (pull) | not logged into GHCR — `docker login ghcr.io` (CI does this itself) |
| `manifest unknown` on dashboard pull | image tag missing — the release sets `*_IMAGE` inline; check the build job actually pushed |
| deploy green but no fresh containers | you're on the wrong box (check `curl -s ifconfig.me` vs `DO_HOST`) |
| bot silent, scheduler never fires, last log `Running gramJS version …` | bad/missing `TELEGRAM_SESSION_STRING` — regenerate (dev runbook §5) |
| dashboard loads but login does nothing | served over `http://` with `Secure` cookie — put it behind HTTPS (§5) |
| dashboard shows "Continue in dev mode" | `VITE_AUTH_MODE` wasn't set at build time — set the repo Variable, re-release |

---

## Related

- Dev-stage setup + shared details (session generation, log locations): `dev-stage-server-setup.md`
- Auto-migration runner: `database/migrate.sh`
