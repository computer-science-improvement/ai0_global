# Autonomy review — dev stage, 2026-11-07

**Question from the owner:** how autonomous is the system today, and what has to change so that running the channels needs no owner action at all, or very little?

**Data:** the server snapshot `tmp/server/server-snapshot-20261107-1824` covers a 7-day window (slots, runs, inbox, owner cards, directives, pauses). It is read together with review 5 (2026-11-04), the code at `72bd12c8`, and the channels as seen in Telegram Web.

## Verdict

**The system is autonomous only while nothing goes wrong. The first anomaly stops it, and then it waits for an owner who does not come.** On a self-driving scale this is level 2: it drives itself on a clear road and hands the wheel back at every exception.

- **Detection works.** The keeper's `dark_day` notes, the manager's KPI digest, the weekly audit and the series breaker all saw the problems within hours. On 11-01 the manager named @ai0_global as dark and filed a frequency directive.
- **Repair does not.** Every repair path ends at an owner gate:
  - a pause lifts only on Resume;
  - a structural directive waits for a decision, then **is dropped on timeout**;
  - the audit's "25 fixable in one click" wait for the click;
  - a dataset import waits for Apply;
  - a source change waits for approval.
- **Owner silence is read as "no".**
  - `DIRECTIVE_TIMEOUT_APPLY_KINDS` is empty by default, so a structural directive with no answer is dropped (`timeout_dropped`).
  - After 5 drops in a row, the manager writes itself a memory line telling it to propose such directives less often (`manager-runner.ts:459–465`). The system learns to do less when the owner is away, which is the opposite of autonomy.
- **Result over 7 days.** Only **7 of 35 channel-days (20%)** met the configured daily minimum.
  - @ai0_global was dark for 15 days and @game_exchange_dev for 6.
  - Both came back only after a manual intervention today, outside the product.

The fix is not more detection. It is **authority to act with safe defaults, and a closed loop that checks the result.**

## 1. The week in numbers

### Plan adherence (posts published vs. the card's daily minimum of 2)

| Channel | Published / slots | Days at minimum | Longest dark run | How it ended |
|---|---|---|---|---|
| @ai0_news_dev | 16 / 22 | 6 of 7 | — | — |
| @pdr_dev_channel | 7 / 19 | 1 of 7 | 4 days (dark_day 11-04…11-07) | still dark at snapshot |
| @ai0_prompts_dev | 4 / 16 | 0 of 7 | 2 days | — |
| @game_exchange_dev | 1 / 4 | 0 of 7 | 6 days (11-01…11-07) | manual resume 11-07 |
| @ai0_global | 0 / 0 | 0 of 7 | 15 days (10-23…11-07) | manual resume 11-07 |

The four channels on the legacy strategies (@quotes_dev, @recipes_dev, space, daily_photo, movies) are not on the editor agent at all. The last posts from that group are dated June. They are outside this review, but the owner's folder lists them as part of the network.

### Owner touchpoints the system created vs. owner actions taken

| What asked for the owner | Count (7 d) | Answered by the owner | What happened without an answer |
|---|---|---|---|
| Inbox notes, severity `action`/`critical` | 13 | 0 acted on (5 read) | nothing |
| Owner Telegram cards | 14 | 0 (7 still open, 6 closed by code) | nothing |
| Structural directive (@ai0_global frequency) | 1 | no | dropped on timeout |
| Open pauses (2 whole-channel, 4 series) | 6 | no | channels stayed dark |
| Audit findings "fixable in one click" | 25 | no | nothing |
| Threads tokens invalid since 10-19 | 2 | no | 18 days without Threads |
| Tool loadout suggestions | 294 | no | nothing |

The owner is in practice not in the loop. Any design that waits for the owner therefore turns into a design that fails silently.

## 2. Autonomy scorecard

The score is 0–5 per capability. 5 means it runs, recovers and verifies with no human.

