#!/usr/bin/env bash
#
# Everything needed to look at the server from a laptop, in one .tar.gz: the latest container logs, an errors-only
# digest, container status and resources, the deployed revision, applied migrations, the health check and the
# agents' state for the window (runs by status, failed runs, slots, drafts, publishes, AI spend). With --full it
# also adds the agent history export (scripts/export-agent-history.sh). Read-only: SELECTs and `docker … logs/ps`.
# Anything that looks like a key or token is masked before packing; .env is never read except for the DB name/user.
#
# Run on the deploy host from the repo root (/opt/ai0_global):
#
#     bash scripts/server-snapshot.sh            # last 24 hours
#     bash scripts/server-snapshot.sh 6          # last 6 hours
#     bash scripts/server-snapshot.sh 48 --full  # + agent history export for the same days
#
# Or from a laptop without checking this branch out on the server: scripts/pull-server-snapshot.sh copies this file over
# ssh and downloads the archive. The archive holds post texts and log lines: keep it out of git.
#
set -uo pipefail
# Streamed over ssh ($0 = bash) it runs where it was started; as a file it runs from the repo root.
[ -f docker-compose.yml ] || cd "$(dirname "$0")/.." 2>/dev/null
[ -f docker-compose.yml ] || cd /opt/ai0_global 2>/dev/null
[ -f docker-compose.yml ] || { echo "run from the repo root (docker-compose.yml not found)" >&2; exit 2; }

HOURS="${1:-24}"
FULL="${2:-}"
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "usage: $0 [hours] [--full]" >&2; exit 2; }

PGUSER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2- || true)"
PGDB="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2- || true)"
PGUSER="${PGUSER:-ai0}"
PGDB="${PGDB:-ai0global}"
dc() { docker compose --profile prod "$@"; }
# </dev/null everywhere docker exec runs: streamed over ssh (bash -s) this script IS stdin, and exec would eat it.
psql() { dc exec -T postgres psql -X -U "$PGUSER" -d "$PGDB" -P pager=off -P footer=off "$@" </dev/null; }
# Testing against a throwaway database instead of the compose one.
if [ -n "${SNAPSHOT_PG_URL:-}" ]; then
  psql() { command psql -X "$SNAPSHOT_PG_URL" -P pager=off -P footer=off "$@"; }
  export REPORT_PG_URL="$SNAPSHOT_PG_URL"
fi
W="now() - interval '$HOURS hours'"

STAMP="$(date -u +%Y%m%d-%H%M)"
OUT="tmp/server-snapshot-$STAMP"
mkdir -p "$OUT/logs" "$OUT/db"
note() { echo "  $*"; }
q() { echo; echo "=== $1 ==="; psql -c "$2" 2>&1; }

# ── Host and containers ──────────────────────────────────────────────────────
{
  echo "snapshot: $(date -u '+%F %T UTC'), window: last $HOURS h, host: $(hostname)"
  echo; echo "=== revision ==="; git log -1 --format='%h %d %s (%cr)' 2>&1; git status --short 2>&1 | head -20
  echo; echo "=== containers ==="; dc ps -a 2>&1
  echo; echo "=== images ==="; dc images 2>&1
  echo; echo "=== resources ==="; docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}' 2>&1
  echo; echo "=== restarts / exit codes ==="
  for c in $(dc ps -aq 2>/dev/null); do
    docker inspect -f '{{.Name}}  restarts={{.RestartCount}}  status={{.State.Status}}  exit={{.State.ExitCode}}  started={{.State.StartedAt}}  oom={{.State.OOMKilled}}' "$c" 2>&1
  done
  echo; echo "=== disk ==="; df -h / 2>&1; docker system df 2>&1
  echo; echo "=== memory ==="; free -m 2>&1 || true
  echo; echo "=== uptime ==="; uptime 2>&1
} > "$OUT/status.txt"
note "wrote  status.txt"

# ── Logs per service ─────────────────────────────────────────────────────────
for svc in $(dc config --services 2>/dev/null); do
  dc logs --no-color --timestamps --since "${HOURS}h" "$svc" > "$OUT/logs/$svc.log" 2>&1 || true
  if [ -s "$OUT/logs/$svc.log" ]; then note "wrote  logs/$svc.log ($(wc -l < "$OUT/logs/$svc.log" | tr -d ' ') lines)"; else rm -f "$OUT/logs/$svc.log"; fi
