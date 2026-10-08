# 033: Telegram rich messages: headings, lists, tables and formulas in agent posts

**Status:** BUILT (T1–T4; owner live smoke pending) · **Depends on:** 004 (PostSpec), 019 (platform render), 024 T8 (`format_prefs`), 031 (approval previews)
· **Migration:** none (PostSpec is JSON)

**Owner request (2026-10-07):** the Telegram editor now offers headings, lists, tables, formulas and more; the owner asked
whether agents can manage this formatting, then said «продовжуй розробку».

## Why
Bot API 10.1 (2026-06-11) added **Rich Messages**: `sendRichMessage` sends a post built from typed blocks
(`RichBlockParagraph`, `RichBlockSectionHeading`, `RichBlockList`/`RichBlockListItem`, `RichBlockTable`/`RichBlockTableCell`,
`RichBlockMathematicalExpression`, `RichBlockDivider`, `RichBlockBlockQuotation`, `RichBlockPullQuotation`, `RichBlockDetails`,
`RichBlockFooter`, `RichBlockPreformatted`, media blocks …) with `RichText*` inline formatting; `editMessageText` accepts
`rich_message`. Agent posts today support only bold, italic, spoiler, links, quote, lead and a "•" list
(`editor/post/post-spec.ts`, `render-telegram.ts`, `inline-markup.ts`), so the agents cannot use any of this.

## Functional requirements
| ID | Requirement |
|---|---|
| FR-001 | **PostSpec blocks.** Add `heading` (level 1–3), `olist` (numbered items), `table` (header row + rows of cells, inline markup in cells), `math` (expression string), `divider`, `details` (title + body blocks), `footer`, and `code` (preformatted, optional language) to `BlockSchema`, all backward compatible. Limits (zod + lint): table ≤ 6 columns × 20 rows, cell ≤ 200 chars; ≤ 60 blocks; math ≤ 500 chars. |
| FR-002 | **Telegram render.** `renderTelegram` returns a `sendRichMessage` `TgMessage` when the spec uses any rich-only block (heading, olist, table, math, divider, details, footer, code) **or** the card/resource prefers rich (FR-005); otherwise today's HTML path is unchanged. Media posts with rich bodies follow the exact Bot API shape (verify against https://core.telegram.org/bots/api — field names, block/inline object types, limits). The publisher sends via `sendRichMessage`, edits via `editMessageText` + `rich_message`, and records the message id like today. |
| FR-003 | **Fallback.** If Telegram rejects a rich message (e.g. not supported in the chat, size limit), the publisher retries once with the HTML render (tables → monospace `<pre>` grid or bullet rows, headings → bold lines, math → `<code>`), logs the reason, and stores `fallback: 'html'` on the publish record. A per-channel capability flag remembers a hard "unsupported" answer for 7 days. |
| FR-004 | **Other platforms and Telegraph.** `render-meta.ts`, `render-telegraph.ts`, `duplicate.ts` and lint map the new blocks to plain text (headings → lines, olist → "1." lines, table → short rows "a — b — c" or a note, math → inline text, divider → blank line, details → title + body). |
| FR-005 | **Agent control.** `format_prefs` (024 FR-013) gains `rich: 'auto' \| 'prefer' \| 'never'` (default `auto`) and the owner can lock it; the executor prompt and the format skill explain when tables/headings/lists help (comparisons, step-by-step, specs) and when they hurt (short news). `lint_post` warns on a table in a < 400-char post and on more than 2 headings in a short post. |
| FR-006 | **Previews.** `TelegramPreview` (dashboard) renders rich messages faithfully: headings, numbered/bulleted lists, tables (scroll inside the bubble at 375 px), math (monospace), divider, details (collapsible), footer. Approval cards (031) and chat drafts use it. English UI. |

## Non-goals
- Rich messages in Telegram DMs/chat replies of the agents; streaming drafts (`sendRichMessageDraft`).
- Map, slideshow, collage, voice and audio blocks (later).

## Success criteria
- Unit: schema + lint limits; render snapshots for every new block; fallback HTML snapshots; meta/telegraph plain mapping.
- Publisher fake-HTTP tests: rich send, rich edit, rejection → HTML retry, capability flag.
- Dashboard: preview tests + browser check (desktop, 375 px) of an approval card with a table and headings.
- Live smoke (owner, dev-stage test channel): one rich post with a heading, a table and a numbered list is delivered and editable.

