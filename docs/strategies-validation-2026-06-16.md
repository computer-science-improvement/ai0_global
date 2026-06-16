# Strategy validation report — 2026-06-16

**Method:** code-level dependency analysis + content-table row counts + run-history.
**Caveat:** run-history was read from the **local dev DB** (only 8 seeded bindings; only 4 strategy types ever exercised locally) — treat it as a *positive* signal where present, not a *negative* one where absent. "Working" = code-functional **and** dependencies/data satisfied. Read-only analysis; no strategies were run, no external/AI calls were made.

## Environment keys
- ✅ Set: `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `GROK_API_KEY`, `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- ❌ Empty/absent: `TMDB_API_KEY`, `NASA_API_KEY`, `OPENAI_API_KEY`, `CAROUSEL_BUCKET`, `TIKTOK_CLIENT_KEY`

## Content tables (local DB row counts)
| table | rows |
|---|---|
| recipes | 25 001 |
| facts | 23 139 |
| prompts | 4 933 (prompthero 4 839 · nanobanana 68 · seedance 26) |
| assets | 5 266 |
| on_this_day | 3 214 |
| birthdays | 1 897 |
| pdr_questions | 866 |
| quotes | 523 |
| posted_news | 87 |

## Per-strategy status

| # | Strategy | Source | Status | Reason |
|---|----------|--------|--------|--------|
| 1 | **quotes** | DB `quotes` (523) | ✅ Working | 65 ok runs locally; data present |
| 2 | **facts** | DB `facts` (23 139) | ✅ Working | large pool; simple text post |
| 3 | **recipes** | DB `recipes` (25 001) + Claude | ✅ Working | 13 ok runs; Anthropic set |
| 4 | **pdr-quiz** | DB `pdr_questions` (866) | ✅ Working | 74 ok runs |
| 5 | **assets** | DB `assets` (5 266) + Claude | ✅ Working | data + Anthropic set |
| 6 | **birthday-strategy** | DB `birthdays` (1 897) + Wikipedia + Claude | ✅ Working | data + public API + Anthropic |
| 7 | **curated-prompts** | DB `prompts` non-prompthero (94) | ✅ Working | 94 curated rows (nanobanana/seedance) |
| 8 | **on-this-day** | byabbe API (public) + Claude | ✅ Working | no key needed; 3 214 cached rows |
| 9 | **space-news** | SpaceNews (public) + Claude | ✅ Working | no key needed |
| 10 | **game-channel** | GamerPower/Epic/Steam (public) + Claude | ✅ Working | no key needed |
| 11 | **ai0-news** | RSS feeds + Claude | ✅ Working\* | \*needs feeds configured in `config/sources/ai0-news.json` |
| 12 | **daily-photo** | NASA APOD + Claude | 🟡 Degraded | falls back to `DEMO_KEY` (rate-limited) — set `NASA_API_KEY` |
| 13 | **ua-news** | per-binding RSS + Claude | 🟡 Degraded | needs a feed URL in the binding's `params` |
| 14 | **ai0-prompts** | DB `prompts` (4 839) + scraper + Claude | 🟡 Partial | Telegram works (12 ok); **Instagram binding errors**: "aspect ratio is not supported" + a `$2` param-type error (7 errs on 2026-06-12) |
| 15 | **recipe-carousel** | DB `recipes` + Satori → Supabase → Meta/TikTok | 🟡 Blocked locally | `CAROUSEL_BUCKET` empty (slide hosting fails) + no Meta/TikTok creds locally |
| 16 | **movies** | TMDB API + Claude | ❌ Not working | `TMDB_API_KEY` not set → fetch skipped, no content |

## Summary
- **11 fully working**, **4 degraded/conditional**, **1 not working**.
- To fix **movies**: set `TMDB_API_KEY`.
- To harden **daily-photo**: set `NASA_API_KEY` (avoids `DEMO_KEY` rate limits).
- **ua-news**: ensure each binding's `params` carries its RSS feed URL.
- **recipe-carousel**: set `CAROUSEL_BUCKET` + connect a Meta/TikTok destination.
- **ai0-prompts → Instagram**: two real bugs flagged for a separate fix —
  1. source image not IG-aspect-ratio compliant (IG wants 4:5 … 1.91:1),
  2. a Postgres "could not determine data type of parameter $2" (untyped param) in that publish/dedup path.
