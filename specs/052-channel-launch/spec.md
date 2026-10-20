# 052 Channel launch

**Epic:** AI0-220 (T1–T5 = AI0-241…245) · **Priority:** P2 · **Depends on:** 012, 017–022, 031, 042, 045, 048, 049 · **Status:** done (2026-10-20)

## Why

Review 2 (`docs/reviews/2026-10-17-agent-review-2.md` §8, gap 10) rates the new-channel lifecycle at 1.5 out of 5.

Today the owner has to do all of this by hand:

- create the Telegram channel;
- add the bot as an admin;
- mark the channel `is_mine` in Connections;
- write a brief or run setup from history;
- switch the card on, because setup creates it in `off`;
- connect Meta tokens.

Setup from history (042) needs at least 5 posts (`too_few_posts`), so it cannot help a brand-new channel. Steering (045) needs a channel that is already tracked as ours and has a card.

Graduation from approval is a daily `info` inbox note ("ready for autonomy", 20 approved and 90 % clean in 14 days). That note never becomes a Telegram card, so the owner rarely sees it.

The owner chose to skip the brainstorm («роби»). Every design decision below is **my call**, and each one is marked as such.

## The flow in one paragraph

1. The owner types `/launch @new_channel @ref1 @ref2 <brief>` in the chat. The new channel may be empty.
2. ai0 creates the card and the agent, reads the 1–3 reference channels (steering sets, 045) and makes one launch plan: profile, formatting, format mix, series and pillars, schedule, voice, and a first-week list of post ideas.
3. While that runs, a checklist shows what only the owner can do, with its live status. In practice that means adding the bot as an admin. Everything else is done in code. A bot that is an admin with the right to post is the proof of ownership, so ai0 adds the channel to tracking as `is_mine` itself.
4. The owner presses **Start**. They can press it before the bot is admin; the launch then starts the moment the check passes.
5. Start writes the plan, activates the steering sets, puts the first-week ideas in the pool, switches the channel to `approve` and plans today and tomorrow.
6. After the first 3 posts are published, the network's own channels closest in topic promote the new one (cross-promo first).
7. When the approval record is good enough, one card offers **Go live**, or the launch goes live itself if the owner chose that in Settings.

## Requirements

### FR-001 `/launch` and the launch record (T1)

**Command:** `/launch <target> [<ref> …] <brief>`.

- `target` is the first channel handle (`@name`, `t.me/name`, `telegram:@name`).
- Up to 3 handles directly after it are references: public channels that are not ours.
- The rest of the line is the brief. It is required and must be at least 30 characters.
- The same is available to @ai0 as the tool `launch_channel {target, references[], brief}`. The owner can therefore say «запусти новий канал @x про … як @y» in plain words.

**Refusals** (data, not exceptions):

| Code | When |
|------|------|
| `invalid_target` | The target is not a channel handle. |
| `brief_too_short` | The brief is under 30 characters. |
| `too_many_references` | More than 3 references. |
| `invalid_reference` | A reference is not a public handle. |
| `same_channel` | A reference is the target. |
| `already_running` | The target has a card in `approve` or `live`; use `/setup` or the agent page. |
| `already_open` | A launch for this target is not finished, discarded or failed. Its chip is returned. |

**Storage:** one row in `channel_launches` (migration 086), with this lifecycle:

`queued → preparing → ready → running → graduated`, plus `failed` and `discarded`.

The chat answer carries an artifact chip of the new artifact type `launch` (048). The panel shows the launch.

**Preparation** is a table-driven worker: a minute tick and a kick on create, one launch at a time, and requeue when stuck, like 042 and 045. It runs these steps:

1. **Card and agent.** The card is created in mode `off`, with the title from the Bot API `getChat` when the bot can see the channel, else the handle. The orchestrator and its children come from the registry sync. Both stay `off` until Start, so nothing is planned or written before the owner says so.
2. **References.** One steering set per reference (045) is created with `createdBy = 'launch'`. Steering's own-channel gate accepts a target with an open launch (**my call**: the launch is the owner's claim, and the bot-admin check proves it before anything is published). The launch waits until every set is out of `queued`, `collecting` and `analyzing`. A reference that ends `no_access` or `too_few_posts` is shown and skipped; it does not fail the launch.
3. **Launch analysis.** One onboarder run with the terminal tool `submit_channel_launch`. Its input is the brief, the target's title and description when visible, the ready steering sets (summary, rules and metrics per reference), and the network's other own channels (title and topic, so it avoids overlap). It answers with:
   - `summary`: 2–4 sentences for the owner;
   - `brief_profile`: brief (200–4000 characters) and the profile fields of 042;
   - `formatting`: format prefs, style and card fields as in 042;
   - `format_mix`: formats implemented on Telegram only; polls and quizzes only when the brief asks for them;
   - `series_pillars`: series without post ids, 0–5 of them; 3–5 pillars summing to 100 ± 5;
   - `schedule`: posts per day min/max, quiet hours, best hours;
   - `voice`: description plus 5–8 do/don't rules;
   - `first_week`: 5–10 post ideas `{day 1–7, title, angle, format}`. Day 1 starts with an introduction post that says what the channel is and who it is for.

   Code checks the answer the way 042 does: pillar sum, series formats in the mix, Telegram formats, min ≤ max, a day-1 intro idea, and the first-week formats in the mix. The checklist goes back to the model.

   Guards: `LAUNCH_MAX_STEPS = 4`, `LAUNCH_MAX_COST_USD = 0.4`, the channel and agent budget caps, and the usage feature `editor.launch`.

   The analysis must not copy the references. The prompt says so, and the copy guard (045) applies to the steering rules.
