# 009: Strategy retirement

**Status:** T001–T003 DONE (T003 partial: no TikTok mirror); T004–T006 owner-gated · **Depends on:** 005, 006, and at least 7 days of shadow results per channel

## Why
The editor makes the 18 hand-written strategies redundant. Each strategy's *unique capability* becomes a tool or a
skill, then the channel moves to the editor, and then the strategy code is deleted.

## Capability → tool/skill mapping
| Strategy | Becomes |
|---|---|
| ai0-news, ua-news | `fetch_feed` with the card's `sources` (RSS) plus `web_fetch`; skill `channel-ai0-news`/`channel-ua-news` |
| recipes, recipe-carousel | `search_library(recipes)` plus format `carousel` (phase 2: `render_carousel` tool over the existing satori renderer) |
| daily-photo, space | tool `fetch_api('nasa_apod')`, `fetch_api('spaceflight_news')` |
| movies | tool `fetch_api('tmdb_trending')` |
| game-channel | tool `fetch_api('epic_free')`, `fetch_api('steam_deals')` |
| facts, quotes, pdr-quiz, motivation-biography, assets, curated-prompts, ai0-prompts | `search_library(<table>)`; pdr → format `quiz` |
| on-this-day | tool `fetch_api('on_this_day')` plus `search_library(on_this_day)` |
| network-digest, topic-digest | tool `get_network_highlights` plus format `longread`/`text`; planner schedules the slot |

## Tasks
- [x] T001 `fetch_api` tool with a typed adapter registry (move the existing fetchers out of the strategies).
- [x] T002 Phase-2 formats: `carousel` (render tool), `longread` (Telegraph tool), `video`.
- [~] T003 Cross-posting: the Meta/TikTok renderer from PostSpec, and `publish_post` fan-out through the existing `CrossPostService`/`GroupFanoutService`.
  Partial: Meta (Instagram/Facebook/Threads) is mirrored; `renderMeta` also produces TikTok payloads, but nothing sends them,
  because no channel → TikTok account link exists (TikTok is only a `recipe-carousel` binding destination). Adding one is a new
  feature, so it is left for when a channel needs it.
- [ ] T004 Per channel: create the card, run 7 days in shadow, compare the shadow previews against the live strategy output (owner review in 006), switch to live, disable the bindings.
- [ ] T005 Once no binding of a strategy type is enabled for 14 days, delete its module, its tests and its skill duplicates.
- [ ] T006 Collapse the dedup ledgers: `published_posts` becomes the single source, and `posted_news`/`posted` JSONB/`bot_logs`-as-ledger are removed (migration that is non-destructive first: stop writing, then archive).

## Implementation notes (T001–T003, 2026-10-01)

**T001 `fetch_api`.** The endpoint constants and pure response mappers moved from `src/workflows/*/fetchers` to
`src/common/fetchers/apis/*.api.ts`. The legacy fetchers now call them, with the same requests and the same mapping, so the
strategies keep working until T005 deletes them. Adapters live in `src/editor/tools/api-adapters/` (one file per source:
`nasa_apod`, `spaceflight_news`, `tmdb_trending`, `epic_free_games`, `steam_deals`, `gamerpower_giveaways`, `on_this_day`).
`gamerpower_giveaways` is there because game-channel uses it. The game-channel news source is plain RSS, which `fetch_feed`
already covers. Every adapter call goes through `safeGet` (SSRF-guarded) as JSON. Keys come from the env names the strategies
use (`NASA_API_KEY` with the `DEMO_KEY` fallback, `TMDB_API_KEY`) and are redacted from error text. The tool takes a flat input
`{source: enum, params: object}`: a discriminated union would give a top-level `anyOf`, which some OpenAI-compatible providers
reject. Each adapter validates its own zod params. Card sources gain `kind: 'api'`, with `ref` set to the source name.
When T005 deletes the strategies and `src/workflows/*/fetchers`, keep `src/common/fetchers/apis`, because the adapters use it.

**T002 formats.** There is no separate `render_carousel` or Telegraph tool: the model only describes the post. `PostSpec` gains
`slides` (carousel), `longread {title, blocks ≤ 60}` and `media[].kind`. `renderTelegram(spec, card, prepared?)` stays pure.
`publish/prepare-media.ts` (`EditorMediaPreparer`) is the async stage that runs only in a live `publish_post`, after all guards:
- carousel: slide backgrounds come through `safeGetBytes`, slides are rendered by a new generic template
  (`RecipeCarouselRendererService.renderSlides`), hosted with `SlideHostingService`, and deleted after the publish and the mirrors;
- longread: `TelegraphService.createPage`, using nodes from `post/render-telegraph.ts`.

Shadow previews and `preview_post` describe slides and the article as text and upload nothing. Lint adds `slides_count`,
`longread_missing`, `teaser_too_long` (600), `video_url`, `media_kind`, and a ban on buttons for carousels (`album_with_buttons`).
Language, banned-term and emoji checks also cover slides and the article. A failed preparation returns `prepare_failed` and
missing deps return `format_unavailable`; neither is terminal, so the agent can pick another format.
`TelegramEditorPublisher` gains `sendVideo` and refuses a media group with fewer than 2 photos.

**T003 cross-posting.** `post/render-meta.ts` maps PostSpec → plain-text payloads per platform (the rules are in the runbook,
section 8). `publish/editor-crosspost.ts` calls both `CrossPostService.afterPublish`, which serves the channel's
`meta_crosspost_targets` as every Telegram strategy does, and `GroupFanOutService.fanOut` with Telegram as the source, as
ai0-prompts does. Both services gain an optional per-platform `render` callback and now return per-target outcomes. These
changes are additive: legacy callers ignore the return value. Captions are HTML-escaped before the hand-off because the Meta
publishers run `htmlToPlainText`. Mirror failures become `crosspost: <platform>: <reason>` on `editor_slots.error` of the
published slot, never a failed publish. Migration `046_editor_crosspost` adds `editor_channels.crosspost BOOLEAN NOT NULL
DEFAULT true`, wired through the repository, card input and dashboard.
