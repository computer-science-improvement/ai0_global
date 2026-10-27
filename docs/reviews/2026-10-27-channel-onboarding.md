# Channel onboarding — why a new channel takes two weeks, and the fix

Analysis of the path from "I want a new channel" to "it posts correctly", asked by the owner on 2026-10-27:

> «мені потрібно щоб коли я додаю новий канал то це було просто, швидко і зручно, щоб не доводилось 2 тижні дебажити його роботу»

**Method.**
1. Eight readers mapped one subsystem each: launch/setup, card/playbook/formats, series/datasets/import, sources, skills/rules/steering, planner/runtime, git and review history, and dashboard surfaces. Together they found 135 raw failure modes, merged into 29 classes.
2. Six skeptics then tried to refute the load-bearing claims against the code at `5f8eeedb`. Result: 84 confirmed, 47 partly confirmed (corrected below), 0 refuted.
3. Three independent design angles followed (owner flow, correctness by construction, feedback loop). A judge merged them, and a completeness critic replayed @pdr_dev_channel, @ai0_prompts_dev and a news channel from zero against the merged plan.
4. Spot checks were made by hand: poll cap at publish, playbook validation, the default card, approval write-ahead, and the stage profile of @pdr_dev_channel.

Working files (not committed): the catalogue, verdicts and design JSON in the session scratchpad.

## 1. What actually happened to the two young channels

| Day | @ai0_prompts_dev | @pdr_dev_channel |
|---|---|---|
| 10-03 … 10-17 | Seeded from PromptHero rows; migration 083 made text-less rows "postable" (4 764) | Poll published without a correct answer (review 2, post 1725); `pdr_questions` on reuse `never` |
| 10-17 … 10-22 | Owner says «бери з nanobanana» → it became a skill, not a series source; the old skill still said `origin=original` / PromptHero | All 866 rows used; channel dark ~10 days (no runway warning, no series) |
| 10-22 … 10-26 | 8 of 9 Prompt slots skipped (`series_source_mismatch`, `origin_mismatch`, `prompt_text порожній`) | Every clause post rejected — the critic could not see `read_doc` (fixed in 067) |
| 10-27 | Owner rule, dataset import, series source, skill off, manual replan — by hand on stage | Card had quiz, the agent's playbook gave quiz weight 0; rule said «poll з correct_index»; no series; `correct_answer_num` off-by-one in the brief; the rules site is geoblocked from the server |

Each layer was found by an export-and-review cycle of 4–6 days. Each fix exposed the next layer. For two channels that took 3–4 iterations, about 3.5 weeks.

## 2. Six structural causes

1. **One decision, many copies.**
   - The format mix lives in the card, the playbook section, `series.format`, `format_prefs.content_kind`/`polls_per_week` and the dataset entity.
   - A channel's sources live in `card.sources`, `series.source`, the profile, skill bodies, owner rules and playbook rule URLs.
   - About 13 stores feed free text into the writer prompt.
   - Each consumer reads a different copy: the planner reads the card or the playbook; lint and the cap read the card; the writer reads skills and the series brief; the critic reads the profile and the section but not the brief.

2. **Checks belong to the object being saved, never to the channel.**
   - The skill source/origin guards run on 2 of 6 skill write paths.
   - The card save never looks at the playbook or the series.
   - The cross-object checks that exist (`configConflicts`, 9 codes; the weekly @sysadmin audit) run on demand or once a week.
   - There is no readiness view. The owner checks about 14 surfaces by hand.

3. **The bring-up flows leave the hard parts to the owner, and the defaults point the wrong way.**
   - `/launch` and `/setup` see no datasets, sources or skills, and they write sourceless locked series.
   - Import creates datasets with reuse `never`, random order and no `post_requires`. The dashboard cannot even set `post_requires`.
   - A dataset quiz channel needs 42 manual steps (list below). Each one fails silently when missed.

