# 045: Steering — rules from a reference resource

**Status:** DONE (2026-10-17) · **Priority:** P1 · **Linear:** AI0-170 (T1–T7: AI0-171…AI0-177) · **Depends on:** 040 (owner rules
block, critic), 042 (post reading, metrics, onboarder run, queue) · **Migration:** `081_steering.sql`

**Owner request (2026-10-17):** "a new functionality for channels and Instagram in the future … for any resources … I want to
call it steering. I can provide some not my channel, and using MTProto for scrapping last 20 posts, and based on these posts
provide some new rules for my channels, and agent should following these rules, like steering rules, new type of rules, and
create a post like this."

Owner decisions (brainstorm 2026-10-17):
- **What carries over: form + content direction.** Structure, hooks, length, formatting, CTAs, series, and which topics /
  angles / post types work there, *adapted to the target channel's own subject*. Not the reference's voice; never its text or
  facts.
- **The channel wins.** Steering is the lowest-priority rule source: it fills gaps and adds direction. A steering rule that
  contradicts the channel's owner rules, playbook, profile, format settings or locks is kept on the set, marked as a conflict,
  shown to the owner, and **not** given to the agent.
- Telegram references and targets now; the model is resource-generic (`source_ref`, `target_ref`) so Instagram and other
  platforms plug in later (FR-010).

## What exists and what is missing
| Exists | Gap |
|---|---|
| Spec 042: last-20-posts reading (`readHistory` through the tracking userbot), `computeMetrics`, one `onboarder` run with a terminal tool + evidence checks, a table-driven queue with a minute tick | 042 refuses channels that are not ours (`not_own_channel`) and writes the channel's own setup; nothing learns from someone else's channel |
| Rule sources the agent follows: owner rules (spec 040, top), playbook rules / series / mix, profile, `format_prefs`, examples, voice skill | No "lower than everything" rule source and no record of where a rule came from |
| `verbatim-guard.ts` (`longestCommonRun`) blocks posts that copy library rows | Nothing stops a post from copying a reference channel's text |
| Critic gets the owner rules (`criticOwnerRulesLines`) | Critic does not know what the owner is steering towards |

## FRs

### FR-001 Steering set
A **steering set** = one reference resource (`source_ref`, e.g. `telegram:@ref`) applied to one target resource of ours
(`target_ref`, e.g. `telegram:@mine`). It holds a snapshot of the reference posts, metrics, a short summary and up to **12
rules**. Statuses: `queued → collecting → analyzing → ready → active ⇄ paused`; terminal: `discarded`, `superseded`,
`failed`, `no_access`, `too_few_posts`.
- Target: an own Telegram channel with an editor card (v1). Source: any public Telegram channel by `@username` or a `t.me/…`
  link; the source must not be the target. Our own other channels are allowed as a reference.
- At most **3 active** sets per target (activating a 4th is refused with `too_many_active`).
- One open set per (target, source); analyzing again creates a new set and, once the new one is activated, the old one becomes
  `superseded`.

### FR-002 Reading the reference
- The tracking userbot reads the reference history (`readHistory(username, 50)`), no subscription needed for public channels;
  the last **20** usable posts (text or media, not service) are kept, newest first, keys `r1…r20`.
- The snapshot (message id, date, text ≤ 4000 chars, media type, views, reactions, forwards, comments) is stored on the set,
  not in `tracked_posts` (the reference is not tracked or polled).
- Private / unreadable → `no_access` ("The tracking account cannot read this channel; it must be public"); fewer than **5**
  usable posts → `too_few_posts`; `FLOOD_WAIT` → back to `queued` with `retry_at`. The model is not called in these cases.
- Metrics: spec 042 `computeMetrics` (format mix, length, emoji, hashtags, CTA, signature, rubric candidates, engagement, top
  posts, peak hours).

### FR-003 Analysis
- One `AgentLoop` run, role `onboarder`, feature `editor.steering`, `maxSteps` 4, `maxCostUsd` 0.30; the target's budget and
  the total AI cap apply.
- The user prompt carries: the reference (title, subscribers), its metrics and posts (text cut at 1500 chars); the **target**
  channel: title, brief, profile, its owner rules, playbook rules / series / format mix for the target, `format_prefs` and
  locked fields.
- The only tool is the terminal `submit_steering`: `{ summary ≤ 600, rules: [{ kind, text ≤ 300, evidence: { post_ids: r…,
  note ≤ 300 }, conflict: null | { with: string ≤ 120, note ≤ 300 } }] }`, 3–12 rules. Kinds: `structure`, `hook`, `length`,
  `formatting`, `cta`, `series`, `topic`, `mix`.
