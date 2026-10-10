# Editor agent evals

Live evals for the editor agents (planner, executor, reviewer). Each run uses:

- **the real LLM** through OpenRouter (whatever `EDITOR_MODEL_*` resolves to; the default is `z-ai/glm-5.3-flash`);
- **the production wiring**, i.e. the same tools, prompts, skills, guards, loop, budget and trace;
- **a fixture web** (`FakeWeb`): only the URLs a case defines exist, and every other URL returns 404. Results are reproducible and nothing reaches the real internet;
- **a fake Telegram**: live-mode publishes are recorded, never sent;
- **a scratch Postgres** with all migrations applied. The runner refuses any database that looks real: one with bots or Meta accounts, or more than 5000 published posts.

Every case is graded by **hard checks in code**. A failure means a regression. Soft checks (⚠️) are reported but don't fail the run. You can optionally add an **LLM judge** (`--judge`) that scores voice, accuracy, relevance and craft from 1 to 5 against the source material.

## Cases

| id | role | what it proves |
|---|---|---|
| `executor-photo-from-feed` | executor (live, fake TG) | RSS → article → photo post with a real source, an image from that source, numbers taken from the source, Ukrainian, and no AI clichés. Exercises the full publish path. |
| `executor-quiz-from-library` | executor | A quiz built from `pdr_questions`, with the correct option matching the database answer and a correct `library_ref`. |
| `executor-prompt-injection` | executor | An instruction planted inside the article (a casino link and hashtag) never reaches the post. |
| `executor-skip-when-nothing-relevant` | executor | The feed has nothing on the topic, so the agent skips the slot instead of inventing news. |
| `executor-avoid-repeat` | executor | Yesterday's post already covered the obvious story, so the agent picks something else (similarity < 0.6). |
| `executor-recipe-from-library` | executor | Recipe from the library: written in the agent's own words (longest copied run < 80 chars), with the recipe image and `library_ref`. |
| `executor-picks-dataset` | executor | Spec 032: two new datasets (dishes with long texts, a car-facts distractor). The executor reads `library_catalog` first, picks the dishes dataset, calls `query_data` with ≤ 5 fields and posts with a `data://` ref. Hard check: the row data it fetched is ≥ 50 % smaller (≈ tokens, characters / 4) than what `search_library` returns for the same dataset (8 rows, every field); a soft check also counts the catalog reads. |
| `planner-daily-plan` | planner | Builds a valid 3–5 slot plan that uses the best hour (19:00) and the best format (quiz), after reading the stats. |
| `reviewer-weekly-insights` | reviewer | Finds that quizzes outperform and writes concrete memory entries. Does not lower the quiz weight. |
| `chat-schedule-tomorrow` | composer (chat, fake TG) | "Make a post about <article> for @eval_chat and schedule it for tomorrow 19:00" leads to a scheduled draft whose reserved slot is at tomorrow 19:00 Kyiv. Nothing is sent. The channel has no card, so the default card and the minimal `off` card are exercised. |
| `chat-draft-only` | composer (chat) | "Prepare a post" without a publish request produces a draft only: status `draft`, no reserved slot, nothing sent. |
| `chat-series-change` | composer (agent chat) | Spec 023: "@agent рецепти о 20:30 по буднях" leads to one `series_change` card (update "Рецепт дня" to `weekly:mon,tue,wed,thu,fri@20:30`) whose summary shows the human diff; the active playbook is unchanged until Apply. |
| `executor-rich-comparison` | executor (live, fake TG) | Spec 033: an article comparing three phones becomes a post with a `table` block (≥ 3 rows, 2–6 columns) that goes out as `sendRichMessage`; numbers grounded, Ukrainian. Soft: no rich lint warnings, ≤ 2 headings, the `format-rich-telegram` skill loaded. Written, not yet run. |
| `executor-rich-short-news` | executor (live, fake TG) | Spec 033: a two-sentence news item stays a short plain post (no table, no headings, sent as HTML). Written, not yet run. |
| `executor-rich-never` | executor (live, fake TG) | Spec 033: with `format_prefs.rich = never` the card carries `richPref` and nothing is sent as `sendRichMessage`. Written, not yet run. |
| `planner-honours-pins` | planner | Spec 023: an owner pin at 16:00 stays in the plan exactly once, no planned slot is within 60 min of it, and the due series "Рецепт дня" (19:00) is planned with `series`. |
| `executor-voice-plain` | executor (shadow) | Spec 034: a news resource with `humor: none` and a story that invites jokes (a delivery robot stuck in snow). The post has no listed slop phrase, no humour or slang marker, no reader question (news cap 0), passes `lintPost`, is Ukrainian and its numbers come from the source. Soft: no slop warnings, the critic passed it without a rewrite. Judge input included. Written, not yet run. |
| `critic-rejects-slop` | checker | Spec 034: the critic on two fixed posts about the same news. The AI-sounding one (pathos opener, a rhetorical question answered at once, an adjective triple, dashes, a moralising closer; no listed phrase, so only the critic can stop it) gets `revise` or `reject`, and the model flags it itself (its own verdict is not `pass` or `ai_likeness` ≤ 3). The clean human post gets `pass`. Written, not yet run. |
| `critic-rejects-nonsense` | checker | Spec 034: a fluent post that contradicts its source (wrong city, 2000 instead of 200 MW, storage "generates" power for "the whole country", blackouts end "this week") gets `reject` with `sense` ≤ 2 or `grounding` ≤ 2. Written, not yet run. |
| `planner-poll-cap` | planner | Spec 034: poll and quiz are in the card's formats, polls had the best views, and a poll was already published this week (default cap 1). The final plan has no poll or quiz. A `polls_per_week` refusal from the validator is a soft failure. Written, not yet run. |
| `builder-fitting-formats` | builder (chat) | Spec 034: "@ai0 create an agent for my short IT-news channel" leads to a `create_agent` card with 1–4 formats, each with a reason, no poll or quiz, and no longread or carousel. Nothing is created before Apply. Written, not yet run. |
| `builder-examples-and-warnings` | builder (chat) | Spec 034: in the same creation chat (one neutral follow-up turn allowed, soft) @ai0 calls `propose_content_examples`: 3 Ukrainian examples that pass the slop lint (`checkExample` with the resource card), no listed phrase, no humour or slang, at most 1 reader question each, and 2–4 distinct warnings, each with a reason and a bad example. Written, not yet run. |
| `manager-flags-quality` | manager | Spec 034: a week with flat KPIs but poor quality: a critic reject, a revise that passed after a rewrite, 2 polls against cap 1, a waiting post with two reader questions, an owner rejection with a reason, and an owner edit with its memory note. Pass: MANAGER files `voice_fix` or `format_mix`, or its `quality_check` marks the resource `issue` with a note. `ok` on this resource fails. Soft: advice binding, `voice_fix` quotes a rejected slot, `format_mix` lowers polls, no `quality_check` refusals. Written, not yet run. |
| `executor-live-news-fresh` | executor (live, fake TG) | Spec 034: two live slots (no fixed topic) on fixture feeds dated against the case clock. Feed A has an item posted today (0.5 h old), a fresh one (1.5 h), an older fresh one (4.5 h) and a stale one (30 h). The post cites the 1.5 h item and never the posted or stale one. Feed B has only stale items and the posted one, so its slot is skipped with `no_fresh_item` by code, with no run and no LLM call. Written, not yet run. |

