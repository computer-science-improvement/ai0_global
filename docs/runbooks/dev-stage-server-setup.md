# Dev-stage server: provisioning from scratch

End-to-end runbook for bringing up a fresh `dev-stage` DigitalOcean droplet that
receives auto-deploys on every push to `develop`. Captures everything we
actually hit setting up the current dev box — including the gotchas.

After completing this runbook, the server runs the automation service against
its own isolated Postgres, posting to a dedicated **test** Telegram channel via
a **separate** bot — no risk of touching production `@ai0_global`.

The prod box on `DO_*` secrets is **not** affected; it remains the only target
of `release-prod.yml` (tag-triggered deploys from `main`).

---

## Architecture recap

| Env | Trigger | Image tag | GitHub secrets | Server `.env` `NODE_ENV` |
|---|---|---|---|---|
| Production | `git push v*.*.*` from `main` | `:latest` | `DO_HOST`, `DO_USER`, `DO_SSH_KEY` | `production` |
| Dev-stage  | any push to `develop`         | `:dev-latest` | `DEV_HOST`, `DEV_USER`, `DEV_SSH_KEY` | `dev-stage` |
| Local      | `pnpm dev:automation`         | n/a (source) | n/a | `local-development` |

The `ChannelConfigService` refuses to boot on any other `NODE_ENV` value, and
each env loads a different `channels-*.json`.

---

## Prerequisites

- A DigitalOcean account
- Ability to push secrets to the GitHub repo (admin / write)
- A second Telegram bot (created via @BotFather) — separate from prod
- A **private** Telegram test channel where the dev bot is admin with
  `Post Messages` permission
- Your own Telegram numeric user ID (DM `@userinfobot` to get it)
- A valid `ANTHROPIC_API_KEY` (and any other AI keys you want active)
- Telegram MTProto credentials for stats: `API_ID`, `API_HASH`, and a freshly
  generated `SESSION_STRING` (see step 5)

---

## 1. Create the droplet

DigitalOcean UI → Create Droplet:

- **Image**: Ubuntu 24.04 LTS
- **Region**: same as prod
- **Size**: `s-1vcpu-2gb` works with a 2 GB swapfile; `s-2vcpu-2gb` is
  comfortable
- **Authentication**: SSH key (your personal key — this is for human admin
  access)
- **Hostname**: `ai0-dev-stage` (or similar)

SSH in as `root` once it's up.

---

## 2. Add swap (only needed on 1vcpu-2gb)

Image pulls and the Node build can spike past 2 GB RAM. Without swap, the box
will OOM mid-deploy.

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

Expect `Swap: 2.0Gi` in the output.

---

## 3. Install Docker (official repo, not `docker.io`)

Ubuntu's default `docker.io` package is missing the Compose v2 plugin and is
typically several versions behind. Use Docker's official APT repo instead.

```bash
# Strip any older docker that might be lying around
apt-get remove -y docker.io docker-doc docker-compose podman-docker containerd runc 2>/dev/null || true

apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git

# If the kernel got upgraded during apt: reboot once, then continue.
# Otherwise docker.service can fail to start on stale containerd state.
reboot
```

After reconnect:

```bash
systemctl enable --now docker
docker --version
docker compose version
docker run --rm hello-world
```

`docker compose version` must print **v2.x.x** — if it prints "unknown command",
the official repo install didn't take.

---

## 4. SSH key for GitHub Actions

The deploy workflow needs a **dedicated** keypair — never reuse your personal
key.

On the droplet:

```bash
ssh-keygen -t ed25519 -C "github-actions-dev-stage" -f ~/.ssh/gha_dev_stage -N ""
cat ~/.ssh/gha_dev_stage.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Print the PRIVATE key — copy the entire block (BEGIN to END line)
cat ~/.ssh/gha_dev_stage
```

Get the droplet's public IP:

```bash
curl -s ifconfig.me; echo
```

### Register three GitHub secrets