4. The plan is stored and the launch becomes `ready`. A failure is `failed` with the reason; **Redo** queues it again.

### FR-002 Checklist with live status (T2)

The launch computes its checklist on every read. The minute tick refreshes the stored copy for the owner-bot card.

| Step | Who | Done when |
|------|-----|-----------|
| `bot_admin` | owner | Bot API `getMe` + `getChatMember`: the channel's bot, else the default bot, is creator or admin with `can_post_messages`. The step text names the bot (`@name`) and the exact right. While open, it is checked at most every 2 minutes. |
| `tracked` | code | Once `bot_admin` passes, the channel is added to tracking as ours (`createFullChannel`, public, `is_mine`) or an existing row is marked `is_mine`. This also starts subscriber tracking. |
| `references` | code | Every reference set is ready (or skipped with its reason). |
| `plan` | code | The launch analysis is ready. |
| `start` | owner | The owner pressed Start. |
| `first_posts` | code | 3 posts of the channel are published (they were approved first). |
| `cross_promo` | code | FR-004: promos scheduled, or the reason there are none. |
| `platforms` | owner, optional | Other platforms of the channel's network (Instagram, Facebook, Threads, TikTok) are connected and healthy. With no network this shows "optional: connect them in Connections". It never blocks. |
| `graduation` | owner / code | FR-003. |

**Start** (owner: dashboard, chat panel or owner bot card). With `bot_admin` open, Start sets `start_requested`, and the tick starts the launch as soon as the check passes. When Start runs:

1. It writes the plan through the 042 writers: profile; card brief, language and fields; format prefs without the owner's locks; formats; schedule; a playbook merged with the series, pillars and best hours; and the voice skill `channel-voice`.
2. It activates the ready steering sets.
3. It puts each first-week idea in `content_ideas` as `accepted`, with origin `owner`, `origin_ref launch:<id>` and an expiry 10 days after Start. The planner plans from accepted ideas first (020).
4. It switches the card and the orchestrator to `approve` (031: nothing goes out without the owner).
5. It plans today, when hours are left, and tomorrow, in the background.

A step that fails stops Start and is shown. Pressing Start again resumes, because every step is idempotent.

**Owner bot (012), new card kind `launch`:**

- "Add the bot" (`<id>:bot`), with the bot's name and the right. Its buttons are **Check now** and **Open**. It appears after the plan is ready while `bot_admin` is open, or on Start-requested.
- "Launch plan ready" (`<id>:start`), with **Start** (confirm step) and **Open**.
- "Ready to go live" (`<id>:graduate`), see FR-003.

### FR-003 Graduation from approval (T3)

For a `running` launch, the minute tick checks at most once an hour. The criteria count from Start:

- at least `LAUNCH_GRADUATE_MIN_DAYS` days in `approve` (default 7);
- at least `LAUNCH_GRADUATE_MIN_APPROVED` approved posts (default 10);
- at least `LAUNCH_GRADUATE_MIN_CLEAN_PCT` % of the approved posts approved without edits (default 80);
- no rejection among the last 5 decisions;
- critic pass rate at least `LAUNCH_GRADUATE_MIN_CRITIC_PCT` % (default 80), over at least 5 verdicts. The rate is pass ÷ (pass + revise + reject), the 034 quality rule;
- the channel is usable: no blocking health state (049).

The defaults are **my call**: lower than the general 20 / 90 % note because a launch is watched closely from day one, with the critic added as a second signal.

`LAUNCH_GRADUATION`:

| Value | What happens when the criteria are met |
|-------|----------------------------------------|
| `propose` (default) | One owner card "Ready to go live" shows the numbers. **Go live** (confirm) calls the 031 autonomy switch (`approve → live`; it also approves the waiting posts that are clean). **Not yet** snoozes for 7 days and 5 more approved posts. |
| `auto` | The launch switches itself and sends an action note «канал перейшов у Live» with the numbers. |
| `off` | Nothing happens; the dashboard still shows the progress. |