## Run

```bash
# 1. a scratch Postgres (once per machine): initdb + all migrations, e.g.
#    initdb -D /tmp/ai0-eval-pg -U ai0 --auth=trust && pg_ctl -D /tmp/ai0-eval-pg -o "-p 54329 -k /tmp" start
#    createdb -h /tmp -p 54329 -U ai0 ai0 && psql … -f database/init.sql && for f in database/migrations/*.sql; do psql … -1 -f $f; done
# 2. run (OPENROUTER_API_KEY comes from the root .env)
cd apps/automation
EVAL_DB_URL='postgres://ai0@localhost/ai0?host=/tmp&port=54329' \
  npx tsx --env-file=../../.env evals/run-evals.ts --judge
```

Flags:

| flag | meaning |
|---|---|
| `--case a,b` | Run only these cases. |
| `--reps 3` | Repeat each case to measure flakiness. |
| `--judge` | Add the LLM judge. |
| `--judge-model z-ai/glm-5.3` | Choose the judge model. |
| `--max-usd 1` | Hard spend cap for the whole run. |
| `--list` | Print the registered cases (id, role, channel, title) and exit. This needs no database or API key and makes no LLM call. Use it with `--case` to check ids. |

The exit code is 0 only when every case passes. Reports are written to `evals/results/<timestamp>.md` and `.json`; they are gitignored except `baseline-*.md`.

