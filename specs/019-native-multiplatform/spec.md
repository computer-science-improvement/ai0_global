# 019: Native multi-platform publishing: capability matrix, per-platform variants and executors, platform stats

**Status:** DONE (019b pending 016) · **Depends on:** 009, 017 (019b also needs 016) · **Design:** [../017-agent-platform/design.md](../017-agent-platform/design.md)
· **Migration:** `051_platform_posts.sql`

## Why
Instagram, Facebook and Threads only get **mirrors** of Telegram posts. TikTok is prepared by `renderMeta` but never sent,
because the dispatcher knows only Meta. YouTube is absent. No agent sees non-Telegram stats. Orchestrated networks (020)
need native per-platform posts, decided by agents and validated by code.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Capability matrix** (`platform-capabilities.ts`, pure data plus helpers). Per platform it lists: <br>• supported formats <br>• caption limit, hashtag limit and recommended range, whether links are clickable <br>• media count min/max, aspect ratios, video limits <br>• the API publish limit per 24 h <br>• whether the publisher is implemented <br>Initial rows: <br>• **telegram:** text, photo, album, carousel, poll, quiz, longread, video. <br>• **instagram:** `ig_photo`, `ig_carousel` (2–10), `ig_reel` (019b). Caption 2200, at most 30 hashtags (recommended 3–5), no links. <br>• **facebook:** `fb_text`, `fb_photo`, `fb_album`, `fb_link`, `fb_reel` (019b); links allowed. <br>• **threads:** `th_text`, `th_image`, `th_carousel`; 500 characters; one link. <br>• **tiktok:** `tt_photo` (photo mode, 2–35 images), `tt_video` (019b). <br>• **youtube:** `yt_short` (019b only). <br>All limits sit in one table with a "verified on" date, and the implementer re-checks them against the current platform docs. |
| FR-002 | **`PlatformPostSpec`** (zod; a discriminated union on `platform`), separate from the Telegram `PostSpec`. Shared fields: `caption` (markdown-lite → plain text), `hashtags`, `media[]` (`url`, `kind`, `alt`), `slides[]` (for rendered carousels; the 009 carousel renderer is reused), `link`, `cta`, `source`, `idea_id`, `library_ref`. Per-platform fields: `first_comment` (Instagram), `title` (TikTok, YouTube). Validated against the matrix. |
| FR-003 | **`lintPlatformPost(spec, card, matrix)`**: <br>• caption length after rendering <br>• hashtags: count, normalized, banned terms <br>• links: on a no-link platform → error unless moved to `first_comment` / "link in bio" <br>• media: counts, URL scheme https, a HEAD check for size and type (live only) <br>• format implemented <br>• anti-slop phrases (004) <br>• the verbatim-copy guard (80 characters) |
| FR-004 | **`renderPlatform(spec)`** → `{caption, imageUrls, carousel, extra}`, pure. Carousel slides are rendered by the existing satori/resvg path and hosted through the existing hosting service. |
| FR-005 | **Platform publishers behind one interface** `ResourcePublisher.publish(resourceRef, rendered) → {externalId, url?}`. <br>• **Meta:** wraps the existing Instagram, Facebook and Threads publishers. <br>• **TikTok:** wraps `TikTokCarouselPublisher` in photo mode. This fixes the editor TikTok gap; the mirror path also routes `tiktok` targets to it instead of the Meta dispatcher. <br>• **YouTube:** a stub that throws `not_implemented` until 019b. <br>Token resolution, cooldowns and the posting throttle are reused per resource. |
| FR-006 | **Migration `051_platform_posts.sql`.** <br>• `platform_posts(id bigserial pk, resource_ref text, platform text, external_id text, url text, slot_id uuid null, idea_id uuid null, format text, caption text, spec jsonb, status text check in (published, shadowed, failed), error text, agent_id uuid null, posted_at timestamptz default now(), unique(platform, external_id))`. <br>• `platform_post_metrics(id bigserial, post_id fk cascade, captured_at, views int, reach int, likes int, comments int, shares int, saves int, extra jsonb)`. <br>• `resource_daily_stats(resource_ref text, day date, followers int, followers_delta int, reach int, views int, engagement int, extra jsonb, primary key(resource_ref, day))`. <br>• `youtube_accounts(id uuid pk, channel_id text unique, title, access_token_enc, refresh_token_enc, expires_at, scope, active, created_at)` (token columns encrypted with the existing AES-GCM helper). <br>• The view `network_posts`: a union of the Telegram `published_posts` (with its latest snapshot views) and `platform_posts` (with its latest metrics), exposing `resource_ref, platform, external_id, format, title or caption excerpt, posted_at, views, engagement`. <br>• `editor_ro` gets SELECT on the new tables and the view, but **not** on `youtube_accounts`. |
| FR-007 | **`publishPlatformNow(resourceRef, spec, ctx)`**, the shared live path, mirroring 010's `publishSpecNow`: <br>• lint <br>• `publish_paused` and resource health <br>• dedup: the same `source.url`, `library_ref` or `idea_id` on the same resource within 7 days <br>• the throttle and per-platform 24 h cap from the matrix <br>• render → publish → the `platform_posts` row <br>• In **shadow**: render plus a `platform_posts` row with `status='shadowed'` and a preview for the owner; no API call. |
| FR-008 | **Per-platform executor tools.** `publish_platform_post({resource, spec})` and `lint_platform_post` for the executor role when the slot targets a non-Telegram resource. The slot's resource decides which tool set is offered. Skills: `platform-instagram`, `platform-facebook`, `platform-threads`, `platform-tiktok` and `platform-youtube` (hooks, caption structure, hashtag strategy, link policy, what performs natively), with `applies_to: [executor, planner, ideator, idea_reviewer]`. |
| FR-009 | **Stats collection** (`PlatformStatsCollector`, cron every 3 h). <br>• **Meta:** per-post insights for the last 7 days of `platform_posts` (Instagram: reach, likes, comments, saves, shares; Facebook: reactions, comments, shares, impressions where permitted; Threads: views, likes, replies, reposts), plus account followers daily. <br>• **TikTok:** the post query API for views, likes, comments and shares where the scope allows; followers daily from user info. <br>• **YouTube:** the Analytics API (019b). <br>• **Telegram:** the existing snapshots, plus a daily follower count into `resource_daily_stats`. <br>Errors are recorded per resource and never thrown. Respects the limits in the matrix. |
| FR-010 | **Agent read tools:** `get_platform_stats({resource, days})` and `get_network_posts({network or resource, days})`, built on the view. The existing `get_channel_stats` stays for Telegram. |
| FR-011 | **Resource health** (`ResourceHealthService`, daily plus on demand). States: `ok`, `no_access`, `token_expiring` (under 7 days left), `token_invalid` or `rate_limited`. Each state comes with a detail. <br>• It is stored in the `resource_health` jsonb column in `resource_profiles` (018). <br>• The planner (020) never schedules on a resource that is not `ok`. <br>• A change of state notifies the owner once. |