The default is `propose` (**my call**: going live is publishing without review, so one tap stays with the owner unless they opt into `auto`).

`auto` is a code path the owner turned on in Settings. Agents still have no tool that changes a mode, so the 031 rule "only the owner switches" stays true for agents.

A launch whose channel is switched to `live` elsewhere becomes `graduated` (`by: owner`). One switched back to `off` stays `running` and is shown as paused.

### FR-004 Growth: network cross-promo first (T4)

Once `first_posts` is done, the launch picks up to 3 of our other Telegram channels as promo sources. A source must have:

- an agent in `approve` or `live`;
- no pause;
- a usable resource;
- 022 relevance to the new channel's profile of at least 3 out of 5.

Sources are ranked by relevance and then by subscribers.

For each source, the launch files a `cross_promo` directive to the source's orchestrator (`source_ref` = the source, `target_ref` = the new channel, `window_days` 7). The directive is filed as owner-approved and `accepted` (**my call**: the owner started the launch, so it does not wait for an orchestrator run). The 022 `PromoPlanner` then schedules it right away. Every 022 limit applies: pair cooldown, one promo per source per day, three per network, distance from ads, quiet hours. A refusal is shown with its reason.

The step lists the promos (source, time, tracked link). The launch view shows:

- subscribers at Start and now (`tracked_subs_history`);
- joins through the promo links (`link_joins`).

With no source that fits, the step says why: no other own channel, or none relevant enough.

### FR-005 Dashboard (T5)

The `launch` artifact (048) is listed on `/app/artifacts` and on the agent's Artifacts tab, and opens in the chat side panel. The panel shows:

- **Header:** the channel, status, cost, and the buttons Start / Redo / Discard.
- **Checklist:** each step with a state (done, waiting, needs you, skipped, failed), its detail and a fix link: Telegram for `bot_admin`, Connections for `platforms`.
- **Plan:** summary, brief, profile, formatting, format mix, series and pillars, schedule, voice and first-week ideas, plus the references with their state.
- **After Start:** graduation progress (days, approved, clean %, critic %, last decisions), subscribers since Start, the promos and their joins, and **Go live** when the criteria are met.

Other dashboard changes:

- `/launch` joins the slash menu and `/help`.
- The owner-bot section names the `launch` kind.

All dashboard text is in English. Telegram texts for the owner are in Ukrainian.

## Non-goals

- Creating the Telegram channel itself. The Bot API cannot do that, and the MTProto user session is not used to create channels (**my call**: the owner creates the channel; it takes a minute).
- Connecting Meta or TikTok accounts. That is OAuth in Connections; the checklist only shows their state.
- Launching a channel that has history. That stays `/setup` (042).
- Paid growth (ads, external cross-promo). Those are 011, 014 and 015.
- Image generation for the first posts.

## Anti-goals

- **Never publish before Start and the bot check.** Mode stays `off` until Start, and Start never sets `live`.
- **Never copy a reference's posts.** The 045 copy guard applies.
- **Never let an agent change the mode.** Only the owner's Start, the owner's Go live, or the owner's `auto` setting does.

## Settings (catalog group `editor`)

| Setting | Default |
|---------|---------|
| `LAUNCH_GRADUATION` | `propose` (or `auto`, `off`) |
| `LAUNCH_GRADUATE_MIN_DAYS` | 7 |
| `LAUNCH_GRADUATE_MIN_APPROVED` | 10 |
| `LAUNCH_GRADUATE_MIN_CLEAN_PCT` | 80 |
| `LAUNCH_GRADUATE_MIN_CRITIC_PCT` | 80 |

## Data

Migration `086_channel_launches.sql`, table `channel_launches`:

| Column | Notes |
|--------|-------|
| `id` | |
| `channel_key` | |
| `target_ref` | |
| `title` | |
| `brief` | |
| `references` | JSONB `[{ref, setId, status, reason}]` |
| `status` | |
| `reason` | |
| `retry_at` | |
| `plan` | JSONB: the checked `submit_channel_launch` input |
| `checklist` | JSONB, the last computed copy |
| `start_requested` | |
| `started_at` | |
| `graduation` | JSONB `{proposedAt, snoozedUntil, snoozedApproved, decidedAt, by, stats}` |
| `promo` | JSONB `{filedAt, items:[{sourceRef, directiveId, slotId, at, error}]}` |
| `subs_at_start` | |
| `bot_checked_at` | |
| `run_id` | |
| `cost_usd` | |
| `created_by` | |
| `created_at`, `updated_at`, `graduated_at` | |

A partial unique index allows one open launch per channel (status not in `graduated`, `discarded`, `failed`). The usage feature is `editor.launch`.