Open `Settings → Secrets and variables → Actions → New repository secret` on
the repo (or use `gh secret set` locally):

| Name | Value |
|---|---|
| `DEV_HOST`    | the droplet IP |
| `DEV_USER`    | `root` |
| `DEV_SSH_KEY` | the entire private key including `-----BEGIN/END OPENSSH PRIVATE KEY-----` |

Verify locally:

```bash
gh secret list
# Expect DEV_HOST, DEV_USER, DEV_SSH_KEY (and DO_HOST/DO_USER/DO_SSH_KEY for prod)
```

---

## 5. Generate a Telegram MTProto session string

The `StatsModule` initializes a gramJS MTProto client during `onModuleInit`.
If `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION_STRING` are
missing or invalid, **the entire Nest boot hangs** at that step, blocking the
admin bot and the scheduler. (We hit this — symptom: last log line is
`[Running gramJS version 2.26.21]`, no further output.)

On your **laptop** (not the server):

```bash
cd /path/to/ai0_global/apps/automation
npx ts-node scripts/generate-telegram-session.ts
# Enter your phone, the SMS code, optional 2FA password
# Copy the resulting session string — a single ~350+ char line
```

Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from
<https://my.telegram.org> → API development tools.

**Critical:** the session string MUST end up on a single unbroken line in
`.env`. Soft-wrap in nano can silently truncate it on save — verify with:

```bash
awk -F= '/^TELEGRAM_SESSION_STRING=/ {print length($2)" chars"}' /opt/ai0_global/.env
```

Expect 300+ chars. If it shows ~60, you got line-wrapped — re-paste.

---

## 6. Clone the repo and seed `.env`

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/computer-science-improvement/ai0_global.git
cd ai0_global
git checkout develop
```

If the repo is private, embed a PAT (classic, scope `repo`) or use HTTPS with
the `gh` CLI authenticated.

Create `/opt/ai0_global/.env` — start by copying `.env.example` and fill in
every value. The two most-commonly-missed lines:

```ini
NODE_ENV=dev-stage
AUTOMATION_IMAGE=ghcr.io/computer-science-improvement/ai0_global-automation:dev-latest
```

If `NODE_ENV` is omitted, compose's default in `docker-compose.yml` is
`production`, and you'll silently boot prod config on a dev box. If
`AUTOMATION_IMAGE` is omitted, it falls back to `:latest` (the prod-tagged
image), defeating env separation.

### Full `.env` checklist for dev-stage

```ini
# Core
NODE_ENV=dev-stage
AUTOMATION_IMAGE=ghcr.io/computer-science-improvement/ai0_global-automation:dev-latest
AUTOMATION_PORT=3001

# Postgres — INSIDE compose network, not localhost
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=ai0global
POSTGRES_USER=ai0
POSTGRES_PASSWORD=<fresh-dev-password>   # do NOT reuse prod

# Secrets-at-rest — REQUIRED. Every connection you add (MTProto session, bot,
# Meta / Telegraph / TikTok token) is encrypted before storage. If this is
# unset/empty, saving any of them returns 503 "TOKEN_ENCRYPTION_KEY is not set"
# (previously an opaque 500). Generate ONCE with `openssl rand -base64 32` and
# NEVER change it afterwards — rotating the key makes every already-stored
# secret undecryptable. Back it up alongside the DB password.
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>

# Telegram bot — DEDICATED dev bot from @BotFather
TELEGRAM_BOT_TOKEN=<dev-bot-token>
TELEGRAM_OWNER_ID=<your-numeric-telegram-id>   # gates the admin bot commands

# Telegram MTProto (stats) — see step 5
TELEGRAM_API_ID=<from my.telegram.org>
TELEGRAM_API_HASH=<from my.telegram.org>
TELEGRAM_SESSION_STRING=<single unbroken line, 300+ chars>

# AI agents — must be valid keys (Claude key is hot path; an invalid one
# silently kills every strategy at the AI step)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=          # optional; agent disables itself when blank
PERPLEXITY_API_KEY=
GROK_API_KEY=

