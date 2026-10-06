# 030: New platforms: YouTube (Shorts via the video bridge) and LinkedIn

**Status:** SPEC (future) · **Depends on:** 016 (video bridge), 019 (matrix, `publishPlatformNow`), 020 (orchestrated networks); takes over 019b FR-B4/FR-B5 for YouTube
· **Migration:** `062_youtube_linkedin.sql`
**Owner comments addressed:** #3, #12 (plans/brd-comments-2026-10-06.md)

## Why
The owner wants YouTube and LinkedIn integrations (#3). The landing page should list YouTube once the video
pipeline can feed it (#12). The 019 groundwork exists (`yt_short` in the matrix, `youtube_accounts`, `youtube` in the agents' `Platform` type),
but nothing can connect or publish, and LinkedIn is missing everywhere. Both platforms join as **native resources** of
orchestrated networks: the agent writes a separate post per platform (#1, #6), nothing is mirrored, and they start in
shadow.

## Current state (as-is)
- **Matrix** (`editor/platform/capabilities.ts`): `yt_short` is `implemented: false` (`dailyApiCap: 6`,
  `privateUntilAudit`). No `linkedin` row; `PLATFORMS` (`agent.types.ts`) has no `linkedin`.
- **`ResourcePublisher`:** the `youtube` case throws `not_implemented … 019b`.
- **Migration 051:** `youtube_accounts(channel_id, title, *_token_enc, expires_at, scope, group_id, active)` exists,
  with no OAuth flow, refresh or UI. `editor_ro` correctly cannot read it.
- **`ResourceCatalog`:** lists YouTube rows, but `access()` returns `unknown` ("YouTube — 019b"). LinkedIn is absent.
- **Stats:** `PlatformStatsCollector` handles Meta posts only.
- **Groups page** (BRD 07 §3.3): ports for Telegram, FB, IG and Threads only ("N of 4").
- **Landing** (`routes/index.tsx`): 5 hard-coded icons and the copy "five platforms".
- **Skills:** `platform-youtube.md` says "do not plan YouTube slots". There is no `platform-linkedin`.
- **016** is still a SPEC (`video_library` does not exist), so YouTube cannot go live before it.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `062_youtube_linkedin.sql`.** <br>• `youtube_accounts` gets `handle`, `thumbnail_url`, `subscribers`, `refresh_error`, `refreshed_at`, `public_uploads_ok bool default false` (the owner confirms the Google audit), `landing_visible bool default false` and `updated_at`, plus a partial unique index on `group_id`. <br>• `linkedin_grants(id uuid pk, member_urn unique, member_name, access_token_enc, refresh_token_enc null, expires_at, refresh_expires_at null, scope, refresh_error, timestamps)`: one row per authorizing member. <br>• `linkedin_accounts(id uuid pk, grant_id fk restrict, kind check in (organization, member), urn unique, name, vanity, logo_url, followers, group_id fk set null, active, landing_visible, timestamps)`, plus a partial unique index on `group_id`. <br>• `api_quota_usage(provider, bucket, day, used, cap, pk(provider, bucket, day))`; `day` is the provider's reset day (Pacific for Google). <br>• `platform_posts`: `platform` CHECK gains `linkedin`, and `status` gains `processing`. <br>• `resource_profiles.live_enabled bool default false` (FR-016). <br>• `editor_ro`: SELECT on `api_quota_usage` only, never on token tables. |
| FR-002 | **Platform model.** `PLATFORMS` gains `linkedin` (refs `linkedin:<uuid>` and `youtube:<uuid>` are our row ids). New formats: `li_text`, `li_image`, `li_multi_image`, `li_document` and `li_article`. `yt_short` becomes implemented in T3. The matrix gets the constraint table below and a new `VERIFIED_ON`. |
| FR-003 | **`PlatformPostSpec` additions.** <br>• `video {library_ref, url, duration_s, cover?}`, taken only from a 016 `video_library` item. <br>• `youtube {tags[], made_for_kids=false, synthetic_media}`; `synthetic_media` defaults to the manifest's `contains_generated_footage`. <br>• `document_title` for `li_document`. <br>• `article {url, title, description, thumbnail_url?}` for `li_article`. <br>• Media `alt` doubles as LinkedIn alt text. |
| FR-004 | **Lint.** <br>• **YouTube:** title ≤ 100 characters (recommended ≤ 70) with no `<` or `>`; description ≤ **5000 bytes** (Cyrillic is 2 bytes per letter); tags ≤ 500 characters total; video ≤ 180 s, vertical or square; `library_ref` unused on this resource for 7 days. <br>• **LinkedIn:** commentary ≤ 3000 characters after escaping; `li_multi_image` 2–20 images; `li_document` 2–300 pages; `li_article` needs an https url and a title; 3–5 hashtags recommended. |
| FR-005 | **`renderLinkedIn(spec)`** (pure). <br>• It converts markdown-lite to LinkedIn "little" text, **escaping the reserved characters** (backslash, pipe, `{ } @ [ ] ( ) < > # * _ ~`) except in `#tag` hashtags. No mentions in v1. <br>• `li_document` slides are rendered by the satori/resvg path and assembled into one PDF (a new pure-JS PDF dependency). |
| FR-006 | **YouTube OAuth** (the TikTok pattern from BRD 07 §3.1e). <br>• `GET /api/youtube/oauth/start`: `access_type=offline`, `prompt=consent`, scopes `youtube.upload`, `youtube.readonly` and `yt-analytics.readonly`, and an HMAC `state` with a 10-minute TTL. <br>• The public callback calls `channels.list?mine=true` and upserts by `channel_id`; a re-auth reactivates the row and clears `refresh_error`. It redirects to `/app/connections?section=youtube&youtube=…`, the correct `/app` path. <br>• Tokens use `SecretsService.encrypt` and are never returned. <br>• `YouTubeTokenService` refreshes lazily; `invalid_grant` → `refresh_error`. |
| FR-007 | **Shorts publisher.** <br>• A resumable `videos.insert` streams the 016 MP4 (≤ 19 MB). Snippet: title; description (caption + hashtags, `#Shorts` added if absent); tags; `categoryId` from the profile (default 22); `defaultLanguage=uk`. <br>• Status: `privacyStatus` is `private` unless `public_uploads_ok`; plus `selfDeclaredMadeForKids` and `containsSyntheticMedia`. <br>• The cover goes via `thumbnails.set` only on verified channels. <br>• The row is saved as `processing` with URL `youtube.com/shorts/<id>`. <br>• A job (every 5 minutes, up to 60 minutes) reads `processingDetails` and `uploadStatus`: processed → `published`; rejected or failed → `failed`, plus an owner alert. |
| FR-008 | **Quota-aware scheduling.** <br>• Every Google call is counted in `api_quota_usage`: bucket `uploads` (default cap 100/day) and bucket `units` (cap 10 000). Caps come from env, because quota is per Google project. <br>• The planner sees `remaining_uploads` and never plans more `yt_short` slots than `remaining − 2`. <br>• `publishPlatformNow` refuses with `quota_exhausted`. <br>• A 403 `quotaExceeded` → `rate_limited` until the Pacific midnight reset, and the remaining slots are `skipped`. <br>• Stats may use at most 30 % of `units`. |
| FR-009 | **LinkedIn OAuth.** <br>• One developer app with the **Community Management API**, covering pages and profiles. <br>• Scopes: `openid profile w_member_social w_organization_social r_organization_social rw_organization_admin`, plus `r_member_postAnalytics` if granted. <br>• The callback upserts the grant and lists the pages where the member is ADMINISTRATOR or CONTENT_ADMIN. The owner picks pages and/or the profile, and each pick becomes a `linkedin_accounts` row. <br>• Every call sends `LinkedIn-Version: $LINKEDIN_API_VERSION` and `X-Restli-Protocol-Version: 2.0.0`. <br>• Refresh happens when a refresh token exists; otherwise health turns `token_expiring` 7 days before the 60-day expiry. |
| FR-010 | **LinkedIn publisher** (`POST /rest/posts`, `author` = the account URN, PUBLIC, MAIN_FEED). <br>• `li_text`: commentary. <br>• `li_image` / `li_multi_image`: Images API `initializeUpload` → PUT → AVAILABLE → `content.media` or `content.multiImage` with alt text. <br>• `li_document`: the PDF via the Documents API (poll AVAILABLE for up to 2 minutes) → `content.media {title, id}`. <br>• `li_article`: `content.article {source, title, description, thumbnail}`. The API does not scrape, so the thumbnail is the og:image (via `safeGet`) or the first slide, uploaded as an image. <br>• The id comes from `x-restli-id`; the URL is `linkedin.com/feed/update/<urn>/`. <br>• A stuck asset → `failed`; nothing is half-posted. |
| FR-011 | **Stats** (the existing 3-hour collector; never throws). <br>• **YouTube:** `videos.list` statistics, batched by 50 (views, likes, comments); Analytics API shares and average view duration into `extra`; daily subscribers. <br>• **LinkedIn org:** `organizationalEntityShareStatistics` per post: impressions → views, unique impressions → reach, likes, comments, shares, clicks in `extra`; daily followers. <br>• **LinkedIn member:** collected only with `r_member_postAnalytics`; otherwise null, and agents see "metrics unavailable". |
| FR-012 | **Health** (`ResourceCatalog.access()`). <br>• **YouTube:** `token_invalid` (refresh error); `token_expiring` (a consent screen in "Testing" status kills refresh tokens after 7 days, detected from token age plus `GOOGLE_OAUTH_PUBLISHING_STATUS`); `rate_limited` (quota). <br>• **LinkedIn:** `token_expiring`, `token_invalid`, `no_access` (page role lost → 403 on an ACL re-check), `rate_limited` (429), plus a warning 60 days before the pinned API version sunsets. |
| FR-013 | **Connections UI:** two new providers. <br>• **YouTube:** channels, Connect, Pause, Delete, today's quota, and an "audit passed → public uploads" toggle with confirmation. <br>• **LinkedIn:** grants with their pages and profile, the picker and token expiry. <br>Delete → 409 while future slots exist. |
| FR-014 | **Groups.** <br>• New ports: YouTube, LinkedIn and TikTok (TikTok closes BRD 07 §3.3 open question). The counter becomes "N of M". <br>• YouTube and LinkedIn are **never mirror targets** (`GroupFanOutService` skips them) and never `source_platform`. They publish only in `orchestrated` networks (#1). |
| FR-015 | **Agent platform.** <br>• Catalog and `list_resources` include both platforms; executor tool sets follow the slot's resource. <br>• Playbooks accept the new formats; the MANAGER digest and `add_platform` directives cover both. <br>• New skill `platform-linkedin.md` (executor, planner, orchestrator, idea_reviewer): a 2-line hook before "…see more", document carousels for frameworks, articles for long sources, 3–5 hashtags, page voice vs profile voice, and no engagement bait or corporate slop. <br>• `platform-youtube.md` is rewritten: fresh `video_library` items only, a title formula, the description structure, and respect for `remaining_uploads`. |
| FR-016 | **Shadow-first.** <br>• While `live_enabled=false`, `publishPlatformNow` always takes the shadow branch for that resource, **even when the agent is live**. <br>• After 3 days and ≥ 3 lint-clean shadow posts, `ResourceHealthService` posts an Inbox go-live card; a resource toggle is also available. For YouTube without `public_uploads_ok`, the card warns that uploads stay PRIVATE. |
| FR-017 | **Landing (#12).** <br>• A public `GET /api/public/platforms` returns platforms with an active, `landing_visible` resource; YouTube is listed only after its first published public Short. <br>• The copy reads "One network · N platforms" and "…to every platform, formatted for each". <br>• YouTube and LinkedIn icons are added (YouTube now maps to `globe`). |

## Platform constraints
Verified on 2026-10-06; the implementer re-checks them before T3 and T5.

**YouTube (Data API v3)**

| Item | Value |
|------|-------|
| Upload | `videos.insert`, resumable. Scopes `youtube.upload` (plus `youtube.readonly` and `yt-analytics.readonly` for stats). The API max file size is 256 GB; ours is at most 19 MB (016). |
| Quota | `videos.insert` costs 1 call from its own bucket, **100/day by default**. Other methods share 10 000 units/day (`videos.list` 1, `thumbnails.set` 50). Quota is per Google project and resets at midnight Pacific. |
| Unverified project | Uploads from API projects created after 2020-07-28 are **locked private** until the project passes the YouTube API compliance audit. |
| OAuth | An "External" consent screen in **Testing** status issues refresh tokens that expire after 7 days. Moving it to "In production" with the `youtube.upload` sensitive scope requires Google verification. A single-owner app may use it unverified with the warning screen. |
| Metadata | Title ≤ 100 characters; description ≤ 5000 bytes; tags ≤ 500 characters total; no `<` or `>`. `publishAt` only when private (we publish at slot time instead). `containsSyntheticMedia` is a disclosure flag. |
| Shorts | Vertical or square, ≤ 3 min. Classified automatically; `#Shorts` is a hint only. |

**LinkedIn (Posts API, Community Management)**

| Item | Value |
|------|-------|
| Access | Community Management API is a **vetted** product: the Development tier first (500 requests/app/day, 100/member), then the Standard tier after a screencast review. It must be requested on a fresh app that has no other products. Our single-owner volume fits the Development tier. |
| Scopes | Page: `w_organization_social`, `r_organization_social`, plus `rw_organization_admin` for statistics (ADMINISTRATOR role). Profile: `w_member_social`. Member post analytics `r_member_postAnalytics`. `r_member_social` is closed. |
| Tokens | Access token 60 days. Programmatic refresh tokens (365 days, not extended on refresh) only for approved Marketing partners. Otherwise the owner re-authorizes every 60 days. |
| Versioning | The `LinkedIn-Version: YYYYMM` header is mandatory. Versions sunset after about a year (202510 sunsets 2026-10-15). |
| Content | Organic: text, image, multiImage (2–20), document (PDF/PPT/DOC, ≤ 100 MB, ≤ 300 pages), article (no URL scraping), video, poll. Organic "carousel" is **not** supported; use a document instead. Commentary ≤ 3000 characters in "little" text format with reserved-character escaping. |
| Stats | `organizationalEntityShareStatistics`: per-post lifetime numbers; time-bound numbers only in aggregate; rolling 12 months. |

Sources: developers.google.com/youtube/v3 (videos.insert, determine_quota_cost, videos);
learn.microsoft.com/linkedin (posts-api, multiimage-post-api, documents-api, community-management-overview,
share-statistics, programmatic-refresh-tokens).

## Corner cases
- **YouTube is connected but 016 is not live.** `yt_short` stays unavailable ("no video source"), so the planner never
  plans it.
- **The same short goes to YouTube and TikTok** (019b FR-B5). This is allowed. Dedup is per resource, and each
  platform gets its own native caption.
- **A Cyrillic description of 2600 letters** is about 5200 bytes. Lint fails on the byte count and names the overflow
  in bytes.
- **An upload is accepted but processing is rejected** (a copyright claim or a duplicate). The row goes to `failed`
  and the owner gets one alert. The slot is not retried, and the `video_library` item is marked `used`, so it is not
  re-tried endlessly.
- **The quota runs out mid-day** (another tool shares the project). The 403 → `rate_limited` until reset; no retries.
- **A page admin loses their role.** The ACL re-check returns 403 → `no_access`. The planner stops, and the owner
  reconnects with another admin.
- **The LinkedIn version is sunset.** The health warning appears 60 days ahead. After the sunset, calls fail with
  `426`/`400`, which maps to `token_invalid`-like blocking with the detail "bump LINKEDIN_API_VERSION".
- **The commentary contains `(`, `)` or `[`.** Escaping prevents the silent truncation of the post at the first
  reserved character. A snapshot test covers this.
- **A personal-profile post with no analytics scope.** The post is published and metrics stay null. The KPI digest
  marks it "no metrics", and MANAGER must not judge the resource by zeros.
- **One grant serves several pages.** A token refresh updates the grant once, and every page's health follows it.
  Deleting the grant is refused while pages exist (FK restrict).

## Non-goals
- Long-form YouTube videos, YouTube Community posts, playlists, comment moderation and live streams.
- LinkedIn video, polls, sponsored or dark posts, mentions, newsletters/articles authored on LinkedIn, and LinkedIn
  ads.
- Mirroring Telegram posts to YouTube or LinkedIn.
- Public SaaS onboarding: the apps stay the owner's own (own-network direction).
- Instagram/Facebook Reels and TikTok video. They stay in 019b and reuse T3's video plumbing.

## Success criteria
- **Unit tests:** the matrix and lint tables (byte-length description, tags total, duration, multi-image and document
  bounds); `renderLinkedIn` snapshots including escaping; PDF page count equals slide count; fake-HTTP publishers
  (YouTube upload → processed/rejected; LinkedIn image, multiImage, document, article, a stuck asset); the quota ledger
  and planner cap; token refresh and health transitions; the shadow gate with a live agent and a non-enabled resource.
- **PG tests:** migration 062 (CHECKs, unique group ports, FK restrict); `editor_ro` cannot read token tables;
  `network_posts` shows `linkedin` rows.
- **Eval `platform-native-variants` (extended):** one idea → `li_document`, `th_text` and `yt_short` (fixture
  manifest), all pass lint, similarity < 0.6.
- **Live (owner):** one processed Short (private is fine), one page post per LinkedIn format, metrics within 6 h,
  landing lists platforms from data.

## Open questions for the owner
1. **LinkedIn targets:** company page only, or the personal profile too? *Default: pages first. The profile is
   supported but hidden behind `LINKEDIN_PROFILE_ENABLED=false`.*
2. **Who owns the LinkedIn developer app and the company page** used for the Community Management application?
   LinkedIn requires a verified page and a legal entity. *Default: the owner's own brand page; we prepare the
   screencast for the Standard tier only if the Development tier limits hurt.*
3. **YouTube public uploads:** apply for the Google compliance audit now, or run private and unlisted first?
   *Default: ship private, apply for the audit in parallel, and flip `public_uploads_ok` on approval.*
4. **Google OAuth publishing status:** move the consent screen to "In production" (no 7-day token death; verification
   warning screen)? *Default: yes, unverified, single user.*
5. **Daily caps:** *Default: YouTube 3 Shorts per channel per day (project-wide 100); LinkedIn page 2 per day,
   profile 1 per day.*
6. **Landing:** show YouTube as soon as one Short is processed, even if it is private? *Default: no. Only when a
   public Short exists.*

## Task breakdown

### T1: Extend the platform model and add migration 062
**Scope:** FR-001–FR-004: migration, `linkedin` in `PLATFORMS`, matrix rows, spec fields and lint, `processing`
status, dashboard `Platform` labels and icons.
**Acceptance:** PG migration test green; lint tables cover every new rule; `implementedFormats('linkedin')` is `[]`
until T5; 019 tests stay green.
**Size:** M
**Depends on:** —

### T2: Connect YouTube channels and track their health
**Scope:** FR-006, FR-012 and FR-013 for YouTube: OAuth, `YouTubeTokenService`, channel import, Connections tab.
**Acceptance:** Tests for state HMAC, callback upsert, the `/app/connections?section=youtube` redirect, no tokens in
responses, `invalid_grant` and Testing-mode expiry. A real channel connects.
**Size:** M
**Depends on:** T1

### T3: Publish YouTube Shorts from the video bridge with quota-aware scheduling
**Scope:** FR-007 and FR-008: resumable upload, processing follow-up, quota ledger, planner cap, `video_library`
integration (016 FR-A2); then `yt_short` becomes implemented.
**Acceptance:** Fake-HTTP tests for upload, processing, rejection and `quotaExceeded`; the planner never exceeds
`remaining_uploads − 2`; one real private Short from a manifest item.
**Size:** L
**Depends on:** T2, 016 shipped

### T4: Connect LinkedIn pages and profiles and track their health
**Scope:** FR-009, FR-012 and FR-013 for LinkedIn: `.env.example` entries (`LINKEDIN_CLIENT_ID/SECRET/REDIRECT_URI`,
`LINKEDIN_API_VERSION`), OAuth with grants and the page picker, `LinkedInTokenService`, the versioned client.
**Acceptance:** Tests for ACL listing → picker → rows, refresh with and without a refresh token, 403 → `no_access`,
the version-sunset warning. A real page connects.
**Size:** M
**Depends on:** T1

### T5: Render and publish native LinkedIn posts
**Scope:** FR-005 and FR-010: `renderLinkedIn`, PDF assembly, publisher for all five `li_*` formats.
**Acceptance:** Snapshot, escaping and PDF tests; fake-HTTP tests per format including a stuck asset; one real post
per format in a live smoke run.
**Size:** L
**Depends on:** T4

### T6: Collect YouTube and LinkedIn stats
**Scope:** FR-011: collector branches, daily followers and subscribers, the stats share of the Google quota.
**Acceptance:** Collector tests for normal, partial and error responses; `get_platform_stats` returns the new rows;
YouTube stats stay within 30 % of `units`.
**Size:** M
**Depends on:** T3, T5

### T7: Integrate both platforms into the agent platform, Groups and landing
**Scope:** FR-014–FR-017: Groups ports (YouTube, LinkedIn, TikTok) and the mirror skip; catalog, builder, playbook,
MANAGER digest, directives; `platform-linkedin` skill and `platform-youtube` rewrite; shadow gate and go-live card;
public platforms endpoint and landing copy; extended eval.
**Acceptance:** Fan-out skips both platforms; shadow gate test passes; eval passes; landing count comes from data; the
new skill loads for its 4 roles.
**Size:** M
**Depends on:** T2, T4 (live parts after T3 and T5)
