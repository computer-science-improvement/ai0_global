# Runbook: the agent platform (specs 017–022)

Named agents per resource, the `@ai0` builder, native multi-platform posts, playbooks and the idea pool, the MANAGER
and cross-promo between own resources. Everything below runs inside the automation service; there is no new process.

## 1. Enable

1. **Migrations** `049_agents` … `054_network_promo` apply at boot (MigrationRunnerService) or with `database/migrate.sh`.
   All are additive and idempotent. Number `048` is reserved by spec 011 (deal agent) and is not used yet.
2. **Prerequisites** from the editor runbook: `OPENROUTER_API_KEY`, and `EDITOR_ENABLED=true` for scheduled runs.
3. **On first boot** the registry sync creates an orchestrator `@<channel>` (with planner, executor, reviewer and idea
   reviewer roles) for every editor card. It also loads `editor-skills/*.md` into the `skills` table. Open `/app/agents`.
4. **`@manager` starts in mode `off`.** Set it to `shadow` on its page: it then reviews the network at its times and
   stores directives without delivering them. Switch it to `live` once its reviews look sensible.
5. **Proxy.** The promo redirect `/r/:code` is a bare-root route. It has been added to `apps/dashboard/nginx.conf` and the vite
   dev proxy. If Caddy sits in front, it must forward `/r/*` too.

## 2. Environment

| Variable | Default | Meaning |
|---|---|---|
| `EDITOR_ORCHESTRATION` | on | `off` disables the daily orchestrator runs (playbooks, idea pool). Planning and publishing work as before. |
| `EDITOR_MODEL_<ROLE>` / `EDITOR_REASONING_<ROLE>` | — | Per-role model and reasoning effort. New roles: `ORCHESTRATOR`, `IDEA_REVIEWER` (default `z-ai/glm-5.3`), `MANAGER`, `BUILDER`. |
| `DIRECTIVE_TIMEOUT_HOURS` | 12 | How long a structural directive waits for the owner. |
| `DIRECTIVE_TIMEOUT_APPLY_KINDS` | — | Comma list of kinds that apply on timeout. All others are dropped. |
| `PUBLIC_BASE_URL` | `DASHBOARD_URL` | Base of tracked UTM links (`<base>/r/<code>`). Without it, UTM links are untracked. |
| `PROMO_HASH_SALT` | derived from `TOKEN_ENCRYPTION_KEY` | Salt for the hashed user ids of joins. |
| `TIKTOK_PRIVACY_LEVEL` | `SELF_ONLY` | TikTok posts stay private until the app passes TikTok's audit. |

## 3. Networks (one brand on several platforms)

- **A network is an account group** (`/app/connections/groups`) with a Telegram channel and Meta and/or TikTok accounts.
  - TikTok accounts can now join a group too, through `tiktok_accounts.group_id`.
  - The network is run by **the orchestrator of its Telegram channel**.
- **How a network goes from mirroring to native posts:**
  1. Give the agent a brief in the chat (`@ai0 новий бриф для @kira: …`) or on its Playbook tab ("Rebuild from brief").
  2. The orchestrator drafts a playbook and the idea reviewer comments on it.
  3. You approve it on the Playbook tab.
  4. Switch the network to **Orchestrated** on the same tab. Mirrors of Telegram posts stop for that network, and the
     planner plans native slots for every resource.
- **Shadow first.** Platform posts in shadow are stored in `platform_posts` (status `shadowed`) and sent to you as
  previews. Nothing is posted until the anchor channel's card **and** the orchestrator are `live`.

## 4. Daily cycle (Kyiv time)

| When | What |
|---|---|
| Card plan hour (default 06:00) | The orchestrator's daily run: it resolves directives and tops up the idea pool. The idea reviewer reviews new ideas. Then the planner plans the day; in a network, it plans all resources. |
| Every minute | Due slots run. Telegram slots use the editor executor. Instagram, Facebook, Threads and TikTok slots use the platform executor. Reserved slots (ads, chat posts, promos) are published by code. |
| 08:00, 13:00, 18:00, 22:30 | `@manager` reviews the KPI digest. If nothing changed and there is no anomaly, the run is skipped without an LLM call. |
| Hourly | Registry sync (:17), expired confirmation cards and shadow → "go live?" cards (:23), and directive timeouts, expiry and effect evaluation (:47). Skill probes (:50, §18). |
| Every 3 h | Platform post metrics plus a daily follower rollup (`resource_daily_stats`). |
| 05:40 | Review of skill self-edits: kept, or rolled back on a KPI drop. |
| 06:10 | Resource health check. A resource that becomes unusable triggers a card, and nothing is planned on it until it is fixed. |

## 5. Owner controls

- **Pausing:**
  - one agent: its page → Pause (indefinitely, 24 h, or until a date);
  - a whole network: pause its orchestrator;
  - every scheduled run: `EDITOR_ENABLED=false`;
  - the LLM-free reserved publishing (ads, scheduled chat posts) keeps running on purpose.
- **Skills:** edit, override, lock or roll back on the agent page's Skills tab.
  - Agents may self-edit at most one skill a day. You get an inbox item with the diff.
  - An edit of a live skill is tried on recent posts before it goes live (§18); the old text stays live meanwhile.
  - A self-edit is rolled back automatically when views per post drop ≥ 15 % beyond the noise band within 7 days.
  - Safety skills (`fact-check`, `source-licensing`) and locked skills cannot be edited by agents.
- **Chat** (`/app/chat`):
  - Mention `@handle` to talk to an agent, `@ai0` to create or change agents, `@manager` to ask about the network.
  - Every change is a card with Apply / Discard.
- **Inbox** (`/app/agents/inbox`): skill self-edits and rollbacks, pending playbooks, structural directives, go-live
  offers and resource health.

## 6. Platform limits to know

- **TikTok:** API posts stay private until the app is audited. The images must be hosted on a domain verified in the
  TikTok developer portal, because the slide hosting bucket is pulled by URL.
- **YouTube Shorts, Instagram Reels, TikTok video:** these need spec 019b (after the shorts-studio bridge, spec 016).
  The capability matrix marks them "not yet", so agents cannot plan them.
- **Instagram:** links in captions are not clickable. Agents write "посилання в біо" and may add a first comment.
- **Tracked Telegram invite links** need our bot to be an admin of the target channel with the invite right.
  - Joins are counted from `chat_member` updates, which the admin bot (`TELEGRAM_BOT_TOKEN`) receives.
  - Channels on another bot fall back to public links, and their joins are unknown.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| No agent for a channel | `/app/agents` triggers a sync. Also check that the channel has an editor card. |
| Orchestrator never runs | `EDITOR_ENABLED`, `EDITOR_ORCHESTRATION`, the card mode is not `off`, the agent is not paused, and budgets on its page. |
| Network plan missing | The group mode is Orchestrated **and** there is an active playbook. Check the planner run on the agent's History tab. |
| Directive stuck | The `@manager` → Directives board. `awaiting_owner` waits for you; `new` is delivered on the orchestrator's next run. |
| Promo refused | The directive's resolution says why: pair cooldown, low relevance, health, no window, or proximity to an ad. |
| Platform post failed | `platform_posts.error`, and the resource health on the agent page. |

## 8. Live evals (owner key)

```bash
cd apps/automation && EVAL_DB_URL=<scratch PG> npx tsx --env-file=../../.env evals/run-evals.ts --case builder-onboarding,mention-explain,playbook-from-brief,idea-review,network-plan-staggered,platform-native-variant,manager-stable-continue,manager-drop-directive
```

The baseline is `evals/results/baseline-2026-10-02-agents.md`: 18/18, about $0.05 for the whole suite.

## 9. Setup from history (spec 042)

The onboarder reads an own channel's last 20 posts and proposes its agent's setup. Nothing changes until you apply a section.

**Needs**

- Migration `080_channel_setup` (and `090_setup_proposal_expired` for the expiry below).
- A model key: `OPENROUTER_API_KEY` or the Anthropic key. `EDITOR_ENABLED` is not needed; the owner starts each run.
- The channel is marked as yours (`tracked_channels.is_mine`).
- For channels with fewer than 20 stored posts, a logged-in tracking userbot that can read the channel. It tops up `tracked_posts` once, with up to 50 messages.

**Use**

- Type `/setup @channel` in the chat (spec 048), one channel per command. You can also use "Set up from history" on a channel agent's page, which shows the cost first, or ask `@ai0` with `analyze_channel_history`. The cost is the average of the last 20 successful onboarder runs. There is no estimate before the first run.
- Each run takes about a minute. The worker runs one channel at a time, every minute and at boot. The proposal's chip in the chat follows its status.
- Open the proposal from its chip, from Agents → Artifacts (type "Setups from history"), or from the agent's Artifacts tab. `/app/setup` redirects there. Each section shows "now → proposed" and the posts it rests on. Tick the sections you want, then choose **Apply selected**.
- Sections are written in order: brief and profile, formatting, format mix, series and pillars, schedule, examples and voice. Apply stops at the first failure, and the dialog names the section that failed.
- What Apply keeps and writes:
  - Owner-locked formatting fields and locked series are kept.
  - A new series is written as locked, and its origin is the owner.
  - The voice goes to the agent skill `channel-voice`, for the executor and the checker.
- A channel without an editor card gets one in mode **off**, and its agent is created by the registry sync. Nothing publishes until you switch the mode.

**Statuses**

| Status | Meaning |
|---|---|
| `queued` / `collecting` / `analyzing` | Running. A FLOOD_WAIT puts the run back in the queue with a retry time; a run stuck for 15 min is requeued. |
| `ready` / `partially_applied` | Waiting for you. A new analysis of the same channel supersedes the open proposal. |
| `expired` | Nobody applied it within `SETUP_PROPOSAL_TTL_DAYS`; closed by itself (see Expiry). Analyze again for a fresh one. |
| `no_access` | The tracking account cannot read the channel. Add it to the channel, then analyze again. |
| `too_few_posts` | Fewer than 5 usable posts. The model is not called. |
| `failed` | The reason is on the row. The run trace is under "Open the run" (role `onboarder`, usage feature `editor.onboarder`, at most 4 steps and $0.30). |

**Changed since analysis**

If you edited a section after the analysis, Apply refuses that section and applies the rest. Analyze again to review it with the new values.

**Expiry (spec 057)**

- A proposal that stays `ready` or `partially_applied` for `SETUP_PROPOSAL_TTL_DAYS` days (Settings → Configuration → Editor, default 14, applied at once, `0` = never expire) becomes `expired`. The age counts from its last change (the analysis, or the last Apply). Needs migration `090_setup_proposal_expired`.
- Its sections that were still pending are skipped, as with Discard; sections already applied stay applied. `queued`, `collecting`, `analyzing`, `failed`, `no_access` and `too_few_posts` are never expired.
- `expired` is final like `discarded`: Apply and Discard answer 409 `not_open`, and the channel's open-proposal slot is free again. The dialog says "Closed after N days without an apply" and offers **Analyze again** (cost shown first). In the Artifacts page it sits under Closed; the owner bot's "Налаштування з історії" card of it closes as «Минув термін».
- The sweep is code only (no model call). It runs from the minute tick of the setup worker, at most once an hour per instance (the SQL is idempotent, so a second instance is harmless), and at boot.
- After a sweep that expired anything you get one Inbox note (kind `setup_expired`, info) listing the channels, saying that applied sections stay and how to run a new analysis. The dashboard Inbox shows it in English, the Telegram alert is in Ukrainian.
- **Check it**: `SELECT channel_key, status, reason, updated_at FROM channel_setup_proposals WHERE status = 'expired' ORDER BY updated_at DESC LIMIT 5` (the reason reads "expired: closed after N days without an apply"). Nothing expires: check the setting is not `0` and that the service ran for an hour. To bring one back, run the analysis again.

## 10. Steering (spec 045)

Steering points one of your channels at a public channel you like. The onboarder reads that channel's last 20 posts and writes rules for your channel: the form (structure, opening line, length, formatting, calls to action, series) and the direction of the content, adapted to your channel's own subject. It never copies the reference's voice, text or facts. Steering is the lowest-priority rule source. Your owner rules, the playbook, the profile, formatting, style and examples always win.

**Needs**

- Migration `081_steering`.
- A model key: `OPENROUTER_API_KEY` or the Anthropic key. `EDITOR_ENABLED` is not needed; the owner starts each run.
- Your channel is yours (`tracked_channels.is_mine`) and has an editor card.
- A logged-in tracking userbot. It reads public channels without joining them; private channels and invite links are refused.

**Use**

- Type `/steer @yours @theirs` in the chat (spec 048). The reference can be `@username` or a `t.me/…` link. You can also choose **New steering** on Agents → Artifacts, which opens the chat with `/steer` typed, or ask `@ai0` with `steer_channel`.
- One model run per analysis (role `onboarder`, usage feature `editor.steering`, at most 4 steps and $0.30). A worker takes one set at a time, every minute and at boot.
- Open the set from its chip in the chat or from Agents → Artifacts (type "Steering") when it shows **Ready to review**. `/app/steering` redirects there. It shows a summary, then the rules: kind, text, the reference posts behind each rule (linked), and a switch per rule. You can edit a rule's text. An edit that quotes 60+ characters of a reference post, or asks the agent to pose as a human or to copy, is refused.
- A rule that contradicts your channel's own rules is marked **Conflict**. It stays on the set so you can see it, but the agent never gets it.
- **Activate** gives the rules to the agent from its next run. The rules go to the planner and the writer prompts, below all your other rules. The critic reads them as advice for `format_fit` only, never as a reason to reject.
- A channel follows at most 3 references at once. **Pause** and **Resume** take a set out of the prompts and back. **Analyze again** reads the reference again into a new set; the old one stays active until you activate the new one, and then it becomes `superseded`.
- **Discard** closes a set. Closed sets (discarded, superseded, failed) keep the post ids, dates and numbers, but not the reference texts.
- A post that repeats 80+ characters of an active reference's post is refused at publish with `steering_copy`. This applies to the agent, the chat and native-platform posts.
- The agent page Overview shows "Setup from history · Steering: N active from @a, @b · Owner rules" with a link to the agent's Artifacts tab.

**Statuses**

| Status | Meaning |
|---|---|
| `queued` / `collecting` / `analyzing` | Running. A FLOOD_WAIT puts the set back in the queue with a retry time; a set stuck for 15 min is requeued. |
| `ready` | Waiting for your review. |
| `active` / `paused` | In the prompts / out of them. |
| `no_access` | The tracking account cannot read the channel. It must be public. |
| `too_few_posts` | Fewer than 5 usable posts. The model is not called. |
| `failed` | The reason is on the set. The run trace has role `onboarder` and feature `editor.steering`. |
| `discarded` / `superseded` | Closed by you, or replaced by a newer analysis of the same reference. |

Other platforms come later: Instagram can be read through the Graph API `business_discovery` field of one of our IG business accounts (spec 045 FR-010).

## 11. Chat workspace and artifacts (spec 048)

Artifacts are what shapes an agent: setups from history, steering sets, owner rules, memory, skills, playbooks, profiles and formatting. One registry lists them all, and setups, steering and owner rules keep their versions.

**Needs**

- Migration `084_artifacts` (the `artifact_versions` table). Nothing to enable.

**Use**

- **Commands.** Type `/` at the start of the chat composer for the menu:
  - `/setup @channel` and `/steer @yours @theirs` start the work. They are the same as `analyze_channel_history` and `steer_channel`, run as the owner.
  - `/rules`, `/skills` and `/memory` list the matching artifacts.
  - `/help` lists the commands.
  - Commands run in code with no model turn.
  - A missing `@channel` falls back to the chat agent's channel, then to the picked one.
