#!/usr/bin/env bash
#
# Where the agents' AI money goes: a read-only report over llm_usage, editor_runs and editor_run_steps (no post
# texts, no prompts, no settings). Plain-text tables, safe to paste into a chat.
#
#   - spend by feature × model with the token split (uncached input, cache reads, cache writes, output)
#   - runs per role: count, steps, prompt tokens and cost per run (avg / p90 / max)
#   - context growth: prompt tokens by step number for the loop roles
#   - the 20 most expensive runs, today's spend by hour, errors that still cost money
#   - the largest tool results (bytes re-sent on every later step of a run)
#
# Run on the deploy host from the repo root (psql runs inside the compose `postgres` service):
#
#     bash scripts/llm-cost-report.sh          # last 7 days
#     bash scripts/llm-cost-report.sh 3        # last 3 days
#
set -euo pipefail
cd "$(dirname "$0")/.."
DAYS="${1:-7}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "usage: $0 [days]" >&2; exit 2; }
PGUSER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2- || true)"
PGDB="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2- || true)"
PGUSER="${PGUSER:-ai0}"
PGDB="${PGDB:-ai0global}"
psql() { docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"; }
if [ -n "${REPORT_PG_URL:-}" ]; then psql() { command psql -X -v ON_ERROR_STOP=1 "$REPORT_PG_URL" "$@"; }; fi
W="now() - interval '$DAYS days'"

section() { printf '\n=== %s ===\n' "$1"; }
q() { psql -P pager=off -P footer=off -c "$1"; }

section "1. Spend by feature × model, last $DAYS days (tokens in thousands)"
q "SELECT feature, model, count(*) AS calls, count(DISTINCT run_id) AS runs,
          round(sum(coalesce(tokens_in,0) - coalesce(tokens_cached_read,0) - coalesce(tokens_cached_write,0))/1e3) AS in_uncached_k,
          round(sum(coalesce(tokens_cached_read,0))/1e3)  AS cache_read_k,
          round(sum(coalesce(tokens_cached_write,0))/1e3) AS cache_write_k,
          round(sum(coalesce(tokens_out,0))/1e3)          AS out_k,
          round(sum(cost_usd)::numeric, 2)                AS usd
     FROM llm_usage WHERE at > $W AND NOT shadow
    GROUP BY 1, 2 ORDER BY usd DESC NULLS LAST LIMIT 40"

section "2. Spend by day × provider"
q "SELECT (at AT TIME ZONE 'Europe/Kyiv')::date AS day, provider, count(*) AS calls, round(sum(cost_usd)::numeric, 2) AS usd
     FROM llm_usage WHERE at > $W AND NOT shadow GROUP BY 1, 2 ORDER BY 1, usd DESC"

section "3. Runs per role: model turns (what maxSteps caps), steps (turns + tool calls), prompt tokens and cost per run"
q "SELECT r.role, r.model, count(*) AS runs,
          round(avg(t.turns), 1) AS avg_turns, max(t.turns) AS max_turns,
          round(avg(r.steps), 1) AS avg_steps, max(r.steps) AS max_steps,
          round(avg(r.prompt_tokens)/1e3) AS avg_prompt_k,
          round((percentile_cont(0.9) WITHIN GROUP (ORDER BY r.prompt_tokens))::numeric/1e3) AS p90_prompt_k,
          round(max(r.prompt_tokens)/1e3) AS max_prompt_k,
          round(avg(r.completion_tokens)/1e3, 1) AS avg_out_k,
          round(avg(r.cost_usd)::numeric, 3) AS avg_usd, round(sum(r.cost_usd)::numeric, 2) AS usd,
          count(*) FILTER (WHERE r.status <> 'ok') AS not_ok
     FROM editor_runs r
     LEFT JOIN LATERAL (SELECT count(*) AS turns FROM editor_run_steps s WHERE s.run_id = r.id AND s.type = 'llm') t ON true
    WHERE r.started_at > $W
    GROUP BY 1, 2 ORDER BY usd DESC LIMIT 40"

section "4. Run endings per role (status)"
q "SELECT role, status, count(*) AS runs, round(sum(cost_usd)::numeric, 2) AS usd
     FROM editor_runs WHERE started_at > $W GROUP BY 1, 2 ORDER BY 1, usd DESC"

section "5. Context growth: avg prompt tokens (k) by step number"
q "SELECT u.feature,
          round(avg(u.tokens_in) FILTER (WHERE u.step_idx BETWEEN 0 AND 1)/1e3)  AS s0_1,
          round(avg(u.tokens_in) FILTER (WHERE u.step_idx BETWEEN 2 AND 4)/1e3)  AS s2_4,
          round(avg(u.tokens_in) FILTER (WHERE u.step_idx BETWEEN 5 AND 9)/1e3)  AS s5_9,
          round(avg(u.tokens_in) FILTER (WHERE u.step_idx BETWEEN 10 AND 19)/1e3) AS s10_19,
          round(avg(u.tokens_in) FILTER (WHERE u.step_idx >= 20)/1e3)            AS s20p,
          count(*) FILTER (WHERE u.step_idx >= 20) AS calls_20p
     FROM llm_usage u WHERE u.at > $W AND u.kind = 'llm' AND NOT u.shadow
    GROUP BY 1 ORDER BY sum(u.cost_usd) DESC NULLS LAST LIMIT 15"

section "6. Cache: share of prompt tokens read from cache, and cache writes per call"
q "SELECT provider, feature, model,
          round(100.0 * sum(coalesce(tokens_cached_read,0)) / nullif(sum(tokens_in),0)) AS read_pct,
          round(100.0 * sum(coalesce(tokens_cached_write,0)) / nullif(sum(tokens_in),0)) AS write_pct,
          round(avg(coalesce(tokens_cached_write,0))/1e3, 1) AS avg_write_k_per_call
     FROM llm_usage WHERE at > $W AND kind = 'llm' AND NOT shadow
    GROUP BY 1, 2, 3 ORDER BY sum(cost_usd) DESC NULLS LAST LIMIT 25"

section "7. The 20 most expensive runs"
q "SELECT to_char(r.started_at AT TIME ZONE 'Europe/Kyiv', 'MM-DD HH24:MI') AS at_kyiv, r.role, r.channel_key, r.model,
          r.status, r.steps, round(r.prompt_tokens/1e3) AS prompt_k, round(r.completion_tokens/1e3, 1) AS out_k,
          round(r.cost_usd::numeric, 3) AS usd
     FROM editor_runs r WHERE r.started_at > $W ORDER BY r.cost_usd DESC LIMIT 20"

section "8. Today (Kyiv) by hour × feature"
q "SELECT to_char(at AT TIME ZONE 'Europe/Kyiv', 'HH24') AS hour, feature, count(*) AS calls, round(sum(cost_usd)::numeric, 2) AS usd
     FROM llm_usage
    WHERE (at AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date AND NOT shadow
    GROUP BY 1, 2 HAVING sum(cost_usd) > 0.02 ORDER BY 1, usd DESC"

section "9. Calls that failed but still cost money"
q "SELECT feature, model, status, error_code, count(*) AS calls, round(sum(cost_usd)::numeric, 3) AS usd
     FROM llm_usage WHERE at > $W AND status <> 'ok' GROUP BY 1, 2, 3, 4 ORDER BY usd DESC NULLS LAST LIMIT 15"

section "10. Tool results by size (bytes stay in the context for every later step of the run)"
q "SELECT r.role, s.tool_name, count(*) AS calls,
          round(avg(octet_length(s.output::text))/1e3, 1) AS avg_kb,
          round(max(octet_length(s.output::text))/1e3, 1) AS max_kb,
          round(sum(octet_length(s.output::text))/1e6, 2) AS total_mb
     FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
    WHERE s.type = 'tool' AND s.created_at > $W
    GROUP BY 1, 2 ORDER BY total_mb DESC LIMIT 25"

section "11. Tool calls per run by role (top tools)"
q "SELECT r.role, s.tool_name, count(*) AS calls, round(count(*)::numeric / count(DISTINCT r.id), 1) AS per_run
     FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
    WHERE s.type = 'tool' AND s.created_at > $W
    GROUP BY 1, 2 HAVING count(*) >= 5 ORDER BY 1, calls DESC"

section "12. Cost source"
q "SELECT cost_source, count(*) AS calls, round(sum(cost_usd)::numeric, 2) AS usd FROM llm_usage WHERE at > $W GROUP BY 1 ORDER BY usd DESC NULLS LAST"
