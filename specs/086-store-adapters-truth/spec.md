# 086 — Store adapters tell the truth

Status: in progress (AI0-257) · P0 hotfix · Builds on 009 (fetch_api adapters), 063 FR-005 (`*_local` times), 061 FR-004 (host strikes) · No migration

> Source: review 5 (`docs/reviews/2026-11-04-agent-review-5.md` §3 #16, #20–#23, §5 «086»; the review lives on `feat/editor-agent`). Built on `develop` (branch `hotfix/079-086`) so it can ship without wave 1.

## Why

The game channels post deadlines that the adapters got wrong.

- **Epic gives the sale window as the giveaway deadline.** `mapEpicFreeGames` (`apps/automation/src/common/fetchers/apis/games.api.ts:33-35`) keeps a game when some offer is free right now, then takes the deadline from the first offer whose end is in the future — of any discount. When Epic lists a sale offer before the free one, the post gets the sale's end. Post 1800 said «до 02.11»; the giveaway ran to 05.11.
- **Upcoming Epic giveaways are dropped.** `upcomingPromotionalOffers` is never read, so the writer cannot say «з 06.11 безкоштовно» and guesses.
- **GamerPower's 23:59 is not a moment.** `end_date` comes as «2026-11-05 23:59:00» with no zone. `kyivLocal` reads a zone-less time as UTC (spec 063), so the post says «06.11, 01:59 (Київ)» — a time no store announced. The store's own end (Epic: 16:00 UTC) is the real one.
- **Steam deals have no end.** `steam_deals` returns no deadline at all, although `featuredcategories` gives `discount_expiration` for every special.
- **Blocked hosts outside the sources are never told.** `noteStruckHosts` writes the owner note only for hosts of the card and playbook sources. The source health report already lists `otherHosts` (blocked hosts the channel's runs hit outside its sources); they get no note.

## What

### FR-001 Epic: the free offer, now and next

A shared helper picks the offer: the one with `start <= now < end && discountSetting.discountPercentage === 0`, across all `promotionalOffers` groups.

- `mapEpicFreeGames` keeps an element only when such an offer exists (as today) and takes `endDate` / `publishedAt` from **that** offer — never from a sale offer or an offer that has not started.
- New `mapEpicUpcomingFreeGames(elements, nowMs)`: elements with an offer in `upcomingPromotionalOffers` where `discountPercentage === 0 && start > now`; the item carries `startDate` and `endDate` of that offer. An element free now is not also listed as upcoming.
- `GameChannelItem` (`workflows/game-channel/types.ts`) gains `startDate?: string`.
- `epic_free_games` returns both lists, free-now first:
  - `extra: { status: 'free_now' | 'upcoming', platform, starts_at, ends_at }` (`starts_at` / `ends_at` are the offer's ISO instants, so `fetch_api` adds `starts_at_local` / `ends_at_local`);
  - `date` = the offer start;
  - `note` (when any upcoming item exists): «status upcoming — гра ще не безкоштовна: пиши «безкоштовно з <starts_at_local>», не «вже можна забрати».»;
  - description: «epic_free_games — роздачі Epic Games Store: зараз безкоштовні (status free_now, до ends_at) і наступні (status upcoming, з starts_at). params: {}».

Tests: a sale offer (50 %) and a free offer (0 %) for the same game, **in both orders** in the array → `ends_at` is the free offer's end; an offer that has not started is not the deadline; upcoming free offers come with `starts_at`, an upcoming sale is not listed, a game free now is not repeated as upcoming.

### FR-002 GamerPower: a 23:59 without a zone is a date; the store's moment wins

- `mapGamerPowerGiveaways`: an `end_date` of the form `YYYY-MM-DD 23:59[:SS]` (space or `T`, no zone) becomes the date `YYYY-MM-DD` in `endDate`. A date alone gets no `*_local` (no time is invented). The «still open» filter keeps the whole day (as today). Other forms are kept as they are; `N/A` stays «no end».
- **The store's own moment wins.** When the result has items whose `platforms` include «Epic Games Store», `gamerpower_giveaways` reads Epic's `freeGamesPromotions` once (best-effort: an Epic failure leaves the GamerPower values) and, for an item whose title contains the title of an Epic game free right now (normalised, ≥ 3 characters), sets `ends_at` to that offer's end instant and `ends_at_source: 'epic'`. Otherwise `ends_at_source: 'gamerpower'`.
- The adapter description says: «ends_at — дата (без часу) або момент магазину (ends_at_source); точний час роздачі в Epic бери з epic_free_games».

Tests: «2026-11-05 23:59:00» → `ends_at: "2026-11-05"` and no `ends_at_local`; «2026-11-05 23:59» and «2026-11-05T23:59:59» too; another time stays; an Epic giveaway gets Epic's instant (and its `ends_at_local`), an Epic read that throws keeps the date; a non-Epic item never triggers the Epic read.

### FR-003 Steam: the deal ends when the discount does

`mapSteamDeal` sets `endDate` from `discount_expiration` (Unix seconds) when it is a positive number; `steam_deals` returns it as `extra.ends_at` (ISO), so `ends_at_local` follows. No expiration → `ends_at: null`. The description mentions `ends_at`.

Tests: `discount_expiration: 1793894400` → `ends_at: "2026-11-05T16:00:00.000Z"` and `ends_at_local` «05.11, 18:00 (Київ)»; missing / 0 → null.

### FR-004 Struck hosts outside the sources get the note too

`SourceHealthService.noteStruckHosts` also checks the hosts of the channel's `otherHosts` (the source health report: blocked hosts its runs hit outside the card and playbook sources). One extra source-health read at most per call (reuse the report when the caller has it).

- A host from the sources keeps today's note.
- A host only in `otherHosts` gets, once per streak (the same `claimNote`):
  - title: «<host> відмовляє нам <N> рази поспіль — агенти <channel> ходять туди поза джерелами»;
  - body: «Сайт <host> заблоковано до <date> (<reason> <code>); блокування 1 → 3 → 7 діб, до його кінця запитів не робимо. Його немає серед джерел каналу: агенти читали його <calls> раз(и) за <days> днів (посилання з новин чи пошуку). Якщо матеріал звідти потрібен — додайте джерело тієї ж теми; якщо ні — нічого робити не треба.»
  - kind `host_struck`, severity `info` (nothing breaks on the channel's own sources), `refType: 'host'`, `refId: '<channel>/<host>'`.
- Owner texts on «ви»: today's playbook line «прибери її з плейбука» becomes «приберіть її з плейбука».

Tests: in `host-strikes.061.test.ts` — a struck host in `otherHosts` only gets the new note (severity info, title, body with the calls), once; a host in both the sources and `otherHosts` gets the source note only; the playbook wording on «ви».

## Not in this spec

- Proxies and probes for blocked hosts (076, `feat/editor-agent`).
- A post-time check that the deadline in the text equals the API's — the critic and the integrity checks read the tool output; 084 makes the critic see it.
