# 016: Video bridge: shorts-studio renders become editor video posts (integration option A)

**Status:** SPEC · **Depends on:** 009 (video format, `fetch_api`) · **Research:**
[docs/research/2026-10-01-shorts-studio-integration.md](../../docs/research/2026-10-01-shorts-studio-integration.md)

## Why
shorts-studio produces vertical shorts (median $0.37 and 36.9 MB each) but publishes nothing. ai0 publishes everywhere but
has no video. The cheapest bridge is a **file and manifest handoff**: no shared infrastructure, and rendering stays on the
Mac.

## Contract
**The bucket.** shorts-studio writes to the `ai0-videos` bucket (Supabase Storage, or S3-compatible such as DO Spaces):
```
videos/<slug>/<slug>.delivery.mp4    # 720x1280 (or 1080x1920 at ≤ 2.5 Mbps), h264 + aac, +faststart, ≤ 19 MB
videos/<slug>/cover.jpg              # first strong frame, 720x1280
manifest.json                        # append-only list, newest first
```
**The manifest entry:**
```json
{ "id": "<slug>", "created_at": "...", "pipeline": "facts|digest|stats|promo|...", "lang": "uk",
  "duration_s": 36.2, "size_bytes": 12345678, "url": "https://.../delivery.mp4", "cover": "https://.../cover.jpg",
  "title": "...", "caption_uk": "...", "hashtags": ["..."], "source_urls": ["..."],
  "channel_hint": "@space_daily", "license": "own", "contains_generated_footage": true }
```

## Requirements
**shorts-studio side**

| ID | Requirement |
|----|-------------|
| FR-S1 | A post-render step, `render/scripts/publish/deliver.mjs`, makes the ffmpeg delivery copy and checks it: size ≤ 19 MB, faststart, the duration. It retries at a lower bitrate if the file is too large. |
| FR-S2 | The same step uploads the delivery copy and the cover, then appends to the manifest. The manifest is written atomically (write to a temp file, then rename the object). |
| FR-S3 | `caption_uk` and `hashtags` come from `publish.json`. The step never invents source URLs. |
| FR-S4 | When on-screen labels mark generated "concept" footage, the step sets `contains_generated_footage`. |

**ai0 side**

| ID | Requirement |
|----|-------------|
| FR-A1 | The adapter `src/editor/tools/api-adapters/shorts-studio.ts` (`fetch_api source='shorts_studio'`) reads the manifest URL from `SHORTS_MANIFEST_URL` through `safeGet` (the host is allow-listed). It returns unused items, optionally filtered by `channel_hint`, `pipeline` or a maximum age. |
| FR-A2 | The migration adds `video_library(id text pk, channel_key text, used_at, published_post_id)`. The publish guard dedups on `library_ref = 'library://videos/<id>'`, and `search_library` gets a `videos` table view. |
| FR-A3 | The skill `format-video.md` gets a section on own shorts: <br>• the caption is rewritten for Telegram, not copied verbatim from the TikTok caption <br>• the source is credited when `source_urls` exist <br>• "згенеровані кадри" is noted when `contains_generated_footage` is set |
| FR-A4 | The planner can use `video` slots when the card lists the `shorts_studio` source and the manifest has fresh items. |
| FR-A5 | Cross-posting: Reels, Shorts and TikTok **video** upload is out of scope here; it goes into a later spec. The Meta mirror stays text plus a link, as in 009. |

## Corner cases
- **The manifest is unreachable.** The adapter returns an error, and the agent picks another format.
- **The video URL returns 404 at publish time.** `sendVideo` fails, and the slot fails with a clear error. A HEAD request
  is added to the lint step for video URLs.
- **The file is over 20 MB** (the ffmpeg step was skipped). The lint/HEAD check rejects it, and the reason is shown in
  the trace.
- **The same short fits two channels.** Allowed only if the owner sets `allow_multi_channel`; otherwise the first use wins.

## Success criteria
- Adapter tests use a fixture manifest.
- A dedup test.
- An eval case: a manifest with 2 shorts → the executor makes a video post with the correct URL and a rewritten caption.
- A size guard test.