## 019b: video publishers (after 016)
| ID | Requirement |
|----|-------------|
| FR-B1 | **Instagram Reels:** a container with `media_type=REELS`, `video_url` and caption; poll the container status until finished or an error (with a timeout); then publish. |
| FR-B2 | **Facebook Reels:** the page video reels upload phases (start → upload by `file_url` → finish with description). |
| FR-B3 | **TikTok video:** `PULL_FROM_URL` from a verified domain (the 016 bucket) or a chunked `FILE_UPLOAD`. **Unaudited clients can post only as private (`SELF_ONLY`):** the matrix marks TikTok video `private_only` until the owner confirms the audit, and the planner never counts private posts as reach. |
| FR-B4 | **YouTube Shorts:** OAuth connect flow (the dashboard Connections tab), a resumable `videos.insert` with title, description, tags and `#Shorts` hint, vertical video of at most 3 min. **Unverified API projects upload as private, and the daily quota limits uploads.** The matrix reflects both; the quota usage is tracked per day. |
| FR-B5 | The video sources are the 016 `video_library` items. One video may go to several platforms of the same network (unlike 016's single-channel default), each with its own native caption. |

## Corner cases
- **Instagram without an image** → the executor must produce a carousel or photo. The matrix refuses text-only.
- **A Threads caption over 500** → a lint error that names the overflow, and the agent shortens it.
- **A TikTok photo post where some image URLs are not on a verified domain** → the hosting service re-hosts them to
  the configured domain first. If no domain is configured, the matrix marks `tt_photo` unavailable with a reason.
- **The platform accepts but processing fails later** (an Instagram container error) → the row status becomes
  `failed` with the platform error. No automatic retry, the owner is alerted, and the slot fails.
- **A token expires mid-day** → health flips; the remaining slots of that resource are `skipped` with
  `resource_unavailable`; the owner gets one card.
- **Mirror groups keep working unchanged** until the owner switches a network to `orchestrated` (020).

## Success criteria
- Unit tests:
  - the matrix helpers;
  - `PlatformPostSpec` validation for every platform;
  - lint tables;
  - `renderPlatform` snapshots;
  - `publishPlatformNow` with fake publishers: live, shadow, dedup, cap, paused, unhealthy;
  - mirror TikTok routing;
  - the stats collector with fake API responses: normal, partial, error;
  - health transitions.
- PG tests: the migration and the `network_posts` view.
- Eval: `platform-native-variants`. One idea is turned into Instagram carousel, Threads text and TikTok photo variants
  that pass lint and are not copies of each other (similarity below 0.6).

## Implementation status (2026-10-02)
019 DONE, shadow-safe. **019b is not implemented** because it depends on 016. Backend `src/editor/platform/*`; migration `051_platform_posts.sql`; TikTok joins account groups (`tiktok_accounts.group_id`) and the fan-out routes TikTok members to the TikTok publisher.

**Deviations and limits:**
- Per-post TikTok metrics are not collected; only TikTok followers are.
- The Instagram first comment is best effort.
- `editor_ro` cannot read `youtube_accounts`.

**Tests:**
- unit: `platform.test.ts` and the fan-out and runner tests;
- PG: `platform.pg.test.ts`;
- live eval: `platform-native-variant`.
