#!/usr/bin/env bash
#
# Export the agents' work for an offline review: runs and their steps, dashboard chats, agents, skills (with
# versions), owner rules and memory, directives, manager reviews, plans, drafts, audits, the posts that went out
# (with their metrics), the logs (AI calls, publish ledger, LLM usage, news watch, legacy strategy runs, the
# automation container's own log) and the non-secret settings. Read-only (SELECTs only), one JSON object per line,
# one file per table, then a .tar.gz. Anything that looks like a key or token is masked before packing.
#
# Left out on purpose: account tokens and sessions (my_bots, meta_accounts, telegraph_accounts, mtproto …),
# encrypted setting values (shown as "<encrypted>"), and third-party private messages (agent_dm_threads,
# agent_inbox, agent_opportunities). Long step payloads are cut (see STEP_* below) — a step keeps its tool, error
# flag, tokens, cost and the start of its input/output; ai_logs inputs/outputs are cut the same way.
#
# Run on the deploy host from the repo root (psql runs inside the compose `postgres` service, like migrate.sh):
#
#     bash scripts/export-agent-history.sh          # last 30 days of runs/chats
#     bash scripts/export-agent-history.sh 90       # last 90 days
#
# Then copy the .tar.gz from tmp/ to your machine. It holds post texts and chat history: keep it out of git.
#
set -euo pipefail
cd "$(dirname "$0")/.."

DAYS="${1:-30}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "usage: $0 [days]" >&2; exit 2; }
STEP_INPUT_CHARS="${STEP_INPUT_CHARS:-6000}"
STEP_OUTPUT_CHARS="${STEP_OUTPUT_CHARS:-12000}"

PGUSER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2- || true)"
PGDB="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2- || true)"
PGUSER="${PGUSER:-ai0}"
PGDB="${PGDB:-ai0global}"
psql() { docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"; }
# Testing against a throwaway database instead of the compose one.
if [ -n "${EXPORT_PG_URL:-}" ]; then psql() { command psql -X -v ON_ERROR_STOP=1 "$EXPORT_PG_URL" "$@"; }; fi

STAMP="$(date +%Y%m%d-%H%M)"
OUT="tmp/agent-export-$STAMP"
mkdir -p "$OUT"

exists() { [ "$(psql -tAc "SELECT to_regclass('public.$1') IS NOT NULL")" = "t" ]; }
col() { [ "$(psql -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name = '$1' AND column_name = '$2'")" = "1" ]; }

# One table → <table>.jsonl. $2: an optional SELECT over the table aliased t (default: every row, newest first
# within the window when the table has a time column).
dump() {
  local table="$1" sql="${2:-}"
  if ! exists "$table"; then echo "  skip   $table (no such table)"; return; fi
  if [ -z "$sql" ]; then
    local ts=""
    for c in created_at started_at posted_at captured_at snapshot_at updated_at; do col "$table" "$c" && { ts="$c"; break; }; done
    if [ -n "$ts" ]; then
      sql="SELECT row_to_json(t) FROM $table t WHERE t.$ts > now() - interval '$DAYS days' ORDER BY t.$ts"
    else
      sql="SELECT row_to_json(t) FROM $table t"
    fi
  fi
  psql -tA -c "$sql" > "$OUT/$table.jsonl"
  echo "  wrote  $table ($(wc -l < "$OUT/$table.jsonl" | tr -d ' ') rows)"
}

echo "export: $PGDB, last $DAYS days → $OUT"

# Who the agents are and what drives them (all rows, not windowed).
for t in agents agent_handle_aliases skills skill_versions agent_skills playbooks schedule_rules editor_channels; do
  dump "$t" "SELECT row_to_json(t) FROM $t t"
done
# Owner rules, learned memory, directives and the manager's reviews.
for t in editor_channel_memory agent_memory agent_directives manager_reviews; do
  dump "$t" "SELECT row_to_json(t) FROM $t t"
done

# Dashboard chats in the window: the chats that had a message, and those messages.
dump editor_chats "SELECT row_to_json(c) FROM editor_chats c WHERE EXISTS (SELECT 1 FROM editor_chat_messages m WHERE m.chat_id = c.id AND m.created_at > now() - interval '$DAYS days')"
dump editor_chat_messages
dump pending_actions
dump agent_actions

# Runs and their steps (long payloads cut).
dump editor_runs
dump editor_run_steps "SELECT json_build_object(
    'id', s.id, 'run_id', s.run_id, 'idx', s.idx, 'type', s.type, 'tool_name', s.tool_name, 'is_error', s.is_error,
    'prompt_tokens', s.prompt_tokens, 'completion_tokens', s.completion_tokens, 'cost_usd', s.cost_usd,
    'duration_ms', s.duration_ms, 'created_at', s.created_at,
    'input',  left(s.input::text,  $STEP_INPUT_CHARS),  'input_chars',  length(s.input::text),
    'output', left(s.output::text, $STEP_OUTPUT_CHARS), 'output_chars', length(s.output::text))
  FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
  WHERE r.started_at > now() - interval '$DAYS days' ORDER BY s.run_id, s.idx"

# What the agents planned, wrote and how it was checked.
for t in editor_plans editor_slots editor_drafts editor_stories editor_story_posts content_ideas editor_post_audit_runs editor_post_audit; do
  dump "$t"
done

# The posts that went out, where, and how they did.
for t in published_posts platform_posts platform_post_metrics scheduled_publications content_ledger content_decisions; do
  dump "$t"
done
for t in resource_profiles resource_profile_versions resource_pauses approval_alerts channel_setup_proposals steering_sets; do
  dump "$t" "SELECT row_to_json(t) FROM $t t"
done
dump resource_daily_stats
dump kpi_snapshots

# The owner's side (specs 012, 048, 052, 054–059): Inbox notes, owner-bot cards and reports, artifact history, channel
# launches, per-agent tool sets, the weekly @sysadmin audit, promo pairs and map links. Missing tables are skipped.
for t in agent_inbox owner_cards owner_reports artifact_versions channel_launches audit_reports audit_dismissals map_link_events network_offers media_holds; do
  dump "$t"
done
for t in agent_tools promo_pairs tracked_links; do
  dump "$t" "SELECT row_to_json(t) FROM $t t"
done
dump link_joins
# Paused series (060), datasets and list imports (058/065/066): the schemas whole, the imports of the window, and per
# dataset only counts — the rows themselves are third-party content.
dump series_pauses "SELECT row_to_json(t) FROM series_pauses t"
dump data_schemas "SELECT row_to_json(t) FROM data_schemas t"
dump data_imports
dump data_items "SELECT json_build_object('schema', s.key, 'items', count(i.id), 'with_image', count(i.image_url),
    'with_body', count(i.body), 'newest', max(i.created_at))
  FROM data_schemas s LEFT JOIN data_items i ON i.schema_id = s.id GROUP BY s.key ORDER BY s.key"