done
# Errors only, newest last, with the service name in front.
grep -HiE '\b(error|exception|fatal|unhandled|panic|ECONNREFUSED|ETIMEDOUT|timed? ?out|429|5[0-9]{2} )\b|\[(ERROR|WARN)\]' "$OUT"/logs/*.log 2>/dev/null \
  | sed -E "s#^$OUT/logs/([^:]+)\.log:#\1  #" | sort -k2 | tail -2000 > "$OUT/errors.log" || true
note "wrote  errors.log ($(wc -l < "$OUT/errors.log" | tr -d ' ') lines)"
# The same errors grouped by message shape (numbers and ids folded), most frequent first.
sed -E 's/^[a-z_-]+ +[0-9T:.Z-]+ +//; s/[0-9a-f]{8}-[0-9a-f-]{27}/<id>/g; s/[0-9]+/N/g' "$OUT/errors.log" 2>/dev/null \
  | cut -c1-220 | sort | uniq -c | sort -rn | head -80 > "$OUT/errors-top.txt" || true

# ── Health ───────────────────────────────────────────────────────────────────
{
  for p in /api/health /health; do
    echo "GET $p"; dc exec -T automation wget -qO- -T 5 "http://localhost:3000$p" </dev/null 2>&1; echo
  done
} > "$OUT/health.txt"
note "wrote  health.txt"

# ── Database: migrations and the agents' state for the window ───────────────
{
  q "last migrations" "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 15"
  q "editor runs by role × status (window)" "SELECT role, status, count(*) AS runs, round(sum(cost_usd)::numeric, 3) AS usd
     FROM editor_runs WHERE started_at > $W GROUP BY 1, 2 ORDER BY 1, 2"
  q "failed / errored runs (window, latest 40)" "SELECT started_at, role, channel_key, status, left(coalesce(error, ''), 200) AS error
     FROM editor_runs WHERE started_at > $W AND status NOT IN ('ok', 'running') ORDER BY started_at DESC LIMIT 40"
  q "slots by status (window)" "SELECT channel_key, status, count(*) FROM editor_slots WHERE scheduled_at > $W GROUP BY 1, 2 ORDER BY 1, 2"
  q "skipped / failed slots (latest 40)" "SELECT scheduled_at, channel_key, status, left(coalesce(error, reject_reason, ''), 200) AS why
     FROM editor_slots WHERE scheduled_at > $W AND status IN ('skipped', 'failed') ORDER BY scheduled_at DESC LIMIT 40"
  q "drafts by status (window)" "SELECT channel_key, status, count(*) FROM editor_drafts WHERE updated_at > $W GROUP BY 1, 2 ORDER BY 1, 2"
  q "AI spend by feature × model (window)" "SELECT feature, model, count(*) AS calls, round(sum(cost_usd)::numeric, 4) AS usd
     FROM llm_usage WHERE at > $W GROUP BY 1, 2 ORDER BY usd DESC NULLS LAST LIMIT 30"
  q "bot log errors (latest 40)" "SELECT b.id, b.type, b.channel_id, left(b.message, 300) AS message FROM bot_logs b
     WHERE b.type ILIKE '%error%' ORDER BY b.id DESC LIMIT 40"
} > "$OUT/db/state.txt" 2>&1
note "wrote  db/state.txt (a query on a missing table/column just prints its error)"

DAYS=$(( (HOURS + 23) / 24 ))
if [ -f scripts/llm-cost-report.sh ]; then
  bash scripts/llm-cost-report.sh "$DAYS" </dev/null > "$OUT/db/llm-cost.txt" 2>&1 && note "wrote  db/llm-cost.txt" || note "warn   llm-cost-report failed (see db/llm-cost.txt)"
fi
if [ "$FULL" = "--full" ] && [ -f scripts/export-agent-history.sh ]; then
  note "running export-agent-history.sh $DAYS …"
  EXP="$(bash scripts/export-agent-history.sh "$DAYS" </dev/null 2>&1 | tee "$OUT/db/export.txt" | sed -n 's/.*→ \(tmp\/agent-export-[^ ]*\.tar\.gz\).*/\1/p')"
  [ -n "$EXP" ] && [ -f "$EXP" ] && mv "$EXP" "$OUT/" && rm -rf "${EXP%.tar.gz}" && note "added  $(basename "$EXP")"
fi

# ── Mask anything that looks like a credential, in every text file ──────────
find "$OUT" -type f \( -name '*.log' -o -name '*.txt' \) -print0 | LC_ALL=C xargs -0 perl -pi -e '
  s/(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}/<bot-token>/g;
  s/\bsk-(?:or-v1-|ant-[a-z0-9]+-|proj-)?[A-Za-z0-9_-]{20,}/<api-key>/g;
  s/\bEAA[A-Za-z0-9]{40,}/<meta-token>/g;
  s/\bTHAA[A-Za-z0-9]{40,}/<threads-token>/g;
  s/(Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/${1}<token>/gi;
  s/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/<jwt>/g;
  s/\b1[A-Za-z0-9_-]{300,}={0,2}/<session>/g;
  s#(://[^:/\s"]+:)[^@/\s"]+@#${1}<password>@#g;
  s/\benc:v1:[A-Za-z0-9+\/=:._-]+/<encrypted>/g;
  s/((?:password|passwd|secret|api[_-]?key|access[_-]?token)["\x27]?\s*[:=]\s*["\x27]?)[^\s"\x27,}]{6,}/${1}<masked>/gi;
'
note "masked credentials"

tar -czf "$OUT.tar.gz" -C tmp "$(basename "$OUT")" && rm -rf "$OUT"
echo "snapshot: done → $OUT.tar.gz ($(du -h "$OUT.tar.gz" | cut -f1))"