4. **Mistakes surface only at run time, and look like content problems.**
   - Most contradictions are caught by publish guards inside a paid executor run, classed as `lint`/`other`.
   - They can put good rows aside, and they feed the breaker as "no material".
   - Plans are frozen once made, and pauses never lift by themselves.
   - Reviews 3 and 4 measured 54–71 % of due slots skipped.

5. **The feedback loop is offline and slow.**
   - Nobody can see what the writer was told; no prompt is stored or rendered.
   - Skip reasons show as "Note". Notes carry raw guard text with no link to the fix.

6. **Guards are special-cased to old data.**
   - Quiz ground truth exists only for `pdr_questions`.
   - The verbatim guard knows only `recipes/facts/articles/tg_posts`.
   - The dataset→format rule fires only for entity `quiz_question`.
   - A newly imported dataset therefore gets almost no protection.

## 3. The 29 failure classes (verified)

Severity is 1–5. "Day 0" means a $0 deterministic check could catch it before the first slot.

| # | Failure | Sev | Seen today by | Day 0? |
|---|---|---|---|---|
| F01 | A skill, rule or steering text contradicts a series' required source or origin (PromptHero vs `library:nanobanana_prompts`) | 5 | publish guard in a paid run | yes |
| F02 | No channel-wide consistency check or readiness view | 5 | offline review | yes |
| F03 | Card formats, playbook weights and `series.format` disagree (quiz 0 in the section; in independent groups the planner refuses it) | 5 | `plan_invalid` to the LLM, lint | yes |
| F04 | Unpostable rows counted as material (`post_requires` missing or wrong) | 5 | 068 pre-flight, then a pause | yes |
| F05 | Reuse `never`, random order, silent exhaustion | 5 | dark days, then a pause | yes |
| F06 | Config errors surface only after a paid run, classed as content (`lint`/`other`) | 4 | publish guard | yes |
| F07 | Planned slots, pins and written drafts keep the old config after a change (series slots read the current playbook; slot format, topic, plain hints, skill text and drafts do not) | 4 | nothing | yes |
| F08 | A dataset channel has no dataset-bound series, or its series has no required source | 4 | nothing | yes |
| F09 | Launch/setup write a plan without checking it against the real channel, and never try a first post | 4 | nothing before Start | yes |
| F10 | Breaker pauses never lift by themselves; Resume does not replan | 4 | pause card | partly |
| F11 | Owner messages report symptoms ("Note", raw guard text), not "misconfigured because X, fix by Y" | 4 | inbox | CI rule |
| F12 | A knowledge question goes out as a plain poll (only `format: quiz` renders a quiz) | 5 | warning only | yes |
| F13 | A source the server cannot reach (geoblock) is never probed; timeouts never become strikes | 4 | chat error, later a pause | yes |
| F14 | **The poll cap blocks a quiz series at publish.** The Telegram executor's guard gets no playbook series (`role-tools.ts:229` reads `ctx.extras.network`, which `runTelegramExecutor` never sets), so no series is exempt. A daily quiz on a resource whose topic misses `QUIZ_TOPIC_RE` and has no `content_kind: quiz` goes out once a week. @pdr_dev_channel is safe today only because its topic says «тестові запитання та вікторини» | 4 | `poll_cap_reached` | yes |
| F15 | The quiz answer-key index base lives in prose; ground truth is hard-coded to `pdr_questions` | 4 | put-aside (pdr only) | yes |
| F16 | Series briefs, rules, skills and style disagree (hashtags, pictures) | 3 | lint at publish | yes |
| F17 | What the writer is told is invisible and differs from what the critic sees; overflow inline skills drop silently | 4 | critic reject | yes |
| F18 | Source health is passive and partial (library series, page sources and chat reads are invisible; re-sync failures only logged) | 3 | log | yes |
| F19 | Clause keys sort lexically (1.10 before 1.2) or collapse (`1.10` → 1.1) | 3 | nothing | yes |
| F20 | A series' format is not enforced on the slot or the post; the ladder turns quiz into text | 4 | nothing | yes |
| F21 | Card and playbook duplicate formats and the posting rate; which one applies depends on network mode | 4 | later `plan_invalid` | yes |
| F22 | A new content shape exposes runtime defects only real slots reveal (critic blind to `read_doc`, language lint counting code blocks) | 4 | offline review | first post only |
| F23 | Rule, steering and language checks depend on which path wrote them | 3 | weekly audit | yes |
| F24 | Planner retries reset on restart; the alert carries no validator lines | 3 | alert without a cause | — |
| F25 | Launch/setup lifecycle gaps: half-done Start, no drift check, `/setup` never checks the bot or sets a mode, checklist link `/app/approvals` has no route | 3 | nothing | yes |
| F26 | Content guards keyed by legacy dataset and host names (verbatim, reusable hosts, entity→format) | 3 | nothing | yes |
| F27 | A series stops silently (non-material skip of an unlocked series, renamed or removed series) | 2 | nothing | yes |
| F28 | The card's hidden tools allowlist can remove the read tools a library series needs | 3 | breaker later | yes |
| F29 | Slots of a channel switched off are claimed and swept as "stuck (crash?)" | 2 | log | — |

