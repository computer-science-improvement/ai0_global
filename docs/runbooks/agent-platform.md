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
| Hourly | Registry sync (:17), expired confirmation cards and shadow → "go live?" cards (:23), and directive timeouts, expiry and effect evaluation (:47). |
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

- Migration `080_channel_setup`.
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
| `no_access` | The tracking account cannot read the channel. Add it to the channel, then analyze again. |
| `too_few_posts` | Fewer than 5 usable posts. The model is not called. |
| `failed` | The reason is on the row. The run trace is under "Open the run" (role `onboarder`, usage feature `editor.onboarder`, at most 4 steps and $0.30). |

**Changed since analysis**

If you edited a section after the analysis, Apply refuses that section and applies the rest. Analyze again to review it with the new values.

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