| Capability | Score | Evidence |
|---|---|---|
| Plan the day | 4 | Planner plans every channel at 06:00, respects quiet hours and series. It stops entirely under a resource pause. |
| Write and check a post | 4 | Writer, critic, lint and guards work. Quality issues are mostly caught by code. |
| Publish | 5 | Channels run in `live` mode with no approval needed and no publish failures. |
| Detect a problem | 4 | `dark_day`, KPI digest, audit and breaker fire within hours. |
| Diagnose the cause | 3 | Skip reasons are precise. The manager sometimes pulled the wrong lever: a frequency directive on a paused channel (review 5 #4). |
| **Repair** | **1** | Every repair waits for a click: Resume, directive decision, audit fix, Apply, source approval. |
| **Keep material flowing** | **1** | The prompts dataset holds 22 usable rows out of 70, about 11 days. The pdr dataset has rows without images. Feeds come from 1–2 hosts. Nothing refills them on its own. |
| **Keep settings consistent** | **1** | Three sources of truth disagree (card, brief, playbook). An onboarding guess became a hard rule (§3.3). |
| **Verify the outcome** | **1** | Nothing checks "did the channel get what its settings promise" and corrects it. Skipped slots are never replaced (0 replacements in 7 days). |
| Credentials and platform access | 0 (inherently human) | Threads tokens have been invalid for 18 days and only the owner can renew them. There is no early warning before expiry. |

**Overall: about 2.4 / 5.** The pipeline from writing to publishing is strong. The control loop around it (repair, supply, consistency, verification) is weak.

## 3. Where the loop breaks

### 3.1 Owner gates with no safe default — critical

Six mechanisms end with "the owner decides":

1. series and resource pauses;
2. structural directives (frequency ≥ 30%, strategy, pause_resource, cross_promo);
3. audit fixes;
4. dataset imports (Apply card);
5. source changes (`change_source` proposals);
6. setup proposals (2 discarded this week).

Each needs a default for when the owner says nothing. A reversible action should proceed; only an irreversible or outward-facing one should wait.

- **Already changed today (`72bd12c8`):** a no-material pause is lifted by code after 24 h (`SERIES_PAUSE_RETRY_HOURS`).
- **Still open:**
  - directives (timeout = drop);
  - audit fixes;
  - imports from sources the owner already approved;
  - feed additions that the 076 probe has proven readable.

### 3.2 Two autonomous subsystems contradict each other — major

On 11-06 the manager filed and **applied** a task directive: "@ai0_global has not published for 6 days, build a day plan of 2–3 slots". The resource pause from spec 060 then skipped every slot it produced. The breaker exists to save money and the manager exists to restore output, and neither knows about the other.

An autonomous system needs one owner of the channel's state. The rule should be: when the manager decides to restore a channel, it lifts the pause; when the breaker pauses a channel, it tells the manager the cause.

### 3.3 Settings live in three places and code turns guesses into rules — major

| Setting | Card (code reads) | Brief (writer reads) | Playbook (planner reads) |
|---|---|---|---|
| Posts per day | 2–6 on all 5 channels (default) | 3, 2, "1–3" | 3–3, 2–6 |
| Formats | 8 formats at weight 1 on 3 channels (default) | "interactive at most weekly" | text 0.4 / photo 0.25 / … |
| Picture rule (pdr) | — | "polls with a picture" (inferred by onboarding from **one** post, "to be confirmed with the owner") | series: "picture of the row, if any" |
| Caption (prompts) | hashtags 0 | "🤖 Модель", "📐 Розмір", one hashtag | template without the emojis |

The agent picks between them run by run. That is the "posts do not match the settings" the owner sees.

Spec 042 onboarding writes its inferences into the brief as prose, and spec 041 lint then enforces some of that prose as hard rules. Under autonomy, an **inferred** setting must be marked as inferred and must never block a post.

### 3.4 No outcome loop: a skip is final — major

- **No replacement.** A skipped slot is not replaced, even when the channel is behind its daily minimum. Over 7 days there were 33 skips and 0 replacements.
- **No fallback ladder.** The ladder exists (spec 071) but it works within one slot's run. Nothing works at the level of the day's target.

The system optimises "do not publish a bad post" but has no objective "publish the promised number of posts". An autonomous editor needs both, with the second as an SLO: a target per channel per day, an error budget, and a recovery action when the budget is spent.

### 3.5 Material supply is not managed — major

- **@ai0_prompts_dev:** 70 rows, of which 29 run over 850 characters, 24 need the reader's own photo and 21 contain placeholders. That leaves 22 usable rows, about 11 days at 2 a day. The catalog counts all 70 as available (review 5 #12).
- **@pdr_dev_channel:** many rows have no `image_url`. That blocked quizzes until today's lint change.
- **News:** live slots read 2 feeds with a 6 h window. Today's change widens the window to 24 h before a skip.
- **Games:** the store adapters were fixed in 086, but the material is thin on weekends.

Nobody computes **runway**, meaning days of postable material per channel. Nobody refills it before it runs out. The agents can find and import new material (`import_list`, `fetch_feed`, `change_source`), but each of those ends with an owner Apply.

### 3.6 Credentials are the one genuinely human gate, and they fail silently — minor (inherent)

The two Threads tokens have been `token_invalid` since 10-19. The daily critical note repeats, and nothing reaches the owner before expiry. This gate cannot be automated away. It can be made rare and predictable with:

- an expiry forecast;
- a 7-day pre-warning;
- refresh wherever the platform allows it (Threads long-lived tokens refresh, Meta page tokens do not expire).

## 4. What should stay with the owner

The aim is "the owner audits, the system operates". The owner keeps only what code cannot or must not do:

1. **Credentials and platform access:** tokens, bot admin rights, new accounts.
2. **Money:** budgets above the daily cap, paid promotion, ads.
3. **Identity and legal:** a channel's topic and audience, taboo topics, licences of new material sources (approved once per source, not once per import).
4. **New channels:** `/launch`, once per channel.
5. **A weekly digest to read:** what the system did, what it changed by itself, and what it could not fix. One message, not 13 notes and 14 cards.

Everything else becomes a decision the system makes with a default and a trace, which the owner can reverse.

## 5. The autonomy contract (design rules)

These rules are for every future spec:

1. **Silence is a default, not a veto.** Every owner gate declares a timeout action. Reversible changes (resume, frequency within the card's range, format mix within the card's weights, a feed proven by probe, an import from an approved source) apply on timeout. Irreversible or outward changes (new platform, money, cross-promo with another owner) wait.
2. **One state owner per channel.** The channel controller, not the breaker, manager and planner separately, decides "planning on / off / recovering". Every subsystem reads that state and reports to it.
3. **SLO over gates.** Each channel has a daily target derived from one setting. Behind target triggers a recovery ladder:
   1. retry with another row or item;
   2. a wider freshness window;
   3. a lighter format allowed by the card;
   4. an evergreen post from the channel's own pillars;
   5. only then a skip.

   Dark for more than 24 h triggers a forced recovery run and one note.
4. **Inferred settings are hints.** Anything onboarding or an agent inferred is stored as `inferred`, shown to the owner, and used by the writer, but never enforced by lint. Only owner-set or structured fields block a post.
5. **One source of truth.** Frequency, posting hours, format mix, picture rule, caption template and hashtags are structured card fields. The brief is prose for tone. Code detects conflicts and resolves them by fixed priority: owner rule > series > playbook > card default. The result is shown on the agent page.
6. **Runway is a metric.** Postable days of material per channel feed the planner. Below 7 days triggers a replenish job. Below 2 days, the channel shifts to its fallback pillars.
7. **Every action is checked by its effect.** A change the system makes is re-checked after N days against the metric it was meant to move, and rolled back if the metric did not move. The directive evaluation already exists; it needs teeth.
8. **The owner gets a digest, not a queue.** Per-event notes are kept only for the human-only gates (§4). Everything else is a line in the daily or weekly digest.

## 6. Roadmap

### Wave A — settings and small changes (days, no new spec)

| Change | Effect | Status |
|---|---|---|
| Lift no-material pauses after 24 h | no channel dark for days | **done** `72bd12c8` |
| Template entities out of story_repeat | prompts publish | **done** `72bd12c8` |
| Picture rule is a warning on a dataset row | pdr quizzes publish | **done** `72bd12c8` |
| `correct_index` from `query_data` | pdr answer key right | **done** `72bd12c8` |
| Live window widened to 24 h before skip | fewer news skips | **done** `72bd12c8` |
| `DIRECTIVE_TIMEOUT_APPLY_KINDS` = frequency, format_mix, format_shift, voice_fix, task | manager directives apply on silence | setting change, owner to approve |
| Remove the "propose less" memory line after 5 timeouts | manager stops backing off | small code change |
| Hide the 48 unusable `nanobanana_prompts` rows | no slot burnt on them | owner action (blocked for Claude) |
| Reconcile the 5 cards with their briefs (ppd, formats) | settings stop contradicting | one-off data fix |

### Wave B — the control loop (specs)

The review 5 specs that are still unbuilt are kept and given an autonomy framing. The new ones are numbered after them.

| Spec | Title | Priority | Covers |
|---|---|---|---|
| 080 | Paused channels come back (finish: pause ↔ manager hand-off, back-off) | P0 | §3.1, §3.2 |
| **090** | **Autonomy contract: a default on every owner gate** | **P0** | §3.1, §5.1, §5.8 |
| **091** | **Channel SLO controller: daily target, recovery ladder, replacement slots** | **P0** | §3.4, §5.2, §5.3 |
| **092** | **One source of truth for channel settings** (structured fields, conflict resolver, `inferred` flag) | P1 | §3.3, §5.4, §5.5 |
| 082 + 083 | Material checked before the paid run; library rows that can be posted (row fitness) | P1 | §3.5 |
| **093** | **Material runway and replenishment** (auto-import from approved sources, feed adoption after probe) | P1 | §3.5, §5.6 |
| 085 | Card sources and freshness that fits the clock | P1 | §3.5 |
| **094** | **Effect verification with rollback** (directives and self-changes judged by their metric) | P2 | §5.7 |
| **095** | **Credential runway** (expiry forecast, 7-day warning, auto-refresh where possible) | P2 | §3.6 |
| 081, 084, 087–089 | as in review 5 | P1–P3 | quality and signal |

The proposed scope of each new spec follows.

- **090 Autonomy contract.**
  - Every gate type gets a registry entry: `timeout_hours`, `timeout_action` (`apply` | `drop` | `escalate_once`) and `reversible`.
  - Defaults:
    - resume → apply after 24 h;
    - directives in the reversible kinds → apply after 12 h;
    - audit fixes marked safe → apply after 24 h;
    - an import from an approved source → apply;
    - a probed feed → apply;
    - setup proposals → apply the sections that only touch tone or schedule.
  - Owner cards collapse into the daily digest, except for the §4 gates.
- **091 SLO controller.**
  - Per-channel `daily_target` comes from one field.
  - At each tick the controller compares published plus planned with the target for the rest of the day, using the quiet hours.
  - When the channel is behind, it inserts a replacement slot (`replaces_slot_id`) with the next rung of the ladder.
  - Dark for more than 24 h triggers a forced recovery run with the reason and one note.
  - It owns the pause state. The breaker becomes a signal to it, not a switch.
- **092 Settings source of truth.**
  - Structured fields go on the card: `posts_per_day`, `post_hours`, `format_mix`, `media_rule` per format, `caption_template`, `hashtags`.
  - Onboarding fills them and marks each as `inferred` or `owner`.
  - The brief stays prose. Lint enforces only structured `owner` fields.
  - A conflict checker runs in the keeper and resolves by priority. The agent page shows the effective value and where it came from.
- **093 Runway.**
  - `runway_days` per channel = postable rows (by the row-fitness predicate of 083) plus expected feed yield, divided by the daily need.
  - Below 7 days, the orchestrator runs a replenish task: `import_list` and feed discovery, limited to source domains the owner approved once.
  - The import applies without a card when the source is approved and the 075 profile passes.
- **094 Effect verification.**
  - Every self-applied change records a metric and a horizon, for example `skip_rate` over 3 days.
  - At the horizon, if the metric did not move by the expected amount, the change is rolled back and the manager is told.
- **095 Credential runway.**
  - Token expiry is tracked where the API returns it, and a health probe runs daily.
  - A warning goes out 7 days before expiry and auto-refresh is attempted where supported.
  - One note per credential per week, never daily.

### Wave C — measure autonomy itself

Add an **autonomy dashboard** on `/app/health` with:

- channel-days at target (goal ≥ 90%);
- longest dark run (goal ≤ 24 h);
- owner touches per week (goal ≤ 1, credentials and money only);
- self-repairs and rollbacks;
- runway per channel.

The system counts as autonomous when it holds these goals for **14 consecutive days** with no owner action on the channels.

## 7. Recommended order

1. **Now:**
   - deploy and watch `72bd12c8` for 2–3 days;
   - approve the `DIRECTIVE_TIMEOUT_APPLY_KINDS` setting;
   - hide the unusable prompt rows.
2. **Week 1:** 090 and 091 together, since they share the gate registry and the channel state, then 080's leftovers merged into 091.
3. **Week 2:** 092, then 082/083 and 093.
4. **Week 3:** 085, 094, 095 and the autonomy dashboard.
5. **Then:** 14-day autonomy trial with the owner out of the loop. The report is written by the system itself.