# Meta APIs — only if you want dev to test those publishers
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_ACCOUNT_ID=
THREADS_ACCESS_TOKEN=
THREADS_USER_ID=
FACEBOOK_ACCESS_TOKEN=
FACEBOOK_PAGE_ID=
```

Sanity check after editing:

```bash
grep -E '^(NODE_ENV|AUTOMATION_IMAGE|POSTGRES_HOST|TOKEN_ENCRYPTION_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_OWNER_ID|ANTHROPIC_API_KEY)=' /opt/ai0_global/.env
```

Every line must be present with a non-empty value.

---

## 7. Authenticate to GHCR

The `:dev-latest` image is private to the GHCR registry; the deploy workflow
authenticates per-run, but the first manual pull (and `docker compose up`)
needs an interactive login.

Create a GitHub PAT (classic) with `read:packages` scope, then:

```bash
echo "<your-PAT>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

Expect `Login Succeeded`.

---

## 8. Start Postgres (one-time)

The deploy workflow only manages `automation` — it assumes Postgres is already
running on the box. Bring it up manually once:

```bash
cd /opt/ai0_global
docker compose up -d postgres
docker compose ps     # postgres should reach (healthy) within ~10s
```

The init script at `database/init.sql` runs automatically on first boot,
creating all 19 tables. Verify:

```bash
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT count(*) FROM information_schema.tables WHERE table_schema='public';
"
# Expect 19
```

---

## 9. Trigger the first deploy

From your **laptop**, push any commit to `develop`. The empty-commit pattern
works without code changes:

```bash
git checkout develop && git pull
git commit --allow-empty -m "ci: bootstrap dev-stage server"
git push origin develop
```

Watch the workflow:

- Browser: `https://github.com/<org>/<repo>/actions/workflows/deploy-dev.yml`
- CLI: `gh run watch`

The workflow builds the image, pushes `:dev-latest` to GHCR, then SSHes into
the dev box and runs:

```text
git fetch / reset --hard
docker login ghcr.io
docker compose --profile prod pull automation
docker compose --profile prod up -d automation
docker compose --profile prod restart automation
docker image prune -f
```

When it's green, on the dev box:

```bash
docker compose logs --tail=80 automation | grep -i 'NODE_ENV'
```

Expect `[ChannelConfigService] info: Config: channels-dev.json (NODE_ENV=dev-stage)`.

If you instead see `(NODE_ENV=production)`, your `.env` is missing `NODE_ENV` —
fix it and redeploy.

---

## 10. Seed the database

The schema exists but every source table is empty. Run the pipeline loaders:

```bash
cd /opt/ai0_global
docker compose --profile pipeline run --rm pipeline pnpm run load:all
```

`db:seed` would also run `init-db` first, but the pipeline image doesn't
include `database/init.sql`, so it errors. The schema already exists from
step 8 — `load:all` alone is enough.

Verify:

```bash
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT 'assets'        AS t, count(*) FROM assets
  UNION ALL SELECT 'prompts',       count(*) FROM prompts
  UNION ALL SELECT 'on_this_day',   count(*) FROM on_this_day
  UNION ALL SELECT 'recipes',       count(*) FROM recipes
  UNION ALL SELECT 'facts',         count(*) FROM facts
  UNION ALL SELECT 'pdr_questions', count(*) FROM pdr_questions
  UNION ALL SELECT 'tg_posts',      count(*) FROM tg_posts
  ORDER BY t;
"
```

