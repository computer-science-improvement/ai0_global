# 004: PostSpec, renderers, lint and format skills

**Status:** In progress · **Depends on:** 003

## Why
Posts have to look consistent within a channel: hashtags, links and attribution, whether the image sits above or below the text,
sliders (albums), polls and quizzes. They also must never break Telegram HTML. If an LLM writes raw HTML, the
existing failure modes come straight back (unescaped `<`/`&`, captions that are too long, lost links). So the agent
emits a **structured PostSpec**, and deterministic renderers and a linter own every formatting rule. Skills teach
the agent *when* and *how* to use each format.

## User stories
- **US1 (owner):** I want every post in a channel to follow its editorial card (hashtag vocabulary, link style,
  footer, emoji policy), so that the channel feels like one edited outlet.
- **US2 (agent):** I want rich formats (text, photo with the image above or below, album/slider, poll, quiz, with CTA
  buttons), so that I can choose the best format for each slot.
- **US3 (agent):** I want a lint tool that tells me exactly what is wrong, so that I can fix the post before publishing.
- **US4 (owner):** I want a post that cannot render correctly to never be published.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | `PostSpec` zod schema with these fields: <br>• `format` ∈ {text, photo, album, poll, quiz} (phase 1; `video`, `carousel` and `longread` are reserved in the enum and lint rejects them with `format_not_supported_yet`) <br>• `body: Block[]`, where a block is `{type:'p', text}`, `{type:'list', items[]}`, `{type:'quote', text}` or `{type:'lead', text}` (bold first line) <br>• `media: {url, alt?, credit?}[]`, `placement: 'above'\|'below'` <br>• `hashtags: string[]` <br>• `source?: {url, label?}`, `cta?: {url, label}`, `buttons?: {text,url}[][]` <br>• `poll?: {question, options[], correctIndex?, explanation?, anonymous?}` <br>• `title` (short internal title, used for the digest and analytics) <br>• `origin` ∈ {`external` (based on a fetched or web source), `library` (based on a DB row), `original` (written from scratch)} |
| FR-002 | Inline text in blocks supports a markdown-lite subset: `**bold**`, `_italic_`, `[label](https://url)`, `\|\|spoiler\|\|`. **Everything else is escaped**. The renderer converts it to Telegram HTML. |
| FR-003 | `renderTelegram(spec, card) → TelegramMessage[]`, as a pure function. <br>• **text:** `sendMessage`, HTML. Link previews are disabled unless `media[0]` exists, in which case `link_preview_options={url, prefer_large_media, show_above_text: placement==='above'}`. This gives a large image with up to 4096 characters. <br>• **photo:** if the visible caption is ≤1024 characters, `sendPhoto` with `show_caption_above_media = placement==='below'`; otherwise fall back to text with a large-preview image. <br>• **album:** `sendMediaGroup` with 2–10 photos, caption (≤1024) on the first item. Buttons are not allowed (lint). <br>• **poll/quiz:** an optional `sendMessage` with the body first, then `sendPoll` (`type:'quiz'`, `correct_option_id`, `explanation` ≤200). <br>• Hashtags go on the last line as `#tag #tag`. <br>• Source by `link_style`: `inline` = `<a href>label</a>` at the end of the body; `footer` = a line `Джерело: <a…>`; `button` = an inline-keyboard button. <br>• The footer line is appended before the hashtags. A CTA becomes a URL button. |
| FR-004 | `lintPost(spec, card) → {ok, errors[], warnings[]}`, as a pure function. Errors: <br>• `format_not_allowed` (missing from the card's `formats`), `format_not_supported_yet` <br>• `hashtag_not_in_vocabulary`, `hashtag_count` (not within min..max), `hashtag_format` <br>• `source_required` (when the spec declares `origin:'external'`), `url_invalid` (not http(s)) <br>• `too_long` (per format, after rendering) <br>• `media_count` (album 2–10, photo 1, text 0–1), `album_with_buttons` <br>• `poll_options` (2–10 options, each ≤100 characters), `poll_question` (≤300), `quiz_correct_index`, `quiz_explanation` (≤200) <br>• `banned_term` (from card `banned_terms` plus the global anti-slop list) <br>• `not_ukrainian` (heuristic: share of Cyrillic letters below 0.6 over body text that is not a URL) <br>• `emoji_policy` (`none` means no emoji allowed; `sparse` allows at most 3) <br>• `empty_body` (only text and photo formats need a body) <br>Warnings: `no_media_for_photo_channel`, `lead_missing`. |
| FR-005 | Tools: <br>• `get_channel_card` (read): the card plus a platform capability matrix <br>• `lint_post` (read) <br>• `preview_post` (read): rendered Telegram HTML or text plus lint output <br>• `extract_images(url)` (read): og:image and article images via `ImageResolverService` (SSRF-guarded) |
| FR-006 | `TelegramEditorPublisher.send(messages, channelKey)` maps renderer output to Bot API calls through the channel's bot (`ChannelConfigService.resolveChannel`). It returns the primary message id and respects `publish_paused` (`ChannelPausedError`). It does **not** decide anything; the guarded `publish_post` tool (005) calls it. |
| FR-007 | Skills under `apps/automation/editor-skills/`, one markdown file per skill. Each file has frontmatter (`name`, `description`, `applies_to: [planner\|executor\|reviewer]`) and gives rules plus 1–2 good and bad examples. <br>• Format: `format-hashtags`, `format-links-attribution`, `format-media-placement`, `format-album-slider`, `format-poll-quiz`, `format-buttons-cta`, `format-series`, `format-emoji-typography` <br>• Quality: `fact-check`, `source-licensing` <br>• Voice: `human-voice`, `anti-slop` and `grammar-ua` (copied from `.claude/skills` as the editor source of truth) <br>• Workflow: `editor-executor-workflow`, `editor-planner-workflow`, `editor-reviewer-workflow` |

## Success criteria
- SC-1: Renderer snapshot tests for every format × placement × link_style; escaping tests with `<`, `&` and `"` in body text, URLs and hashtags.
- SC-2: Lint tests: one failing case per error code, plus a green case.
- SC-3: Every skill file parses (the frontmatter test) and is listed by `list_skills`.
