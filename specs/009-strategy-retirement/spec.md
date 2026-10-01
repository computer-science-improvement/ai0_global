# 009: Strategy retirement

**Status:** TODO · **Depends on:** 005, 006, and at least 7 days of shadow results per channel

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
- [ ] T001 `fetch_api` tool with a typed adapter registry (move the existing fetchers out of the strategies).
- [ ] T002 Phase-2 formats: `carousel` (render tool), `longread` (Telegraph tool), `video`.
- [ ] T003 Cross-posting: the Meta/TikTok renderer from PostSpec, and `publish_post` fan-out through the existing `CrossPostService`/`GroupFanoutService`.
- [ ] T004 Per channel: create the card, run 7 days in shadow, compare the shadow previews against the live strategy output (owner review in 006), switch to live, disable the bindings.
- [ ] T005 Once no binding of a strategy type is enabled for 14 days, delete its module, its tests and its skill duplicates.
- [ ] T006 Collapse the dedup ledgers: `published_posts` becomes the single source, and `posted_news`/`posted` JSONB/`bot_logs`-as-ledger are removed (migration that is non-destructive first: stop writing, then archive).