Each table should be non-zero (recipes may be small — that's expected).

Strategies for `quotes` / `jokes` / `articles` won't fire unless those tables
are populated by separate loaders or external imports.

### 10a. Backfill the `tg_posts` table (only on pre-existing DBs)

The `tg_posts` table was added to `database/init.sql` after some boxes were
already seeded. Postgres's `CREATE TABLE IF NOT EXISTS` only protects against
re-running the DDL on a clean DB — it does NOT add the table to a box that
was initialised before the block existed. Fresh droplets (step 8) will get
it automatically; existing boxes need a one-time manual catch-up.

Detect the gap first:

```bash
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c "\dt tg_posts"
```

If the response is `Did not find any relation named "tg_posts"`, apply the
DDL block (idempotent — safe to run even if you're unsure):

```bash
docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global <<'SQL'
create table if not exists tg_posts (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,
  source_url   text not null,
  title        text not null,
  image_url    text,
  post         text not null,
  content_hash text not null,
  author             text,
  source_published_at timestamptz,
  tags         text[] not null default '{}',
  posted       jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create unique index if not exists idx_tg_posts_content_hash on tg_posts (content_hash);
create index if not exists idx_tg_posts_source             on tg_posts (source);
create index if not exists idx_tg_posts_posted             on tg_posts using gin (posted);
SQL
```

Then load the three pre-adapted Ukrainian content pools (motivation /
self-development / biographies) — `load:tg-posts` is the standalone loader
called by `load:all`, but it can be run on its own when only this table is
empty:

```bash
docker compose --profile pipeline run --rm pipeline pnpm run load:tg-posts
```

Expected output:

```
motivation-posts.json: 68 posts
  inserted: 68, skipped: 0
samorozvytok-posts.json: 117 posts
  inserted: 117, skipped: 0
biography-posts.json: 1848 posts
  inserted: 1848, skipped: 0
Total inserted: 2033
```

Final sanity check:

```bash
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT source, count(*) FROM tg_posts GROUP BY source ORDER BY count DESC;
"
```

Optional — strip 1 known-bad placeholder row from the samorozvytok pool that
the AI adapter left behind when its source HTML was empty:

```bash
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  DELETE FROM tg_posts
  WHERE source='samorozvytok-motivatory'
    AND (post ILIKE '%текст статті порожній%' OR post ILIKE '%встав текст статті%');
"
```

Notes:
- The `birthdays-db` pool inside `tg_posts` duplicates the dedicated
  `birthdays` table. Do NOT bind a strategy to it — the `birthday-strategy`
  type already covers biographies through `birthdays` with proper
  "today's date" filtering.
- The loader uses `idx_tg_posts_content_hash` for upsert dedup, so re-running
  is always safe.

---

## 11. Set up the dev bot in Telegram

Three things must be true:

1. **The bot is dedicated to dev.** Create a new bot via `@BotFather` (e.g.
   `@ai0_global_test_bot`). Reuse-of-prod-token is the most common cause of
   dev accidentally posting to `@ai0_global`.

2. **`TELEGRAM_OWNER_ID` in `.env` matches your own user ID.** Without this,
   the `AdminBotService` silently rejects every command:

   ```bash
   grep '^TELEGRAM_OWNER_ID=' /opt/ai0_global/.env
   ```

   Verify your ID by DMing `@userinfobot` from the same account.

3. **The dev bot is an admin in the dev channel with `Post Messages`.**
   Get the channel IDs from `apps/automation/config/channels-dev.json`, then
   for each one:

   ```bash
   TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /opt/ai0_global/.env | cut -d= -f2-)
   curl -s "https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=@your_dev_channel&user_id=<bot-user-id>"
   ```

   Expect `"status":"administrator"` with `"can_post_messages": true`.

---

## 12. End-to-end smoke test

In Telegram, DM the dev bot from the owner account:

- `/help` → help text reply
- `/list` → all strategies → channel bindings from `channels-dev.json`
- `/run` → inline keyboard, pick channel → pick strategy → it publishes

If `/run` returns "завершено без публікації", check the structured logs for
why — see the "Logs" section below.

---

## 13. Routine operations

### Redeploying after a code or `.env` change

Code change: just `git push origin develop`. The workflow rebuilds and ships.

`.env` change on the server: needs a redeploy because compose only recreates
the container when something changes. Easiest is an empty commit to `develop`:

```bash
git commit --allow-empty -m "ci: redeploy after env edit"
git push origin develop
```

### Watching logs

Container stdout:

```bash
docker compose logs --tail=200 -f automation
```

Structured Winston logs (what the admin bot's `/run` summary reads):

```bash
tail -f /opt/ai0_global/logs/automation/combined-$(date +%Y-%m-%d).log \
  | jq -rc 'select(.category | IN("ai_request","ai_response","publication","error","rss","db")) | "\(.timestamp)  \(.category)  \(.level)  \(.message)  \(.data.error // "")"'
```

Errors only:

```bash
tail -f /opt/ai0_global/logs/automation/error-$(date +%Y-%m-%d).log
```

### Clearing dedup state to retest

When testing the same strategy repeatedly, posted-URL dedup will quickly
exhaust candidates. Wipe the tracking tables:

```bash
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  TRUNCATE posted_news, published_posts RESTART IDENTITY CASCADE;
"
```

`CASCADE` is required because `post_stats_snapshots` and
`channel_stats_snapshots` reference `published_posts`.

For non-news strategies (recipes/quotes/prompts/etc.) the posted state lives
on the source row itself — clear with:

```bash
docker exec -it ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  UPDATE recipes SET posted_at = NULL WHERE posted_at IS NOT NULL;
"
```

Column name varies; use `\d <table>` in psql to confirm.

---

## Troubleshooting — things that bit us

### Symptom: deploy is green but container runs prod config

Check on the server:

```bash
grep -E '^(NODE_ENV|AUTOMATION_IMAGE)=' /opt/ai0_global/.env
docker inspect ai0_global-automation-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(NODE_ENV|AUTOMATION_IMAGE)='
```

If `.env` is missing either var, compose falls back to the defaults in
`docker-compose.yml` (`production` / `:latest`). Add the missing lines,
redeploy.

### Symptom: bot doesn't respond to commands, scheduler never fires

Most likely the MTProto session string is missing/invalid and Nest is hanging
at gramJS init. Check the last log line:

```bash
docker compose logs automation | tail -5
```

If the final line is `[Running gramJS version 2.26.21]` with nothing after,
the stats module is blocking. Fix the session string (step 5) and redeploy.

Also confirm:

```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /opt/ai0_global/.env | cut -d= -f2-)
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
```

`pending_update_count` growing across two calls 10s apart = nothing is
draining updates = admin bot isn't running.

### Symptom: strategy runs but no publish, no error

Look at the structured log around the run timestamp without filtering by
channel:

```bash
awk -v ts="$(date +%Y-%m-%dT%H:%M | sed 's/.$//')" '$0 ~ ts' \
  /opt/ai0_global/logs/automation/combined-$(date +%Y-%m-%d).log \
  | jq -c '{ts:.timestamp, cat:.category, msg:.message, error:.data.error}' \
  | tail -50
```

Common findings:

- `category: ai_response, error: "401 ... invalid x-api-key"` → bad
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- `category: publication, status: failure, error: "chat not found"` → bot is
  not in the channel as admin
- `category: publication, status: blocked, error: "throttle"` → recent post
  cooldown; wait it out or clear the throttle

### Symptom: `docker compose --profile pipeline ... db:seed` fails with `ENOENT init.sql`

The pipeline Dockerfile doesn't `COPY database/`. Skip `init-db` (schema is
already created by the postgres init mount):

```bash
docker compose --profile pipeline run --rm pipeline pnpm run load:all
```

### Symptom: `apt-get install docker-compose-plugin` says "Unable to locate package"

You're trying to install from Ubuntu's default repo. Use Docker's official
repo — see step 3.

### Symptom: `systemctl start docker` fails on a fresh install

A kernel upgrade landed during `apt-get install`. Reboot and start docker
again.

---

## Related docs

- Production release runbook: `prod-release.md`
- Application architecture: `apps/automation/README.md` (TODO)
- Channel config schema: see `apps/automation/config/channels-dev.json`