- **Chips.** A message shows the artifacts it made or changed as chips. A chip shows the current status and version. A click opens the panel next to the thread. On a phone the panel is a full-screen sheet. The open artifact is in the URL (`?art=type:id`).
- **Panel.** It shows the details, your edit (through the type's own checks), the type's actions, and the versions with a diff against the one before. **Ask the agent** puts `[[type:id]]` into the composer, and the agent reads it with `get_artifact`.
- **Agent changes.** When an agent changes a live artifact or owner rules, it proposes an **Apply / Discard** card. The change is checked before the card and again at Apply. A draft changes at once, but only when you asked for the change.
- **Artifacts page.** Agents → Artifacts (`/app/artifacts`) has:
  - filters by type, view (All / Needs you / In use / Closed) and agent, kept in the URL (`?type`, `?view`, `?agent`);
  - `?open=type:id`, which opens one artifact;
  - **Open in chat**, which goes to the chat that made the artifact, or starts a new chat that names it.
- **Agent page.** Each agent page has an Artifacts tab with that agent's artifacts. The Skills, Memory and Playbook tabs stay.
- **Chat layout.** On `/app/chat` the app menu is the icon rail. Its toggle opens the full menu on this page only. The chat list is its own column, and it becomes a drawer on a phone or when the panel is open under 1280 px.

## 12. Owner bot (spec 012 part A)

What waits for you comes to Telegram as a card with buttons. A tap does what the same button does in the dashboard. A daily summary and a weekly report come on their own. The bot is the admin bot (`TELEGRAM_BOT_TOKEN`); cards go to the `TELEGRAM_OWNER_ID` chat, like the alerts.

**Needs**

- Migration `085_owner_cards` (`owner_cards`, `owner_reports`).
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` set. Write to the bot once (`/start`) so it may message you.
- One service instance only: the bot is the one `getUpdates` consumer of its token. Its offset is in `app_settings` (`owner_bot.offset`).

**Settings** (Settings → Configuration → Telegram, applied at once)

| Setting | Default | What it does |
|---|---|---|
| `OWNER_BOT_CARDS` | `on` | `off` stops the cards and brings back the plain inbox alerts |
| `OWNER_QUIET_HOURS` | `23-8` | Kyiv hours when only critical cards go; `off` = none |
| `OWNER_BOT_MAX_PER_HOUR` | `30` | Cards per hour; critical cards go anyway |
| `OWNER_DAILY_REPORT_AT` | `21:00` | Daily summary time (Kyiv); `off` turns it off |
| `OWNER_WEEKLY_REPORT_AT` | `Mon 09:00` | Weekly report time (Kyiv); `off` turns it off |

**Cards**

- Posts to approve (after the batch alert), directives and contested directives, agent cards made outside a chat, ready steering sets, ready setups from history ("Застосувати все" asks to confirm), playbook versions, and critical or action inbox notes.
- Items that already waited when cards were switched on do not come by themselves: send `/waiting` (10 at a time, oldest first).
- A card decided in the dashboard loses its buttons and says "Вирішено в дашборді" (or "Минув термін") within a minute.
- A post due within 2 hours and a critical inbox note are critical: they skip quiet hours and the hourly limit.
- While cards are on, inbox notes are not sent as plain alerts: info notes go into the daily summary.

**Commands** (private chat, from the owner or an id in `TRACKING_ALLOWED_TG_USER_IDS`): `/status`, `/waiting`, `/today`, `/week`, `/analyze`, `/help`.

**Check it**

- Network health (`/app/health`) → **Owner bot**: whether it polls, the cards (open, queued, sent today, not sent), when the reports last went out.
- **Send a test card** sends a card with one "Працює" button; a tap closes it and proves the buttons reach the service.
- **Send today's summary** / **Send the weekly report** send them now; the scheduled ones still go at their time.
- A card that Telegram refused 5 times is counted under "Not sent today"; `/waiting` sends it again.

## 13. Channel launch (spec 052)

A new channel from a brief: you create the channel in Telegram, the agents plan it, you approve its first posts, and it goes live once the approvals show the agent writes well.

**Needs**

- Migration `086_channel_launches`.
- The channel exists in Telegram with a public @username (the launch never creates channels).
- A bot that can post there: the channel's own bot from Settings → Telegram, else the default bot. Add it as an administrator with "Post messages".

**Steps**

1. In the chat: `/launch @new_channel [@reference …] brief` (up to 3 public reference channels, a brief of at least 30 characters), or ask @ai0 to launch it. A card and an agent in `off` appear at once.
2. The references are read as steering sets (up to an hour), then one onboarder run makes the plan (a few cents, feature `editor.launch`). The launch panel (chat chip or Artifacts → Launches) shows the plan and the checklist. **Make the plan again** takes a new brief.
3. **Start** (panel or the owner bot card) applies the plan (profile, card, formatting, mix, schedule, playbook, voice skill), activates the reference sets, puts the first-week ideas into the pool as accepted and switches the channel to approval. Pressed before the bot is an admin, Start waits and runs on the minute the bot check passes (checked every 2 minutes; **Check the bot now** asks at once).
4. Approve the first posts in Approvals or the owner bot. After 3 published posts up to 3 of your other channels (in approval or live, healthy, relevant ≥ 3/5) get a cross-promo, scheduled through the 022 promo limits.
5. Graduation is checked hourly: 7 days in approval, 10 approved posts, 80 % without edits, no rejection in the last 5, critic passes 80 % over 5+ verdicts, the channel healthy. Then a "Ready to go live" card: **У Live** runs the autonomy switch (clean waiting posts are approved too), **Ще ні** waits 7 days and 5 more approved posts.

**Settings** (Settings → Configuration → Editor, applied at once)

| Setting | Default | What it does |
|---|---|---|
| `LAUNCH_GRADUATION` | `propose` | `propose` = a card; `auto` = goes live by itself and files an inbox note; `off` = progress only |
| `LAUNCH_GRADUATE_MIN_DAYS` | `7` | Days in approval since Start |
| `LAUNCH_GRADUATE_MIN_APPROVED` | `10` | Approved posts since Start |
| `LAUNCH_GRADUATE_MIN_CLEAN_PCT` | `80` | Share approved without edits |
| `LAUNCH_GRADUATE_MIN_CRITIC_PCT` | `80` | Critic pass rate (over at least 5 verdicts) |

**Check it**

- The panel's checklist says what waits and who does it; a failed Start keeps the launch ready with the step in the reason (press Start again: each step is idempotent).
- `GET /api/launches?channel=@name`, `GET /api/launches/:id` (with the checklist and growth).
- **Stop the launch** (running) closes the launch only; the channel keeps its mode. Discard before Start also discards the reference sets that were not activated.

## 14. Agent loadout (spec 054)

Each agent has its own tool set. Every tool offered is re-sent to the model on every step, so a smaller set is cheaper and gives the model fewer ways to wander. Existing agents keep the full set of their role until you change it.

**Needs**

- Migration `087_agent_loadout` (`agent_tools`, `agents.loadout_mode`, `editor_runs.tools_offered`). Down: `database/migrations/down/087_agent_loadout.down.sql`.
- No settings and no env vars. Nothing here calls a model.

**How it works**

- Mode `role` (the default for every existing agent): the agent is offered every tool of its role, as before. Mode `custom`: only the tools enabled for it, intersected with the channel card's `tools_allow`.
- Terminal tools (publish, plan, skip, submit) are always offered. Core tools (the few its workflow skill names) cannot be switched off. Unknown names stored for an agent are ignored.
- The list is fixed once per run and recorded in `editor_runs.tools_offered`. A scheduled run uses the loadout only when the agent's own role is the run's role; in the chat the agent keeps the composer and chat-only tools.
- A **new** agent (made by the builder or by the registry sync) gets mode `custom`: core tools, the platform or Telegram-only tools its resource needs, and tools that its role's peers call in at least 20 % of their runs (given 5+ peer runs in 30 days). The sync never changes an agent that already exists.

**Owner steps**

1. Open `/app/agents/<handle>` → **Loadout**. Tools are grouped Read · Act · Finish, each with uses, errors, last use and token size. Header: the mode and "~N tokens per call (role default M)".
2. Flip a toggle to drop or add a tool (the first flip makes the loadout `custom`). Locked toggles are core or terminal tools, or tools that runs of this role always drop (the writer's raw SQL).
3. **Reset to role default** (behind a confirm) removes the choices and goes back to the full role set.
4. **Suggestions** (counted from the last 30 days, no model):
   - *Missing*: the agent called a tool it was not offered, 2+ times (the harness's `tool_not_allowed` refusal).
   - *Peers use it*: peers of the same role call it in 30 %+ of their runs (5+ peer runs).
   - *Unused*: an optional tool offered in 10+ runs and never called.
   - *Stale*: a stored name that is not a tool of the role any more.
   - *Skill unused*: an enabled on-demand skill never loaded while the agent ran 10+ times (skills already in the prompt, safety and voice skills are never suggested).
   Apply one with its button, or **Use recommended** (confirm) for all of them.
5. Skills and Rules on this tab are read-only summaries with links to where they are edited (Skills tab, Rules / Memory / Steering / Playbook artifacts). Rules belong to the channel and bind every agent on it.

**Where suggestions also show up**

- The manager's KPI digest: one `loadout` block, at most 5 lines across the network. The manager may mention it in advice; there is no directive kind for it (changing tools is your decision).
- A weekly inbox note (Mondays 09:30, once per ISO week, kind `loadout_suggestions`, severity `info`): «Інструменти агентів: N пропозицій», linking to the first agent's Loadout tab. Nothing is posted when there are no suggestions.

**API** (TrackingAuthGuard): `GET /api/agents/:handle/loadout`, `PUT …/loadout/tools` `{ tools }` (refusals `core_tool`, `unknown_tool`), `POST …/loadout/reset`, `POST …/loadout/apply` `{ add, remove, disableSkills }` (also `safety_skill`, `unknown_skill`).

**Check it**

- After a run: `SELECT tools_offered FROM editor_runs ORDER BY started_at DESC LIMIT 1;` lists the names that run was offered (null for runs before the migration).
- A Telegram-only agent created before its channel joined a network has no `lint_platform_post`; a *Missing* suggestion appears after two refused calls, or add it on the tab.
- Roll back one agent with **Reset to role default**; roll back everything by applying the down migration (agents go back to the full role set).

## 15. Network map (spec 056)

`/app/map` ("Network map" in the sidebar) shows the whole network as one live map: networks are territories, channels and accounts are buildings, agents are units with pixel avatars, cross-promo and repost flows are roads, today's spend is the gem in the top bar, and what waits for you is a beacon on the building.

**Needs**

- Nothing to enable and no migration: the page reads `GET /api/map`, built from the resource catalog, the agents, the spend caps, network health, promo pairs and the last 24 hours of runs and slots. Tables from later migrations that are missing are skipped, not fatal.

**Reading the map**

- A unit's ring is its state: idle, planning, writing, reviewing, waiting (posts wait for you), publishing, error, paused or off. The state is derived from live facts (a running run, a slot about to go out, posts waiting, the last run or post failing, a pause on the resource); the legend (bottom left) lists them.
- The level badge (1–10) counts quality, never volume: clean approvals plus critic passes, minus twice the rejections, minus failed runs, over 30 days; every 10 points is a level. Role agents show their orchestrator's level. The unit drawer states the numbers.
- A building's border is the connection health (connected, needs attention, broken); hatching means paused; the number badge is what waits for you there. Roads: dashed blue is cross-promo, dotted is repost, solid is duplicate.
- Everything clicks through: the drawers link to the agent page, its Artifacts, a chat with the agent, Approvals and the right Connections section. The bell in the top bar lists everything that waits for you.
- Sections: each network is its own section; resources outside any network sit in one section per platform (Telegram channels, Instagram, Facebook pages, Threads, TikTok, YouTube). Below, on a row of their own, are the connections the channels work through: Telegram bots, MTProto sessions (tracker or agent) and Telegraph accounts. Their border is the last verify (a broken one that is switched on is also an alert); the default bot wears a star. A selected bot draws dotted lines to the channels it publishes to (its own channels, and as the default bot every channel without a bot); a selected channel draws the line to its bot. No token, session string or phone ever reaches the map.
- Roads are the links that exist now (spec 058, §17), not 30 days of traffic: a copy link between a network's Telegram channel and each other member, and a promo link for each pair the owner linked (or an approved promo linked). A link with no posts yet is drawn thin. Past links (activity of the last 30 days between resources no longer linked) are drawn only after **Show past links**. The road drawer says what each line is and breaks it.
- Changing it from the map: a building's drawer has a **Network** picker — move the resource into another network (one per platform per network; a network that already has that platform is greyed out), take it out of any, or start a **New network** with it; taking out a network's Telegram channel warns that the network's agent is anchored on it. A road's drawer breaks the link (§17) or switches a legacy network to **Independent**. Endpoint: `POST /api/map/resource-network {ref, groupId|null}` (`POST /api/map/promo-block {a, b, blocked}` stays: block = unlink, allow = link).
- Each building wears its mode — LIVE, APPROVE, SHADOW or OFF (the Telegram card's mode, else the mode of the agent that runs it); the drawer repeats it with a link to change it on the agent page.
- The MTProto tracker session in use (the first active one) draws lines to every Telegram channel when selected — it reads their views and subscribers; another active tracker is on standby, an agent session writes DMs and is tied to no channel.

**Live updates**

- The page polls every 5 s while any unit is planning, writing, reviewing or publishing, otherwise every 30 s, and not at all while the tab is hidden. "Offline" in the top bar means the last answer is older than 90 s.
- Only what is new animates (a state change, a published post, a promo, a failure, a new alert); nothing animates on the first load, and nothing replays after a long time in a background tab. With `prefers-reduced-motion` nothing moves, only colours change.

**Check it**

- `GET /api/map` as the owner: one JSON snapshot, cached for 5 s, no post text (an event names a post by its topic only).
- The map says "not available right now" with a Try again button when the snapshot fails; the rest of the dashboard is unaffected.
- Rendering is deterministic: the same network always lays out the same way, so a poll never moves anything; the positions change only when channels, networks or agents are added or removed.

## 16. Sysadmin audit (spec 055)

Once a week @sysadmin looks over the material that shapes the agents: skills, memory, owner rules, config conflicts, playbooks, steering sets, tool errors and the inline skill budget. The code runs the checks, then one bounded model pass adds a summary, comments and a few findings of its own. You get a report with one-click fixes. @sysadmin never changes anything by itself.

**Needs**

- Migration `088_audit_reports` (`audit_reports`, `audit_dismissals`, and `agents_kind_check` widened to the `auditor` kind). The registry sync creates @sysadmin (kind `auditor`, system scope, live) on the next hourly sync after the migration, or at boot.
- A model key (OpenRouter or Anthropic) only for the model pass. Without one, or with the pass switched off, the report holds the code's findings and says so. The weekly run needs neither `EDITOR_ENABLED` nor a running writer: it publishes nothing.
- One service instance schedules the run, but a second one is harmless: the week is claimed by a unique insert.

**Settings** (Settings → Configuration → Editor, applied at once)

| Setting | Default | What it does |
|---|---|---|
| `AUDITOR_ENABLED` | `true` | `false` stops the weekly run; `/audit` and Run again still work |
| `AUDITOR_LLM` | `on` | `off` = the report has the code checks only (no model call, no cost) |
| `AUDITOR_WEEKDAY` | `1` | Day of the weekly run, 1 = Monday … 7 = Sunday (Kyiv) |
| `AUDITOR_AT` | `06:30` | Time of the weekly run, `HH:MM` Kyiv |
| `AUDITOR_BUDGET_USD` | `0.15` | Cap of the model pass; over it, the report goes on without comments |

The model pass uses the `auditor` role: Haiku on the Anthropic workspace, low effort, at most 8 steps; its spend is under the feature `editor.auditor`.

**What it checks** (all in code, at most 25 findings per check)

- Skills: lint errors and warnings, unknown tool names, enabled skills no run of the agent loaded in 30 days (agents with at least 10 runs), near-identical skills of one agent, skills rolled back twice in 60 days, self-edits stuck in `probing` for more than 3 days, and agents whose edits the probe rejected 3 times in 30 days (§18).
- Memory: rows no prompt shows (more than 30 active), duplicates, old reviewer insights nothing confirms.
- Rules: owner-rule lint, rules against config (the config conflicts), playbook validation, steering sets with no rules or a missing channel.
- Tools: error rate of 20 % or more over 7 days, runs of a role that end without a result.
- Prompt: inline skills over the 8000-character budget.

**The report**

- Artifacts → Audits (or `/audit` in the chat, which starts a run and shows the report as a chip). The report lists the open findings by area as compact rows; a row opens the detail, the evidence, @sysadmin's comment and the buttons.
- **Apply fix** is one of four, each through the service that already does it: disable a skill, turn a skill's inline off, retire a reviewer memory row (never an owner row), resolve the config conflicts of an agent. A fix whose subject changed since the report is refused with the reason and the finding is marked "fix failed".
- **Dismiss 30 days** leaves the finding out of the next reports until the date. Handled findings (applied, dismissed) collapse at the bottom.
- **Run again** starts a run at once and the page refreshes by itself while it runs. A run left running for 30 minutes (a crash) stops blocking new ones.

**Owner note and manager**

- After the scheduled run, if at least one finding is open, one inbox note (kind `audit_report`) comes: «Аудит системи: N знахідок (E помилок), F можна виправити одним кліком» with the first line of the summary. It is an action note when any finding is an error, else info; the dashboard Inbox links it to the report. Your own Run does not post a note.
- The MANAGER's digest gets one `audit` line (open findings by severity, the report id, week) while the newest report has open findings. No directive kind and no change to the digest hash.

**Check it**

- `GET /api/audits` (reports with counts), `GET /api/audits/:id`; `POST /api/audits/run` starts a run in the background (409 `already_running` while another is alive).
- The week was run if `SELECT week, trigger, status FROM audit_reports ORDER BY started_at DESC LIMIT 3` shows a `schedule` row for it. A failed scheduled run is not retried that week: press Run again.
- No report on Monday: check `AUDITOR_ENABLED`, `AUDITOR_WEEKDAY` and `AUDITOR_AT`, and that the service was up after the time.
- The report's amber note says why the model pass was skipped (switched off, no key, @sysadmin off, budget, no answer).

## 17. Map links the owner controls (spec 058)

On `/app/map` a road is a link that exists now. Two kinds: a **copy link** (network membership: the network's Telegram channel to each other member, solid; "Duplicate" for an Auto-duplicate network, "Adapted copy" for an Independent one) and a **promo link** (a pair the owner linked: cross-promos and reposts between them, dashed or dotted). The owner makes and breaks both from the map; breaking makes the line disappear at once.

**Needs**

- Migration `091_promo_links` (`promo_pairs.linked_at`, table `map_link_events`). The seed runs once, when the column is created: every pair with a promo in the last 60 days that is not blocked is linked both ways, so today's active pairs stay on the map. Re-applying never relinks a pair you unlinked. Down: `database/migrations/down/091_promo_links.down.sql`.
- Nothing to enable. Without the migration the new endpoints answer with an error and the map shows it as a toast; the map itself still loads.

**What a link means**

- A promo pair is linked when `linked_at` is set and `blocked_at` is not (both directions are kept in step). A linked pair skips the relevance check in the promo planner; an unlinked pair still has to pass it, and approving a promo for an unlinked pair links it.
- **Unlink** sets `blocked_at`, clears `linked_at` and skips the pair's pending promo slots (`promo pair blocked by owner`). The planner and the manager's `cross_promo` / `repost` tools refuse the pair with `pair_blocked` until it is linked again. The promo overview (`GET /api/agents/:handle/promo`) lists `linked` and `blocked` on each pair.
- A copy link follows membership: a resource that leaves a network (or the anchor leaving) has its pending derived copies skipped (`resource left the network`), in both directions. A network without a Telegram channel has no anchor and draws no copy links.
- Past links: the last 30 days of promo pairs no longer linked, and copy traffic of a resource that left a network. They are never drawn unless **Show past links** is on; the road drawer says "Not linked any more" and offers **Link again** for a promo pair.
- The feed shows what you changed: "linked X and Y", "unlinked X and Y", "X left Network" (`map_link_events`, refs and the network name only).

**On the map**

- A building's drawer, **Links**: the network picker with the network's other members as chips, the promo partners as chips (× unlinks after a confirm), and **Link resources…**, a searchable checklist of every other resource grouped by network and platform (checked = linked; the footer says "N to link, M to unlink"; Apply sends one call).
- A road's drawer: a copy road takes the target out of the network (or switches a legacy network to Independent), a promo road unlinks the pair; both say how many planned copies or promos were skipped. A past road offers Link again.
- A network's drawer (click its label on the map, or its name in a building's drawer): mode, Telegram channel, agent, free places, the members and **Members…**, a checklist of the network's members and the resources in no network (one per platform: a taken platform is disabled and names who holds it). Removals go first, so one Apply can swap a member for another of the same platform. A partial success lists the refused ones.
- **Link** in the top bar starts link mode: click a building, then another; the popover offers **Promo partners** and, when the first is in a network with a free place for the second's platform, **Put <B> in <network>**. The mode stays on for the next pair; Esc leaves it.

**Endpoints** (owner only)

| Call | Body | Answer |
|---|---|---|
| `POST /api/map/links` | `{ref, add: [ref], remove: [ref]}` (30 refs per list at most) | `{ref, linked, unlinked, canceled}` (only the pairs that actually changed) |
| `POST /api/map/network-members` | `{groupId, add: [ref], remove: [ref]}` (30 per list; 400 above) | `{groupId, groupName, results: [{ref, ok, error?}], canceled}` (partial success) |
| `POST /api/map/resource-network` | `{ref, groupId \| null}` | `{ref, groupId, groupName, canceled}` |
| `POST /api/map/promo-block` | `{a, b, blocked}` | block = unlink, allow = link |

Each change drops the snapshot cache, so the next `GET /api/map` is current.

**Check it**

- `SELECT source_ref, target_ref, linked_at, blocked_at FROM promo_pairs WHERE linked_at IS NOT NULL OR blocked_at IS NOT NULL ORDER BY 1, 2;` shows the pairs both ways. A pair must not have both columns set.
- `SELECT at, kind, ref, other_ref, detail FROM map_link_events ORDER BY at DESC LIMIT 10;` is the feed's owner changes.
- After an unlink, `SELECT id, status, error FROM editor_slots WHERE error = 'promo pair blocked by owner'` shows the skipped slots.
- Tests: `map.links.pg.test.ts` (setLinks, setMembers, copies skipped, seed), `map-roads.test.ts` (roads = links + past), `manager/directive-pair-blocked.test.ts`, `promo.pg.test.ts`; in the dashboard `lib/map-links.test.ts`. `lib/map-demo.ts` has a linked pair with no traffic, past roads and a network with free places for a mock-server check.

## 18. Probe before adopt (spec 059)

An agent's `propose_skill_edit` no longer goes live at once. The edit is stored as a `probing` version and the previous text stays live. An hourly job (:50) tries it on the agent's latest posts, then adopts it, rejects it or says it could not tell. The owner gets one Inbox item per decision.

**Needs**

- Migration `092_skill_probe` (`skill_versions.probe`, outcomes `probing` and `rejected`, a partial index). Apply it before deploying the code that reads it. Down: `database/migrations/down/092_skill_probe.down.sql` (probing and rejected rows become `superseded`).
- Nothing to enable. The probe needs the editor on and a model key like any run; a probe that cannot run adopts the edit as before, marked `unprobed` with the reason.

**What happens**

1. `propose_skill_edit` on a live skill returns `probing: true` ("зміну перевіряю на N недавніх постах, рішення — у наступному прогоні"). A new skill, an owner edit, a safety or locked skill, and any edit while probes are off apply at once, as before. A newer write (an agent proposal or your edit) drops a waiting probe.
2. The job takes the waiting edits oldest first, at most `SKILL_PROBE_PER_DAY` per Kyiv day, each within `SKILL_PROBE_BUDGET_USD`. For each it picks the `SKILL_PROBE_SAMPLES` newest published or approved posts of the agent's scope (a `format-` or `platform-` skill prefers posts of that format or platform), writes each post twice as a dry run (the live text, then the proposed text for that run only, nothing stored or sent), and a pairwise judge on the critic's model compares the two in random order. The spend is `editor.probe`; the critic's own passes stay `editor.checker`.
3. Code decides:
   - **Rejected**: the new text's post got a critic `reject` / `revise` that the old text's post did not, or the judge preferred the old text in most pairs. The version is never live; the agent gets an `avoid` memory line with the evidence.
   - **Adopted**: never worse on the critic's ladder, at least one win, and wins plus ties above half. It goes live under the usual 7-day KPI review.
   - **Inconclusive** (anything else, or the budget ran out) and **Unprobed** (probes off, the writer does not read the skill, no post to re-write, every run failed): live as before, same KPI review.
4. The evidence is in the version's row (`skill_versions.probe`): per post the old and new text, critic verdicts, lint counts, the judge's call, reasons and risks, and the cost.

**On the dashboard** (agent page → Skills → a skill's versions)

- Badges: `Probing…`, `Rejected by probe`, `Adopted after probe`, `Adopted anyway`, `Inconclusive`, `Unprobed`. The eye button opens the Probe dialog with the posts side by side.
- **Adopt anyway** (in that dialog, behind a confirm) makes the newest rejected version live under the 7-day review. An older rejection is restored with a rollback.
- The Memory tab shows a short "Why" under a line written by a probe rejection or a KPI rollback.
- The Inbox item (kind `skill_probe`) opens the Skills tab; a rejection also tells you where to adopt anyway.

**Settings** (Settings → Configuration → Editor, applied at once)

| Setting | Default | What it does |
|---|---|---|
| `SKILL_PROBE_PER_DAY` | `3` | Probes per Kyiv day; the rest wait. `0` = off: edits go live at once, as before |
| `SKILL_PROBE_SAMPLES` | `3` | Recent posts re-written for each probe (1–5) |
| `SKILL_PROBE_BUDGET_USD` | `0.30` | One probe's cap (the dry runs and the judge); over it the probe ends as inconclusive |

**Endpoint** (owner only): `POST /api/skills/:id/versions/:version/adopt`, no body. `409 not_rejected` for any other state, `409 cannot_adopt` when a newer version exists, `404` for an unknown skill or version.

**Audit** (§16): a version in `probing` for more than 3 days is a warning (the probe is not reaching it: check the daily limit and budget, that the editor is enabled and a key is set, and the `SkillProbe` log lines); an agent with 3 or more probe rejections in 30 days gets "self-edits keep failing — consider locking its skills".

**Troubleshooting**

- Nothing is probed: `SKILL_PROBE_PER_DAY` is 0 or already used today, the budget is 0, or the editor is off. A probe that skips ends as `unprobed` with the reason in the dialog.
- Every probe is `unprobed` "no recent published or approved posts": a new agent has nothing to re-write yet.
- A probe costs about two dry runs, two critic passes and one judge call per post; with the defaults that is under the $0.30 cap, at most $0.90 a day.
- Tests: `agents/skill-probe.059.test.ts` (decision, order, budget, cap, judge), `agents/skill-probe.059.pg.test.ts` and `skill-probe.059.pick.pg.test.ts` (store, sample picking, adopt anyway), `roles/preview-probe.059.test.ts` (the dry run of a published slot and the override), `sysadmin/checks/checks.059.test.ts`, `sysadmin/audit-probes.059.pg.test.ts`; in the dashboard `lib/skill-probe.test.ts`.

## 19. Dead series and owner signal (spec 060)

A series whose slots keep being skipped for the same reason is paused by code, and the notes about it are said once instead of every day.

**Needs**

- Migration `093_series_pauses` (`series_pauses`; `agent_inbox.subject`, `parts` and `actions`). Apply it before deploying the code that reads it. Down: `database/migrations/down/093_series_pauses.down.sql` (the pauses are dropped, so every series is planned again).
- Nothing to enable. The breaker runs from the scheduler tick (at most every 2 minutes, code only, no LLM).

**What happens**

1. **Breaker.** Over the closed slots of the last 14 days it counts, per series, the skips in a row that have nothing to post from (spec 068). At `SERIES_SKIP_STREAK` (default 3) the series is paused. The causes are `no_material` (no fresh item, empty library, rows without the needed fields), `source_used` (the source or row was already posted) and `source_unreachable` (403, timeout, too large, host blocked). For a series (`series_name`) and a fixed-time pin the three are **one family**: N, S and U in any order make one run. A plain resource (no series, no pin; the channel itself) keeps `source_unreachable` apart from `no_material` + `source_used`, so an outage and an empty library do not add up, and its streak must span 20 hours; a run made only of unreachable skips still pauses it. The pause cause stored is `no_material` when the run has any no_material or source_used skip, else `source_unreachable`. **Critic closes are transparent**: they neither count nor end a run (a series whose posts the critic kills, mixed with no-material skips, is paused on the no-material ones; a critic streak alone is never paused and keeps its own note). A post going out (or waiting for approval) ends a run, and so does a skip for `quality`, `other`, a story the network already told, or any text the classifier does not know. Owner decisions, budget waits, expired approvals and slots already skipped as `series_paused` neither count nor break a streak.
   **Where the cause comes from.** `skip_slot` takes a required `cause` (`no_material | source_unreachable | source_used | quality | other`; optional when it has a `code`: `no_fresh_item` counts as no_material, `story_skip` as other) and stores `skipped by agent: <cause>: <reason>`; that cause is read first, after the checks that must win (not-a-miss and owner skips, `series_paused`, budget, and an executor skip after a critic `revise`/`reject`, which is the critic's). The planner's empty-day placeholders (`planner_no_material`, `planner_source_unreachable`) and the pre-flight's `preflight_no_material` are read by their code. Rows from before 068 (14-day window) are read by text: a guard code anywhere in an agent's sentence (`source_already_posted`, `library_item_already_posted`, `already_posted`) is `source_used`, the Ukrainian patterns are Cyrillic-safe, and a text that names the library, a row or a `data://` ref is `no_material` even when it says «недоступний». `not_next_in_order` (a spec 071 guard code) is a content failure in the `lint` group and counts as `other` here, whatever row id its text names (an id like 404 or 503 is never read as an HTTP status). A run that crashed, timed out or was switched off (`error: …`, `timeout: …`, `disabled: …` as the slot error) did not test the material: it is transparent, like a critic close (it neither counts nor ends a run); an executor's own skip text is still judged by what it says.
2. **Pause.** One open pause per series (`series_pauses`). The planner does not plan it (a slot of it in a plan is a plan error, and it is no longer "due"), its already planned slots are skipped with `series_paused` at $0, and `series_missed` is not raised for them. The channel's mode and `resource_pauses` are untouched. The planners also read the last 3 skip reasons per series and the paused series in their schedule block.
3. **One note, one card.** The Inbox note (kind `series_paused`) is English; the Telegram card is Ukrainian and has **Відновити**, **Залишити на паузі** and **Відкрити**.
4. **Resume.** From the card, or on the agent page (**Overview → Paused series → Resume**, the section is hidden when nothing is paused). `resumed_by` is `owner`; only skips after the resume count towards a new pause.
5. **An honest empty day (spec 068).** A planner with nothing to post from says so instead of planning slots that cannot go out: `skipped_series[].cause` (`no_material | source_unreachable | other`, default `other`; a series locked by the owner may be skipped only with a material cause) or `short_day { cause, reason ≥ 20 }` (the network form is `short_days [{ resource_ref, cause, reason }]`). The day's minimum then loses the skipped series' due instances (a `short_day` takes it to 0; the maximum stays), and the code writes **placeholder slots** in the plan's own transaction: `kind 'content'`, `status 'skipped'`, error `planner_no_material: <reason>` or `planner_source_unreachable: <reason>`. A material-skipped series gets one per due instance (at its time, `series_name` set, topic «Порожній випуск: <series>»); a short day gets one per resource per day (format `text`, topic «Порожній день: <reason>», at the later of the planning moment and local 00:00). They are ordinary closed slots: the breaker counts them (so an empty library pauses the series after 3 days, without ever planning a doomed slot), `dark_day` / `series_missed` show the planner's reason, and there is no new table or note kind. A replan marks the old plan's **future** placeholders `superseded by a new plan` and writes new ones only for what is still declared, never twice for the same series and time or the same resource and local day, and never for an instance the executor or the pre-flight already closed (a skipped or failed slot of the same series within 90 minutes of it, not superseded or `series_paused`), so one instance is one close; a placeholder whose time has passed stays and counts once. The refusal for a short count and for a locked skip names the way out («якщо матеріалу немає — `skipped_series` з `cause: no_material` або `short_day`»; a network plan is told `short_days [{resource_ref, cause, reason}]`, which is the field it has).
   **Pauses lower the minimum.** The planners' per-day bounds (`planPerDay`: Telegram card and network sections) lose the instances of paused series on that resource, and a paused resource owes nothing; `silent-days` reads the same lowered minimum (`ScheduleService.minPerDay`), so a channel whose only dead series is paused no longer gets a daily `dark_day`. Without a pause nothing changes.

**Owner notes say it once**

- Each note has a subject (what it is about: `silent:<resource>:miss`, `silent:<resource>:critic`, `resource:<ref>`, `connection:<ref>`) and parts (its causes and numbers). It fires again only when its parts bring something new, or once per `OWNER_NOTE_REPEAT_DAYS` as «досі … N днів» (title "still going, N days" in the dashboard). The memory is in the Inbox rows themselves.
- `series_missed` and `dark_day` of one resource and day are one note (the dark-day one lists the missed series). A newer note of the same subject marks the older unread ones read and closes their cards ("Замінено новішою карткою"), so there is one live card per problem.
- Health notes (`token_invalid`, source down, …) and `connection_broken` follow the same rule: once, then every `OWNER_NOTE_REPEAT_DAYS`.

**Card buttons** (callback data is only card id and button index)

| Note | Button | Does |
|---|---|---|
| Health | Заглушити на 7 днів | The health dismiss of spec 049, now for 7 days (or until the state changes) |
| Silent day, critic streak | Пауза серії (or «Пауза: <name>» for two series) | An owner pause (`cause = owner`) of that series; none is offered for a plain slot |
| Series paused | Відновити, Залишити на паузі | Resume; mark the note read, the pause stays |

Each action is logged on the card (the outcome line) and on the Inbox note (an "Owner action: …" line in its body, the note marked read).

**The manager**

- The digest's open directives and the prompt list carry `adherence` (spec 025) and the age in days.
- The review signature counts no cover from an applied directive that was `not_followed` or an accepted one past its review date; a `dark_day`, a paused series (`signals: series_paused`) and a critic streak of 3 or more (`signals: critic_streak`) force a review even when covered. At most one forced review a day, as before.
- The prompt: advice that was not followed is re-filed as a directive with `supersedes`; not followed twice goes to the owner as a structural directive; a paused series is not advised again.
- `owner_rejection_rate` / `owner_edit_rate` are refused as `expected.metric` (`unmeasurable_metric`) when the channel had no owner approvals in 7 days.
- A directive that was not followed (`avoid`) or could not be judged (`insight`) leaves one line in the manager's memory with its id.

**Settings** (Settings → Configuration, applied at once)

| Setting | Default | What it does |
|---|---|---|
| `SERIES_SKIP_STREAK` | `3` | Skips in a row (one family of causes, see above) that pause a series. `0` = off |
| `OWNER_NOTE_REPEAT_DAYS` | `3` | A note about a problem that has not changed comes again after this many days (1–30) |

**Endpoints** (owner only): `GET /api/agents/:handle/series-pauses` (`{ channelKey, open, recent }`), `POST /api/agents/:handle/series-pauses` with `{ "action": "resume", "id": "<pause id>" }` (`404` for a pause of another channel, `409 not_paused` when already resumed).

**Troubleshooting**

- A series was paused but the source is back: Resume it (card or page). It is planned again from the next plan, and a new pause needs a fresh streak.
- A series should have been paused but was not: its latest skips must be in the family above (no_material, source_used, source_unreachable), the latest slots must be closed, and `SERIES_SKIP_STREAK` must not be 0. A skip with `cause: quality` or `other`, or with free text the patterns do not know, ends the streak. For a plain resource the run must also span 20 hours, and `source_unreachable` is counted apart from the other two.
- A note comes every day: its parts keep changing (a new cause or number each day is news). Check the subject and parts in `agent_inbox`.
- Mute does not stop the reminders: the mute lasts 7 days; after that the next health check sends them again.
- Tests: `series-pause/series-pause.060.test.ts` and `.pg.test.ts` (counter, breaker, planner view), `note-actions.060.test.ts` and `pause-actions.060.pg.test.ts` (card buttons, actions, endpoint, mute), `agents/note-gate.060.test.ts` and `owner-notes.060.pg.test.ts` (repeat rule, merge, supersede), `manager/manager-060.test.ts`; spec 068: `series-pause/skip-cause.068.test.ts` (the cause, the classifier and the replay of the review-4 export from `series-pause/fixtures/review4-skips.ts`), `schedule/empty-day.068.test.ts` and `.pg.test.ts` (the empty day, placeholders, replan, pauses lowering the minimum).

**Less noise from owner notes (spec 069)**

Spec 060 made a note say it once; spec 069 closes the three ways it still came back. Nothing to enable, no migration, no new setting.

- **A cause or number you have seen is not news.** The gate compares a note with everything its subject said inside the repeat window (`OWNER_NOTE_REPEAT_DAYS`), not with the last note: `8 → 6 → 8` and `critic → lint → critic` stay quiet. A number is news only when it grew by a whole step over the largest one said in the window; the step is `EDITOR_CRITIC_REJECT_STREAK` (default 3), a gate may set its own (the manager's «days» uses 3). Everything else is a repeat and comes once per window as «досі … N днів».
- **One live card per problem, edited in place.** A newer note of the same subject does not send a second message: the open card's Telegram message is edited to the new text (same message, same buttons, `oc:<card>:<button>` taps keep working). A new message is sent instead when the new note is critical, when the old card was sent more than 24 hours ago or never sent, or when Telegram no longer has the message (the card goes back to the queue and is sent again). The old note is marked read as before.
- **A past day is told once.** A `series_missed` for a day that is over and was already reported is not evaluated again (the 48-hour window used to give it a new set of parts every night). A miss found late, for a day not yet told, still goes out, on its own: it does not replace or edit the notes of the days after it.
- **Third time in a row, nobody pressing anything: info.** From the third note of an unbroken run (notes at most `OWNER_NOTE_REPEAT_DAYS + 1` days apart) the note is stored as `info`: it stays in the Inbox, but it has no card and no Telegram message. It is never done to a critical note, and not when a card of the run was resolved from Telegram (a button you pressed). The **daily summary** then has a block «Повторюється без вашої реакції» with one line per such problem: what, since when, how many times. Press a button on the problem's card, or fix it, and it rings again from the next note.
- **«Announced event got no recap»** no longer stays open: when a recap comes out, or the 48-hour alert grace runs out, the note is marked read and its card closes.

**The manager escalates by code (spec 069)**

Advice nobody follows used to disappear from the digest and the manager kept saying `continue`. Now the hourly housekeeping (no LLM) raises it. Nothing to enable, no migration.

- **Trigger 1: advice not followed.** Two or more directives (any status, a superseded advice and its re-filed directive both count) to one agent and one kind whose `verification.adherence` is `not_followed`, changed within 14 days. Shadow directives do not count.
- **Trigger 2: posts below the norm.** A negative posts anomaly (`kpi_snapshots`, `posts` anomaly with z < 0) on 3 or more days in a row, ending yesterday or today, for an agent that runs the resource itself, with no directive filed for that agent since the run began (the true first day of the run: the snapshots are read 60 days back, so a run of a month keeps its first day). A resource run by a network or anchor orchestrator is not covered, and neither is a channel you stopped: an orchestrator that is off, in shadow mode or paused (for good or until a date), a resource under an active pause, or a channel whose plain slots the series breaker (spec 068) paused (an open `resource:<ref>` pause, also one you chose to keep with «Залишити на паузі», see § 19: the scheduler does not plan it, so there is nothing for a directive to fix). After you resume it, the days whose 7-day KPI window still holds paused time are not counted either (the snapshot of day D is made from D-7..D-1): the trigger counts again only from the day whose window began after the resume, about a week later, and only if posts are still short. A pause on one series only (`series:<name>`) does not exempt the channel: it still plans its other slots, and a directive to replace the dead series is a legitimate answer.
- **What you get.** One Inbox note (kind `manager_escalation`, severity action, subject `escalation:<handle>:<kind|posts>`, English text; the Telegram card is Ukrainian: «Менеджер: @агент не виконує поради …») and one line in the manager's memory. The same causes say nothing again; trigger 2 comes again only after 3 more days of the same run. An escalation you have not read is open, so it is not told again as «still going» (the manager answers it at every review); once you read it, a cause that goes on is told again after 3 days. Each escalation subject keeps one active line in the manager's memory (a repeat replaces it). From the third note without your reaction the note is info (see above), and in the daily summary a posts escalation reads «Менеджер: постів менше за норму (@агент)».
- **The manager has to answer.** The digest has an `escalations` block with the open ones (an unread `manager_escalation` note of the last 14 days, one per subject). `submit_review` takes `escalations: [{ subject, directive_id | decline_reason }]` and refuses a review that leaves one unanswered, a `continue` included: the answer is a directive filed for that agent in the same review (its id also in `directive_ids`), or a reason of 20+ characters. The answers are appended to the stored review summary. An escalation stays open until you read the note, so the manager answers it at each review until then. The digest lists at most 100 open escalations (the oldest first) and `submit_review` takes as many answers, so a review can always answer every one it is shown.
- **The digest.** Open escalations count in the digest hash and the review signature, so a new one wakes the manager even when its flags are covered. Advice that was not followed no longer counts as cover whatever its status; an evaluated one from the last 14 days stays in the open-directives list, marked «не виконано — ескалюй, не дублюй як пораду».
- **Cadence.** The default manager time is now `09:00` only (an agent that has its own `schedule.times` keeps them). The cache mode of the manager run is unchanged: it makes two or more calls when it files a directive, where the prefix cache is cheaper.
- Tests: `manager/manager-escalation.069.test.ts`, `manager/manager-escalation.069.pg.test.ts` (the SQL on real rows).

**Troubleshooting (spec 069)**

- A problem you expected a card for did not ring: look for it in the daily summary block above, or in the Inbox as an info note («still going, N days»). It is the third or later note of a run with no reaction from Telegram.
- A card changed its text and did not move to the bottom of the chat: that is the edit in place. Telegram shows the edited message where it was.
- Tests: `agents/note-gate.069.test.ts`, `agents/owner-inbox.069.test.ts`, `owner-bot/owner-bot.069.test.ts`, `owner-bot/owner-bot.069.pg.test.ts` (retarget, real runs), `owner-bot/owner-reports.069.test.ts`, `silent/silent-days.069.test.ts`, `story/story-event.test.ts`; `agents/note-gate.060.test.ts` and `owner-notes.060.pg.test.ts` were updated on purpose (a streak of 4 after 3 is no longer news).

## 20. Slot pre-flight and sources (spec 061)

Code checks what code can know before the executor is paid to discover it, and the sources stop wasting calls. Apply migration `094` before deploying the code that reads it (the content ledger `anchor` column and `content_ledger_record_anchored`, `source_host_failures.strikes` and `noted_at`).

**Pre-flight** (before the executor of a content slot)

- For the idea's `sources` and the slot's source hints, code checks: spent in the content ledger (published, waiting, error), too old for the resource's freshness limit (`style.freshness_hours`, else news 36 h / games 72 h; evergreen exempt), the host blocked (§ below), and the format available (a carousel needs the slide hosting: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_CAROUSEL_BUCKET).
- A failing slot is swapped once for the next accepted idea of the same orchestrator that passes all checks and fits the resource and format (the slot's lint warnings keep `preflight_swap: …`; the old idea is `rejected` with the reason). With nothing to swap to, the slot is skipped with `preflight_source_used`, `preflight_stale`, `preflight_host_blocked`, `preflight_format_unavailable` or `preflight_no_material` and the reason. No executor run is paid.
- Reserved, promo, derived (duplicate / adapt) and live slots and owner previews are not pre-flighted.
- **Library slots (spec 068).** The hints of a series or library slot are judged too: `series:` and `directive:` are labels, not material. A `data://<dataset>/<id>` or `library://<table>/<id>` row must exist, be active and have what its dataset needs for posting (`post_requires`, e.g. the page, or the text and the picture), else `preflight_no_material` («рядок data://prompts/7 без prompt_text»); a row already posted or waiting on the resource is `preflight_source_used`. A `library:<table>[/<category>]` hint with no unposted row left on the resource (the catalog's `unposted_here`; the category is ignored) is `preflight_no_material`. A slot fails only when every material hint fails; any other kind of hint (`feed:`, `api:`, `network_highlights:`) or free text cannot be judged and lets the slot run. A library slot is skipped with the code, not swapped for another idea; neither is a slot that carries a manager directive (`directive:<id>`, an experiment): a swap would lose the hint and the angle, so it fails with the code. The skip counts as `no_material` in the series breaker (§ 19).
- **The series' next row overrides the planner's row hint (spec 071 × 068).** A series slot on a dataset that repeats in order is told the next row in its note, and the executor takes it whatever `data://` the planner hinted. The run-time pre-flight judges the same row: the series' `nextRow` replaces the slot's row hints (`data://` / `library://` rows) of that dataset before the checks, and the stored hints are not touched. So a hint the round has moved past (an earlier slot posted that row or put it aside, a row still waiting for approval) does not skip a slot that has material. The next row is still checked (active, `post_requires`, not used). Without a next row (a dataset that does not go in order, a series without a library source) the hints decide as before.
- **At plan time (spec 068).** `submit_plan` and `submit_network_plan` run the same checks on every slot before the plan is stored, and a refused slot comes back as a `plan_invalid` line («слот 2 (12:00): рядок … без prompt_text — заміни джерело/рядок або постав skipped_series з cause no_material / short_day»). The planner then picks another row, or declares the series a `short_day`/`no_material` skip (§ 19). A format that cannot be produced here (a carousel without slide hosting) is not offered in the plan at all, and an open experiment quota in such a format forces no slot (it is left out of the validators, of the planner prompts, and the `experiment` directive for that format is `not_executable` until the hosting is set), so a day is never unplannable because of it. A network plan's refusal names `short_days` (the field it has), not `short_day`. Host blocks are checked again at run time: some appear after the plan is made. The plan-time check does not know the series' next row (it changes with every slot that posts, and reading it from a plan would also write the series' source-empty note), so a planner hint that is already used is still refused there with the way out; only at run time does the next row override a stale hint. Nothing is refused where no pre-flight is wired (tests).
- **Ideas are not burned by skips.** A slot that goes out (published, shadowed, waiting for you) makes the idea `used`. Infra, budget, a missing format, a paused series or a crashed run send it back to `accepted`. No material (a spent, stale or blocked source, nothing fresh) makes it `rejected` with `review.slot_outcome`. Critic and content failures stay `used`.

**Reference documents** (a law cited many times)

- `LEDGER_REUSABLE_HOSTS` (Settings → Configuration, default `zakon.rada.gov.ua`, comma-separated hosts) are keyed by `url#anchor`: each clause is posted once, the document many times. The post spec takes `source.anchor` (a clause, e.g. `п12.3`, up to 40 characters). A source without an anchor on such a host is allowed.
- `source_already_posted` now says what was posted, when, in which slot and the remedy ("cite a different clause with `source.anchor`" for a reference host, "pick another source" otherwise).

**Host blocks escalate**

- A refusal (401 / 403 / 429 / 451), DNS or TLS failure blocks the host 1 day, then 3 days, then 7 days (cap). The strike count is not reset when a block ends; only a page that loads resets it. Feed failures stay a flat day on their own address.
- A timeout blocks the host for 1 hour and is not a strike. The pre-flight does not reject an idea over a timeout block.
- Source health (`get_source_health`, `/app/health`) now also lists the feeds the orchestrator's playbook reads (series `source: feed <url>` and links in its rules) with `origin: playbook`; the card's sources come first.
- **Third strike.** One Inbox note, severity action, in Ukrainian («marktechpost.com відмовляє нам 3 рази поспіль — прибрати з плейбука @ai0_global?») per streak, from the orchestrator's daily run. For a card source the channel agent is already asked for a replacement (Apply / Discard card); for a playbook feed remove the address from the playbook with a directive to the MANAGER, or leave it if the site may come back.

**Expired tokens**

- "Session has expired", or Meta code 190 with subcode 463 / 467, on verify or refresh marks the account expired: `token_expires_at` is the date in the error (else now), `token_valid` false, and the health text is «токен прострочено з <date> — перепідключіть акаунт у /app/connections». The keeper counts it (`expired` in its log line: Threads and Meta).
- The hourly Meta stats collector asks such an account once a day and logs one line a day, not one per hour. Reconnect the account in `/app/connections`; a good verify and the new token's expiry clear the state.
- Note dedup of the repeated alerts is spec 060, not this one.

**Troubleshooting**

- Many `preflight_stale` skips: the idea sources are older than the resource's freshness limit; refresh the pool or set `style.freshness_hours` for the resource.
- `preflight_format_unavailable` for carousels: set the slide hosting variables (above). The idea goes back to the pool.
- A host you trust is blocked for days: its strikes only reset on a working page fetch; open a page of it once with `web_fetch` after the block ends, or delete its row in `source_host_failures`.
- A reference-host source is still `source_already_posted`: the same clause (`source.anchor`) was posted; pick another clause.
- Many `preflight_no_material` skips: a dataset ran out of unposted rows on that resource, or its rows lack what `post_requires` asks (open the dataset in `/app/data`, the catalog's `not_postable` count says how many); import more, repair the rows, or point the series at another dataset.
- Tests: `preflight/slot-preflight.068.test.ts`, `preflight/material.068.pg.test.ts`, `network/plan-preflight.068.test.ts`, `preflight/slot-preflight.test.ts`, `preflight/preflight.pg.test.ts`, `data/ledger-anchor.test.ts`, `data/ledger-anchor.pg.test.ts`, `net/host-strikes.061.test.ts`, `net/host-strikes.061.pg.test.ts`, `config/token-expiry.061.test.ts`, `config/token-expiry.061.pg.test.ts`.

## 21. Chat truthfulness (spec 062)

What the chat tells you about its own turn now comes from the system, not from the model. No migration, nothing to enable.

**What changed**

- **System footers are the system's.** A trailing `[дії: …]`, `[чернетки: …]` or `[actions: …]` block and a leading `@handle:` in the model's answer are cut before the guards read it and before it is stored. The history the model reads still adds the real ones. Every chat prompt says so.
- **The history line names the tools.** A read-only turn shows `[дії: змін немає; викликано: library_catalog, sql_readonly]`, a writing turn adds `; викликано: …`, and `[дії: інструменти не викликались]` means none were called. (It used to say "tools changed nothing", which the model read as "I checked nothing".)
- **The denial check is precise.** "Nothing was applied" falls back to the chat's latest card only when the sentence is about a card (`картк…`, `card`, `Apply`, `застосув…` or a card id). "I called no tools" fires whenever the turn called any tool, named or not, written or only read. "No write tools" after a read-only turn is true and passes.
- **The retry knows what happened.** A denied card, a denied agent or an unbacked claim is re-run once with the first run's tool trace (tool names, one line of result each, up to ~1500 characters). A reply whose only fault is "I called no tools" keeps its answer and gets the English note `(Check: the data says otherwise — this turn called …)`, with no second run. When a corrected answer replaces the first, the stored message has `actions.retried_from = <first run id>` (find the first run in Logs).
- **`lint_post` / `preview_post` take `draft_id`** in the chat: they check the stored draft, and `spec` fields given with it override it. A picture URL that looks made up (`example.*` host, `placeholder` or `example` as a path segment or file name) is refused with `invalid_media_url`.
- **`save_draft` with `draft_id` merges.** Top-level keys the model did not send (media, source, hashtags…) stay as stored, `null` clears one; the result lists `kept_from_draft`. The lint-attempt stop text says "у цьому ході" (this turn): the counter resets with every turn.
- **Data questions read rows.** The composer and @ai0 prompts say to `query_data` three rows before answering a question about the data. `library_catalog` gives every listed field a `fill_pct` once the dataset's stats exist (a field no row carries is 0 %).
- **Rules and skills.** `add_owner_rule` returns only the config conflicts the new rule causes (the ones that were not there before it, or that name it). `edit_my_skill` returns `warnings` when the body prescribes reader text in a language the channel card's lint rejects (`not_ukrainian` / `wrong_language`) or states dated facts («станом на 2026-10-18», "as of today"). They are warnings: the card still goes, and the model must tell you.
- **`/align @channel`** (or `@agent`; without an argument, the chat's agent) runs `fix_config_conflicts` in code: no model turn, $0. The reply lists the items and the card follows; nothing to align says so. On the dashboard, "Resolve in one card" (agent Overview, Memory tab) prefills `/align @handle`, and the card bubble lists its first items.

**Troubleshooting**

- A reply ends with "(Check: the data says otherwise …)": the model denied something the data contradicts (a card, an agent, its own tool calls) and the check kept its answer. The facts are in the note.
- A saved draft lost a field you wanted removed: send the key as `null` (an empty list `[]` also replaces it).
- `/align` says "not a channel or agent of the network": use the agent's handle or its channel key.
- Tests: `chat/chat-truthfulness.062.test.ts` (replay of chat e8c11647), `chat/chat-tools.062.test.ts`, `chat/chat-rules-align.062.test.ts`; in the dashboard `lib/align.test.ts`.

## 22. Critic precision (spec 063)

Fewer good posts lost to the critic, and a few real defects caught in code. No migration, no setting, nothing to enable; it is all in the next deploy.

**What changed for a post**

1. **Grounding reads spelled numbers.** «$1 млрд» matches "over a billion dollars", «SB 53» matches "Senate Bill 53" (also AB, HB), «40%» matches "40 percent", «5 120» matches "5,120". A number still missing is `number_not_in_sources`, but the critic gets it as a hint to check against the passages and quotes the passage when it confirms the number is there.
2. **A fixable `revise` keeps its source.** The fallback ladder is now `initial → revise_source → next_candidate → lighter_format → evergreen`, still one extra step at most. `revise_source` re-runs the executor on the same article with the critic's notes. Only `reject`, a revise with grounding ≤ 2 or a wrong topic bans the source and goes to the next candidate.
3. **The executor never substitutes the topic.** No article found for the slot: `skip_slot` with the reason, not a post about something else.
4. **Edits are guarded.** A critic `pass_with_edits` edit is dropped when its `to` loses a word, and when the Ukrainian lexicon finds a new problem in the edited text. The dash rule is code (`post/dash-fix.ts`), not a model edit; «— це» stays.
5. **Kyiv times from tools.** `fetch_api` items and the tools that read event or deadline times add `<field>_local`, e.g. `"ends_at_local": "22.10, 18:00 (Київ)"`. The executor is told to take the reader's time from these fields.
6. **One link per source.** The typography normaliser turns an inline link to the post's own source into plain text, keeping the `→ Джерело` line or the button. The lint `duplicate_source_link` (warning) flags published posts that have both; it is in the audit catalogue and the golden set.
7. **Voice tells.** New lint warnings `slop_emoji_tail` (a post that ends with an emoji where `format_prefs.emoji` is none or light) and `slop_analogy_opener` («X — це як Y», «Уявіть, що…» in 2 of the channel's last 5 posts). The critic skill now anchors `voice` and `ai_likeness` with concrete low-score examples. An unset resource style now means `names: original` (names as in the source, Latin), so the critic stops flagging mixed Latin / Cyrillic names.
8. **Critic prefix cache.** On the Anthropic workspace (and OpenRouter models that need marks) the critic sends one cache breakpoint after its system prompt when that prompt is at least 1024 tokens (rough count: characters / 3.5); the post is in the user message after it. Below the threshold the call stays uncached as in 053.

**How to see it working**

- Dashboard → Runs → a `checker` run: `tokensCachedWrite` on the first post of a resource, `tokensCachedRead` on the next within 5 minutes. A cache read on every check with no write means the breakpoint holds.
- A slot whose first critic verdict was `revise` now shows a second run on the same source (ladder step `revise_source`) instead of `next_candidate`.
- Audit §16: `duplicate_source_link` appears in the post-integrity findings (warning); it should fade as new posts go out.

**Troubleshooting**

- Still a false `number_not_in_sources`: look at the passages the critic received. The extractor reads English and Ukrainian scales; a spelled number in another language is not matched.
- The critic's edit was not applied: the run's `critic.edits_rejected` lists each edit with the reason (`word_dropped`, `language_regression`).
- A post kept an inline link to its source: the link points to another page (different path), which is kept on purpose.
- Tests: `post/grounding.test.ts`, `critic/critic-passages.test.ts`, `silent/fallback-ladder.test.ts`, `critic/pass-with-edits.test.ts` (edit guards and the dash transform), `post/typography.test.ts`, `post/integrity/text-hygiene-checks.test.ts`, `tools/api-tools.test.ts`, `tools/read-tools.test.ts`, `post/slop-lint.test.ts`, `critic/critic.test.ts`, `llm/anthropic.client.test.ts`.

## 23. Ops batch from review 3 (spec 064)

Small fixes to the loop, the loadout and the audit. No migration, no new setting.

**What changed**

- Usage rollup: concurrent rollups are serialised with `pg_advisory_xact_lock(6400029001)`, so two runs no longer double-count a day.
- Log lines use one `errText(err)` (`common/err-text.ts`): message, else code, else cause, else name. An empty `err.message` no longer produces a blank error in the log or the Inbox.
- Planner and executor loops: a terminal-tool error on the last turn adds a turn (at most 2 per run). `series: null` is accepted. Long `topic`, `summary`, `notes` and series `brief` text is cut, not rejected, and the limit is in the field description. A bad JSON argument now carries the parse message. `ilike '%'` matches everything.
- The circuit breaker counts errors per `tool@host` for `web_fetch` and `fetch_feed`: one dead host is dropped for the run, the tool stays. The run record's dropped list shows `web_fetch@host`.
- An elided tool result keeps a one-line gist and its arguments. Stored tool results are capped at 8,000 characters including the wrapper.
- Meta insights: an unsupported metric is remembered for 7 days per account and not asked again (`config/meta-insight-backoff.ts`, in memory, resets on restart).
- Loadout: the executor no longer gets `sql_readonly`, `get_channel_card`, `get_channel_memory`, `list_skills`, `lint_post`, `preview_post` by default, and an orchestrator no longer gets `propose_skill_edit`. A channel's `tools_allow` can still add the executor tools back.
- A role agent (planner, executor, ideas) has no mode. `PATCH /api/agents/:handle` with `mode` on a role child answers `409 mode_follows_orchestrator` (with `follows` and `mode`). The dashboard shows a read-only badge "Follows @orchestrator (live)" on the agents list, the agent page and its overview; the mode switch stays on the orchestrator.
- @sysadmin (§16): the weekly audit lints the active owner rules in memory with the same lint the owner chat uses. Each flagged rule (a request to the agent, an unknown skill, a pointer with no content) is a finding with a **Retire rule** fix (`memory_retire`), which retires the row.

**Troubleshooting**

- A rule you want to keep is flagged: reword it in the owner chat (the lint explains why), or dismiss the finding.
- An executor lost a tool it needs: add it under the channel's `tools_allow` in its loadout.
- Tests: `common/err-text.test.ts`, `common/ai/usage/llm-usage-rollup.lock.pg.test.ts`, `config/meta-insight-backoff.test.ts`, `editor/harness/ops.064.test.ts`, `editor/sysadmin/stored-rules.064.test.ts`, `editor/loadout/loadout-profiles.test.ts`, `editor/setup/dataset-formats.047.test.ts`; in the dashboard `lib/agent-mode.test.ts`.

## 24. Document reader and list import (spec 065)

`web_fetch` keeps the whole page; a large one comes back as an outline plus the first chunk, and the agent reads the rest with `read_doc` and `find_in_doc`. A list page (a GitHub README of prompts, a catalogue) becomes dataset rows with `import_list`: extraction runs in code, the owner sees a preview and an Apply card, and every import can be undone on the dataset page.

**Needs**

- No migration. Nothing to enable: the tools are in the loadout of the chat roles (`read_doc` and `find_in_doc` follow `web_fetch`; `import_list` and `resync_import` are for the composer and builder in chat only).
- The documents live in memory (about 100, `DOC_STORE_HOURS` each) and are lost on a restart; an agent that gets `doc_expired` fetches the page again.

**How the agent reads a large page**

1. `web_fetch` returns `doc_id`, `outline` (heading, level, size, number of code blocks and pictures, at most 80 entries and `outline_more`), the first ~3,000 characters and `next_from`. A short page keeps the old shape. A second fetch of the same address inside `DOC_STORE_HOURS` is answered from memory.
2. `read_doc` takes a section (`id` or heading) or `from`; it never cuts a fenced code block (a prompt stays whole). `find_in_doc` finds a phrase, or the words that occur together, with 300 characters around.
3. A GitHub repository, `/tree/<branch>`, `blob` or `raw` page is read as the raw file (`README.md` on `main`, then `master`); markdown is split into sections with the code blocks, pictures and links of each entry attached to it. `url` stays as typed, `fetched_url` is the raw one.

**Nanobanana prompts for @ai0_prompts_dev (first use)**

1. In the chat with the @ai0_prompts_dev agent say what you want, in your words: «бери промпти з https://github.com/ZeroLu/awesome-nanobanana-pro, PromptHero більше не бери». The agent proposes the whole change as one card (spec 069, below); «імпортуй … у датасет nanobanana_prompts» still works and gives the import alone.
2. The agent fetches the page, reads two or three entries, and calls `import_list` with a mapping like: `title: heading`, `prompt_text: first_code_block`, `media_url: last_image` (the result picture, not the input), `author: link_text_after:Source`, `source_url: last_link_after:Source`, licence `CC BY 4.0` (the repository badge), filter `has_code_block: true` (drops the sponsor blocks).
3. Read the preview in the chat: number of entries, three sample rows, how full each field is, how many entries are not postable (no picture). Entries without a prompt or picture are skipped, not imported half-empty.
4. Press **Apply** on the card. The dataset is created (`post_requires` = title, prompt_text, media_url; `dedup_key` = `list_ref`, which is the page address plus the entry's heading) and the rows are written as one import.
5. Point the channel at it. With the bundle card (below) this is already on the card: the series is bound to the dataset as its required source, and if the breaker paused the series (§ 19, § 27) the same card resumes it. Do not write a skill for it: a skill that names a URL, an API, a `provider=` filter or «only from dataset X» is refused (`source_belongs_in_import`), because the planner never reads channel skills and the series kept pinning the old rows (review 4). A URL counts only when posts are taken FROM it («бери з …», «from …», «через API»): a link put into a post, a CTA button or a credit line («вкажи автора з посиланням …») passes.
6. Undo: the dataset page → Imports → the import → Undo. (Undo covers the rows only; the series change, the rule and the skill switch-off are undone on the agent's page.)

**Changing the source in one card (spec 069)**

When you say «бери з X» / «не бери Y» / «зміни джерело», the agent calls `import_list` with three more inputs, and the card carries what follows the import as a checklist («Then, in this order — untick what you do not want»):

| Input | Follow-up on the card | What Apply does |
|---|---|---|
| `series` | `Series` | binds that series to the new dataset, `source_mode: required` (the series becomes yours: locked). Checked when the card is proposed against a dataset that does not exist yet; skipped with `import_empty` when the import found nothing (a re-import of an unchanged list is not empty). |
| `stop_using` | `Rule` | stores your words as an «avoid» rule of the channel (the same lint as `add_owner_rule`). |
| `disable_skills` | `Skill off` (one per skill) | switches the named skills of that agent off (the old «Фільтр provider=prompthero»). |
| (the pause of the series) | `Resume` | when the series bound by `series` has an open pause (the dead-series breaker, § 19; also one you made with «Пауза серії»), the card has this item right after `Series` — ticked for a breaker pause, **unticked** for a pause you made yourself (a new source is not a reason to undo your decision): Apply lifts the pause (the same Resume as the dashboard and the Telegram card). It waits for rows like `Series` (an import that found nothing resumes nothing), and it refuses to resume a series whose change did not apply (the series must read the new dataset), so a stale card leaves the pause alone. |
| (the pause of the channel) | `Resume` (second, **unticked**) | when the channel's own plain slots are paused (`resource:telegram:<channel>`, three dead days of a plain slot), the card suggests resuming them too; it stays off until you tick it, and its text says so: while the channel is paused nothing on it is planned, **the series bound on this card included**. So when the card has this item, tick it (the agent is told to ask you to) if the series should post; with the default Apply the series is resumed but the channel stays paused and nothing is posted. |

- The import runs first, then the items in that order. Each runs on its own: a failing one is shown with its reason on the card, the card stays **applied**, the next one still runs. The import has an Undo; the series change, the rule and the skill switch-off do not (use the agent's page).
- A card that binds a paused series therefore needs no separate **Resume**; one is needed only when the source was changed another way (the dashboard series editor, `propose_series_change`), the card was applied with the `Resume` item unticked, or the **channel's** own pause was left unticked (a paused channel plans nothing, the series included).
- Apply looks the pause up again **by its key** (`series:<name>`, `resource:telegram:<channel>`), not only by the id stored when the card was proposed: if that pause was resumed meanwhile (by hand, from the Telegram card) and the breaker has opened a new one on the same series, the new one is resumed. A pause **you** opened again meanwhile (or any owner pause) is not undone: the item fails with the way to resume it by hand. A pause that first opens **after** the card was proposed is not covered (the card has no item for it): use the «Відновити» button of its note or Overview → Paused series. Nothing open at Apply is reported as «already resumed».
- An item you untick is not run (`left unticked`). Cards applied from the API or the owner bot run only the ticked-by-default items.
- These cards belong to a chat, so they are dashboard-only (the owner bot lists cards without a chat).
- **Skills that contradict the change are found in code.** With `stop_using`, the agent's skills (the orchestrator's and its children's, enabled, not builtin / safety / voice) are compared with «не використовуй <your words>»; a skill that still tells the agent to use the dropped source (a `provider=` value, a host, a `data://` or `library:` key) is added to the card as `Skill off`, ticked, after the items you asked for (the review-4 pair: «Фільтр provider=prompthero» against «PromptHero не використовую»). The card never has more than 8 follow-ups; a skill already named in `disable_skills` is not added twice. Your words are read clause by clause: «не бери Y, тепер бери з X» rules out only the part before the comma or dash that starts «бери …», «X замість Y» rules out only Y, and a generic format word («prompts», «recipes») does not rule out a dataset whose key merely starts with it. A skill about the dataset the card imports is never proposed for switching off.
- Tests: `agents/pending-actions.069.test.ts`, `docs/import-list-tools.069.test.ts`, `docs/import-bundle.069.pg.test.ts`, `schedule/schedule-pending-tables.069.test.ts`, `agents/skill-warnings.069.test.ts`, `agents/skill-conflicts.069.test.ts`; in the dashboard `lib/follow-ups.test.ts`.

**A new skill that contradicts an old one (spec 069)**

`edit_my_skill` (the agent's own chat) and the builder's `write_skill` compare the new text with the agent's other skills before the card is proposed. Source tokens are the second-level host label (`prompthero.com` → `prompthero`), a `data://` / `library:` key and a `provider=` value; a clause (a sentence, a line, a half of `;`) with a negation («не бери / не використовуй / не з», «ніколи», «never», «don't use», «avoid», «замість», «instead of») rules its tokens and its words (4+ letters) out, any other clause uses them.

| Found | Item on the `write_skill` card | Starts |
|---|---|---|
| **Hard**: one skill rules out a source the other tells the agent to use (either way round) | `Skill off` for the older skill | ticked |
| **Soft**: both name sources, different ones, for the same format or series word («prompt», «recipe», …) | `Skill off` for the older skill | unticked |

- The agent is told about each (`conflicts`, `conflicts_note`) and must say it in the reply; the card summary ends with «Also disables the conflicting skill …» / «Suggested, unticked: …». The skill being written is never compared with itself; builtin, safety and voice skills (`anti-slop`, `human-voice`, `voice-core`) and switched-off skills are never candidates. A failed lookup (`conflicts_error`) does not stop the card.
- Limits: the heuristic reads names of sources, not meaning. A negation and a source in the same sentence are taken as «ruled out» («Бери з prompthero, не бери з nanobanana» rules out both), so write one source per sentence.

**Updates**

- After the first Apply the list is re-read silently once a week (Monday 04:20 Kyiv): only new or changed entries are added, as a new undoable import; a week with nothing new leaves no import row. `resync_import` does the same on request.
- `IMPORT_RESYNC_AUTO` (Settings → Configuration, live, default on): when off, neither the weekly job nor `resync_import` writes by itself; `resync_import` then proposes a card.
- `DOC_STORE_HOURS` (default 6, 1–72, needs a restart): how long a fetched page stays readable.

**Troubleshooting**

- `bad_extractor` / `unknown_field`: the message lists the valid extractors or the dataset's fields. `nothing_to_import`: no entry has everything the dataset needs; the preview shows which field is empty.
- `already_pending`: an import card for this page and dataset is waiting in the chat; apply or discard it first.
- An existing dataset must have a `list_ref` field or a mapped dedup key, otherwise a re-sync would add entries twice (`no_dedup`).
- Tests: `docs/doc-store.test.ts`, `doc-tools.test.ts`, `doc-fetch.test.ts`, `markdown-doc.test.ts`, `github-url.test.ts`, `import-list.test.ts` (fixture `docs/testing/nanobanana-fixture.ts`), `import-list.pg.test.ts` (Apply, no-op re-sync, new entry, weekly job, undo).

## 25. JSON APIs in the reader and import (spec 066)

A public JSON API is read like any large page and imported like a list: `web_fetch` of a JSON address returns its shape, `read_doc` / `find_in_doc` read records, `import_list` maps record fields into dataset rows and follows the API's pages. No site-specific code; first use is https://prompts.chat/api/prompts for @ai_global.

**Needs**

- No migration. Nothing to enable. Two settings (Settings → Configuration, live): `IMPORT_MAX_PAGES` (default 30) and `IMPORT_MAX_ROWS` (default 3,000) cap one run of an import or a re-sync.
- Not covered: pages drawn by scripts (no headless browser), APIs that need a login, XML APIs (RSS stays in `fetch_feed`), pagination in the `Link` response header (the HTTP helper does not return headers).

**How the agent reads JSON**

1. `web_fetch` accepts `application/json`, `*/*+json`, `text/json`, and a `text/plain` or untyped body that parses as an object or array. A broken body is `unsupported_content` / `invalid JSON`. The cap is still 2 MB.
2. The answer has `doc_id`, `json` (`records_path`, record count, the scalar root values, up to 40 `fields` as `{ path, type, filled, sample }`, and `pagination` with `next_url` when found), `first_record` (≤ 3,000 characters), a short `outline` and a hint. A small object with no records array comes back whole.
3. Records are the largest array of objects at the root or one level below it (`prompts`, `data.items`), or the root array. Each record is one section of pretty-printed JSON, labelled by `title`, `name`, `slug`, `id` or `#n`; the other root keys are the intro section. `read_doc(doc_id, section)` returns one record, `find_in_doc` finds records.
4. Pagination is read from the root keys: `page` / `currentPage` / `page_number` with `totalPages` / `total_pages` / `pages` / `last_page` (or `total` with `perPage` / `per_page` / `limit`), a `next` / `next_url` / `nextPage` / `links.next` address, or a `next_cursor` / `cursor` / `nextCursor` token. None found = one page.

**prompts.chat for @ai_global (first use)**

1. In the chat with @ai_global: «бери промпти з https://prompts.chat/api/prompts?perPage=100» (the agent proposes the import, and with it the series bind, the «avoid» rule and the old skills to switch off, as in § 24); or «імпортуй https://prompts.chat/api/prompts?perPage=100 у датасет promptschat» for the import alone.
2. The agent fetches it, reads a few records, and calls `import_list` with a mapping like `title: field:title`, `prompt_text: field:content`, `media_url: field:mediaUrl`, `type: field:type`, `category: field:category.name`, `author: first_of:author.name|author.username`, `tags: field:tags[].tag.name`, optionally `where: {"type": ["TEXT", "IMAGE"]}` to leave out the SKILL, TASTE and VIDEO records.
3. Read the preview: the counts are of the first page; `pages` says how many pages and records the API has and how many Apply reads (`pages_to_read`). With `?perPage=100` the 2,571 records are 26 pages, inside both caps; at the default page size of 24 they are 108 pages and Apply stops at page 30. When the list outgrows a cap, raise it in Settings or narrow the request with the API's own parameters (`?type=IMAGE`).
4. **Check the prompts.chat licence** and give it as `license` (stored per row; the dataset default is `unknown`).
5. Press **Apply**. The dataset is created (`post_requires` = the text or the picture; `dedup_key` = `list_ref`, which is the address without paging parameters plus the record id; `type`, `kind` and `category` are filterable). A page that fails (429, a timeout) stops the run: the rows already read are imported and the result says «прочитано 12 з 30 сторінок: status 429».
6. Ask @ai_global to write its skill on top of the dataset (`query_data` with `type` as the filter). A record of type SKILL is content for a post, never copied into the agent's own skills or rules; the skill about *how to use* the dataset (pick a row, keep the prompt in a code block, credit the author) is fine.
7. A channel that only wants pictures imports `?type=IMAGE` into a dataset of its own.

**Updates**

- A re-sync of a paged source reads from page 1 and stops after the first page that adds no new record (newest-first APIs pay one or two requests), or at the caps; the weekly job does the same. Changes to older records on later pages are not seen by it; run `import_list` again for a full read.
- Pages are fetched fresh, about half a second apart, through the host guard (a refusing host is blocked like any other), and are not kept in the document store.

**Troubleshooting**

- `wrong_extractor`: `heading`, `first_code_block` and the other markdown extractors do not read JSON, and `field:` / `first_of:` do not read markdown; the message lists the ones that apply. `wrong_filter`: the same for the filters (`heading_matches`… for markdown; `where` / `has` for JSON).
- A default `required` of «text or picture» keeps TEXT records (no picture) and IMAGE records; pass `required` to demand a field (each listed field is then needed).
- A note «no id, uuid, slug or title» means refs are positions in the list: a re-sync may add shifted records again; map a stable field or accept it.
- Tests: `docs/doc-json.test.ts`, `list-extract-json.test.ts`, `import-list-json.test.ts` (fixture `docs/testing/promptschat-fixture.ts`), `import-list-json.pg.test.ts` (two-page Apply, one-page no-op re-sync, incremental re-sync, failing page, caps, undo).

## 26. The critic reads what the author read (spec 067)

Fewer good posts killed by a critic that could not see the author's source, and no more deadlock over posters. No migration, no setting, nothing to enable; it is all in the next deploy.

**What changed for a post**

1. **The critic gets the text the author read.** `read_doc` and `find_in_doc` are captured with `web_fetch`. A page up to 12,000 characters, or a library row (every field, up to 12,000), comes whole and is marked `full`; a big document comes as the parts the author read (offsets shown) and is marked `read`; a feed item is `snippet`. Lint's `number_not_in_sources` and the critic's grounding check read the same text. When a page is whole and the post also cites a library row, the critic gets both as separate labelled sources (the row whole when it fits, otherwise the part of it that mentions the post's numbers). A ratio claim («3 з 5») is checked as a pair; a part may be a number with space-grouped thousands («10 000 з 20 000 квитків» is one pair, a no-break space works too), and a version pair like «Windows 10/11» is not a ratio.
2. **The verdict is a contract, not a mood.** Pass 1: sense ≤ 2 (or the model's `reject`) is a reject; any other axis ≤ 2 is a revise (a language or grounding 2 is fixable); 3 is a revise; praise in quotes no longer counts. The critic lists `issues`; only a `blocking` one with a quote found in the post sends the post back. Pass 2 does not start from scratch: it answers `previous_checks` per item of the first pass; all fixed and no new blocking issue is a pass (new 3s are advice, stored with `reason: pass2_advice`); an unfixed or unanswered item is a revise; `poster_mismatch` or `number_not_in_sources` still in lint is a revise. Grounding ≤ 2 bans the source only when the critic saw the whole page (`source_coverage: full`) and the code also found the number missing.
3. **One critic level per slot.** Once a pass of the slot was high (an external source, numbers, quotes), the rewrite and every later ladder step use the same strong model, even if the rewrite alone would be low. The stored route says `level: high` with a `pinned` factor; the slot's ladder step records `critic_level` and `critic_model`. The owner's critic model setting is still honoured.
4. **The cap is 3 critic runs per slot.** The first attempt may use 2 (a revise and one rewrite); a ladder step or the 15-minute retry gets `3 − runs so far` (at most 2). With a budget of 1 the first `revise` is final: live and shadow skip with `critic_rejected: cap_revise — …` (the verdict stays `revise`, so the ladder still sees it as fixable); approval proceeds with `final: true`. Previews and skill probes keep 2.
5. **Posters are decided by code.** A post made from a library row (`origin: library` or a `library_ref`) is not news, whatever source URL it cites, so it may carry a poster whose `use_for` is its topic. For every post, with or without an image, the code decides `news_no_poster`, `poster_fits` or `none_fits` and tells the critic. An off-topic poster is now an error before publishing (the executor fixes it; the message names the posters that fit, or says none does and the post goes as text) and stays a warning in the weekly audit; a poster on news is an error as before. The critic no longer judges the fit and does not lower `format_fit` for a poster unless lint flagged `poster_mismatch`.
6. **Picture rules are not asked when no poster applies.** When the decision is `news_no_poster` or `none_fits`, the owner's rules that name a picture (картинк, зображен, ілюстрац, світлин, постер, фото / фотографія, image, picture) are left out; a rule about a photographer («не пиши про фотографів») or about media outlets («не цитуй російські медіа») is not a picture rule and stays of the critic's prompt and its verdict. Their ids are stored in `critic.rules_skipped` and logged (`CriticRules`: «owner picture rule(s) left out of the critic prompt»); the approval card says «Not checked by the critic: your picture rule #13».
7. **A fix the critic waived must land.** On `pass_with_edits` the critic may block on a quote and cover it with an exact edit, and the code applies the edit instead of asking for a rewrite. If that edit does not land (the safe-edit guard refuses it, it matches the text zero or several times, or the lint refuses the edited text), the blocking issue is no longer waived: the verdict becomes `revise` with reason `blocking_issue_unfixed: <axis>` and a note with the quote and the fix, and goes through the usual path (rewrite in the same run; owner card with `final` in approval mode; skip in live and shadow). Edits that fix only advice, and edits that land, work as before.

**Owner action**

- Reword rule #13 («кожен пост з картинкою») for @ai_global to say what it means, for example «якщо до теми є постер мережі — додай його; інакше пост без зображення». The code now ignores a picture rule for a post with no fitting poster, so the old wording no longer kills text-only posts, but it says nothing the critic can check when a poster does fit. A rule that only mentions a picture word for another reason (e.g. «не бери фото з PromptHero») is dropped from the critic's prompt too when no poster applies; the log line names it.

**How to see it working**

- Approval card or slot → critic block: the issues list (`Must fix` / `Advice`), «The critic saw the whole source page» or only the read part, and the skipped-rule note. A final revise on pass 1 says the slot used up its critic runs.
- Slot JSON → `critic.source_coverage`, `critic.issues`, `critic.previous_checks`, `critic.route` (`pinned`), `critic.rules_skipped`; the ladder step has `critic_level`.
- A skipped slot after a revise: `error` begins `critic_rejected: cap_revise —` (no rewrite left) or `second revise —` (the rewrite left a first-pass item unfixed). `critic.reason` of `blocking_issue_unfixed: …` means a blocking issue the critic had covered with an edit was not fixed because the edit did not apply (see `critic.edits_rejected` / `edits_failed`).
- A library post with a source URL and a fitting poster goes out; an off-topic poster comes back to the executor as `lint_failed: poster_mismatch …` before the critic runs.

**Troubleshooting**

- The critic still says a fact is not in the source: check `critic.source_coverage`. `read` means it saw only the parts the author read; the author should read the right section (`find_in_doc`, then `read_doc`) before writing the number.
- A post is skipped with `cap_revise`: the slot already used 2 critic runs (or 1 after a retry). Read the stored notes; the next slot starts with a fresh budget.
- A poster the owner wants is refused: check the topic against the poster's `use_for` (a keyword in the title or lead, or twice in the text); the error names the posters that fit.
- Tests: `critic/read-capture.test.ts`, `critic/critic-passages.test.ts`, `post/grounding.test.ts`, `critic/verdict-contract.067.test.ts`, `critic/pass-budget-pin.067.test.ts`, `silent/fallback-ladder.test.ts`, `post/integrity/poster-fit.067.test.ts`, `critic/poster-decision.067.test.ts`, `critic/pass-with-edits.test.ts`, `tools/role-tools.test.ts`, dashboard `lib/critic.test.ts`.

## 27. Stop dead series (spec 068)

A series with nothing to post from now stops early, says so, and costs nothing while it is dead. The parts are in § 19 (cause, classifier, empty day, pauses lowering the minimum) and § 20 (pre-flight on library slots and at plan time); this section is what to do on deploy and how to read it.

**Needs**

- Migration `095_prompts_post_requires` (data only: `prompts.post_requires` from `[["page_url"], ["prompt_text", "media_url"]]` to `[["prompt_text"], ["media_url"]]`, one sentence added to the description, the stats refreshed). Apply it with the deploy; the code works without it, the Prompt series just keeps meeting PromptHero rows. It touches the rule only while it is exactly the 083 value and the description only while it is the 083 text: an owner's own rule or wording stays. Down: `database/migrations/down/095_prompts_post_requires.down.sql` (puts the 083 rule back; no row changes).
- Nothing to enable. The new checks and the cause field are code; no new setting.

**What changes for the owner**

1. **PromptHero rows of `prompts` can no longer be posted.** A post of the Prompt series is the prompt with its example, and a PromptHero row has the page and the picture but no prompt text. After 095 the catalog counts them in `not_postable`, `unposted_here` and `query_data` leave them out, a slot that names one is stopped by the pre-flight (`preflight_no_material`), and the series pauses after 3 dead days (§ 19) instead of a skip a day. Give the series a source that has text: import a curated dataset or prompts.chat (§ 25), or point the series at a dataset with `prompt_text` and `media_url`.
2. **The 083 insert check now refuses PromptHero loads.** The write path (`data_items_upsert`, the importers, the dry run) rejects a new `prompts` row without `prompt_text` as «required for posting: prompt_text»; a PromptHero loader that writes only page and picture reports those rows as invalid, not inserted. Existing rows are not touched (they stay, flagged not postable). To bring PromptHero rows back, load the prompt text with them, or set another rule for the dataset in the dashboard (an owner rule is never replaced).
3. **`query_data` by ref.** `refs: ["data://prompts/123", "library://…"]` (1–20) takes those rows whatever their status and returns `postable`, `missing` (what `post_requires` lacks) and `used_here` per row; a ref with no row is `{ ref, found: false }`; a row that is not active (hidden, for example by an import undo) is `postable: false` with `missing: ["status: hidden"]`; a `data://` ref of another dataset is `ref_dataset_mismatch`. Filters, search and `unposted_on` are not applied (`unposted_on` only picks the resource for `used_here`). A filter on a field named `id` is refused with the way to use `refs` (the dataset's `id` field is often a CDN address; the number in the ref is the row id).
4. **An empty result says why.** With a resource, zero hits is «nothing left that is unposted» only when rows match at all; when nothing matches used or not it says the filtered or searched field may be empty in most rows (fill % in `library_catalog`), or that the dataset has nothing postable.

**Reading it**

- Series planned as `planner_no_material` / `planner_source_unreachable` placeholders, or skipped with `preflight_no_material`, are the intended behaviour for an empty library: three of them in a row pause the series (`/app/health`, the Inbox note and card of § 19).
- A plan refused with «слот N (HH:MM): … — заміни джерело/рядок або постав skipped_series з cause no_material / short_day» is the planner being told, once, that a source cannot post; it picks another row or declares the empty day. Many such refusals for one dataset mean its rows lack what `post_requires` asks (the catalog's `not_postable`).

**Troubleshooting**

- Prompt series paused right after deploy: expected if its source was PromptHero rows; fix the source (item 1). The «бери з X» card (§ 24) binds the series to the new dataset **and resumes it in the same Apply** (its `Resume` item, ticked); a manual Resume (Overview → Paused series, or the «Відновити» card) is needed only when the source was changed another way. The channel's own pause (plain slots) is only suggested on the card, unticked: tick it too (the card says that the channel and the series bound on it are not planned until it is ticked), or the series still posts nothing.
- A curated prompts row will not post: it lacks `media_url` or `prompt_text` (the rule is both); `query_data` with `refs` shows `missing`.
- Rolling back 095 only restores the 083 rule (PromptHero rows are postable again); no row changes either way.
- Tests: `preflight/slot-preflight.068.test.ts`, `preflight/material.068.pg.test.ts`, `network/plan-preflight.068.test.ts`, `tools/query-refs.068.test.ts` and `.pg.test.ts`, `data/prompts-rule.095.migration.pg.test.ts` (own database: the no-op without 083, the replace, idempotence, the owner's rule, the down file), plus those of § 19.

## 28. Chat claims and attribution (spec 069)

Two things the chat and the lint now know that they did not: what the chat did **earlier**, and what the agent **read** before it called a post its own. No migration, nothing to enable.

**What changed**

- **The claim guard knows the chat's past.** A reply like «я записав скіл nanobanana-prompts» used to be a false claim whenever this turn called no tool, even when the skill card had been applied an hour ago. Now a claim sentence is backed by an earlier action when it **names** it: the skill handle (also in «quotes»; the version is ignored), the rule number (`#12`, «правило 12»), the id of a card (8 hex or longer) or of a draft. The sources are the stored `actions` of the earlier assistant messages and the chat's cards with their status now (`ChatFacts.cards`; a skill card's name is the quoted word of its summary). A card has to be **applied** to back «застосовано» or «записав»; a card that still waits backs «надіслав картку». Free-word overlap is not enough: «я записав скіл про промпти» names nothing and is still re-run.
- **Write claims.** «записав / зберіг / створив» in a sentence that names a скіл, пост, чернетку (or skill, post, draft) is a **write** claim, backed by any change; with the word «правило» it stays a rule claim (needs a stored rule or its card). «створив» alone says nothing.
- **The retry hides the first answer.** After an unbacked claim the second run starts from the chat history **without** the first answer, and its last message is the owner's message again plus the note «відповідай на останнє повідомлення власника ще раз; кажи лише те, що зробили інструменти; ніколи не згадуй перевірку чи виправлення», plus the calls this turn already made («Ці виклики вже виконано в цьому ході — не повторюй їх: …»). The owner no longer reads «Я виправляю відповідь… Що було не так у моїй відповіді». With a claim and a denial together the claim shape is used and the denial text follows; a denial alone keeps the old shape (history + first answer + the denial text + the trace).
- **A retry does not repeat a write.** An act or terminal tool call that already succeeded in the turn (same tool, same input, any key order) answers the retry with its first result plus `already_done` and runs nothing: no second owner rule, no second card, no second draft. A different input is a real call; reads and failed calls run again.
- **Etiquette.** Every chat prompt (composer, named agent, @ai0, @manager) and the `agent-chat-etiquette` skill say: do not announce a corrected answer.
- **`origin_mismatch`** (lint error). A post with `origin=original` that shares a verbatim run of 80 characters or more (case and spacing ignored) with anything the agent read is refused: «використай origin=library + library_ref або origin=external + source.url, або перепиши». It looks at the whole text of each source (a 60k page too), and at the body, carousel slides and longread. Only `original` is checked.
- **Where the sources come from.** Executor runs: the critic gate's pages and feed items (`web_fetch`, `fetch_feed`) and the library row of `library_ref`. Chat: a per-chat, in-memory capture (6 hours, 40 sources per chat, 100 chats, 60k characters a source) written from the results of `web_fetch`, `fetch_feed`, `read_doc`, `find_in_doc`, `query_data` and `search_library`; `save_draft`, `lint_post`, `preview_post`, schedule and publish of a draft all lint against it. Only `{ url, text }` is kept, so the image and freshness checks stay off for chat drafts (the number-grounding warning `number_not_in_sources` can now appear on a chat draft that read a page).
- **Skills.** `edit_my_skill` and the builder's `write_skill` return `origin_original_with_source` for a body that prescribes `origin=original` next to a fetched or library source (a tool name, a URL, `data://`, «бібліотека», «датасет», «рядок»). A sentence that also names `origin=library` / `origin=external`, or says «не / без / ніколи», passes; a list item reads its lead line too.

**Troubleshooting**

- A post is refused with `origin_mismatch` and it really is the agent's own text: it reused 80 characters of something it read (a prompt row, a page). Rewrite the passage, or label it honestly (`origin=library` + `library_ref`, `origin=external` + `source`). The capture lives in memory: after a restart or 6 hours the chat has no sources and the check is silent.
- A reply still ends with «(Not done: no tool call recorded this action.)»: the retry also claimed an action no tool did. The sentence has to name the thing it restates (skill handle, `#N`, card id) to count as a restatement of the past.
- The retry answered a different question than the first run: the retry reads only the chat history plus the owner's last message. If the owner's message depends on text the model wrote earlier in the same turn, say it again in the next message.
- Tests: `chat/chat-claims.069.test.ts` (claims, backing, the retry shape, no second rule), `chat/chat-reads.069.test.ts` (capture, drafts, `lint_post`), `post/lint-post.069.test.ts`, `tools/origin-mismatch.069.test.ts` (executor), `agents/skill-origin.069.test.ts`.

## 29. Source resilience and ops (spec 070)

No migration. One owner action per item below; none of them needs a setting.

**The ПДР as a dataset (`import_list` `split_on`)**

A law or standard on one long page has no headings per clause, so `import_list` cuts it by a line pattern. The first use is the road rules for @pdr_dev_channel: 866 `pdr_questions` rows are used up, and the clauses are the next source of quiz posts.

1. In the chat with @pdr_dev_channel (or `@ai0`): fetch the page of the rules on zakon.rada.gov.ua (the `…/print` address), then ask for an import into `pdr_rules` with `split_on` set to `^([0-9]{1,2}[.][0-9]{1,2}(?:[.][0-9]{1,2})?)[.]` (group 1 is the clause number) and this mapping: `clause` = `split_key`, `title` = `heading`, `text` = `text_without:^\{` (leaves out the editorial notes «{Пункт … в редакції …}»), `category` = `context_line:^[0-9]{1,2}[.] [^.]{3,60}$` (the section title, e.g. «14. ОБГІН»), `source_url` = `url_anchor:п.`, `license` = `const:public domain`.
2. Read the preview: `records` (one per clause), `longest_record_chars` (one clause that runs to thousands of characters means a section title was not recognised), and `repeated_keys` (`1.1 ×2` means a sign or markup line collides with a clause: narrow the pattern). The patterns are tested on the first 300 characters of each line and are **case-insensitive**, so rely on the numbering, not on capitals.
3. Press **Apply**. `post_requires` is `[[text]]` (with `split_on` the default is only the fields read by `text` / `text_without`; a picture or the heading is not enough); `list_ref` is the page address plus `#<clause>` and is the dedup key; the weekly re-sync repeats the same `split_on` and updates only the clauses that changed.
4. Add `pdr_rules` as a library source on the pdr card and allow the `quiz` format. Library posts carry `library_ref` (`data://pdr_rules/N`) and `source.url` = the anchored clause (`…/print#п.14.6`), so the ledger records both and the critic reads the row.
5. **After spec 071 ships**, set the reuse policy of `pdr_rules` to «Repeat in rounds» (see § 30): otherwise the clauses run out like the questions did. If the breaker paused @pdr_dev_channel (spec 068: its empty days pause the channel itself), press **Resume** after saving the policy (Overview → Paused series, or the «Відновити» card): switching a dataset to rounds does not lift a pause, and a paused channel is not planned.

**Connection resets and feeds**

- A site that cuts the connection (`socket hang up`, `ECONNRESET`, a closed socket) is asked once more after a second. If that fails too it is recorded as a `timeout`: one hour of pause, no strike, and the agent is told «сайт обірвав з'єднання; година паузи».
- A feed's own 401 / 403 / 429 / 451 (`feed_refused`) or 400 / 404 / 410 (`feed_missing`) pauses that feed for a day, without strikes, and **pages of the same site keep working**. A page's 403 no longer blocks the site's RSS. Source health shows the feed as blocked for a day; a feed that keeps failing reaches the owner as `failing` (three failed reads in 14 days), not through a strike note.
- A feed at the root of a site is stored under `host/`, so it never replaces the row of the host itself.
- A network failure of a feed (DNS, TLS, timeout, reset) is recorded on the host **and** on the feed's own address. Otherwise a host that already has a live «refused» row (its pages answer 403) would keep the shorter timeout row out, and a feed that keeps failing would be asked again on every call.

**A stale copy when the site fails**

- The document store keeps a page for 6 hours as a fetch cache (`DOC_STORE_HOURS`) and for up to 7 days as a stale copy. `read_doc`, `find_in_doc` and `import_list` read a `doc_id` for those 7 days instead of answering `doc_expired`.
- When the refetch fails because the site is down, blocked or refusing (a reset, a block row, a 5xx, 401, 403, 429, 451), `web_fetch` answers the kept copy with `stale: true`, `fetched_at` and a note «копія від … UTC; сайт зараз недоступний». A 404 or 410, a body that is not a document and a re-sync never get an old copy.

**Quiz channels**

A profile topic that names a quiz («Вікторини з ПДР», the words quiz / quizzes / trivia on their own, «тестові запитання», «екзаменаційні питання / білети») is now a quiz when `content_kind` is not set: the order is the explicit field, then quiz, then news, then general. A quiz guessed this way has a cap of 14 polls and quizzes a week (an explicit `content_kind: quiz` stays uncapped; an explicit `polls_per_week` wins). «Тест-драйв» and «тестування» are not quizzes. In the Formatting form the placeholder of «Polls a week» follows the kinds: «Quiz» in the select shows «no limit», any other kind «1 (default)», and «From the topic» shows what the server falls back to after clearing both fields (`defaultPollsPerWeek`: 14 for a quiz guessed from the topic, 1 otherwise); a saved cap is the field's value, never the placeholder.

**Meta metrics**

A Graph insights metric that answers HTTP 400 three times in a row for one account (any code except 190, 1, 2, 4, 17, 32, 613) is not requested for 24 hours; after that it gets one request a day while it keeps failing, and one success starts the count again. One warning a UTC day says what Meta answered: `status 400 code=10/2108006 OAuthException: … (fbtrace_id …)`; give the fbtrace_id to Meta support or fix the permission. The 7-day path for «unsupported metric» is unchanged. The count is in memory: a restart asks once more.

**Story repeats**

The `story_repeat` check no longer passes two posts as one story just because one contains the other's names. Without shared topic words it now needs strong evidence: five or more shared entities, a multi-word name, a person, a number or a date. It never applies when either post is an explainer or declared evergreen. A post with no source at all counts as evergreen (spec 041): give a news post its source.

**Deploy and stop**

- The `docker compose restart automation` line after `up -d` is gone from `deploy-develop.yml` and `release-prod.yml`. It was added (40d9a951) so that a config-only deploy reloaded `channels.json`, which the service reads once at boot. The config is now copied into the image (`apps/automation/Dockerfile`, `COPY apps/automation/config`), so a config commit builds a new image, `pull` fetches it and `up -d` recreates the container. The restart then only killed the container that had just started: Node is PID 1, had no SIGTERM handler until the shutdown hooks were enabled, and Docker waited 10 s and sent SIGKILL in the middle of boot. Only `*.local.json` files are gitignored and stay on the box.
- `apps/automation/src/boot-signals.ts`: a SIGTERM or SIGINT that arrives while the service is still booting logs «shutdown during boot» and exits with 143 at once; the listeners stay armed through `app.init()` (migrations, the MTProto connect and the other onModuleInit hooks) and are removed right before `enableShutdownHooks()` and `listen()`, so a stop after boot is graceful as before.
- **Owner action, not in the repo:** add `init: true` to the `automation` service in `docker-compose.yml` on the box (and in the dev compose). An init process as PID 1 forwards signals and reaps children, so a stop is never ignored. The compose files carry local changes, so they are not edited by the deploy or by this spec.

**Troubleshooting**

- `no_entries` («split_on matches no line of the document»): the pattern does not match any line start; the page may be a different layout than the rules (open the doc with `read_doc` and look at the first characters of a clause line). `bad_pattern`: the regex does not compile.
- `wrong_extractor` «needs split_on»: `split_key`, `url_anchor:` and `context_line:` read a record made by `split_on` only.
- Feeds and pages that keep failing show in source health (`/app/health`, spec 049). A feed block expires by itself after a day.
- Tests: `docs/import-list-split.test.ts` and `.pg.test.ts` (fixture `docs/testing/pdr-fixture.ts`), `net/host-failures.test.ts`, `host-strikes.061.test.ts` and `.pg.test.ts`, `docs/doc-store.test.ts`, `docs/doc-stale.070.test.ts`, `post/audience-asks.test.ts`, `config/meta-insight-backoff.test.ts`, `config/meta-graph.client.test.ts`, `story/story-match.test.ts`, `boot-signals.test.ts`; the dashboard placeholder in `lib/format-prefs.test.ts`.

## 30. Datasets that repeat in rounds (spec 071)

A dataset can now be set to **repeat in rounds**: every row is posted once on each channel; when the channel has used them all, a new round starts and the rows are free again. The order of a round is either by fields you choose («in order») or random. Before this the choices were «never again» and «after N days», and `pdr_questions` ran out for good: all 866 rows were used by June.

**Needs**

- Migration `096_data_reuse_rounds.sql` (down: `down/096_data_reuse_rounds.down.sql`; it sets cycle datasets back to «never again», deletes the `passed` ledger rows and drops the round table). Nothing to enable: the setting is per dataset and a dataset stays «never again» until you change it.
- Nothing is redeployed for the dashboard beyond the normal build: the Reuse field and the Rounds panel are in the Data pages.

**The setting (Data → a dataset → Schema → Reuse)**

- **Never again** (the default), **After N days**, **Repeat in rounds — in order**, **Repeat in rounds — random**. A dataset that does not repeat behaves exactly as before.
- «In order» has up to three selects: **Order by**, **Then by**, **Then by**, over the dataset's live scalar fields (numbers, dates, text, lists of choices). The default, «Import order», sends no field. Rows are sorted by the first field, ties by the second, and so on, then by import order. A row with an empty value goes last. Numbers sort as numbers (2 before 10).
- It can also be set from the agent chat: «давай pdr_questions по колу по черзі» makes the agent propose an **Edit dataset** card (target Reuse); you apply it like any dataset suggestion.

**What a round is**

- Each channel (or page) has its own round of each dataset. No round row means round 1, and everything published or posted from the dataset before counts in round 1.
- A row is **done** on a channel when it was published there, or **put aside** (see below) after the round started. The round rolls to the next one by itself, at the moment the last open row is done: the new round starts that instant and every row is open again. A row that waits for your approval on that channel is neither open nor done, so it does not hold the round back.
- Only rows that can be posted count (`post_requires`, active, not hidden). An empty dataset or one with nothing postable never rolls.
- **In order**: the agents are told the next row: `query_data` with `unposted_on` returns the rows in the round's order, the first is `next`, and the note says «бери перший рядок». A series whose source is such a dataset gets the next row in its note, and `publishGuard` refuses another row of that dataset with `not_next_in_order` (series slots only; a free post is not ordered). The note's row also overrides a different `data://` row the planner hinted, in the pre-flight too (§ 20): a stale hint never skips the slot.
- **Random**: a row published on the channel in the last 7 days is put last, so the last row of one round is not the first of the next. An explicit `newest` or `oldest` from the agent is kept.
- **Put aside**: when no post can be made from a row (the critic rejects it for a reason a rewrite cannot fix, a failed revise, `quiz_answer_mismatch`, or the executor calls `skip_slot` with `ref`), the row is recorded as `passed` for that channel in this round only and the executor is not asked to retry it. It comes back in the next round. Never network-wide, and never for a guard or lint code (those say the draft was wrong, not the row).
- **Put-aside rows still count for the breaker (spec 068).** Three `skip_slot` closes in a row with cause `no_material` pause the series (or the channel, for plain slots) even though each row was only put aside and the round has hundreds left: on purpose, because a dataset whose rows are all bad must stop instead of burning a slot a day. The pause card names the last row. Fix the data or the dataset's `post_requires` (a row that lacks the picture or the text a post needs), then **Resume**.
- The URL a post cites (`source.url`) no longer blocks the second round: the library row is the material, the URL is a citation. The row itself is still checked. This holds on every way a post goes out: the agent's own publish, the re-check after you approve a post, and a post from the chat drafts.
- A row of a repeating dataset is not compared with its own earlier post: when the same row comes back in round 2, the «too similar to a recent post» check leaves out the earlier posts of that row (on Telegram, on the platforms, and in the re-check after approval), so a small dataset does not stall on its own round-1 post. Other rows' posts and posts of datasets that do not repeat are compared as before.
- In order, a failed attempt on the next row is fixed on that row: if the post for the row the series waits for fails on similarity, lint or a fixable critic note, the next attempt rewrites the same row (it is not told «take other material», which the order guard would refuse). When a row is put aside the next attempt is told the new next row, and when the round has nothing left the slot is skipped with that reason.
- Catalog and prompts: a repeating dataset shows as «по колу (по черзі), коло 2: лишилось 840 з 866» and has no runway (a round never runs out; the low-runway warning skips it).

**The Rounds panel (Data → a dataset → Items)**

- One card per channel that has posted from the dataset: **Round N**, how many rows are posted out of how many, how many are left or waiting for approval, and a percentage. Click for the details: when the round started, the order, and for «in order» the **next row** (`data://dataset/id`).
- **Restart round** (in the details, behind a confirm) starts the next round on that channel now, whatever is left in the current one. Use it to start over; you never need it to finish a round.
- The **Unposted** number on the dataset page and in the list reads «in current rounds» for these datasets: rows not yet posted in the channels' current rounds.
- The panel is hidden for a dataset that does not repeat and when the server has no rounds endpoint. API: `GET /api/data/schemas/:key/rounds`, `POST /api/data/schemas/:key/rounds/restart` with `{ "resource_ref": "telegram:@channel" }`.

**What happens at the switch**

- Switching a dataset **to** repeating (from «never again» or «after N days») starts clean: everything already published counts in round 1, and every channel that had used all of the rows rolls to round 2 at once. So a dataset that was used up (pdr_questions on @pdr_dev_channel, 866 of 866) is free again the moment you save, and an in-order dataset starts from the first row.
- Changing «in order» to «random», or the order fields, keeps the rounds.
- Switching **away** from repeating deletes nothing, but the rules go back: under «never again» every publication of every round blocks again (a row posted in round 2 is used for good, so the dataset looks used up), and `passed` rows stop blocking. Under «after N days» the clock of each publication counts.

**Owner step after the deploy (pdr_questions)**

1. Data → PDR questions → Schema → Reuse → **Repeat in rounds — in order**, Order by `ticket_number`, Then by `question_num` → Save.
2. If a later import changed the numbering, check it first: every row needs both numbers (a row without one goes to the end of the round), and the import order must not matter within one ticket. Open the Items tab and look at a few tickets before saving.
3. After saving, @pdr_dev_channel is in round 2, the Rounds panel shows `next` = the first question of the first ticket, and the series slot's note names it. The next planned slot posts it.
4. **If the breaker paused @pdr_dev_channel** (spec 068: its empty days pause the channel itself, so by now it very likely did), press **Resume** after saving the rounds policy: Overview → Paused series, or the «Відновити» card in the Inbox / Telegram. Switching the dataset to rounds does not lift a pause, and a paused channel is not planned (`plainPausedChannels`), so without Resume no slot appears even though the Rounds panel shows `next`.

**Troubleshooting**

- The Rounds panel shows `next` but nothing is planned: the channel (or the series) is paused. Resume it (Overview → Paused series, or the «Відновити» card); a dataset switch never lifts a pause.
- A round does not roll although nothing is left: the Rounds card says «waiting for approval». A post of this dataset waits for you on that channel (Posts to approve); decide it. A published post rolls the round at once; a rejected one is noticed at the next read of the dataset by an agent.
- `not_next_in_order` in a skip reason: the executor picked another row than the next one. It is a content failure (it does not pause the series); the note of the next attempt names the row.
- A row never appears: it is hidden, or not postable (a required field is empty), or it was put aside in this round. The Rounds card counts only postable rows.
- Tests: `data/data-rounds.test.ts`, `data-rounds.pg.test.ts`, `data-rounds.migration.pg.test.ts` (migration traps and the down file), `data-rounds.read.test.ts`, `data-rounds.read.pg.test.ts` (round order, lazy roll, the 7-day tail, passed, A7), `data-rounds-api.pg.test.ts` (rounds view and restart), `editor/silent/pass-row.071.test.ts` (also the ladder keeping the next row, the series note after a row is put aside), `editor/tools/data-tools.rounds.test.ts`, `role-tools.071.test.ts`, `role-tools.test.ts` (similarity without the row's own post), `editor/schedule/schedule.071.test.ts`, `editor/approval/approval-publisher.test.ts`, `editor/chat/drafts.service.test.ts`, `editor/platform/platform.test.ts`, `editor/repo/round-similarity.071.pg.test.ts`; in the dashboard `lib/data-store.rounds.test.ts`.

## 31. The dashboard redesign (spec 078)

The dashboard and the landing page have a new look: dark panels with hairlines, one green accent, amber for "you have to act", mono type for machine facts. The menu is shorter, three pages are new (Today, Inbox, Calendar), and every other page is restyled. No API was removed. Two backend changes ship with it: the Inbox actions endpoints and a mark-read answer (below). There is no migration.

**Needs**

- A normal deploy of both images. Deploy the automation service with the dashboard, or at the same time. With an older service the Inbox note buttons answer 404, and the page says the server does not support the action yet.
- Optional: the stage's sidebar shows a small `dev` pill. The develop workflow passes `VITE_ENV_LABEL=dev` (override with the repository variable `DEV_VITE_ENV_LABEL`). The prod build passes nothing, so prod has no pill. Locally, set `VITE_ENV_LABEL` in `apps/dashboard/.env.local`.

**The menu (saved menu schema v2)**

- The default menu has 11 items in four groups:
  - **Home:** Today, Inbox, Chat.
  - **Network:** Agents, Calendar, Channels, Map.
  - **Insights:** Analytics, Spend, Health.
  - **System:** Settings.
- Every other page is under **More tools**, in ⌘K and in breadcrumbs. Hiding a page only changes the menu: every route keeps working.
- A menu saved before (schema v1) is migrated when it is read. The migration starts from the new default and keeps:
  - pins, custom links, and renames, icons and counter switches;
  - your own groups and their order;
  - the pages you hid on purpose (including every page of a group you hid);
  - the pages you un-hid from the old hidden-by-default list (directives, the Telegram tabs and so on);
  - a title you gave a surviving group.
- The migration does not keep:
  - the order of pages inside a built-in group;
  - pages moved between built-in groups;
  - where you placed pages you left visible (the redesign decides the 11).
- The migration runs on every load until you save the menu once (Settings → Navigation). From then on the menu is stored as v2. Nothing is lost by not saving.
- The Inbox counter in the menu is unread notes plus posts to approve. "Posts to approve" is no longer its own menu item. It is the Inbox's Approvals tab (`/app/agents/inbox?tab=approvals`), and the old Telegram links land there.

**What moved where**

- **`/app`** is now **Today**: what needs you, the day's ring and a Telegram timeline (06:00–24:00 Kyiv). It replaced the old Overview.
  - The headline counts only what needs a decision: unread critical and action notes, posts to approve, and cards waiting in a chat.
  - Dismissing a note marks it read, and Undo brings it back.
- **Inbox** (`/app/agents/inbox`) has a list on the left and the note on the right; on a narrow screen the note opens in a sheet.
  - A note carries the same buttons as its Telegram card: Resume, Keep paused, Pause series, Mute for 7 days.
  - A press in the dashboard counts as your reaction (the A10 demotion rule; `owner_cards.resolved_by = 'dashboard:owner'`). The bot then never sends a card for that note.
  - "Mark as done" offers Undo only for the notes it actually changed. A note you settled in Telegram in the meantime stays settled.
  - API:
    - `POST /api/agents/inbox/:id/actions {key}` runs a note's button.
    - `POST /api/agents/inbox/read` now also answers `ids` (the notes it changed).
    - `POST /api/agents/inbox/unread` marks notes unread.
- **Agent page:**
  - It has 17 tabs in five groups, with a second row for the group's tabs. `?tab=` is still the tab, so old links work.
  - The profile, resource, formatting and sources forms moved from Overview to **Settings**. Overview keeps two short summaries, each with a link to Settings.
  - Lock a formatting field from the summary's switch.
  - **In force** lists the active effects.
- **Calendar** (`/app/calendar`) is new. It shows a week of agent slots and your own posts.
  - **Add** opens the composer as a side sheet (`?compose=new&channel=&day=`). A post opens with `?compose=edit&post=`.
  - "Ask the agent" adds a one-off pin to the agent's schedule. The toast's Undo withdraws it.
- **The network KPI digest** (per-resource KPIs, anomalies, quality flags, open directives, the answers to `@manager`) was a card on the old Overview. It is now at the bottom of **Health** (`/app/health`), after Stuck work; it reads its own endpoint, so it shows even when the health checks above fail. On a phone only flagged resources show until you open the rest.
- **Redirects** keep old links working: `/app/strategies*` → Agents, `/app/bots` and `/app/telegraph` → Connections, `/app/agent` → DM, `/app/setup` and `/app/steering` → Artifacts.
- **Landing (`/`)**: a new hero with an orbit of the network's agents and an agent log built from the public pulse.
  - The sections and anchors are unchanged, and so are the lead-form and CTA tracking.
  - Under "reduce motion" nothing moves, and the channel row and the log show as plain lists.
  - `/white-label` is not restyled.

**Troubleshooting**

- The menu still shows the old 26 items: the browser has an old build cached. Reload the page. The first paint uses a local copy of the menu, and the saved menu replaces it a moment later.
- An Inbox button answers "This server does not support that action yet": the automation image is older than the dashboard. Deploy it, or use the note's link to the page.
- "This note no longer offers that action. Refresh the list.": the note's buttons changed since the list loaded.
- "That series was already resumed" or "That series is already paused": the pause changed elsewhere (Telegram, the agent page). The note is still marked read.
- The Today headline says only the greeting: the Inbox has not answered yet, or the approvals counter is still loading. If the Inbox fails, the "Needs you" panel says so and offers Try again. It never says "All clear" on a failure.
- Tests:
  - Dashboard: `nav/migrate.test.ts`, `nav/registry.test.ts`, `nav/badges.test.ts`, `lib/today.test.ts`, `lib/inbox-*.test.ts`, `lib/calendar.test.ts`, `lib/agent-tabs.test.ts`, `lib/landing-*.test.ts`, `lib/status-tone.test.ts`.
  - Backend: `editor/series-pause/inbox-actions.078.test.ts` and `inbox-actions.078.pg.test.ts`.
