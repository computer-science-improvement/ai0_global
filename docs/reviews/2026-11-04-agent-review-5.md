# Agent review 5 — dev stage 10-29 … 11-04

Fifth offline review of the agents' work (review 4: `2026-10-26-agent-review-4.md`; channel onboarding review with failure classes F01–F29: `2026-10-27-channel-onboarding.md`).

**Source.** `scripts/export-agent-history.sh` (last 7 days) and `scripts/server-snapshot.sh` (window 168 h), both taken 2026-11-04 19:41 UTC. Archives: `tmp/server/x/agent-export-20261104-1941/` and `tmp/server/x/server-snapshot-20261104-1941/`. The server runs develop at `1ecb8160` (spec 078), deployed 10-29 10:25 UTC, with no restarts since. Wave 1 of channel onboarding (072 doctor, 073 config is not content, 076 sources proven from the server) is built on `feat/editor-agent` and **not deployed**. Specs 074, 075 and 077 are written and not built.

**Size.** 217 runs (all `ok`), 1,978 steps, 78 slots, 32 published posts, 706 LLM calls, 72 ideas, 25 Inbox notes, 18 owner cards, 7 manager reviews, 1 weekly audit, 0 owner chat messages, and the container logs for the whole window.

**Method.** Six analysts covered skips, content, datasets, the control layer, runtime and sources. One skeptic per lens re-checked every finding in the data and in the code at `1ecb8160`. Corrections are folded in below, and the claims they refuted are listed in the appendix. The headline numbers in section 1 were recounted for this document.

## Verdict

Output is up and waste is down, but **two channels went dark and the defects that cost the most are data and format mismatches the code could see.**

- **Skip rate.** 46 of 78 slots skipped (59%; review 4: 57 of 80, 71%).
- **Waste.** Paid skips took 45% of executor and critic spend (review 4: 74%). Cost per published post is $0.26 (review 4: $0.65).
- **Total spend is fine.** $8.29 in the window, about $1.2 a day, under both the $3/day target of 046 and the ≤$2/day target of 053.

Four causes explain most of what is left.

