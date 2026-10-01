# 010: Editor chat (Claude-style chat with the editor agent)

**Status:** TODO · **Depends on:** 003–006, 008 (reserved slots), 009 (formats)

## Why
The owner wants to work with the editor agent conversationally, as with Claude: "зроби пост про X у @channel з
вікториною", look at the preview, ask for changes, then **publish now** or **schedule** it for a date and time. Today
the agent only acts on its own plan; manual posting goes through a separate form with no AI help.

## User stories
- **US1:** I chat with the agent and it researches, using the same tools as the executor (feeds, library, web,
  `fetch_api`, stats), and drafts a post for a channel I name. The draft appears in the chat as a rendered Telegram
  preview card.
- **US2:** I ask for edits in plain language ("коротше", "додай опитування", "інша картинка"). The agent revises the
  draft, and the card updates.
- **US3:** I click **Опублікувати зараз**, or tell the agent to publish. The post goes out immediately through the same
  guards as `publish_post` (lint, dedup, `publish_paused`), and cross-posting follows the card.
- **US4:** I click **Запланувати** and pick a date and time, or tell the agent "на завтра о 19:00". The post is
  published at that time **deterministically, without an LLM**, even if the editor is off.
- **US5:** I see my chats in a sidebar, can come back to one, and see scheduled drafts and their status.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | Migration `047_editor_chat.sql` (additive, idempotent, records its own version). <br>• `editor_chats(id uuid, title, created_at, updated_at)` <br>• `editor_chat_messages(id bigserial, chat_id fk cascade, role user\|assistant, content text, draft_ids uuid[], run_id uuid, created_at)` <br>• `editor_drafts(id uuid, chat_id fk set null, channel_key, spec jsonb, preview text, lint jsonb, status draft\|scheduled\|published\|failed\|canceled, scheduled_at, slot_id uuid, published_post_id bigint, error text, created_at, updated_at)` |
| FR-002 | New agent role `composer` using the AgentLoop with **multi-turn history**. Add `history?: ChatMessage[]` to `AgentLoopInput`: prior user and assistant *text* turns, last 20, with drafts summarised in the assistant text. Add an `onEvent` callback for streaming: `llm_text`, `tool_call {name,args}` and `tool_result {name, ok, summary}`. The loop has no terminal tools and ends when the model answers with text. Max 16 steps. Budget: global scope. The chat is enabled when `OPENROUTER_API_KEY` is set; the chat does not depend on `EDITOR_ENABLED`. |
| FR-003 | Composer tools: <br>• all read tools and compose tools, plus `fetch_api` <br>• `list_my_channels`: `tracked_channels` where `is_mine`, with title, key, whether a card exists, and card mode <br>• `save_draft({channel, spec, draft_id?})`: validates with the channel card, or a **default card** when the channel has none (all formats allowed, no hashtag vocabulary, inline links). Stores or updates the draft and returns `{draft_id, preview, lint}`; lint errors are returned so the agent fixes them. <br>• `publish_draft({draft_id})` <br>• `schedule_draft({draft_id, at})`, where `at` is ISO or `YYYY-MM-DD HH:MM` in Kyiv time <br>• `cancel_draft({draft_id})` <br>• `list_drafts({status?})` |
| FR-004 | `DraftsService` holds the deterministic actions; tools and the REST buttons both call it. <br>**publish:** <br>• lint passes <br>• `publish_paused` is respected <br>• dedup: the same `source.url` or `library_ref` was not posted to the channel in the last 7 days <br>• the live media stage (carousel/longread) runs <br>• `TelegramEditorPublisher` sends <br>• `published_posts` gets `strategy_type='chat'` and `format` <br>• cross-posting runs when the card exists and `crosspost` is on <br>**schedule:** <br>• `at` must be at least 2 minutes in the future and at most 60 days ahead <br>• the channel gets a card if it has none: a minimal card with `mode='off'` (harmless; the planner ignores `off`) <br>• the day gets a plan if it has none: a "reserved only" plan, reusing 008's helper <br>• a reserved slot is inserted with `post_spec` = the spec and `topic` = `Чат: <title>` <br>• the draft becomes `scheduled` <br>**cancel:** the slot becomes `skipped`, the draft `canceled`. |
| FR-005 | Reserved-slot publishing becomes a dispatcher. A reserved slot owned by an ad order uses the sponsored path from 008 (unchanged). A reserved slot without an order but with a valid `PostSpec` in `post_spec` uses the **manual path**: the same steps as publish-now, at the scheduled time, deterministic, at most 6 h late, never retried. On success the draft becomes `published`; on failure the draft becomes `failed` and the owner is alerted. |
| FR-006 | REST, behind TrackingAuthGuard: <br>• `GET/POST /api/editor/chats` <br>• `GET /api/editor/chats/:id`, returning messages and drafts <br>• `DELETE /api/editor/chats/:id` <br>• `POST /api/editor/chats/:id/messages`, which **streams** newline-delimited JSON events (`text/x-ndjson`): `{type:'tool_call'}`, `{type:'tool_result'}`, `{type:'draft', draft}`, `{type:'message', message}`, `{type:'error'}`, `{type:'done'}` <br>• `GET /api/editor/drafts?status=` <br>• `POST /api/editor/drafts/:id/publish` <br>• `POST /api/editor/drafts/:id/schedule {at}` <br>• `POST /api/editor/drafts/:id/cancel` |
| FR-007 | Dashboard `/app/chat` (sidebar entry "Chat") with a Claude-like layout. <br>• **Left column:** the chat list, a "Новий чат" button, and a **Scheduled** list with upcoming drafts. <br>• **Centre:** the message thread with markdown-lite rendering. Live tool activity shows as compact collapsible chips ("🔎 fetch_feed…"). **Draft cards** show the sanitized Telegram preview, the channel, the format and lint warnings, with buttons **Опублікувати зараз** (ConfirmDialog), **Запланувати** (date/time picker in Kyiv time, defaulting to the next round hour) and **Скасувати**. The status updates live. <br>• **Bottom:** a composer with a channel picker (sets context: "Канал: @x" is prepended to the first message), Enter to send, Shift+Enter for a newline, and a stop button that aborts the stream. <br>• Follow `apps/dashboard/CLAUDE.md`. Mobile works (the chat list collapses). |
| FR-008 | Skill `editor-composer-workflow.md` (`applies_to: [composer]`). The agent: <br>• clarifies the channel if it is unknown (via `list_my_channels`) <br>• researches before writing and never invents facts <br>• always saves a draft and shows it before any publish <br>• publishes or schedules **only when the owner asks explicitly** in the current message, otherwise offers the buttons <br>• converts relative times ("завтра о 19") to Kyiv time and states the exact date and time back. <br>The other skills get `composer` added to `applies_to` where relevant (format-*, voice, fact-check, source-licensing). |

## Safety
- A publish from the chat goes through the same deterministic guards. The agent cannot bypass lint, dedup or pause.
- The route is behind the owner auth guard; only the owner chats.
- Prompt injection in fetched pages is handled as for the executor. Publish and schedule tools additionally require that
  the **latest user message** contains an explicit intent: the server passes `ctx.extras.userIntent` and the tool refuses
  with `needs_explicit_request` otherwise. The buttons always work.

## Success criteria
- SC-1: Unit tests cover DraftsService (publish, schedule, cancel, dedup, paused, minimal card creation, plan creation)
  and the reserved dispatcher (ad path vs manual path).
- SC-2: The loop history and onEvent are tested, and the existing loop tests still pass.
- SC-3: An e2e `*.pg.test.ts` with a scripted LLM covers chat message → save_draft → schedule_draft → reserved slot → the
  dispatcher publishes at the time through a fake TG → the draft is `published`.
- SC-4: Two live eval cases are added to `evals/`: (a) "make a post about X and schedule it for tomorrow 19:00" leads to a
  scheduled draft at the correct Kyiv time; (b) "make a post" without a publish request produces a draft only, and
  nothing is published.
- SC-5: The dashboard page builds. It is checked in a browser against the mock API (owner verifies live).