# The round each channel is in for datasets that repeat in rounds (071); empty before migration 096.
dump data_reuse_rounds "SELECT json_build_object('schema', s.key, 'resource_ref', r.resource_ref, 'round', r.round,
    'started_at', r.started_at, 'updated_at', r.updated_at)
  FROM data_reuse_rounds r JOIN data_schemas s ON s.id = r.schema_id ORDER BY s.key, r.resource_ref"

# Logs. ai_logs holds the full prompt and output of every AI call: cut like the run steps.
dump ai_logs "SELECT json_build_object(
    'id', a.id, 'agent', a.agent, 'model', a.model, 'status', a.status, 'error', a.error, 'created_at', a.created_at,
    'input',  left(a.input::text, $STEP_INPUT_CHARS),  'input_chars',  length(a.input::text),
    'output', left(a.output,      $STEP_OUTPUT_CHARS), 'output_chars', length(a.output))
  FROM ai_logs a WHERE a.created_at > now() - interval '$DAYS days' ORDER BY a.created_at"
for t in bot_logs llm_usage llm_usage_daily llm_budget_alerts news_watch_log strategy_runs source_host_failures; do
  dump "$t"
done

# The automation container's log for the same window (skipped when testing against another database).
if [ -z "${EXPORT_PG_URL:-}" ]; then
  docker compose --profile prod logs --no-color --since "$((DAYS * 24))h" automation > "$OUT/automation.log" 2>&1 || echo "  warn   automation log not available"
  [ -f "$OUT/automation.log" ] && echo "  wrote  automation.log ($(wc -l < "$OUT/automation.log" | tr -d ' ') lines)"
fi

# Settings that steer the agents; secrets never leave the box.
dump app_settings "SELECT json_build_object('key', key, 'value', CASE WHEN value LIKE 'enc:%' THEN '<encrypted>' ELSE value END) FROM app_settings ORDER BY key"

# The skill files shipped with the code, for the same snapshot.
[ -d apps/automation/editor-skills ] && cp -R apps/automation/editor-skills "$OUT/editor-skills"
git rev-parse HEAD > "$OUT/code-revision.txt" 2>/dev/null || true

# Mask anything that looks like a credential, in every file (Telegram bot tokens, OpenRouter / Anthropic / OpenAI
# keys, Meta tokens, bearer headers, JWTs, MTProto session strings, passwords in URLs).
find "$OUT" -type f \( -name '*.jsonl' -o -name '*.log' \) -print0 | LC_ALL=C xargs -0 perl -pi -e '
  s/(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}/<bot-token>/g;
  s/\bsk-(?:or-v1-|ant-[a-z0-9]+-|proj-)?[A-Za-z0-9_-]{20,}/<api-key>/g;
  s/\bEAA[A-Za-z0-9]{40,}/<meta-token>/g;
  s/\bTHAA[A-Za-z0-9]{40,}/<threads-token>/g;
  s/(Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/${1}<token>/gi;
  s/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/<jwt>/g;
  s/\b1[A-Za-z0-9_-]{300,}={0,2}/<session>/g;
  s#(://[^:/\s"]+:)[^@/\s"]+@#${1}<password>@#g;
  s/\benc:v1:[A-Za-z0-9+\/=:._-]+/<encrypted>/g;
'
echo "  masked credentials"

tar -czf "$OUT.tar.gz" -C tmp "$(basename "$OUT")"
echo "export: done → $OUT.tar.gz ($(du -h "$OUT.tar.gz" | cut -f1))"