Corrections from verification that change the design:
- F03's section-weight refusal applies only to independent network groups. Standalone channels use the single planner, where nothing compares `slot.format` with `series.format` at all (F20).
- `HTTPS_PROXY` already works process-wide. That would also route model calls, so it is not a fix for one geoblocked host.
- Spec 069 T3 already edits repeated inbox cards in place, so inbox noise is lower than review 4 measured.
- In approve mode, a slot is written about 12 h ahead (`approval-timing.ts`). After Start, the first drafts appear within minutes, so the first real drafts can stand in for a paid rehearsal.

## 4. The 42 manual steps today (dataset quiz channel)

Seven are unavoidable or a matter of taste:
- create the channel;
- add the bot;
- write the brief;
- press Start;
- approve the first posts;
- connect other platforms;
- go live.

The other 35 are configuration that the system could infer, set or check. Examples:
- quiz weight in the card **and** the playbook;
- series with `library:<dataset>`, `required`, format `quiz`;
- `content_kind quiz` / `polls_per_week`;
- reuse in rounds, in order, with natural sort;
- `post_requires`;
- dedup key;
- conflicting skills off;
- a brief without index arithmetic;
- replan after each change;
- resume after each pause;
- checking whether a source is reachable from the server;
- adding the reference host to `LEDGER_REUSABLE_HOSTS`.

## 5. Target: what adding a channel looks like after the fix

**Dataset quiz channel** (about 10 min of owner time):
1. Telegram: create the channel and add the bot.
2. `/launch @x from dataset pdr_questions <brief>`, or the import wizard's new last step "Use in a channel".
3. Code binds the series: `library:pdr_questions`, `required`, format `quiz` taken from the dataset's publish profile, rounds in order. The cap does not apply to the owner's series.
4. The launch panel shows **Readiness: 0 blockers**, or lists them with **Fix all**. The plan's own errors, such as a posts-per-day maximum below the series count, are fixed by code.
5. **Start**: the doctor runs on the current state, then writes, approval mode, and today and tomorrow are planned.
6. The first drafts are written within minutes. Readiness shows each series' first outcome: "awaiting approval" or "skipped: <reason> → <fix link>".
7. Approve in the owner bot.

**Sources/news channel**:
- `/launch @x @ref from https://site-a/feed.xml https://site-b/news <brief>`.
- Each source is read once from the server ($0): "OK, 24 items, newest 2 h ago" or "timeout ×2 — unreachable from the server" with **Remove / Route via proxy / Upload the page**.

**Original-content channel**:
- `/launch @x <brief>`. Readiness checks style, language, hashtags and that no skill names an outside source.

**After Start, on every config change** (the owner's or an agent's):
- the doctor re-checks within minutes;
- today's planned slots are repaired at $0 (format, hints, removed series), with an LLM replan only when a due series lost its slot;
- a pause whose cause is gone lifts by itself.

