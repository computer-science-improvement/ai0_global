# 053 Token economy — runbook

## Before deploy (owner, from the 046 runbook)

These are settings, not code. 053 assumes they are done:

- Remove the Opus agent models (manager, weekly reviewers).
- Clear the Anthropic critic and default models.
- Make sure no orchestrator has Sonnet, because its children inherit it.

## New settings (all optional)

| Env | Default | What it does |
|---|---|---|
| `EDITOR_LADDER_EXTRA_STEPS` | `1` | Fallback-ladder steps after a failed first attempt (0–3). Set `3` to restore the full ladder: next candidate → lighter format → evergreen. |
| `EDITOR_ANTHROPIC_TOOLS_CACHE_TTL` | unset (5 min) | Set `1h` to cache the tool block for an hour. A 1-hour write costs 2× instead of 1.25×, so it pays off only with ≥ 2 reuses an hour. Decide from report sections 1 and 6 after a 2-day window. |

## Measuring (FR-010)

`scripts/llm-cost-report.sh` is a read-only report over `llm_usage`, `editor_runs` and `editor_run_steps`. It reads no post texts, prompts or settings, so its output is safe to paste into a chat.

Run it on the deploy host. `scp` needs the absolute path:

```bash
scp /Users/tupotavalentyn/CS/20-ai0/ai0-global/scripts/llm-cost-report.sh root@159.65.241.89:/opt/ai0_global/tmp/
```

```bash
ssh root@159.65.241.89 'cd /opt/ai0_global && bash tmp/llm-cost-report.sh 2'
```

**When:**
1. The "before" window is the 2 days before the deploy (the baseline is in the spec).
2. The "after" window is the first 2 full days after the deploy.
3. Measure each workspace in use; switch `ai.workspace` for the second window if both are used.

### What to check

| Check | Report section | Target |
|---|---|---|
| Agent spend per day | 1 (feature × model) | ≤ $2 a day |
| Executor first-step prompt | 5, column `s0_1` | ≤ 22k tokens (was 42k) |
| Executor cache writes per call | 1 / 6 | half of the baseline |
| Checker cache writes | 1, `editor.checker` | 0 |
| Tool results over 8 KB | 10 | none except `load_skill` (12 KB) and `list_ideas` (16 KB) |
| idea_reviewer | 2 (runs per role) | ≤ 4 model turns, no `sql_readonly` |
| orchestrator | 2 | ≤ 10 model turns; days with a full pool cost $0 |
| manager | 2 | ≤ 12 model turns, ≤ $0.25 a run on Sonnet |
| OpenRouter with a Claude model | 6 | cache read share ≥ 70% |

`editor_runs.steps` counts LLM turns and tool calls together, so a run with 2 tool calls a turn shows about 3× its turn count. The step caps (`maxSteps`) count LLM turns. Read the "model turns" columns, not `steps`, against the caps.

Record each window in `tasks.md` under "Measurements".