**Cost:** about $0.005 per case on `glm-5.3-flash`, plus about $0.002 per judged case.

The stack mirrors production for spec 034. The poll cap is in both plan validators. The runner gets the target's
humour, slang and question caps (`voiceOf`) and the code-side live-slot scan, which reads the fixture web with the
fixed clock. `fetch_feed` uses the fixed clock too. @ai0 has `propose_content_examples`. The **pre-publish critic**
runs on every executor run. Each executor case therefore costs one critic pass more, about $0.001 on the default
model, or two passes after a revise. The critic uses `EDITOR_MODEL_CHECKER`, else the global default; the owner's
dashboard critic model is not read. `EDITOR_CRITIC=off` in the environment turns the critic off, as in production.
The two `critic-*` cases then fail with "critic enabled".

### Spec 034 quality cases (written, not run)

The live run makes paid LLM calls, so it is the owner's to start. This check makes none:

```bash
cd apps/automation
npx tsx evals/run-evals.ts --list --case executor-voice-plain,critic-rejects-slop,critic-rejects-nonsense,planner-poll-cap,builder-fitting-formats,builder-examples-and-warnings,manager-flags-quality,executor-live-news-fresh
npx tsx --test evals/cases/quality.fixtures.test.ts   # fixture sanity: no DB, no LLM, no network
```

The run itself, 3 reps:

```bash
cd apps/automation
EVAL_DB_URL='postgres://ai0@localhost/ai0?host=/tmp&port=54329' \
  npx tsx --env-file=../../.env evals/run-evals.ts \
  --case executor-voice-plain,critic-rejects-slop,critic-rejects-nonsense,planner-poll-cap,builder-fitting-formats,builder-examples-and-warnings,manager-flags-quality,executor-live-news-fresh \
  --reps 3 --max-usd 1
```

Add `--judge` to score the two executor posts.

**Estimated cost** on the default `z-ai/glm-5.3-flash`, with the critic on the same model:

| case | estimate per rep |
|---|---|
| `executor-voice-plain` | executor + 1–2 critic passes, ≈ $0.007 |
| `critic-rejects-slop` | 2 critic passes, ≈ $0.002 |
| `critic-rejects-nonsense` | 1 critic pass, ≈ $0.001 |
| `planner-poll-cap` | ≈ $0.004, more after a refusal |
| `builder-fitting-formats` | ≈ $0.005 |
| `builder-examples-and-warnings` | 1–2 chat turns, ≈ $0.01 |
| `manager-flags-quality` | ≈ $0.01 (digest up to 20k chars) |
| `executor-live-news-fresh` | ≈ $0.007; the no-fresh slot makes no call |

That is about **$0.05 per full pass** of the 8 cases, or **$0.15 for `--reps 3`**. `--judge` adds about $0.004 per
pass. With a Sonnet-class critic (`EDITOR_MODEL_CHECKER`, $3 / $15 per M tokens), each critic pass costs
$0.015–0.02. That adds about $0.1 per pass, or about $0.3 for 3 reps. Keep `--max-usd 1` as the cap.

## Adding a case

1. Add an `EvalCase` to `cases/*.ts`:
   - `web(now)` returns the fixture pages (`now` is the run's fixed clock, for feeds dated relative to it);
   - `execute(ctx)` seeds data with `lib/seed.ts` helpers and runs the role through `ctx.stack.runner`;
   - it returns `checks` built with `check(name, pass, detail, soft?)`, and `extraRunIds` when it ran more than one agent run (their cost counts too).
2. Register it in `run-evals.ts`.

Every case must use its own `@eval_*` channel key. The runner resets that key before and after the case.

**When an agent misbehaves in production,** turn the situation into a case first. Then fix the prompt, skill or guard, and keep the case as a regression test.
