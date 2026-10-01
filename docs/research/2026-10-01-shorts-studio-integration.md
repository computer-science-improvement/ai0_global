# shorts-studio × ai0_global: intersections, integration options and server sizing (2026-10-01)

**Sources:** a read-only study of `~/CS/10-edu/edu-courses/shorts-studio` and of this repo.
**Labels:** **[M]** measured on the owner's Mac · **[C]** read from code · **[E]** estimate.
No renders, servers or paid APIs were run for this study.

## 1. What shorts-studio is

**Three apps:**
- `render/`: Remotion 4.0.382 and React 19, plus about 44 `.mjs` pipeline scripts.
- `backend/`: NestJS 10, TypeORM on MySQL 8.4, LangChain/LangGraph.
- `frontend/`: React 19 + Vite.

**Status [C]:** a local tool for one person. It has no auth, no Dockerfile and no CI. MySQL uses `synchronize:true`, so there
are no migrations.

**Pipelines [C]:** shorts, digest, stats, story, manga, facts, word, promo, motivation. Each runs plan (an LLM writes
`spec.json`), then a human approves, then the build: voice → images and clips → `remotion render`.

**Providers [C]:**
- LLM, images and video clips through OpenRouter. Text models are chosen per role; the editor agent uses `z-ai/glm-5.3-flash`,
  **the same model as ai0's editor**.
- Voice: ElevenLabs.

**The promo agent [C]:**
- Contract in `docs/promo-contract.md`.
- **Inputs:** a brand kit (palette, fonts, logo, facts, CTA, playbook). A chat intake collects the brief and never invents
  numbers.
- **Output:** a `renderer:"promo"` spec with typed segments (type, lockup, counter, cards, checklist, list, endcard, plate),
  in 16:9 or 9:16 at 30 fps, without voice-over.
- **Runtime:** a LangGraph agent with about 55 tools, an approval gate (ask/accept/auto) and 11 `editor-skills/*.md`.

**Publishing [C]:** none. `publish-meta.mjs` writes per-platform captions to `publish.json`; uploading is manual.

**Risk [M]:** about a month of work is uncommitted: about 500 `git status` entries, and `backend/src/editor/` is untracked.
**Commit and push before any integration work.**

## 2. Resource profile

| | shorts-studio | ai0_global |
|---|---|---|
| Steady RAM | backend + MySQL ≈ 0.6–0.9 GB [E] | pg + redis + automation + nginx ≈ 0.6–1.1 GB [E] |
| Peak | **Remotion render 2–3 GB** at `--concurrency=2`: Chromium headless plus webpack bundle [E] | satori/resvg carousel spikes of +100–200 MB [E] |
| CPU | 1080×1920@30: about 4–15 min per 60 s video on 2 dedicated vCPU; the M2 Max is several times faster [E] | low, mostly I/O |
| Disk | Median video 36.9 MB, 6.1 Mbps [M]. 100–125 MB per video including intermediates [E]. `render/public` is 3.1 GB [M] | small: DB plus logs |
| Spend | **median $0.37 per video** (62 ledgers; p75 $0.61, max $2.12) [M]. ElevenLabs Creator ($22) covers about 121k characters/month | about $0.002–0.005 per editor post (evals) [M] |
| Runtime needs | Debian-based image (Chromium), ffmpeg/ffprobe, python3 | `node:20-alpine` |

Known traps:
- `short-build.mjs` does not pass `--public-dir`, so every render copies all 3.1 GB of `render/public` into the bundle.
- Both backends default to port 3001.
- Alpine (ai0) vs Debian (Remotion).

## 3. Intersections

1. **Video as a post format.** ai0's PostSpec already has `format:'video'` with `media[].kind:'video'`, sent with
   `sendVideo` by URL (spec 009). Telegram fetches files by URL only up to **20 MB**, and the median short is about 37 MB,
   so shorts-studio must produce a **delivery copy**: 720×1280 or a higher CRF, about 2.5 Mbps, which gives 10–14 MB per 36 s,
   with `+faststart`.
2. **Distribution.** ai0 has the publishers (Telegram; Meta as text mirror; TikTok photo-carousel only). shorts-studio has
   the per-platform captions. Neither uploads video to Reels, Shorts or TikTok yet, so that is new code on the ai0 side.
3. **Same LLM stack.** Both use OpenRouter and GLM 5.3 Flash. One key can serve both, with shared spend dashboards and shared
   reasoning-effort learnings (see the 2026-10-01 evals: `reasoning.effort=low` cut tokens about 10×).
4. **Same skill pattern.** Both keep markdown skills with frontmatter; the voice and language skills (anti-slop,
   human-voice, grammar-ua ↔ language-rules, brand-voice) can be shared.