1. **A code-made resource pause darkens a whole channel and nothing lifts it.** @ai0_global has had 0 slots since 10-28 and @game_exchange_dev since 11-02. After one Inbox note, every other signal is suppressed, and the manager filed the one directive that could not work (#1–#6).
2. **The pdr quiz guard reads a 0-based answer key as 1-based.** It refused the correct answer 9 times and would accept the wrong one. Spec 075 as written hard-codes the same error, and 073 on the branch retries with the guard's wrong text (#7).
3. **Datasets do not say what a format needs.** A descriptive sentence in the pdr card brief became a hard "quiz needs a picture" lint (9 skips). Only 12 of 70 nanobanana prompts can be posted under the channel's own rules, while the catalog reports 65–69 (11 skips). Pre-flight checks neither (#8, #9, #12, #13).
4. **Sources live in prose, and one store adapter is wrong.** Live slots read 1–2 feeds with a 6 h window, so weekend columns trip the breaker. The Epic adapter publishes a sale window as the giveaway deadline (#2, #16–#18).

Together, the three dataset-to-format mismatches explain 29 of the 46 skips and $1.96 of the $3.15 paid-skip spend.

**Deploy order.** Ship the answer-key hotfix (proposed 079) **before** deploying wave 1. On `HEAD`, 073 treats `quiz_answer_mismatch` as "the row is right, the attempt is wrong" and retries with the guard's own text, which on this data names the wrong option.

## 1. The week in numbers

### Slots and spend by channel

| Channel | Slots | Published | Skipped | Skip rate | LLM spend | $ per post |
|---|---|---|---|---|---|---|
| @ai0_news_dev | 21 | 16 | 5 | 24% | $2.65 | $0.17 |
| @game_exchange_dev | 18 | 7 | 11 | 61% | $1.89 | $0.27 |
| @ai0_prompts_dev | 16 | 4 | 12 | 75% | $0.98 | $0.25 |
| @pdr_dev_channel | 23 | 5 | 18 | 78% | $2.08 | $0.42 |
| @ai0_global | 0 | 0 | 0 | — | $0.21 | — |
| No resource (manager, auditor) | — | — | — | — | $0.48 | — |
| **Total** | **78** | **32** | **46** | **59%** | **$8.29** | **$0.26** |

@ai0_global is mode `live` and had 0 slots, 0 plans and 0 planner runs in the window. It still cost $0.21 in orchestrator, idea-reviewer and reviewer runs.

### Spend by role and by day

- **By role.** Executor $5.80 (70%), checker $1.21, manager $0.48, orchestrator $0.41, reviewer $0.18, planner $0.17, idea reviewer $0.05, auditor $0.003.
- **By day (UTC).** 10-29 $1.27, 10-30 $1.42, 10-31 $1.22, 11-01 $1.20, 11-02 $1.18, 11-03 $1.10, 11-04 $0.89 (to 19:41).
- **On skipped slots.** $3.15 (38% of all spend): executor $2.94 over 37 runs on 32 skipped slots, plus checker $0.21. The executors of the 32 published posts cost $2.86. A skipped slot's executor averaged $0.092, almost the same as a post's ($0.089).
- **Fixed entry fee.** The executor's first call averages $0.064, because it re-writes a cached prefix of about 27k tokens (#34).

### Skips by class

| Class | Skips | Cost |
|---|---|---|
| `agent:quality` | 18 | $1.70 |
| `planner_no_material` | 9 | $0 |
| `agent:no_material` | 7 | $0.63 |
| `no_fresh_item` | 6 | $0.31 (2 at $0) |
| `critic_rejected` (cap_revise) | 2 | $0.42 |
| `source_used` | 1 | $0.09 |
| `preflight_stale`, `planner_source_unreachable`, `series_paused` | 1 each | $0 |

14 skips closed at $0 and 32 were paid.

### Skips by root cause

| Root cause | Skips | Paid cost | Finding |
|---|---|---|---|
| pdr answer key read with the wrong base | 9 | $0.86 | #7 |
| pdr card brief read as "quiz needs a picture" | 9 (7 paid, 2 at $0) | $0.65 | #8 |
| nanobanana rows need an uploaded photo, have placeholders or are too long | 11 (6 paid, 5 at $0) | $0.45 | #12 |
| Freshness: single feed, 6 h window, weekend columns, stale idea | 8 (3 at $0) | $0.49 | #2, #18 |
| Store APIs: Epic deadline and rotation, Steam deals with no deadline, 403 hosts | 4 | $0.12 | #16, #20, #21, #23 |
| Critic verdict code (cap_revise) | 2 | $0.42 | #27 |
| Recap with no source (guessed Steam feed) | 1 | $0.08 | #17 |
| story_repeat false positive | 1 | $0.09 | #14 |
| Resource pause (planned slot) | 1 | $0 | #1 |

### Trend against review 4

| | Review 4 (10-21 … 10-26) | Review 5 (10-29 … 11-04) |
|---|---|---|
| Slots | 80 | 78 |
| Published from slots | 23 | 32 |
| Skip rate | 71% | 59% |
| Paid skips as share of executor + critic spend | 74% | 45% |
| Cost per published post | $0.65 | $0.26 |
| Spend per day | $1.96 (after 10-22) | about $1.2 |
| Skips the critic took part in | 31 of 57 | 5 of 46 |
| Breaker pauses opened | 0 | 4 (6 open in total) |
| Failed runs | — | 0 of 217 |

## 2. What went well

- **Stability.** All 217 runs finished `ok`. There was 1 LLM retry and no call over 100k prompt tokens. There were 0 container restarts and no OOM; 881 MB of 1,967 MB was still available. The hourly stats collector ran a median 34.7 s and never overlapped itself.
- **Spend.** About $1.2 a day, down from $2–8 a day in mid-October. Cost per post fell from $0.65 to $0.26.
- **Specs 067/068 work.** The critic took part in only 5 of 46 skips (review 4: 31 of 57). The breaker fired 4 times in the window (review 4: 0), and paused or empty slots closed at $0 (14 skips at $0).
- **Facts in what shipped.** All 32 posts went out 15–65 s after slot time and none in quiet hours. Every number in all 32 posts appears in the text the run read. All 16 news posts link their source. The ledger shows no repeated source. None of the 77 `publish_post` drafts contained `SKIP_POST`, "rate limit" or error JSON.
- **The writer refused bad instructions.** It refused the guard's wrong answer 9 of 9 times, and both published quizzes carry the dataset's correct answer. It also refused weekly columns and unverifiable deadlines instead of publishing them.
- **News.** @ai0_news_dev published 16 of 21 slots (76%). All 5 evening live slots (17:00 UTC) found items 0.5–1.7 h old.
- **Data fixes landed.** 095 `post_requires` drops all PromptHero rows to 0 postable. 071 rounds gave pdr a fresh 866-row round. The Kyiv-local time fields are correct for `Z` timestamps across both DST switches.
- **Delivery to the owner.** All 18 owner cards (ids 76–93), 7 daily reports and 1 weekly report went out with no errors.
- **Honest agents.** On 11-04 the manager refused to guess instead of filing another blind directive. On 10-30 the pdr orchestrator (run `0b188075`) found the 0-based answer key by itself. Its warning did not reach the owner (#7).

## 3. Findings by theme

Each finding lists the lens ids it merges, then evidence, cause, status and fix. Code lines are at `1ecb8160` unless marked `HEAD`. Status uses four values: **fixed on the branch, not deployed**; **covered by an unbuilt spec**; **new**; **owner data action**. "Partly" means part of the fix is in a spec.

### A. Dark channels and pauses

#### 1. A resource pause darkens a whole channel and nothing lifts it — critical
*Lenses: SK1, CL1, DT7, SR2.*

- **Evidence.**
  - `series_pauses` has 6 open rows and 0 resumed.
  - @ai0_global: `659c2f20` (`resource:telegram:@ai0_global`, 10-28 04:08, streak 3) and `0f248f34` (series «AI-новини дня», 10-27) are open. The channel had 0 slots, 0 plans and 0 planner runs in the window. Its unpaused weekly series «MCP-сервер тижня» (playbook `eb905e52`, `weekly:wed@18:00`) got no slot on Wed 11-04. Its KPI posts value is 0 from 10-31, and the last ledger publish was 10-22.
  - @game_exchange_dev: `18cefb50` opened 11-01 13:03 with streak 4: `efd64b04`, `6c3dbc6c`, `04f476d2` and `43ed18f7`, spanning 25 h. It skipped planned slot `c3b86db3` (`automation.log:2267`). There were 0 slots on 11-02 … 11-04, so «Роздача дня» stopped too. The last games planner run is `8bb4fa88` (11-01 04:03).
  - Planner runs in the window: 7 each on news, prompts and pdr, 4 on games and 0 on @ai0_global.
- **Cause.**
  - `editor.scheduler.ts:181` calls `maybePlan` / `maybePlanAhead` / `newsWatch` only for channels outside `plainPausedChannels()` (`series-pauses.repository.ts:66-71`, every open `resource:telegram:%` key). A plain-slot pause therefore stops series and pins too (F10).
  - `streak.ts:36` keys every plain slot as `resource:<ref>`, so live, recap and fixed plain slots form one run. Threshold 3 (`series-breaker.ts:8`) plus a 20 h span (`streak.ts:51`, `:111`).
  - Nothing lifts a `series_pauses` row except an owner Resume (`pause-actions.ts:58`, `pause-resume-action.ts:44`). The manager's `resumeSeries` (`executors/index.ts:240`) handles `pause_series` directives, not breaker pauses.
- **Status.** Partly covered by unbuilt spec 074. FR-007 (`spec.md:212-225`) lets a plain-paused channel plan series and pins. In this window that would add 3 «Роздача дня» slots (11-02 … 11-04) and 1 «MCP-сервер тижня» slot. FR-005 leaves `resource:` pauses with the owner (`spec.md:162`, `:268`). «AI-новини дня» has a `free` source, so it lifts only when its source changes (`spec.md:172-176`). 072 on the branch shows pauses as `info` only (`HEAD checks/pauses.ts:71`, `:90`).
- **Fix.**
  - Build 074 FR-007.
  - Lift a `resource:` pause by code at the next plan hour when its streak came only from freshness closes (`no_fresh_item`) or `planner_no_material`. Or require 2 calendar days with 0 posts before pausing a resource.
  - Give `resource:` pauses a maximum age, after which code re-probes and resumes them with a note.
  - Proposed spec 080.

#### 2. Weekend single-feed misses trip the resource breaker — major
*Lenses: SK7, SR11, SR2.*

- **Evidence.**
  - All 9 games live slots had one feed (RPS 7, Eurogamer 2) and `max_age_hours` 6.
  - Three paid live runs on games ended `no_fresh_item`, each costing $0.077. `efd64b04` (10-31 12:00) found only «What are we all playing this weekend?», `6c3dbc6c` (10-31 18:00) an opinion column, and `43ed18f7` (11-01 13:00) «The Sunday Papers». News `217dd02b` (11-04 07:00) cost $0.079 for 2 off-brief items.
  - Together with the sourceless recap `04f476d2`, these opened pause `18cefb50`. At 17:30 that day RPS had a 13-minute-old item. Eurogamer had 3, GamesRadar 6 and PC Gamer 3 items 6 h old or newer.
- **Cause.**
  - The planner writes one feed into `live_spec.sources` (`live-slot.ts:114-125`).
  - The live scan skips at $0 only when no item survives its old/undated/posted/similar filters (`editor-runner.service.ts:448-449`, `live-slot.ts:149-152`). `filterFresh` (`live/feed-items.ts:138-168`) has no rubric filter, so a fresh column goes to a paid run.
  - `skip-cause.ts:35` folds `no_fresh_item` into `no_material` by design (060/068).
- **Status.** New. 076 probes whether feeds load; these feeds loaded fine.
- **Fix.**
  - Every live slot reads 2 or more card feeds, with `max_age` of 12 h or more on Saturday and Sunday (#18).
  - Add per-feed exclude patterns (`Sunday Papers|What are we all playing`), so a scan that keeps only excluded items skips at $0.
  - Do not count a `no_fresh_item` whose feeds read OK, with `dropped.old > 0`, toward the resource streak.
  - Proposed specs 080 and 085.

#### 3. After one card, every signal about a dark channel goes quiet — major
*Lenses: CL1, CL6, CL5.*

- **Evidence.**
  - Games got one pause card (86). After it came 0 `dark_day` or `series_missed` notes, and only card 92 (`event_not_covered`, 11-04), which does not mention the pause. @ai0_global got no card except the directive card 85.
  - Inbox note 138 (`dark_day`, games, 10-31, «Planned today: 4; out: 0») was demoted to `info` and never became a card. In all, 4 of the 25 window notes were demoted.
  - The owner reacted to 0 of 18 cards (`resolved_by` is null on all 18), resumed 0 of 6 pauses and wrote 0 chat messages.
  - On 10-29 11:13 the owner cycled @ai0_global's mode four times (live → approve → shadow → off → live; 3 `PATCH /api/agents/ai_global`, 1 `POST …/autonomy`). That did not lift `659c2f20`. The agent page did show a «Planning paused» banner with a Resume button (`PauseBanners.tsx:74`), fetched 9 times, and Resume was not pressed.
- **Cause.**
  - `series-breaker.ts:94-105` posts one note per pause and never reminds.
  - `schedule.service.ts:202-210` and `plan-schedule-rules.ts:244-246` make the day minimum 0, so the dark-day test at `silent-days.ts:154` never fires.
  - `escalation.ts:105-110` leaves resource-paused channels out of the posts trigger. `owner-reports.ts:153` drops channels with no slots. `kpi-digest.service.ts:458-464` adds a bare `series_paused` flag, which the tiny view drops (`:258`).
  - `owner-inbox.ts:133-137` demotes the third and later `action` note of a run when the owner has not acted (`note-gate.ts:33`, `DEMOTE_AFTER = 3`).
  - A mode change only writes an audit row (`editor-channels.repository.ts:237-246`). The Telegram pause card says «Планувальник більше її не планує» (`series-breaker.ts:38-41`), which does not say the channel will publish nothing.
- **Status.** New. 074 FR-008 rewrites the banner text but adds no reminder, report line, digest detail or mode-switch warning. On the branch, 072's I9 rule keeps pause rows out of the readiness owner card (`notify.ts:13`, `:21`).
- **Fix.**
  - Post a daily «планування на паузі з DD.MM (N днів, 0 постів)» note with a Resume button while a `resource:` pause holds the day minimum at 0. Never demote it.
  - Never demote a `dark_day` with 0 out of 3 or more planned.
  - Add a line for every non-off card with no slots to the daily report, and a `resource_paused` digest signal that the tiny view keeps.
  - On a switch to `live` or `approve` while a `resource:` pause is open, ask «Planning is paused since DD.MM. Resume too?».
  - Proposed spec 081.

#### 4. The manager pulled the wrong lever and works from a frozen view — major
*Lenses: CL2, CL3.*

- **Evidence.**
  - The manager ran 7 times for $0.476 and filed 1 directive. `6e4f8ff6` (frequency, «posts per day 2–6 → 3–8») targeted @ai0_global, whose planner never runs. It was filed 11-01 07:00 after 2 refused `file_directive` calls, and expired at 19:47 as `timeout_dropped`, unanswered, 12 h 47 min later. Card 85 shows no expiry date.
  - All 7 reviews answer the same two escalations from 10-27 (`ai_global:posts`, `loko_games:posts`): 14 answers, 13 declines and 1 directive. Four of the 7 repeat a stale «6 днів» figure from `agent_memory` 8, written 10-27 11:47; by the window the silence was 10–12 days.
  - All 7 reviews cite the no-duplicate rule as a reason not to act. Advice `c4be02cf`, `d69ee3cf` and `fdd94fae` has been `evaluated` since 10-22/23 and is still described as open. Verdicts: 6 `continue`, 1 `directives`.
  - `explain_decision` (run `8b407ec4`) returned only «немає активного плану зі слотами», with no pause.
- **Cause.**
  - `file_directive` has no check against `series_pauses` (`directive-tools.ts`). The owner-answer timeout is 12 h (`manager-runner.ts:456-459`, default at `editor.module.ts:1521`).
  - `escalation.ts:243-250` keeps an escalation open while its note is unread, and `checkEscalations` (`directive-tools.ts:160-200`) never closes it. Its days and title are not recomputed.
  - `kpi-digest.service.ts:404-408` keeps evaluated, not-followed advice in `directives.open` for 14 days, and `manager-runner.ts:159-160` labels it «не виконано — ескалюй, не дублюй як пораду».
  - `explain_decision` (`agent-chat-tools.ts:130-170`) never reads `series_pauses`.
- **Status.** New.
- **Fix.**
  - `file_directive` refuses frequency, format_shift and strategy for a resource with an open `resource:` pause, and offers a «resume?» escalation instead.
  - Raise the owner timeout to at least 48 h, or tie it to `review_at`, and print the expiry on the card.
  - Close an escalation when a review answers it, and recompute days from `kpi_snapshots`. Show evaluated advice as closed.
  - `explain_decision` returns open pauses.
  - Proposed spec 081.

#### 5. The pause-lift rules on the branch and in 074 would resume both dead series into a loop — major
*Lens: DT6.*

- **Evidence.** «Білети ПДР» (`6d0f1fdf`, 10-30 08:00) and «Prompt» (`cbaac4f8`, 10-30 18:00) are open with cause `no_material`. pdr shows 844 unposted rows in round 2, and nanobanana shows 65 unposted. Neither number touches the cause: pdr is stuck on the image-less head row 57471 (#9), and most nanobanana rows are unfit (#12). The daily pdr series needs 48 h or more for 3 skips, and «Prompt» about 24 h, so both re-pause at or past the edge of 074's 24 h flapping window.
- **Cause.** On `HEAD`, `readiness/checks/pauses.ts:27` sets `hasMaterial = cycle ? rows − notPostable > 0 : unusedPostable > 0`, and `:62-68` raises `pause_cause_gone` with a `series_resume` fix. «Виправити все» includes it, because `HEAD auto-fix.ts:16` excludes only `bind_dataset`, `dataset_patch` and `source_drop`. 074 (`spec.md:167-180`) lifts a library `no_material` pause after two checks of `unposted > 0`.
- **Status.** On the branch, 072 only suggests the resume; the automatic loop would come with 074.
- **Fix.** Lift or flag a `no_material` pause only on evidence dated after `paused_at`: rows imported or edited after the pause, a different head row for in-order series, or a change to the series source or brief. Count only rows that meet the format's needs (#9, #12). Treat «same reason text twice» as flapping. Keep `series_resume` out of «Виправити все» when the pause reason contradicts it. Amend 072 and 074 (section 4).

#### 6. Agents keep working on paused channels — minor
*Lenses: RT7, DT7.*

- **Evidence.** After its pause, @ai0_global got 7 orchestrator, 5 idea-reviewer and 1 reviewer runs ($0.212) with 19 `add_idea` calls. Of its 9 ideas, 5 expired, 3 are accepted and waiting, and 1 was rejected. Games got 3 orchestrator, 2 idea-reviewer and 1 reviewer run ($0.073) after `18cefb50`. All 7 @ai0_global orchestrator summaries call the breaker pause «планування telegram на паузі за розкладом власника» (e.g. `228e5f5d`).
- **Cause.** `editor.scheduler.ts:178-179` gates `maybeOrchestrate` only on `resource_pauses` (spec 025). `plainPaused` (`:172`) gates only planning and news watch (`:181-187`), and `maybeReview` (`:188`) is not gated. The orchestrator prompt frames the pause as the owner's schedule.
- **Status.** New.
- **Fix.** While a resource-level breaker pause is open, skip the orchestrator, the idea reviewer and the weekly reviewer, or set the idea quota to 0. Tell the orchestrator the real cause (breaker, `no_material`). Proposed spec 080.

### B. The pdr quiz channel

#### 7. The quiz guard reads a 0-based answer key as 1-based, and spec 075 would lock it in — critical
*Lenses: SK2, DT1, RT1, DT2.*

- **Evidence.**
  - **Skips.** 9 pdr slots whose last `publish_post` returned `quiz_answer_mismatch`, costing $0.859: `d52323f4`, `be3ac6b3`, `dd343a6f` and `55378a7c` (10-31); `45a55b80` and `cba9922a` (11-03); `291a9e8b`, `25f478f3` and `9836fd66` (11-04). Eight failed on this guard alone ($0.713). `9836fd66` also had a critic reject (#10) and a brief lint (#8).
  - **What the writer did.** In all 9 runs it marked `answers[num == correct_answer_num]` (7 word for word, 2 shortened), which is the option the explanation supports. The guard demanded `answers[v − 1]`. Example: row 57256 (v = 1), where the writer marked «Перед перехрестям біля лінії розмітки 1.13.» and the guard demanded «Перед знаком.».
  - **The data is 0-based.** All 866 rows store answers as `{num: 0..n−1}`. 239 rows have v = 0 and none has v = n. The 71 rows read in the window have the same shape (19 with v = 0). `apps/pipeline/src/data/normalized/pdr/tickets.json` has 1,640 questions, 510 with v = 0 and 0 with v = n.
  - **Rows burned.** 8 good rows were put aside for round 2: 57829, 57245, 57827, 57258, 57433, 57758, 57242, 57256.
  - **Unchecked rows.** The guard skips v = 0 rows, so both published quizzes (rows 57555 and 57757) were unchecked. 27.6% of rows are never checked.
  - **Long options.** In 8 of the 71 rows read, the correct option is over 100 characters, so an exact match after the 100-character clip cannot pass.
  - **The diagnosis was lost.** The pdr orchestrator (run `0b188075`, 10-30) wrote «УВАГА ВЛАСНИКУ … correct_answer_num у pdr_questions фактично 0-based» in its summary, and 4 of the refused rows came from its ideas. No Inbox note, card or report carries it. The owner saw only «У базі правильна відповідь суперечлива» (note 139, grouped as "other").
- **Cause.**
  - `editor/post/quiz-ground-truth.ts:30` takes `answers[Number(correct_answer_num) − 1]`. `:31` returns null for 0, and `:33` requires exact normalised equality.
  - Everything around it repeats the 1-based premise:
    - the field description (`database/migrations/058_data_store.sql:954`, «1-based»), which agents see in `data_schemas`;
    - the test fixtures, which use 1-based string arrays and not the production `{num, text}` objects (`quiz-ground-truth.test.ts:11-28`, `data-tools.pg.test.ts:70`, `legacy-seed.ts:109`);
    - the owner's series brief (playbook `3d5e470f` v4, «correct_index = correct_answer_num − 1»), which reaches the writer through `series-guard.ts:107`.
  - The scraper reads both `answers[].num` and `correct_answer_num` from the same 0-based attribute (`scrape-pdr-tickets.ts:147`, `:175`). The removed `pdr-quiz.strategy.ts:74-75` matched by `num`.
  - The rows were put aside by the executor's `skip_slot` `ref` (`role-tools.ts:453-455` → `pass-row.ts:21`), not by the fallback ladder.
- **Status.** New. On the branch it gets worse:
  - `quiz-ground-truth.ts` is unchanged on `HEAD`. 073 moves `quiz_answer_mismatch` into `NEVER_PASS` (`HEAD fallback-ladder.ts:243`, `:250`), treating the row as right and the attempt as wrong, and retries with the guard's text «Познач саме її як correct_index» (073 `spec.md:52`).
  - On `HEAD`, `skip_slot` with a ref still calls `passRow` unconditionally (`role-tools.ts:460-462`).
  - Unbuilt 075 hard-codes `base: 1` for `pdr_questions` (`spec.md:85`, A12 `:535`, tests `:287`, `:291`, `:304`, `:307`) and gives the computed `correct_index` to every agent row (A17 `:612-620`). On the real rows, 627 (72.4%) would get the wrong option as the key and 239 (27.6%) would show "This row has no valid answer" (`:169`). Wrong answers would become the only ones the code accepts. 075's own A28 inference (`:745-748`) gives base 0, but it runs only on import.
- **Fix.**
  - Hotfix before deploying wave 1: when options carry `num`, truth is `answers.find(a => a.num === v)`. Otherwise infer the base (any 0 means base 0). A value outside the options is an error, not null. Accept a word-boundary prefix match for options clipped at 100 characters.
  - Migration: correct the 058 description to «0-based; equals answers[].num». Rewrite the fixtures in the production shape from rows 57256 and 57555.
  - `skip_slot` `ref` does not put a row aside when the run's last publish error was `quiz_answer_mismatch`. Re-open the 8 rows.
  - Route an agent's «УВАГА ВЛАСНИКУ» line in `finish_orchestration` to the Inbox.
  - Amend 075 and 073 (section 4). Proposed spec 079.

#### 8. A descriptive sentence in the pdr card brief became a hard "quiz needs a picture" lint — major
*Lenses: SK3, DT3.*

- **Evidence.**
  - 7 paid pdr slots ended on lint `brief_media_missing` for rows with an empty `image_url`, costing $0.651: `a6504ee0`, `cefecc53` and `712653d3` (10-29), `a25e72d3` (11-01), and `31dfcd83`, `dd57003c` and `169d5bdf` (11-02). Six of those rows were put aside.
  - 2 more slots closed at $0: the «Білети ПДР» placeholders `dc2bdedc` and `23233fa9` on row 57471. They led to pause `6d0f1fdf`.
  - 383 of 866 rows (44.2%) have no image. The series brief says «Картинка рядка, якщо є».
  - Replaying the deployed `briefMediaNeed` on the card brief gives `{poll, quiz}`. The quiz part comes only from the hedged sentence «…імовірно, вікторини з ПДР і картинки до них». The brief text comes from a spec-042 setup proposal (`channel_setup_proposals 1c664cce`), not from an owner rule.
  - `31dfcd83` and `169d5bdf` also had answer options over 100 characters (`invalid_args`).
- **Cause.**
  - `brief-media.ts:14` (`ASKS_RE`) allows up to 2 words between «з» and the picture word. `:17-22` and `:28-31` count every format word of a matching sentence.
  - `lint-post.ts:164-165` makes it an error, using the card brief only.
  - Pre-flight `assessRow` (`slot-preflight.ts:211-219`) checks only `post_requires`, which is `[]` for pdr. So image-less rows reach a paid run.
- **Status.** New. `brief_media_missing` is not in `CONFIG_FAILURE_CODES` on `HEAD` (`readiness/slot-config.ts:22-26`). 072 `material.ts` does not compare image fill with the brief. 075 FR-002 sets pdr `post_requires` with no image field.
- **Fix.**
  - Owner: rewrite the card brief (section 6).
  - `briefMediaNeed` skips hedged or descriptive sentences (імовірно, схоже, за постами) and requires the picture word right after the asking verb or preposition. Or use a structured card field `media_required: [formats]`.
  - A series brief that says «якщо є» overrides the card for that series.
  - When a format needs a picture, pre-flight and the planner's row pick treat a row without the dataset's image field as not postable, at $0.
  - Proposed spec 082.

#### 9. An in-order series stalls on one unpostable head row, and agents cannot filter rows by image — major
*Lens: DT4.*

- **Evidence.**
  - On 10-28 08:00 the executor skipped head row 57452 (no image) with a ref, so it was put aside.
  - On 10-29 and 10-30 the planner placed placeholders on the new head 57471 and passed no row. The series paused on 10-30 08:00 (`6d0f1fdf`). Row 57471 has only a round-1 ledger row (id 584), so it is still the head of round 2.
  - In (ticket, question) order, rows with images come in 176 runs averaging 2.74 rows. Only 1.26 rows in a row pass both the guard and the picture lint.
  - 6 pdr planner and orchestrator runs (`df83405e`, `0b188075`, `d0e90e71`, `33d121e1`, `8568f3ed`, `8c37439c`) tried `query_data` with `image_url is_null` and got `field_not_filterable`.
- **Cause.**
  - A planner material skip writes a placeholder with no row ref (`schedule/empty-day.ts:49-55`). Only `skip_slot(ref)` puts a row aside (`role-tools.ts:453`).
  - `schedule.service.ts:382` (`not_next_in_order`) pins the series to the head row.
  - `nextInRound` skips only rows that fail `post_requires` (`data-query.ts:252-253`, `:389-399`).
  - `image_url` is `filterable: false` (`data-query.ts:264-266`).
- **Status.** New. 073 on `HEAD` adds placeholder kinds to `empty-day.ts` but still passes no row. 075 FR-005 and FR-008 do not touch the head row.
- **Fix.** When the planner skips an in-order series for a material reason and names the next row, pass that row for the round. Or give `nextInRound` the series format's needs, so it returns the first row that can make the post. Make `pdr_questions.image_url` filterable or add `has_image`. Proposed spec 082.

#### 10. The critic reads the poll preview's ✅ as reader text and revises quizzes — major
*Lens: CT4.*

- **Evidence.** In slot `9836fd66` (11-04 15:30, row 57466), checkers `909461af` and `47bf1c81` returned revise with `format_fit` 2 for `quiz_answer_revealed` («у пості й досі стоїть ✅»), and the executor then skipped. On `pp1793` the same revise came on pass 1; the executor moved the correct option from index 0 to 1, and pass 2 passed. The `sendPoll` payload never carries the marks. In the window, 5 `submit_critique` calls mention the marks, across 2 slots.
- **Cause.** `role-tools.ts:342` gives the critic `htmlToPlain(g.rendered.preview)`, labelled «## Пост (що побачить читач)» (`critic.service.ts:169`). For a quiz, that preview has ✅ on the correct index and ▫️ on the rest (`render-telegram.ts:222`). `editor-critic-workflow.md:29` then requires `format_fit ≤ 3`.
- **Status.** New. Unchanged on `HEAD` (`role-tools.ts:349`).
- **Fix.** Show the critic the question and options without marks, plus a separate line «ключ відповіді (читач не бачить)». Add one sentence to `editor-critic-workflow.md:29` saying the key line is not published. Proposed spec 084.

#### 11. The pdr and prompts defects never reached the owner or the manager — major
*Lens: CL4.*

- **Evidence.** The answer key caused 9 of 18 pdr skips, yet 0 of 18 cards, 0 of 7 reviews and 0 of 38 audit findings mention it. Review `91dec486` called pdr «ok … ризику якості немає». Card 84 (10-31, 3 such skips by 18:00) says «причини: інше». On 11-03 and 11-04 one post a day went out, so no card. On prompts, cards 90 and 93 say «інше» or «немає свіжого матеріалу», and cards 80 and 82 name only "the library state". 4 of the 6 dark-day cards carry no reason text.
- **Cause.** `skip-reasons.ts:52-59` maps executor cause `quality` to group "other". The Telegram dark-day body (`silent-days.ts:174-181`) carries group labels only; «Latest: <reason>» exists only in the dashboard body (`:165`). `dark_day` needs 0 posts out (`:154`), and `series_missed` covers only series and rule slots (`:190`). The manager digest uses the same grouping (`quality-digest.ts:194`).
- **Status.** Partly fixed on the branch, not deployed: 073 adds catalogue reason text to the dashboard dark-day body and Ukrainian `series_missed` lines. On `HEAD` the Telegram dark-day alert still lists group names only, and `quality` still ends as "other" (`skip-reasons.ts:57-62`).
- **Fix.** Put the latest catalogue reason in the Telegram dark-day alert. Count `skip_slot cause=quality` per dataset and channel; at 3 or more in 7 days, post a `data_quality` note that names the table and row ids, with an "open the dataset" link. Put the top skip-reason texts per resource in the manager digest. Proposed spec 088.

### C. The prompts library

#### 12. Only 12 of 70 nanobanana prompts can be posted, but the catalog reports 65–69 — major
*Lenses: SK4, DT5.*

- **Evidence.**
  - The channel's own skill («nanobanana-github-prompt-post» v5, `d3ef5edb`) skips prompts that need an input photo, have placeholders or run over about 800 characters. Of 70 rows, 12 pass all three rules and 11 of them are unused, about 5.5 days at 2 posts a day. 31 prompts are over 800 characters and 21 are over 1,024.
  - `library_catalog` reported `unposted_here` 69 → 65 and `runway_days` 34.5 → 32.5 over the window.
  - 6 paid quality skips cost $0.446:
    - `b2c588e0` and `98329e88`, both row 71593 («Without changing her original face»);
    - `ce3fd5ab`, an uploaded photo;
    - `480685cc`, row 71599, a 3,500-character JSON prompt against the 1,024-character caption;
    - `b132f7c4`, two input images plus a placeholder;
    - `23c45c3a`, an uploaded photo plus a placeholder.
  - 5 `planner_no_material` placeholders closed at $0: `735bf67d`, `8e08cc58`, `6783da32`, `3f7fbfd6` and `be6eb3ef`.
  - Of the executor's 11 row picks, only 2 were rule-clean (71620, 71609). The prompts agent had 12 rule-breaking ideas, 11 of them accepted or used. The idea reviewer scored them fit 4–5.
- **Cause.** `post_requires` `[[title],[image],[prompt]]` (`data_schemas 85706bd9`) checks only that the fields are filled, so pre-flight passes every row (`slot-preflight.ts:216`, one passing hint is enough at `:197`). The fitness rule lives only in skill prose for the executor, composer and checker. The orchestrator, idea reviewer and catalog never apply it, and the planner applies it unevenly.
- **Status.** Partly covered by unbuilt spec 075, which does not fix it. 075's `postableCount` (FR-008) still counts by `post_requires`, so it would report all 70 rows as postable. Its backfill names `media_field: 'media_url'` (`spec.md:90`), but the dataset's field is `image`, so its field guard (`:80-81`) skips the whole profile.
- **Fix.** Add computed row fields `needs_input_image`, `has_placeholder` and `prompt_chars`, and a derived `self_contained` flag in `post_requires`. Then the catalog, `postableCount`, the idea reviewer and the planner all see 11. Add a per-format length limit (photo caption 1,024). Fix 075's `media_field` to `image`. Proposed spec 083.

#### 13. A row rejected for needing an uploaded photo was planned again and published — major
*Lens: CT5.*

- **Evidence.** In slot `ce3fd5ab` (11-01 18:00), run `2eb3d5f3` skipped row 71595 with a ref: «Промпт вимагає завантаженого фото». No `passed` ledger row was written. On 11-03 04:02 the orchestrator proposed idea `7b92080a` on the same row, with `used_here=false`. The idea reviewer accepted it while noting the photo need. Executor `26a015b9` published it as `pp1810` (slot `def443e2`), because «Тема слота прямо дозволяє вхідне фото». The Haiku checker passed it with non-blocking notes.
- **Cause.** `skip_slot` passes the ref to `passRow` (`role-tools.ts:448-457`). The ledger records only cycle datasets: `content_ledger_pass` returns false unless `reuse_policy.kind = 'cycle'` (`096_data_reuse_rounds.sql:313-317`, `pass-row.ts:6-8`). `nanobanana_prompts` has `reuse_policy: never`, so the rejection is lost. No code enforces the skill's upload markers.
- **Status.** New. 071 skips non-cycle datasets on purpose. 075 proposes `cycle` only for new imports.
- **Fix.** Record a quality skip with a ref on any dataset as a per-resource `rejected` ledger mark. Show it in `query_data` and `library_catalog`, and refuse the same `library_ref` in `publish_post`. Turn the upload markers (uploaded image, upload, reference image, `[placeholder]`) into a lint error for nanobanana posts. Proposed spec 083.

#### 14. story_repeat called a different prompt "the same story" — minor
*Lens: DT8.*

- **Evidence.** Run `da4d2801` (slot `3a3a1c50`, 10-29 14:00) tried row 71620 (75 characters, rule-clean) and got `story_repeat` against the 10-28 16:00 Kyiv post. That post was row 71634 (`pp1780`), a different prompt. The slot was skipped as `source_used` and lost one of the 12 usable rows.
- **Cause.** `editor/story/story-match.ts:287`, after `storyMatch` at `:240`. The likely trigger, not confirmed because post 1780's text is outside the export: shared template lines («💬 Prompt:», «🤖 Модель: Nano Banana Pro»). A multi-word name weighs 3 (`story-match.ts:36-37`), which meets the threshold alone.
- **Status.** New.
- **Fix.** Strip card-template lines before entity extraction. For posts from different `data://` rows of a library dataset, skip `story_repeat` or require a non-template entity overlap. Proposed spec 083.

#### 15. A duplicate prompt, and a series brief that asks for a field the dataset lacks — minor
*Lens: DT9.*

- **Evidence.** Rows 71597 and 71636 carry the same 948-character prompt under two titles. 71597 was published on 11-01 (`pp1802`), so 71636 is a ready repeat. The «Prompt» series brief (playbook `a57be850`) asks for «модель, розмір», which the dataset does not have. The planner cited it on 11-04 (`be6eb3ef`).
- **Cause.** The dedup key is `list_ref` (list page plus entry name). The brief was written for the old PromptHero layout.
- **Status.** Owner data action. 075 FR-006 does not dedup on prompt text.
- **Fix.** Owner: hide 71636 and fix the brief (section 6). Code: `import_list` also dedups on a normalised hash of the prompt text (spec 083).

### D. Sources, freshness and store APIs

#### 16. The Epic adapter publishes a sale window as the giveaway deadline — critical
*Lens: SR1.*

- **Evidence.** There were 7 `epic_free_games` reads of Sorry We're Closed. Two (10-30 04:03 and 04:04) gave the free window, 29.10 15:00Z to 05.11 16:00Z. Five gave a sale window, 19.10 15:00Z to 02.11 16:00Z. The result:
  - Slot `7e25b4c6` was skipped on the 02.11 vs 05.11 conflict.
  - Slot `673323e4` became `planner_source_unreachable` (Epic 403, plus the conflict with GamerPower).
  - Slot `e4412459` published `pp1800`, which says the game is free until 2 November, 18:00 Kyiv. That is 3 days early.
  - That is 3 of the 4 «Роздача дня» slots.
- **Cause.** `common/fetchers/apis/games.api.ts:21-31` keeps a game if any open offer has `discountPercentage === 0`. Then `:33-35` takes the first offer with `endDate > now`, with no start or discount test, and `:51`/`:53` publish its dates. `epic-free-games.adapter.ts:12-16` passes them through. The raw response is not exported, so "the order is not stable" is inferred; the defect does not depend on it.
- **Status.** New. Unchanged on `HEAD`; 076 leaves API adapters out of scope.
- **Fix.** Pick the offer with the filter's own predicate (`start <= now < end && discountPercentage === 0`). Add a unit test with a sale offer and a free offer in both orders. Owner: correct `pp1800`. Proposed spec 086.

#### 17. Sources live in prose: live slots read 1–2 feeds while the agents know 8–11 — major
*Lens: SR3.*

- **Evidence.**
  - `editor_channels.sources` is `[]` on all 5 cards. The news feeds exist only in owner memory rule id 3.
  - The orchestrators read 8 (news) and 11 (games) distinct feeds without errors. Live slots read 2 (news) and 1 (games).
  - All 14 news live slots used Verge and TechCrunch. TechCrunch wrote 11 of the 16 news posts and Ukrainian sources wrote 0, although `content-sources.md:34` asks for other feeds once one site has half of the week's posts.
  - 8 of the 10 `fetch_feed` errors were guessed URLs (for example `dev.ua/feed` 404 three times, while `dev.ua/rss` worked). The guessed Steam feed `app/2284190` returned a 2023 post and is part of skip `04f476d2`.
- **Cause.** With no card sources, a live slot reads whatever URLs the Haiku planner writes. `live/feed-items.ts:176` accepts any http(s) URL from the slot, and the card fallback (`live-slot.ts:69-71`, `:120`) is empty. Nothing stores a feed that worked, so each orchestrator run guesses again.
- **Status.** Partly covered. 076 on the branch checks declared sources only; here it would report `card_without_sources` («writes from its brief only», `source-findings.ts:186-191`), which is wrong for these channels. Unbuilt 077 writes probe-OK sources into the card only when the owner runs `/launch`.
- **Fix.** Owner: put the working feeds into the cards (section 6). Code: live slots read all of the channel's card rss feeds (at least 2 hosts) instead of the planner's pick. After a successful read, the orchestrator proposes a card-source add through `change_source`, probed by 076. Proposed spec 085.

#### 18. Freshness windows do not fit the slot times or the feeds' clock — major
*Lenses: SR4, CT7, SK8.*

- **Evidence.**
  - News live slots with `max_age` of 8 h or less published 4 of 7, and all 3 skips were among them. Slots with 10 h or more published 7 of 7.
  - Items used at 07:00 UTC were 7.8, 5.7, 9.1 and 9.1 h old. 121 of 134 Verge/TechCrunch items (90%) were published between 12:00 and 24:00 UTC.
  - `pp1801` went out on a source 39 h old (the critic noted «stale_source (39 год) лишається» and passed it). The same day, `7dd283cb` was stopped at «37 год … (від появи ідеї)», while its Verge source was really 46.6 h old.
  - `41a973b8` passed pre-flight with one stale dated TechCrunch hint and two undated hints. It cost $0.183 before the executor skipped it on a source about 44 h old.
- **Cause.**
  - `live/live-slot.ts:16` (`LIVE_DEFAULT_MAX_AGE_HOURS = 6`, used at `:125`) and `editor-planner-workflow.md:24` («типово 6 год») contradict `content-sources.md:37` (news 36 h, games 72 h). News watch uses 3 h (`news-watch-config.ts:20`). No per-channel or per-series max age exists.
  - Pre-flight ages an undated URL by the idea's `created_at` (`slot-preflight.ts:232-236`), and one passing hint is enough (`:197`).
  - `stale_source` is only a warning (`post/integrity/codes.ts:41`).
- **Status.** New. 074 reuses the 6 h constant for its feed-clear test (`spec.md:427`).
- **Fix.** Make freshness a card or series setting, or derive it from the slot hour and the feeds' clock: about 12 h for 07:00–12:00 UTC slots on US feeds, and 24 h for games at weekends. Store the source item's date on the idea and let pre-flight age by it. When any dated hint of an idea is stale, use the oldest dated hint. Set the idea's `expires_at` to min(TTL, source date + stale limit). Make `stale_source` an error on news, unless the story is a follow-up with dated new facts. Proposed spec 085.

#### 19. News watch never ran because the news card has no feeds — major
*Lens: SR5.*

- **Evidence.** `news_watch_log` has 0 rows and the log has 0 news-watch lines. The @ai0_news_dev card has `sources: []`. Its brief matches `NEWS_RE`, so the missing rss sources are the only thing keeping the watch off.
- **Cause.** `news-watch-config.ts:77-78` returns null when the card has no rss source, and `isNewsCard` (`:35-37`) also requires one.
- **Status.** Owner data action. The code works as designed.
- **Fix.** Add the feeds to the card (#17); the watch then turns on by itself. Optionally, let `newsWatchConfig` read feeds from the memory rule when the card has none.

#### 20. Store and aggregator pages refuse the server (403), and no note reaches the owner — major
*Lens: SR6.*

- **Evidence.** `source_host_failures`: `store.epicgames.com` 403 (strikes 3, blocked to 04.11), `itch.io` 403 (strikes 3), `gamerpower.com` 403 (the API still answered), `ign.com/feed.xml` 403, and `marktechpost.com` pages 403 (strikes 4, blocked to 10.11; its feed still reads). They contributed to skips `b1af47a7` and `673323e4`. The window's Inbox has no `host_struck` or `source_failing` note. The hosts appear only passively in the dashboard Sources section (`otherHosts`).
- **Cause.** `noteStruckHosts` (`source-health.service.ts:76-98`) considers only card and playbook sources, and these channels declare none. Undeclared blocked hosts reach only `sourceHealthReport.otherHosts` (`source-health.ts:181-186`), which is never posted.
- **Status.** Partly fixed on the branch, not deployed. 076 adds an egress proxy (FR-003) and page upload (FR-005), both needing owner setup. Its FR-006 posts `host_struck` notes daily, but on `HEAD` `noteStruckHosts` still uses `sourcesOf`, so these hosts would still raise no note.
- **Fix.** Deploy 076 and configure the proxy for these hosts. `noteStruckHosts` also notes hosts in `otherHosts` once they reach `STRIKES_FOR_OWNER`. Proposed spec 086.

#### 21. steam_deals gives no deadline, so «Знижки тижня» cannot be written — major
*Lens: SR7.*

- **Evidence.** 6 `steam_deals` reads between 10-29 and 11-01 returned 3, 2, 2, 2, 3 and 4 items, none with an end date. In slot `c36c80b9`, only one game with −50% or more had a verified deadline. The series brief requires before/after prices and a deadline in an album. The series paused on 10-30 16:00 (`3378a2e5`) and is inactive in playbook v10.
- **Cause.** `games.api.ts:120-145` (`mapSteamDeal`) maps no expiry, and `steam-deals.adapter.ts:33-36` puts no `ends_at` in `extra`. The source is the short curated `featuredcategories` specials list (`games.api.ts:12`, `:107-110`).
- **Status.** New.
- **Fix.** Map the specials item's discount expiry to `extra.ends_at` and `ends_at_local` (confirm the field against a live response). Add a deeper deals source so an album gets 3 or more items. Proposed spec 086.

#### 22. GamerPower deadlines without a zone move to the next day in Kyiv — minor
*Lens: SR9.*

- **Evidence.** «2026-11-05 23:59:00» becomes «06.11, 01:59 (Київ)» for Sorry We're Closed and Galaxy Kart, and the planner then cited «GamerPower (06.11)» as a conflict. 23 of 28 GamerPower items in the window had such a zoneless end.
- **Cause.** `editor/tools/local-time.ts:13-14` and `:22` append `Z` to zoneless strings, but GamerPower's 23:59 is an end-of-day marker.
- **Status.** New.
- **Fix.** For a zoneless end at 23:59, emit a date-only field («до 5 листопада»). Prefer the store's own instant when both exist. Proposed spec 086.

#### 23. Epic's upcoming offers are ignored, so the Thursday rotation lands after the morning plan — minor
*Lens: SR10.*

- **Evidence.** The 10-29 04:04 read listed only the outgoing games, so slot `b1af47a7` (10:00) became `planner_no_material`. Sorry We're Closed went free at 15:00Z.
- **Cause.** `games.api.ts:23` reads only `promotionalOffers`, never `upcomingPromotionalOffers`. The planner runs at 06:00 Kyiv.
- **Status.** New.
- **Fix.** Return upcoming offers with `starts_at` and `starts_at_local`, so the planner can put Thursday's slot after the rotation. Proposed spec 086.

### E. The critic and what shipped

#### 24. The critic cannot see fetch_api data — major
*Lenses: CT2, SK6.*

- **Evidence.**
  - `pp1800` (giveaway, 11-01): the critic had `source_coverage: none` and passed the post as «для роздачі це прийнятно». The post says "first-person", but the API summary does not.
  - Slot `7e25b4c6` (10-30): `fetch_api` said 02.11, and the planner's topic said 05.11. Checkers `b5a5f8f0` and `856a172c` marked the correct date as blocking («Замінити строк на 5 листопада, як у слоті»), and the retry skipped ($0.119).
  - The critic does see dataset rows, through `library_ref` (`critic-gate.ts:253-265`). Only `fetch_api` is missing.
- **Cause.** `critic-gate.ts:134` `READ_TOOLS` = `web_fetch`, `fetch_feed`, `extract_images`, `read_doc`, `find_in_doc`. `wrapTools` (`:196-207`) never captures `fetch_api`, so `readTextOf` (`read-capture.ts:181-195`) returns null. The slot topic reaches the critic as «Тема» (`critic.service.ts:166`) and is treated as the reference.
- **Status.** New. `editor/critic/` is unchanged on `HEAD`. 077 gives the critic the series note, not tool outputs.
- **Fix.** Add `fetch_api` to `READ_TOOLS` and store each item (title, summary, `extra` including `ends_at_local`) as full coverage. In `editor-critic-workflow.md`, say that the slot topic is the planner's plan, not a source. The planner writes no dates or numbers into a topic unless it copies them from a tool result. Proposed spec 084.

#### 25. None of the 9 library posts credits its source — major
*Lens: CT1.*

- **Evidence.** The 4 prompt posts (`pp1797`, `1802`, `1807` and `1810`) copy CC BY 4.0 prompts with no author. The `nanobanana_prompts` schema says «credit the author and the source». Slot `ac5ac135` asked for the author, and checker `20a5642f` refused it as a channel rule. The 5 ПДР posts (`pp1790`, `1793`, `1803`, `1809` and `1812`) never name pdr-online.com.ua. The schema says «Credit it when the license is unknown». 0 of 47 executor `query_data` calls on `pdr_questions` asked for `source_name` or `license`.
- **Cause.** The owner skill `d3ef5edb` v5 §4 forbids any author or link (owner rule). That contradicts `editor-skills/source-licensing.md:27-28` and `content-sources.md:22`. No code check enforces credit at `1ecb8160` or `HEAD`.
- **Status.** Partly covered by unbuilt spec 075: `credit_fields ['author']` for nanobanana only (`spec.md:90`). Credit guards are under "Not doing" (`:275`, Q4 `:320`, L1 `:342`), and pdr gets no `credit_fields`.
- **Fix.** Owner decision first (section 6). Then build 075 `credit_fields`, including `source_name` for pdr, and add a lint error `credit_missing` for CC BY or unknown-licence rows. Proposed spec 087.

#### 26. 7 of 16 news posts keep untranslated English quotes — major
*Lens: CT3.*

- **Evidence.** 10 Latin-only «…» fragments in 7 posts: 7 are quoted speech in 5 posts, and 3 are names. In `pp1801`, pass 1 (`f27dd4a1`) objected to a faithful translation of «quite terrible», the rewrite switched to English, and pass 2 passed it. The channel's audience is «Широка українськомовна аудиторія».
- **Cause.** `editor-critic-workflow.md:14` gives grounding 5 only when every quote is in the source text, and `:34` makes a quote absent from the source a blocking error. A translation therefore looks unsupported. The lint checks only a 60% Cyrillic share (`lint-post.ts:271-274`), even though its own message asks to retell English quotes.
- **Status.** New.
- **Fix.** Add a lint warning `foreign_quote` for «…» with 2 or more Latin words and no Cyrillic (names and glossary terms excepted). Let the critic accept a faithful translation, with the original wording in its passages. Add a rule to `grammar-ua.md`. Proposed spec 084.

#### 27. The verdict code turns passing verdicts into revise — minor
*Lenses: SK5, SR8.*

- **Evidence.**
  - `92ead6c5` (games, 10-30 14:00): the model said pass, with scores 4–5 and rule checks #9 and #10 kept. Because the `owner_rules` score was missing, the reason became `cap_revise: owner_rules_missing: #10, #9` ($0.196, 5 runs). This happened in 1 of 51 accepted critiques.
  - `a330da93` (10-31 07:00): pass 2 returned `pass_with_edits` with all scores 4 or more. The code still revised, most likely on hard lint `number_not_in_sources` («нижче 20» for "drops into the teens"). The retry's critic then demanded «10–19 fps», and the slot ended `cap_revise` ($0.226).
- **Cause.** `critic.service.ts:279`: when `owner_rules == null`, every rule counts as missing. `critic.ts:208` then revises, and at the pass cap a revise is a skip. `critic.ts:170` (`HARD_LINT_CODES`) and `:231` force revise on pass 2 for a number the code does not find literally (`critic.service.ts:385-387`). Both follow spec 041 FR-005 and spec 067.
- **Status.** New. Unchanged on `HEAD`.
- **Fix.** Derive `owner_rules` from `rule_checks` when the score is missing (5 when all are kept). A pass-2 `previous_checks` "fixed" on the flagged item clears `number_not_in_sources`, and derived bounds ("teens" → "below 20") are accepted. Store the pass-2 decision reason. Proposed spec 084.

#### 28. The critic names language and meaning defects, then passes them as advice — minor
*Lens: CT6.*

- **Evidence.** In 5 posts, a named defect stayed in the text:
  - `pp1785` «трівіалізувати»;
  - `pp1798` «при оцінці»;
  - `pp1783`, a sentence the critic itself called hard to read;
  - `pp1813`, «оцінили … $35 млрд», while the source says investors cut the valuation to about $35 billion;
  - `pp1796`, where the critic's own edit left two colons in one sentence.

  30 of 32 final critic notes contain advice. 10 of the 15 quoted issues in final critic records are still in the published text.
- **Cause.** On pass 2, `decideVerdict` passes everything without a blocking issue (`critic.ts:235-237`). On pass 1, language 4 with no blocking issue passes (`:245-252`). The relint after model edits (`critic-gate.ts:540-547`) has no punctuation check.
- **Status.** New.
- **Fix.** Every quoted language or meaning issue becomes an exact edit (`pass_with_edits`), not advice. Add the found calques to the lexicon, and add a relint warning for two colons in one sentence. Proposed spec 084.

#### 29. No control token came close to publishing, but the editor path has no guard for one — minor
*Lens: CT8.*

- **Evidence.** `bot_logs` has 0 rows in the window. The 12 old error rows shown in `db/state.txt` (`SKIP_POST`, «rate limit», empty messages) come from the legacy strategy path, which was removed in `b77b7687`. 0 of 77 `publish_post` drafts contained a blocked pattern. One process leak reached the critic and was marked non-blocking: «(дані з API Epic: …)» in run `ba246ee5`.
- **Cause.** `scripts/server-snapshot.sh:98-99` selects `bot_logs` with no window. The legacy guard `TelegramPublisher.guardText` (`publishers/telegram.publisher.ts:23-55`) is not used by the editor publisher (`telegram-editor.publisher.ts:50-52`). `PROCESS_LEAK_EXPLICIT/SOFT` (`process-leak.ts:11-20`) lacks these phrases.
- **Status.** New.
- **Fix.** Add a window and `ORDER BY created_at DESC` to the snapshot query. Port `BLOCKED_PATTERNS` into the editor lint as `process_leak`, and add «з api», «дані з api» and «api epic». Proposed spec 087.

### F. Owner surface and ops

#### 30. The Meta signal is noisy and mis-aimed; a Facebook page-token failure was never carded — minor
*Lenses: CL7, RT5, RT6.*

- **Evidence.**
  - 4 critical cards (77, 78, 88 and 89) for two Threads accounts that expired in August. No active playbook uses them; `cf8548a5` appears only in one superseded playbook. Card 88 shows three different ages.
  - `page_views_total` on facebook/1391025657426668 failed with Graph code 190 («must be called with a Page Access Token») on all 153 hourly runs. It never backed off and never made a card.
  - `tracking.roi` got `http_401` on 10-17 and 10-28 through `ANTHROPIC_API_KEY`. It made no calls in the window.
- **Cause.** `resource-health.service.ts:60-61` sends a daily critical reminder for every bad resource, with no relevance check. Critical notes are never demoted (`owner-inbox.ts:134`). `meta-insight-backoff.ts:19` puts 190 in `UNCOUNTED_GRAPH_CODES`, so `:96` returns before counting a strike. The ROI analyzer uses `ClaudeAgent` (`claude.agent.ts:20`), not the editor key.
- **Status.** New; the credentials are an owner data action.
- **Fix.** Send the reminder as critical only for resources in an active playbook, and otherwise as info. Merge reminders per provider and show one age, measured from the real expiry. Count a 190 that names "Page Access Token" as a metric-level failure, so the 24 h back-off applies. Owner: section 6. Proposed spec 088.

#### 31. The weekly audit pointed away from the week's problems — minor
*Lens: CL8.*

- **Evidence.** Audit `f7203821` (card 87) had 38 findings: 30 info, 7 warn and 1 error. All 25 one-click fixes are `skill_disable`. Its second point, «publish_post падає в 46% викликів», counts gate refusals (25 `critic_revise`, 13 `lint_failed`, 5 `story_repeat`) as failures and advises checking tokens. It had 0 findings on paused or silent channels, the pdr dataset or tokens.
- **Cause.** `sysadmin/checks/tools.ts:8-19` counts every tool error. `ALL_CHECKS` (`checks/index.ts`) covers only skills, memory, rules, tools and prompt.
- **Status.** New. 072 declines a weekly channel audit area (`spec.md:236`).
- **Fix.** Report gate codes apart from tool errors. Add checks for a live channel with 0 posts for 3 or more days, a `resource:` pause older than 48 h, and a dataset with 3 or more quality skips in 7 days. Rank `skill_unused` below these. Proposed spec 088.

#### 32. A card closed by code is labelled as resolved by the owner — minor
*Lens: CL9.*

- **Evidence.** Card 83 (event «Phantom Blade Zero», note 136) was closed at 11-01 22:02 with «Вирішено в дашборді» and `resolved_by` null. The owner made no dashboard request that day.
- **Cause.** `event-watch.ts:74-83` (`closeSettled`) marks the note read. `owner-bot.service.ts:162-164` then labels every card whose note is no longer waiting as «Вирішено в дашборді».
- **Status.** New. 074 FR-005 presets an outcome only for auto-resumed pauses.
- **Fix.** Closes made by code set an outcome such as «Закрито автоматично: подія минула без підсумку». Use «Вирішено в дашборді» only when a dashboard request set `read_at`. Proposed spec 088.

### G. Runtime and cost

#### 33. 38% of spend goes to slots that end skipped, because material checks run after the Sonnet writer — major
*Lens: RT2.*

- **Evidence.** $3.15 of $8.29 went to skipped slots. Of each channel's spend, this was pdr $1.51 of $2.08, games $0.85 of $1.89, prompts $0.53 of $0.98 and news $0.26 of $2.65. On pdr, #7 and #8 together account for 16 of the 18 skipped slots and $1.51. The Haiku planner caught the missing picture twice at $0.
- **Cause.** The brief-media lint (`lint-post.ts:164-165`) and the quiz guard (called from `role-tools.ts:204`) run only inside `publish_post`, after the executor has written the post. `query_data` filters only by `post_requires` (`data-query.ts:252-253`).
- **Status.** Partly covered. On the branch, 073 adds `checkSlotConfig` before the paid run, but it checks config only (series, format, source, tools), not row material. 075 and 077 are unbuilt.
- **Fix.** Run the brief-media check, the answer key (after #7) and the caption-length check when the planner binds a row, and again in the pre-run check (073's `checkSlotConfig` is the natural hook). Skip with a code reason at $0. Code can catch about $1.25 per window (brief-media $0.80 and prompts quality $0.45); fixing #7 turns its $0.86 into posts. Proposed spec 082.

#### 34. The executor re-writes its ~27k-token prompt prefix on every run; 053's target is not met — minor
*Lens: RT3.*

- **Evidence.** Cache writes are $4.78 of the executor's $5.80 (82%). The first call averages 27.2k tokens, against FR-001's ≤22k. 63 of 69 first calls read 0 tokens from cache. In 11 cross-channel pairs at shared slot times, the second request started 0.01–0.35 s after the first and wrote the full prefix again. The "after deploy" row in `specs/053-token-economy/tasks.md` is empty.
- **Cause.** `editor.scheduler.ts:218` (`runLimited`, `EXECUTOR_PARALLEL=2` at `:98`) starts two due slots at once, before either has written the cache. The shared ~17.9k-token tool block dominates the prefix. The 5-minute cache does not survive the hours between slots.
- **Status.** Partly covered by spec 053 (built). Its FR-001 acceptance is not met, and the FR-008 static-block split was deferred.
- **Fix.** Start the second parallel executor only after the first one's first response (about $0.47 per window). Trim tool schemas toward 22k (about $0.9 per window). Keep the 1-hour cache off; it is roughly break-even, since 27 of 69 runs start within 60 minutes of another run. Fill in the 053 measurement row. Proposed spec 089.

#### 35. Avoidable tool errors add turns — minor
*Lens: RT8.*

- **Evidence.** 169 of 1,272 tool calls failed (13%). Executor `query_data` failed 23 of 59 times, all `unknown_field` and all on pdr. All 22 pdr executor runs began with a failing query (21 asked for `question`; the field is `text`). The 4 Postgres ERROR lines are agents' `sql_readonly` guesses, each followed by a «no transaction in progress» warning.
- **Cause.** `executorUserPrompt` (`roles/prompts.ts:240-262`) names the `data://` ref but no fields. `query_data` returns the field list with the error (`data-query.ts:229`), so it costs one extra turn. `readonly-query.service.ts:47` rolls back on purpose, so that `columnsOf` (`:48`) can run; the `finally` at `:51` then sends a second ROLLBACK.
- **Status.** New.
- **Fix.** Put the dataset's field list in the executor's slot context, or let `query_data` drop unknown fields and return the rows with a note. Keep the ROLLBACK at `:47` and skip the one in `finally` once the catch has rolled back. Optionally remove `sql_readonly` from the planner and the reviewer. Proposed spec 089.

#### 36. Postgres sends about 2.8 GB a day, and the snapshot cannot say which queries — minor
*Lens: RT4.*

- **Evidence.** The Postgres container sent 80 GB in 28.4 days, and the automation container received 23 GB in 6.4 days. The dashboard (16.5 MB out), writes (WAL 64–70 MB per full day) and the backup sidecar (not running) are ruled out. Postgres CPU was 7.5% and the host load 0.38.
- **Cause.** Not attributable: the snapshot has no `pg_stat_statements` or `pg_stat_database` counters. Inbound bytes include TCP ACKs, so they do not give a statement rate.
- **Status.** New.
- **Fix.** Enable `pg_stat_statements`. Add the top 20 statements by rows and by calls, `tup_returned`/`tup_fetched`, and a 10-minute NET delta per container to `scripts/server-snapshot.sh`. Proposed spec 089.

## 4. Wave 1 and the unbuilt specs

### What deploying wave 1 (072/073/076) would change

**On this window's skips: almost nothing.** None of the 32 paid skips would have become a $0 stop or a Readiness blocker.

- **073 config is not content.**
  - It moves `quiz_answer_mismatch` into `NEVER_PASS` (`HEAD fallback-ladder.ts:243`). That affects only the runner's ladder path (`editor-runner.service.ts:777`), which did not fire this week. The 8 pdr rows were burned by `skip_slot` `ref`, which 073 does not touch (`HEAD role-tools.ts:460-462`).
  - **Danger.** Its ladder retry uses the guard's own text «Познач саме її як correct_index» (073 `spec.md:52`), which on this data names the wrong option. Its owner-facing reason text (`reasons/catalogue.ts:66-67`) tells the owner the writer is wrong. Deploy only after 079.
  - `checkSlotConfig` checks config, not row material. `brief_media_missing` is not a config code (`HEAD readiness/slot-config.ts:22-26`), so #8 still runs paid and counts as `no_material`.
  - It adds reason text to the dashboard dark-day body and Ukrainian `series_missed` lines. The Telegram dark-day alert still lists group names, and `quality` still maps to "other" (#11).
- **072 channel doctor.**
  - Open pauses show as `info` (`checks/pauses.ts:71`, `:90`), and the owner-bot card names only errors (`notify.ts:13`, `:21`). No check flags a live channel with an open resource pause and 0 slots (#1, #3).
  - `pause_cause_gone` offers `series_resume` inside «Виправити все» for «Білети ПДР» and «Prompt», whose causes are not gone (#5).
  - `material.ts` warns `dataset_post_requires_missing` for pdr, but compares neither image fill with the brief nor the answer key.
  - `card_without_sources` («writes from its brief only») misdescribes the news and games channels, which write from feeds kept in a memory rule (#17).
- **076 sources proven from the server.**
  - The proxy and page upload help the 403 hosts only after owner setup (#20).
  - Probes, notes and the doctor see only declared sources, and these channels declare none. So `host_struck` notes would not fire for `store.epicgames.com`, `itch.io` or `marktechpost.com`.
  - The feeds behind the freshness skips loaded fine, so 076 does not change #2 or #18.

**Amend before deploying wave 1.**
- 072: never put `series_resume` in «Виправити все» when the pause reason contradicts `pause_cause_gone`. Make a live channel with an open `resource:` pause and 0 slots for 24 h an `error` with a bot card.
- 073: drop the guard-text retry for `quiz_answer_mismatch` until 079 ships, or make it «познач варіант, у якого num = correct_answer_num».

### What 074 must cover

1. **FR-005 library clear-check** (`spec.md:173`, `unposted > 0`) would lift «Білети ПДР» (844 unposted, head row 57471 has no image) and «Prompt» (about 65 unposted, about two thirds unfit). Lift only on evidence dated after `paused_at`, and count only rows that meet the series format's needs.
2. **Flapping.** The 24 h window (`spec.md:167`) misses a re-pause that takes 48 h (daily pdr) or about 24 h («Prompt»). Also treat "same reason text twice" as flapping.
3. **`resource:` pauses stay with the owner** (`spec.md:162`, `:268`) with no reminder, report line or digest detail. This window shows the owner does not act on them (0 resumes in 7 days). Add an automatic lift for streaks made only of freshness and planner no-material closes, or a maximum age with a re-probe (spec 080).
4. **FR-007** is right; keep it. Expect +3 «Роздача дня» and +1 «MCP-сервер тижня» slots per window like this one. «AI-новини дня» stays paused, because its `free` source lifts only when it changes (`spec.md:172-176`).
5. **The feed-clear test** uses the 6 h `LIVE_DEFAULT_MAX_AGE_HOURS` (`spec.md:427`). Use the channel or series freshness from spec 085.
6. **Making «Prompt» required and in order** (074 `:314`, 075 `:311`) starts at rows 71590 (1,007 characters) and 71591 (input photo), so it would hit the head-row stall (#9). Do it only together with row fitness (083) and passing the head row on a planner skip (082).
7. **Preset outcomes.** FR-005 step 3 sets one only for auto-resumes. Extend it to every code close, including `event-watch` (#32).
8. **FR-008** rewrites the banner but gives no warning on a mode switch while a `resource:` pause is open (#3).

### What 075 must cover

1. **The answer-key base is wrong.** `pdr_questions` must be `base: 0`, or better `match_by: 'num'` when options carry their own key. This affects `spec.md:85`, A12 `:535`, and the tests at `:287`, `:291`, `:304` and `:307`, which must use 0-based `{num, text}` fixtures from rows 57256 and 57555. Add an acceptance case: `answerOf(row 57256)` = «Перед перехрестям біля лінії розмітки 1.13.». Run A28 inference on the backfill too, and make migration 099 refuse base 1 when any value is 0.
2. **Fix the narrative.** `:16` and `:307` («refuses the off-by-one») say the brief's «−1» was the bug; on this data it is the other way round. A31 `brief_index_arithmetic` (`:776-784`) would steer the owner to delete the «−1» and trust base-1 code. Fix 073 `:47`/`:52` and 077 `:20` the same way.
3. **The nanobanana `media_field`** is `'media_url'` (`:90`), but the field is `image`. The FR-002 field guard (`:80-81`) would skip the whole profile.
4. **`postableCount`** (FR-008) counts by `post_requires` and would report 70 postable rows (65 unposted). It needs a per-dataset row-fitness predicate (spec 083) before it feeds 074 and 077.
5. **Format media needs.** There is no `media_field` for pdr (`image_url`), and nothing compares a format's picture need with 56% image fill (#8).
6. **Credit.** `credit_fields` exist only for nanobanana. pdr needs `source_name`. "Credit guards" under Not doing (`:275`, Q4, L1) needs an owner decision, because the owner skill forbids the author line (#25).
7. **Reuse.** The existing `nanobanana_prompts` stays `never`, so rejected rows come back (#13). Either propose `cycle` for existing library datasets or add a per-resource `rejected` mark (083).
8. **Import dedup** on prompt text (#15).

### What 077 must cover

1. It changes nothing for running channels. It writes probe-OK sources into the card only when the owner runs `/launch` (`spec.md:78`). Running channels need the source proposal from spec 085.
2. Its runway reads the same `postableCount` and would report about 32 days for prompts.
3. It infers formats only at bring-up (`spec.md:149`), so a misread brief on a running channel (#8) is not addressed.
4. It gives the critic the series note (`spec.md:174-178`) but not tool outputs (#24).
5. `spec.md:20` repeats the wrong off-by-one story.

## 5. New work not covered by any spec

Spec numbers 079–089 are free (`specs/` ends at 078 on `HEAD` and on every local branch).

| Spec | Priority | Covers |
|---|---|---|
| 079 Quiz answer key read from the data | P0 hotfix, before wave 1 | #7 |
| 080 Paused channels come back | P0 | #1, #2, #6 |
| 081 Owner and manager see a dark channel | P1 | #3, #4 |
| 082 Material checked before the paid run | P1 | #8, #9, #33 |
| 083 Library rows that can be posted | P1 | #12, #13, #14, #15 |
| 084 Critic sees API data and the reader's view | P1 | #10, #24, #26, #27, #28 |
| 085 Card sources and freshness that fits the clock | P1 | #2, #17, #18, #19 |
| 086 Store API adapters tell the truth | P0 (small) | #16, #20, #21, #22, #23 |
| 087 Credit and process-leak guards | P2 | #25, #29 |
| 088 Owner signal quality | P2 | #11, #30, #31, #32 |
| 089 Runtime hygiene | P3 | #34, #35, #36 |

**079 Quiz answer key read from the data**
- `quiz-ground-truth.ts`: when options carry `num`, truth is `answers.find(a => a.num === v)`. Otherwise infer the base (any 0 means base 0). A value outside the options is an error, not null. Accept a word-boundary prefix match for options clipped at 100 characters.
- Migration: correct the `correct_answer_num` description (058:954) in `data_schemas`. Rewrite the fixtures in the production `{num, text}` shape from rows 57256 and 57555.
- `skip_slot` `ref` does not put a row aside when the run's last publish error was `quiz_answer_mismatch`. Re-open the 8 round-2 rows (57829, 57245, 57827, 57258, 57433, 57758, 57242, 57256).
- An agent's «УВАГА ВЛАСНИКУ» line in `finish_orchestration` becomes an Inbox note.
- Amend 073 (retry text) and 075 (`base`, tests, narrative) in the same change.

**080 Paused channels come back**
- A `resource:` pause whose streak came only from `no_fresh_item` (feeds read OK, `dropped.old > 0`) or `planner_no_material` lifts at the next plan hour, with a note. Repeated lifts back off to once a day.
- Plain-slot streaks need 2 calendar days with 0 posts, or exclude single-feed live slots.
- `resource:` pauses get a maximum age (e.g. 72 h) with a re-probe of the channel's feeds and accepted ideas.
- While a channel's planning is paused, the orchestrator, idea reviewer and weekly reviewer do not run, or the idea quota is 0. The orchestrator is told the real cause.
- Depends on 074 FR-007.

**081 Owner and manager see a dark channel**
- A daily «планування на паузі з DD.MM (N днів, 0 постів)» note with Resume, never demoted. `dark_day` with 0 out of 3 or more planned is never demoted.
- A daily-report line for every non-off card with no slots, and a `resource_paused` digest signal (key, `paused_at`, streak, reason) kept in the tiny view. `explain_decision` returns open pauses.
- `file_directive` refuses frequency, format_shift and strategy on a paused resource and offers a «resume?» escalation. The owner timeout is at least 48 h or tied to `review_at`, and the card shows the expiry.
- An escalation closes when a review answers it and re-opens only on a new trigger. Its days are recomputed from `kpi_snapshots`, and its memory line is retired.
- Evaluated, not-followed advice is listed as closed. The manager may file a different kind or ask the owner.
- A switch to `live`/`approve` while a `resource:` pause is open asks «Resume too?». The Telegram pause card says the channel publishes nothing until Resume.

**082 Material checked before the paid run**
- `briefMediaNeed` reads only imperative sentences, or a structured card field `media_required: [formats]`. A series brief that says «якщо є» overrides the card. `brief_media_missing` against a dataset row is a config conflict, not `no_material`.
- When the planner binds a row and in the pre-run check (073's `checkSlotConfig`): brief media against the row, answer key (after 079), and caption length per format. A failure is a $0 skip with a code reason.
- When a format needs a picture, `nextInRound` and the planner's row pick return the first row that has one. Make `pdr_questions.image_url` filterable, or add `has_image`.
- A planner material skip of an in-order series that names the next row passes that row for the round.
- The executor's slot context lists the dataset's field names.

**083 Library rows that can be posted**
- A per-dataset row-fitness predicate on `data_schemas`. For nanobanana that is computed fields `needs_input_image`, `has_placeholder` and `prompt_chars`, plus a derived `self_contained` flag in `post_requires`.
- The predicate feeds the postable count, `library_catalog`, pre-flight, the idea-reviewer context and 075's `postableCount`.
- A quality skip with a ref on any dataset writes a per-resource `rejected` mark. `query_data` and the catalog show it, and `publish_post` refuses that `library_ref`.
- A lint error for upload markers (uploaded image, upload, reference image, `[placeholder]`) on nanobanana posts.
- `story_repeat` strips card-template lines, and needs a non-template entity overlap between different `data://` rows.
- `import_list` dedups on a normalised hash of the prompt text.

**084 Critic sees API data and the reader's view**
- Add `fetch_api` to `READ_TOOLS`, and capture each item (title, summary, `extra` including `ends_at_local`) as full coverage.
- The slot topic is labelled as the planner's plan, not a source. The planner copies dates and numbers into a topic only from a tool result.
- A quiz reaches the critic as question and options without marks, plus a separate key line.
- `owner_rules` is derived from `rule_checks` when the score is missing. A pass-2 "fixed" clears `number_not_in_sources`, and derived bounds are accepted. The pass-2 decision reason is stored on the run.
- Every quoted language or meaning issue becomes an exact edit. The found calques go into the lexicon. Add relint warnings for two colons in one sentence and for `foreign_quote`, and accept faithful quote translations.

**085 Card sources and freshness that fits the clock**
- After a successful feed read, the orchestrator proposes adding the feed to the card through `change_source`, probed by 076. Running channels get the same proposal 077 makes at `/launch`.
- Live slots read all of the card's rss feeds (at least 2 hosts), not the planner's single pick.
- Freshness is a card or series setting, or derived from the slot hour and the feeds' publishing clock, with a weekend default. It replaces the hard-coded 6 h in `live-slot.ts:16`, the planner workflow and 074 `:427`.
- An idea stores its source item's date. Pre-flight ages by it, or by the oldest dated hint, and the idea's `expires_at` is min(TTL, source date + stale limit). `stale_source` is an error on news unless the story is a dated follow-up.
- Per-feed exclude patterns (weekly columns) in `filterFresh`, so a scan that keeps only excluded items closes at $0.
- `newsWatchConfig` falls back to the channel's memory-rule feeds when the card has none.

**086 Store API adapters tell the truth**
- Epic: pick the offer with `start <= now < end && discountPercentage === 0`, with a unit test of a sale offer and a free offer in both orders.
- Epic: return upcoming offers with `starts_at`/`starts_at_local`, so the planner can place Thursday's slot after the rotation.
- GamerPower: a zoneless 23:59 end becomes a date-only field, and the store's own instant wins when both exist.
- Steam: map the specials discount expiry to `ends_at`/`ends_at_local`, and add a deeper deals source.
- `noteStruckHosts` also notes hosts from `sourceHealthReport.otherHosts` that reach `STRIKES_FOR_OWNER`.

**087 Credit and process-leak guards**
- Owner decision first: allow a short credit line for CC BY and unknown-licence rows.
- Build 075 `credit_fields`, including `source_name` for `pdr_questions`.
- A lint error `credit_missing` when a `library_ref` row's licence is CC BY or unknown and the post lacks the credit value.
- Port `BLOCKED_PATTERNS` from the legacy publisher into the editor lint as `process_leak`, and add «з api», «дані з api» and «api epic».
- `scripts/server-snapshot.sh` selects `bot_logs` within the window, ordered by `created_at`.

**088 Owner signal quality**
- The Telegram dark-day alert carries the latest catalogue reason. `quality` gets its own group instead of "other".
- At 3 or more quality skips per dataset and channel in 7 days, post a `data_quality` note with table, row ids and a link.
- Resource-health reminders are critical only for resources in an active playbook. They are merged per provider and show one age, measured from the real expiry. Graph 190 "Page Access Token" errors go into resource health and the 24 h back-off.
- Weekly audit: report gate codes apart from tool errors, and add checks for liveness, open `resource:` pauses older than 48 h and dataset quality. Rank `skill_unused` lower.
- Closes made by code preset their own outcome, never «Вирішено в дашборді».

**089 Runtime hygiene**
- Start the second parallel executor after the first one's first response (cache warm-up). Trim the tool schemas toward the 22k target, and record the 053 measurement row.
- `query_data` drops unknown fields and returns the rows with a note.
- `readonly-query.service.ts`: skip the second ROLLBACK in `finally` after the catch has rolled back.
- Enable `pg_stat_statements`. The snapshot adds the top statements, `pg_stat_database` tuple counters and a 10-minute NET delta per container.

## 6. Owner actions

1. **Відновіть дві паузи каналів** (агент → банер «Planning paused» → Resume):
   - `resource:telegram:@ai0_global` (з 28.10);
   - `resource:telegram:@game_exchange_dev` (з 01.11).

   Перемикання режиму паузу не знімає, потрібно саме «Відновити».
2. **«AI-новини дня» на @ai0_global:** спершу замініть джерело з openai.com (403) на робочу стрічку, потім відновіть серію.
3. **Поки не відновлюйте дві серії,** інакше вони знову зупиняться:
   - «Білети ПДР» — після виправлення ключа відповіді (079) і зміни брифів (п. 4–5);
   - «Prompt» — після того, як сховаєте непридатні рядки (п. 6) або вийде 083.
4. **Бриф картки @pdr_dev_channel:**
   - видаліть речення «…імовірно, вікторини з ПДР і картинки до них»;
   - замість «у форматі опитувань із картинкою» напишіть «картинка, якщо вона є в рядку».
5. **Бриф серії «Білети ПДР»:** замініть «correct_index = correct_answer_num − 1» на «correct_index = позиція варіанта, у якого num = correct_answer_num». Ключ у даних рахується від 0.
6. **nanobanana_prompts:**
   - сховайте рядки, яким потрібне ваше фото чи референс, рядки з плейсхолдерами [..] і рядки довші за 800 символів (або дозвольте їх з рядком «потрібне ваше фото»);
   - сховайте дубль 71636;
   - у брифі серії «Prompt» приберіть «розмір» або напишіть «лише якщо вказано в промпті»;
   - імпортуйте більше самодостатніх промптів: придатних лишилось 11.
7. **Джерела в картках** (тоді й news watch увімкнеться сам):
   - @ai0_news_dev: theverge tech і AI, techcrunch і AI-категорія, dev.ua/rss, habr AI-хаб;
   - @game_exchange_dev: RPS, Eurogamer, PC Gamer, GamesRadar, PlayStation Blog, Xbox Wire;
   - @ai0_global: стрічка marktechpost, Google AI blog, Hugging Face blog, TechCrunch AI.
8. **Авторство:** вирішіть, чи дозволити короткий рядок «Prompt: @author · CC BY 4.0» і «Джерело: pdr-online.com.ua». Якщо так, оновіть навичку nanobanana-github-prompt-post (v5).
9. **Пост 1800** (Sorry We're Closed): роздача триває до 05.11, 18:00 за Києвом, а не до 02.11. Виправте пост.
10. **Meta:**
    - перепідключіть або вимкніть Threads cf8548a5… і ab4269dc… (токени прострочені з серпня);
    - перепідключіть сторінку Facebook 1391025657426668, щоб зберігся токен сторінки.
11. **ANTHROPIC_API_KEY:** замініть або очистіть (ROI-аналіз отримує 401).
12. **Після деплою 076:** налаштуйте проксі (`EGRESS_PROXY_URL`/`EGRESS_PROXY_HOSTS`) для store.epicgames.com, itch.io, gamerpower.com і marktechpost.com.
13. **«Знижки тижня»:** не вмикайте, доки Steam не віддає дедлайни (086).

## 7. Appendix

### A. Refuted or corrected claims

Skeptics refuted no finding outright. They refuted or corrected these sub-claims:

- "073 only stops 8 good pdr rows being put aside": wrong. `skip_slot` `ref` put them aside, and 073 does not touch it (SK2).
- "The fallback ladder put the 8 pdr rows aside": wrong. The executor's `skip_slot` `ref` did (SK2).
- "9 skips would become 9 published wrong quizzes under 075": overstated. Wrong answers become the only option the code accepts (DT2).
- "The model marked answers[num==c] in 7 of 9 runs": it was 9 of 9 (7 verbatim, 2 shortened) (RT1).
- The pdr mismatch runs cost $0.763, not $0.767 (DT1). The base-0 token check and the explanation-overlap counts depend on the method (SK2, DT1).
- "The breaker fired 6 times in the window": 4 pauses opened in the window. The other 2 opened on 10-27 and 10-28 (SK1).
- "Every other channel had 7 planner runs": games had 4 and @ai0_global 0 (SK1).
- "The games streak was 3 single-feed slots": it was 4, including recap `04f476d2`, because the 20 h span gate held at 3 (SK1, SR2).
- "No code path resumes a pause": true only for automatic resumes. The manager's `resumeSeries` handles `pause_series` directives (SK1).
- "series-breaker.ts stops the whole channel": the gate is `editor.scheduler.ts:172`/`:181` (SR2). Games had 1 slot after its pause, closed at $0 (RT7). `maybeReview` is at `:188`, not `:189`.
- "072 resumes paused series by itself": no. It offers a one-tap fix inside «Виправити все»; the automatic loop is 074's (DT6).
- "The orchestrator is not told @ai0_global is paused": it is told, and misreads it as the owner's schedule (DT7).
- "The mode change silently did nothing": the agent page showed a «Planning paused» banner with Resume (CL5).
- "The owner's last session was 10-30": a read-only session on 11-04 09:08 viewed the spend page (CL5).
- "Card 85 showed review_at 11-08": the card shows no date (CL2).
- "The no-duplicate rule appears in 6 of 7 reviews": it appears in 7 of 7. `countsAsCover` is not the source of the open list; `kpi-digest.service.ts:404-408` is (CL3).
- The 9 answer-key pdr skips include the mixed slot `9836fd66`. Prompts skip `480685cc` is about length, not a photo (CL4).
- "threads:cf8548a5 is in 2 playbooks": it is in 1 superseded playbook. The note text is at `resource-health.service.ts:79-96` (CL7).
- The audit check files are memory, prompt, rules, skills and tools (CL8).
- "074 covers code-closed card labels": it covers only auto-resumed pauses (CL9).
- "The critic never sees dataset rows": refuted. `library_ref` rows reach it; only `fetch_api` is missing (SK6).
- "a330da93 shows critic tool blindness": refuted. It was critic inconsistency between passes (SK6).
- "7e25b4c6 was one day before pp1800 and ended critic_rejected": it was two days before, and it ended in `skip_slot` quality (CT2).
- The poll-mark critiques were 3 accepted revises plus 1 refused for `invalid_args` and resent, not 4 (CT4).
- Run `2eb3d5f3` is a run id, not a slot. The slot is `ce3fd5ab` (CT5).
- Advice notes: 30 of 32 counted case-insensitively, not 24 (CT6).
- "claimAnchors favours keeping English": not supported (CT3).
- The `license=unknown` rows were read by the orchestrator (`0b188075`), not the planner (CT1).
- "The planner never applies the nanobanana rule": it did in `8e08cc58` and `be6eb3ef`, but unevenly (SK4).
- "All 12 prompts skips are row fitness": 11 are. `3a3a1c50` was a story_repeat (SK4, DT8).
- "074 would resume Prompt with 60+ unfit rows": about 65 rows are unposted, and about two thirds of them are unfit (SK4).
- Runway went 34.5 → 32.5, not 34 → 32. 4 of the 16 rule-breaking ideas belong to @ai0_global's agent (DT5).
- "Row 57471 has no ledger row": it has round-1 row 584. The head on 10-28 was 57452 (DT4).
- The $0 news closes came from the live scan, not pre-flight. SK7's status is new, not partly covered (SK7).
- "@ai0_global's only source is dead": the marktechpost feed reads OK, and only its pages are 403 (SR3, SR6).
- "live/feed-items.ts resolves only card sources": it accepts any http(s) URL from the slot (SR3).
- Guessed feed URLs: 8 of the 10 errors, not 9 (SR3).
- "openai.com and gamespot failed in the window": they last failed on 10-24 (SR6).
- "SOURCE_PROPOSALS is off on the server": not shown in `app_settings` (SR6).
- steam_deals counts in time order are 3, 2, 2, 2, 3, 4 (SR7).
- "Drop the ROLLBACK at readonly-query.service.ts:47": that would break 046 FR-008. Drop the one in `finally` instead (RT8).
- "query_data hides the real fields": it returns them with the error. There were 22 pdr executor runs, not 23 (RT8).
- "Postgres inbound shows hundreds of statements a minute": the inbound bytes include ACKs, so they give an upper bound only (RT4).
- 706 LLM calls, not 707. 27 of 69 runs start within 60 minutes of another, not 28 of 68 (RT3).
- RT2 saving: about $1.25 per window. Fixing RT1 turns its $0.86 into posts, not savings. The games slots got 3 critic passes over 2 runs, not a kill at the second revise.

### B. Queries and scripts

All under `/private/tmp/claude-501/-Users-tupotavalentyn-CS-20-ai0-ai0-global/2132be12-8cfd-462d-b944-db7830138061/scratchpad/r5/`. They are read-only Python (`python3 -I`) and node scripts over the export and snapshot files.

- `doc/headline.py`, `doc/skipped.py`: the headline recount for this document (slots by channel and status, spend by role, day and resource, open pauses, skip texts).
- `load.py`, `lib.py`, `slots.py`, `runs.py`, `dump*.py`, `a1.py`–`a21.py`, `t2.py`–`t8.py`: shared loaders and the runtime and skips counts (runs by role, runs per slot, tool error codes per slot, cache overlap).
- `posts.txt`, `ground.py`, `advice.py`, `ages.py`, `feeditems.py`, `items.json`: content lens (the 32 posts, number grounding, advice notes, source ages, feed items).
- `sk_lens/`: skips lens (`money.py` paid skips, `groups.py` root causes, `crit.py` critic involvement, `ideas.py`, `nb.py`/`nb2.py` nanobanana, `api.py` Epic reads). `vsk/v1.py`–`v17.py`, `vsk/bm_run*.mjs`: its verification, including the deployed `briefMediaNeed` replay.
- `dt/`: data lens (`pdr_mismatch.py`, `pdr_slots.py`, `pr_slots.py`, `nbclass*.py`, `nbmd.py`, `briefs.py`, `bm.mjs`, `story_test.mjs`, copies of `tickets.json` and `nanobanana.md` at `1ecb8160`). `vdt/` (`pdr1.py`, `pdr2.py`, `mm*.py`, `nb_seen.py`): its verification.
- `ctl/a1.py`–`a27.py`, `ctl/l.py`: control lens (cards, Inbox, reviews, directives, escalations, dashboard log).
- `rt/`, `vrt/s1.py`–`s12.py`: runtime lens and its verification (cost split, first-call cache, tool errors, Postgres traffic).
- `vsrc/s1.py`–`s15.py`: sources verification (feeds per slot, freshness windows, Epic/GamerPower/Steam reads, host failures).
- `vct/c1.py`–`c23.py`: content verification.