## 6. Proposed specs

Migration numbers are reserved up front so the worktrees do not collide.

### 072 Channel doctor and Readiness (L, migration 097)

- **The check.** A pure `channelDoctor(facts)` in `editor/readiness/`. It makes no I/O and no model call. It returns coded findings with severity blocker / warning / info, English text, a deep link to the object to change, and a one-tap fix where one exists.
- **Shared with the audit.** It reuses the sysadmin `Finding` shape and the audit's fix runner, which is extracted and shared. The weekly audit keeps its own checks.
- **The facts loader** reads:
  - card, profile/`format_prefs`, playbook (active and pending), series, pins;
  - skills of the agent chain, owner rules, active steering;
  - bound datasets with postable runway and field fill;
  - open pauses, host failures, effective tools, network mode.
- **When it runs:**
  - a $0 sweep every 10 minutes for channels in approve or live mode or with an open launch;
  - on demand on `GET /readiness`;
  - right after owner saves in the dashboard.
  It stores the result in `channel_readiness`.
- **First checks:**
  - a required source contradicted by a skill, rule or steering line (`sourceInSkill`, `originWithSource`, `skillConflicts`);
  - a dataset channel without a required series;
  - a dataset without `post_requires`, or with low fill;
  - reuse `never` or random order on an in-order series, and runway;
  - series instances above the card's posts-per-day maximum;
  - read tools missing for a series source;
  - `hashtagMin > 0` with an empty vocabulary;
  - format divergence in independent groups;
  - open pauses whose cause is gone;
  - unreachable sources (076) and dataset checks (075) plug in later.
- **Auto-safe fixes**, applied by code from a closed list enforced by a test, each logged and shown:
  - add a read tool a series source needs;
  - `hashtagMin` 0 when the vocabulary is empty.
- **Dashboard.** A Readiness panel (CompactCard plus details) on the agent Overview, replacing ConflictsLine and absorbing Paused series and Sources. It is also shown in the `/app/editor/$channel` header and in the launch panel. It has **Fix all** and **Recheck**, and a **last 24 h** line: planned / published / skipped by cause, with the top fix.
- **Owner bot.** One note when the set of blockers changes, at most daily, with «Виправити все» and «Відкрити».
- **Mode switches.** Start and the mode switch show open blockers and ask to confirm: "Start anyway". There is no hard gate. `LAUNCH_GRADUATION=auto` waits while blockers are open.

### 073 Config is not content (L, migration 098)

- **Poll cap.** Every active series and pin of the resource is exempt, at plan and at publish. The publish guard loads the resource's full series list from the current playbook instead of `ctx.extras.network`. A new series or a cadence change is structural, so the owner approves it anyway. `poll_series_over_cap` and its harmful "pause the series" fix are removed.
- **Series format is authoritative for series slots.**
  - The planner sets a series slot's format to `series.format`, and the card and section weight checks exempt it.
  - Card formats govern only improvised slots.
  - At publish, `series_format_mismatch` applies only to series slots.
  - The ladder never lightens a series slot or an answer-key row; it skips with a cause instead.
- **Polls.** New lint error `poll_correct_index`: a poll with a correct answer must be format `quiz`.
- **$0 config pre-flight before the writer.**
  - The series exists and is active.
  - Required-source hints are replaced by the next row.
  - The read tools are present.
  - A failure is skip class `config`: it never counts toward the breaker, never runs the ladder, never puts a row aside, and becomes a doctor finding.
  - `quiz_answer_mismatch` stops putting rows aside when the writer picked the wrong option.
- **Write paths.**
  - `writeAgentSkill` checks every skill write against the agent's required series sources. An agent's conflicting write is refused; an owner's write is saved with a warning.
  - Rule writes from the memory form, the Rules artifact and card Apply run rule lint and `configConflicts`.