5. **Content loops.**
   - ai0 → shorts: the editor's best posts (by views per hour) and its `fetch_api` sources (NASA APOD, on-this-day, TMDB)
     are ready briefs for the facts, digest and stats pipelines.
   - shorts → ai0: every rendered short becomes a video post plus a teaser for the right channel.
6. **Ads (008/015).** The promo agent with brand kits is a natural **upsell**: a "promo video" product for ad clients, sold
   by the deal agent (015) as a package item. This requires `SponsoredCreativeSchema` to allow video.
7. **Hosting.** Use the same Supabase project with a separate `videos` bucket, because the carousel bucket deletes files
   after publishing.

## 4. Integration options (least effort first)

| Option | Effort | ai0 side | shorts-studio side | Risks |
|---|---|---|---|---|
| **A. File/URL handoff**: shorts-studio publishes finished shorts into a bucket plus a manifest; ai0 reads them as a source | 1–3 days | <ul><li>`fetch_api` adapter `shorts_studio` (manifest → items {title, summary, url, image, duration, channel_hint})</li><li>`video_library` table, so each video is used once</li><li>Card source `{kind:'api', ref:'shorts_studio'}`</li></ul> | <ul><li>A post-render step makes the delivery copy (ffmpeg) and uploads it with its cover</li><li>Append to `manifest.json`, with captions taken from `publish.json`</li></ul> | <ul><li>Bucket growth</li><li>The 20 MB limit</li><li>A video used twice (the table prevents it)</li></ul> |
| **B. Job API (pull)**: ai0 asks for a video; a shorts-studio worker polls and fulfils the job | 1–2 weeks | <ul><li>Tool `request_video(brief, channel, kind, budget)`</li><li>`video_jobs` table and an API for workers (token auth)</li><li>The editor slot waits for the asset or falls back to another format</li></ul> | <ul><li>A headless plan → build path with an auto-approve policy and a per-job spend cap</li><li>A durable job store instead of in-memory chains</li><li>A worker that polls ai0, so it works from the Mac behind NAT</li></ul> | <ul><li>Unsupervised spend ($0.37–2 per video)</li><li>Quality without human review → keep shadow previews</li></ul> |
| **C. Shared BullMQ on ai0's Redis** | about 1 week + infra | A queue producer | A consumer | <ul><li>Redis is loopback-only → needs WireGuard/Tailscale or the same box</li><li>Couples the two release cycles</li></ul> |
| **D. Monorepo merge** | weeks | — | <ul><li>MySQL → Postgres with migrations</li><li>A Debian image</li><li>Auth</li></ul> | <ul><li>Big bang</li><li>Render OOM next to the single automation instance</li></ul> |

**Recommendation:**
- **A now.** It brings value immediately, with no new infrastructure, and rendering stays on the Mac.
- **B once A proves demand.** It is the pull model, so the Mac or an on-demand box can be the worker.
- **Don't merge.**

## 5. Server sizing

**Option (i): everything on one VPS [E]**
- **4 vCPU (dedicated preferred), 8 GB RAM, 100–160 GB SSD.**
- Render in its own container: `mem_limit ≈ 3.5g`, `cpus ≈ 2.5`, one render at a time. This keeps a Chromium spike from
  OOM-killing ai0's single automation process, which would mean missed slots and MTProto reconnects.
- Prune intermediates older than N days.
- Price: about $48/month on DigitalOcean (Basic 4/8), about €8–16 on Hetzner (CX32/CPX31).

**Option (ii): split (recommended) [E]**
- **ai0:** the current small droplet, `s-2vcpu-2gb` ($18) or `s-2vcpu-4gb` ($24). Unchanged; ai0 itself needs about 1–1.5 GB
  including n8n.
- **Rendering, phase 1:** the owner's Mac (M2 Max, 32 GB) as the worker, at no extra cost, as long as it is awake.
- **Rendering, phase 2:** an on-demand 4-vCPU box billed by the hour (about $0.05–0.13/h). At 3–10 shorts/day that is under
  1 h of compute per day, roughly $2–10/month.
- **Video storage:**
  - Supabase Free gives only 1 GB with a 50 MB file limit.
  - Supabase Pro: about $25/month for 100 GB.
  - DO Spaces: about $5 for 250 GB.
  - Hetzner Object Storage: about €5/TB.

**The real costs are not servers:**
- per-video API spend: $35–185/month at 3–10 videos/day;
- the ElevenLabs tier: at 10 narrated videos/day, about 135k characters/month, which is above the $22 Creator plan.

## 6. Next steps
1. Commit and push shorts-studio's uncommitted month of work.
2. Spec 016: integration option A (bridge: a delivery copy plus a manifest, and the `shorts_studio` adapter plus
   `video_library` in ai0).
3. Fix `short-build.mjs` to pass `--public-dir`.
4. Decide on the video bucket (Supabase Pro vs DO Spaces).