## Task breakdown
### T1: PostSpec rich blocks, lint and plain fallbacks
**Scope:** FR-001, FR-004, FR-005 (schema + lint part). **Size:** M
### T2: Telegram rich render, publisher and HTML fallback
**Scope:** FR-002, FR-003. **Size:** L · **Depends on:** T1
### T3: Dashboard rich preview
**Scope:** FR-006. **Size:** M · **Depends on:** T1
### T4: Agent control: `format_prefs.rich`, skill and prompt guidance, evals (written, not run)
**Scope:** FR-005. **Size:** S · **Depends on:** T1

## Implementation notes (2026-10-08)

**Verified against https://core.telegram.org/bots/api** (read 2026-10-08; no Telegram call was made):
- `sendRichMessage`: `chat_id` and `rich_message` (InputRichMessage) required; optional `reply_markup`,
  `message_thread_id`, `disable_notification`, `protect_content` and others; returns the sent Message.
  `editMessageText` takes `rich_message` (InputRichMessage) instead of `text`.
- `InputRichMessage`: exactly one of `html`, `markdown`, `blocks`; plus `media`, `is_rtl`, `skip_entity_detection`.
  We send `blocks`.
- Block `type` values and fields used: `paragraph {text}`, `heading {text, size 1–6}`, `pre {text, language?}`,
  `footer {text}`, `divider`, `mathematical_expression {expression}` (LaTeX), `list {items}` with
  `InputRichBlockListItem {blocks, type?, value?, has_checkbox?, is_checked?}`, `blockquote {blocks, credit?}`,
  `table {cells: RichBlockTableCell[][], is_bordered?, is_striped?, is_compact?, caption?}` with
  `RichBlockTableCell {text?, is_header?, colspan?, rowspan?, align?, valign?}`,
  `details {summary, blocks, is_open?}`, `photo {photo: InputMediaPhoto}`, `video {video: InputMediaVideo}`.
- `RichText` is a string, an array, or `{type: bold|italic|underline|strikethrough|spoiler|code|… , text}`,
  `{type: 'url', text, url}`, `{type: 'mathematical_expression', expression}`. There is no `RichTextPlain`.
- Limits: 32 768 characters (formula source included), 500 blocks (nested blocks, list items and table rows
  count), 16 nesting levels, 50 media, 20 table columns. Lint enforces them on the rich message, plus our
  stricter PostSpec limits (6 × 20 table, 60 blocks).

**Left unclear by the docs** (decisions taken):
- **Channels.** `chat_id` is documented as "bot, supergroup or channel"; nothing says rich messages render in
  every channel or on every client. → Every rich message carries an HTML fallback; a definite Bad Request is
  retried once as HTML, a hard "unsupported" answer (or 404 / "method not found") flags the channel for 7 days.
  Network errors, 429 and 5xx are never retried (the message may be out; no duplicates).
- **Ordered vs bulleted lists in `blocks`.** `InputRichBlockList` has only `items` and is described as `<ul>` or
  `<ol>`; `type` / `value` on items are "for ordered lists". → Numbered items carry `type: '1'` and `value: n`;
  the live smoke must confirm that this renders as a numbered list (else switch olist to `html` `<ol>`).
- **Paragraph line breaks** inside a RichText string are not described → the tail (source, footer, hashtags) is
  one paragraph per line. **Empty table cells**: an omitted `text` makes the cell invisible → we send `text: ''`.
- **Error wording** for unsupported chats is not documented → `classifyRichRejection` matches
  "not supported / unsupported / method not found / not implemented / RICH_MESSAGE" (adjust after the smoke).

**Design.**
- `TgMessage` gains `{method: 'sendRichMessage', blocks, buttons, fallback}`; `fallback` is the HTML render
  of the same post, so an approval (031) stores and previews both and the approval publisher sends exactly the
  stored payload. Text, photo (photo block), video (video block), longread and the poll/quiz intro can be rich;
  album and carousel captions stay HTML (lint `rich_in_caption`).
- `format_prefs.rich` and the capability flag reach the renderer on the card: `EditorChannelsRepository` joins
  `resource_profiles.profile->format_prefs->rich` and `app_settings` `cap.tg_rich_unsupported:<channel>` (ISO time
  until which the flag holds; `SettingsService` ignores `cap.*`). No migration.
- The fallback is recorded as `fallback: 'html'` on the publish result (`publish_post` returns it) and as the slot
  warning `rich_fallback: html (<reason>)`; `published_posts` has no column for it (no migration).
- `TelegramEditorPublisher.edit()` (editMessageText + `rich_message`, HTML via editMessageText / editMessageCaption)
  exists and is tested; nothing in the product edits published posts yet.
- Evals `executor-rich-comparison`, `executor-rich-short-news`, `executor-rich-never` are written, not run.