- **Defaults.**
  - `hashtagMin` defaults to 0.
  - A stored "vocabulary" style with an empty vocabulary counts as off.
  - A card library source accepts dataset keys with digits.
  - An inline skill over budget is listed, not dropped.
- **Planner.** The retry count survives a restart (read from `editor_runs`), and the alert carries the validator lines.
- **Switching off.** `claimDue` skips channels in mode off. When the channel is switched back on, overdue slots are skipped with `mode_changed` and the day is replanned.
- **Reason catalogue.** One catalogue for the codes the owner sees (skip, pre-flight, config, doctor), each with English and Ukrainian label, fix text and link. A test fails on a missing code or Cyrillic in English text. The dashboard drops the "Note" fallback.
- **Quick fixes** in the same spec:
  - the checklist link `/app/approvals`;
  - planning tomorrow at Start;
  - two consecutive days of non-material skips of one series raise one note.

### 074 Changes take effect by themselves (M, no migration)

- **Repair after a config change.** The doctor sweep detects a change through a hash of the config columns, never `updated_at`, which moves on mode and model switches. Then:
  - planned, unwritten slots of today and tomorrow are repaired at $0: format := series format, hints := current source and next row, slots of a removed series skipped with `config_series_gone`;
  - pins of a changed series are re-materialised;
  - an LLM replan runs only when a due required series has no slot, capped per channel-day and run outside the main tick.
- **Owner actions propagate.** The owner's Resume and the change_source Apply run the same repair and replan.
- **Automatic resume.** A `no_material` or `source_unreachable` pause lifts when its cause has been gone on two consecutive checks. The hosts of open source pauses are re-probed every 6 h whatever the channel's age. Owner pauses are never lifted by code.
- **Plain pauses.** A pause on a channel's plain slots no longer stops its series and pins from being planned.

### 075 Datasets declare how they post (L, migration 099)

- **Publish profile.** New column `data_schemas.publish` (jsonb), validated by zod:
  - `format` (quiz / poll / text / photo);
  - `answer_key {options_field, correct_field, base 0|1}`;
  - `text_use` (verbatim / retell / cite; unset means no verbatim check);
  - `retell_fields`, `media_field`, `credit_fields`, `reusable_hosts`.
- **Backfill.** `pdr_questions`, the legacy entities, the `RETELL_SOURCES` keys, the prompt datasets (`prompts`, `nanobanana_prompts`) and `pdr_rules`.
- **Guards read the profile:**
  - quiz ground truth for any answer-key dataset;
  - `dataset_needs_quiz` only for series bound to that dataset;
  - the verbatim check by `text_use`;
  - reusable hosts.
  `query_data` rows and the series note carry the computed `correct_index` and correct option, so no brief does index arithmetic.
- **Import infers the profile.**
  - The answer key; the owner must choose the base when the samples do not decide it.
  - The format.
  - Dotted numbers stay text and sort naturally (numeric array, not int).
  - A `post_requires` proposal.
  - Reuse proposed as "in rounds, in order".
  - A $0 HEAD probe of sample media URLs (image type, ≤ 5 MB).
- **Dashboard.** ImportWizard gets a "How it posts" step showing one rendered sample quiz with the right answer highlighted. SchemaEditor gets the same section, so `post_requires` becomes editable in the dashboard for the first time.
- **Binding.** `bindDatasetPlan(channel, dataset)` produces one card:
  - a required series, which takes over the plan's series of the same format, else is added;
  - reuse and `post_requires`;
  - detach items for conflicting skills.
  It is used by the wizard's last step "Use in a channel" and by `/launch … from dataset`.
- **Shared count.** One postable count helper, used by `change_source` and the doctor, so an unpostable dataset is never "4 764 rows".

### 076 Sources proven from the server (M, migration 100)

- **Probe.** `probeSource` reads once at $0, with the failure class (timeout / refused / TLS / DNS / HTTP / empty), item count, newest item and sample titles. It tells RSS from page and auto-discovers a page's feed. Results are cached for 6 h. It runs:
  - on card source save;
  - on series bind;
  - on import preview;
  - in the launch worker;
  - daily for channels younger than 14 days;
  - from a "Test from server" button.