- Rules are written for the **target**: topics and angles are translated to the target's subject ("a myth-busting post on a
  traffic rule", not "a myth about vitamins").
- Code checks (errors go back to the model, spec 040 style): every evidence key exists; `series` / `topic` / `mix` rules cite
  ≥ 2 posts; no rule shares a run of **60+ characters** with any reference post (rules describe, never quote); no rule asks the
  agent to pose as a human or to copy text; duplicate texts are refused.
- A rule the model marks with `conflict` stays on the set with `conflict` set; the owner sees it; it is never given to the
  agent (FR-005).

### FR-004 Owner review and lifecycle
- `ready`: the owner reads the summary and the rules (kind, text, evidence posts with links, conflict note), switches single
  rules off, may edit a rule's text (the 60-char copy check applies), then **Activate**.
- `active` ⇄ `paused` (Pause / Resume); **Discard** from any open status. Rules can be switched on/off and edited while active.
- Discarded and superseded sets drop the reference texts from the snapshot (ids, dates and metrics stay).

### FR-005 The agent follows the rules
- The enabled, non-conflicting rules of the target's **active** sets render as one block, **below** every other rule source:
  `## Напрям від референсів (steering — найнижчий пріоритет)` with the note that owner rules, playbook, profile, style and
  examples win, and that reference text and facts are never copied; rules grouped by reference and kind.
- The block goes to the writer and planner system prompts (`buildSystemPrompt`, the network planner) and to the critic's
  request, where it is advice for `format_fit` (not a new score, never a reason to reject on its own).
- With no active sets nothing changes in the prompts.

### FR-006 Copy guard
- A post for a target with active sets is refused at the publish guards when it shares a run of ≥ **80** characters
  (`MAX_VERBATIM_RUN`) with any stored reference post of those sets: error `steering_copy` ("this repeats the reference
  channel's text; say it in your own words").

### FR-007 API (`/api/steering`, owner auth)
- `GET /` — sets (optionally `?target=`), newest first, with counts and the rules; `GET /:id` — one set with posts (links
  `https://t.me/<ref>/<msgId>`) and metrics; `GET /estimate` — cost per analysis (average of the last 20 ok steering runs,
  else of onboarder runs, else null); `GET /active?target=` — the active count and sources (the agent Overview line).
- `POST /` `{ target, source }` — validates and queues; refusals: `not_own_channel`, `no_card`, `same_channel`,
  `invalid_source`, `already_open` (returns the open set).
- `POST /:id/activate`, `/pause`, `/resume`, `/discard`, `/reanalyze`; `PATCH /:id/rules/:ruleId` `{ enabled?, text? }`.

### FR-008 Dashboard
- Page **Steering** (`/app/steering`, nav group Agents): compact cards per set (target ← reference, status, active rules /
  total, conflicts, date); a dialog with the summary, the rules (kind badge, text, evidence links, conflict note, a switch and
  an edit per rule) and the actions (Activate / Pause / Resume / Re-analyze / Discard). "New steering" dialog: target (own
  channels with a card), reference (`@username` or link), the cost estimate, Analyze.
- Agent page Overview: a one-line "Steering: N active from @a, @b" linking to the page filtered by the target.

### FR-009 @ai0
- Builder tool `steer_channel { channel, reference }` queues a set (same refusals as the API) and answers with the link; the
  owner still activates it on the page.

### FR-010 Other platforms (later)
- Reading is a `SteeringSourceReader` per platform (`telegram` now). Instagram: the Graph API `business_discovery` field reads
  a public business / creator account's media (caption, type, time, likes, comments) through one of our IG business accounts;
  Threads / Facebook / TikTok when their APIs allow it. Targets beyond Telegram need the platform writers' prompts (spec
  043 / AI0-149).

## Non-goals
- Copying reference posts, reposting, or tracking the reference continuously (no automatic refresh; Re-analyze is manual).
- Changing the channel's own settings — that is spec 042 (setup from history).
- Scoring how well posts follow steering (a metric can come later).

## Safety
- Rules describe patterns, never quote: 60-char check on rules, 80-char publish guard on posts.
- Agents never pose as humans: steering cannot carry "write as a person" rules (checked like owner skills).
- The reference text is third-party content: kept only while the set is open, never shown outside the owner dashboard.