- **Escalation.** Three timeouts or resets in 14 days with no success count as a strike, reason `unreachable`. The pre-flight then skips at $0.
- **Geoblocked sites.** Two routes:
  - **Upload the page.** The saved page goes into DocStore under its canonical URL, so the `split_on` import keeps `url#anchor` refs, the ledger and dedup. This replaces today's local script for `pdr_rules`, whose re-sync is marked manual.
  - **A per-host proxy.** The `EGRESS_PROXY_URL` and `EGRESS_PROXY_HOSTS` settings, for source fetches only; model and Telegram traffic stay direct.
- **Health coverage.** Health lists library series sources (runway), feed series and cards with no sources. Re-sync failures become an action note. The "all feeds failed → $0 skip" counts only RSS sources, so page sources keep working.

### 077 Bring-up: launch and setup that take the material (L, migration 101)

- **Launch input.** `/launch` accepts `from dataset <key>[,<key>]` and `from <url>…`. The analysis sees a «Матеріал» block: fields, 3 sample rows and runway, or probe results and sample titles. Code binds the material through 075 and 076. `mergePlaybook` keeps unlocked library and feed series and carries `source` / `source_mode`.
- **Checks before writing.** At plan-ready and at Start, the plan is validated with the real resources, quiet hours and source catalogue, and the doctor runs on the would-be state. Auto-fixes cover what only code can fix, such as raising posts-per-day to the series count. Blockers are shown before anything is written ("Start anyway" stays available).
- **First posts.** Start lets the approval write-ahead write the first slot of each series at once. Readiness shows each outcome. Preview stays the manual button. There is no separate paid rehearsal.
- **What the writer is told.** `GET /api/editor/slots/:id/instructions` renders in code, without a model, what the writer and the critic get for a planned slot. Each block is labelled with its source (card, style, skill:<name>, series, owner rules, steering, profile, memory). Prompt fixes found this way:
  - the critic gets the series note;
  - the Telegram writer gets the profile's taboo and tone lines;
  - the precedence line names skills.
- **Lifecycle.**
  - The checklist gets readiness and first-outcome steps, plus a card after 24 h with nothing published and nothing waiting.
  - `/setup` Apply ends with the bot check and an unticked "Start in approval".
  - A ready launch older than 7 days shows an age warning.

**Order:**
1. Wave 1, in parallel: 073 (it holds the quick wins and goes first), 072 and 076.
2. Wave 2, in parallel: 074 and 075.
3. Wave 3: 077.

Each spec is implemented by one Sonnet worktree, then verified on Node 20 with tests on the scratch PG, the dashboard tsc, and replays of the review fixtures. The doctor must flag the 10-27 stage problems and raise no false blocker on the healthy series of @ai0_global.

## 7. Not doing

- **Creating the Telegram channel or adding the bot by MTProto.** Only the bot check is automatic.
- **Any code path that changes a channel's mode by itself.** Readiness informs; the owner's Start or mode switch decides.
- **Mirroring the card into the playbook on every write.** Standalone channels never read section weights. Series slots are made independent of both instead.
- **A paid rehearsal as a separate system.** The approval write-ahead already writes real drafts within minutes of Start.
- **Event buses or DB triggers on every config table.** A 10-minute $0 sweep plus rechecks after owner saves covers every write path, SQL edits included.
- **Storing full prompts on every run.** The instructions view renders them on demand.
- **Archetype presets and a new "New channel" dialog.** Material binding behind `/launch` and the import wizard does the same with fewer surfaces.
- **Automatic rewriting of skill, rule or brief prose.** The doctor offers detach and disable, and links to the text.
- **A "rewrite stale drafts" card.** In approve mode the owner rejects a draft that looks wrong; the repair stops new ones being written with the old setup.
