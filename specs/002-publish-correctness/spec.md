# 002: Publish correctness (legacy strategies)

**Status:** DONE (2026-10-01, branch worktree-agent-a4b0b631c249e8a4b) — migration 043 pending owner apply · **Depends on:** 001

Fixes for strategies that stay live until 009 retires them. Do only the items for strategies still bound to
live channels at execution time.

## Requirements and tasks
- [x] T001 **Runner lock leak:** wrap the generic pipeline in `content-strategy.runner.ts` (fetch → publish) in
  `try/finally`. Release the lock when no publish was recorded. Add a TTL to `PostingThrottleService.tryLock` (10 min). Tests: a throw in fetch must not leave the channel locked.
- [x] T002 **Partial-publish loop:**
  - `telegram.publisher.ts` tier 3 and `publishPrompt`/`publishVideo` treat a failed *reply* after a successful
    photo as success, logging a warning and returning the photo id.
  - Strategies that `markPosted` after publish then mark the item.
  - Tests.
- [x] T003 **HTML escaping:** escape everything that goes into captions:
  - `recipes.buildCaption`, `buildReply`
  - `quotes` (text, author)
  - `game-channel`, `movies`, `ai0-news`, `ua-news` hrefs (escape `"`)
  - Reuse one `escapeHtml`/`escapeAttr` in `src/common/html.ts`. Tests.
- [x] T004 **Poisoned items:** add `markError(id, reason)` (or `posted` with an `error:` value) on validator rejection, SKIP_POST, an empty draft and permanent publish errors:
  - ai0-prompts (dead page/image, TG fail)
  - space, movies, on-this-day, daily-photo, game-channel, motivation-biography, assets
  - Add `ORDER BY` to `prompts.getNext`. Tests per strategy.
- [x] T005 **CrossPostService token:** resolve through `secrets.resolveToken({enc, env})` the same way `DestinationResolver` does. Test.
- [x] T006 **Run status honesty:** custom-execute Telegram errors and cooldown skips are recorded as `error`/`skipped`, not `ok`, in `strategy_runs`.
- [x] T007 **Digests:**
  - Retry-window cron (`*/10 19-20 * * *`) documented in the binding defaults.
  - `timeZone: 'Europe/Kyiv'` on CronJob.
  - Clamp `minItems ≤ maxItems`.
  - Drop unlinkable channels before slicing.
  - Use `strategy_type`-aware title cleanup.
- [x] T008 **ReviewAgent:** check `stop_reason`/finish (a truncated review means keep the draft). Run `cleanFinalText` and `PostValidator` on the review output.
- [x] T009 **Recipes runway:** `countEligible(postedKey)` takes the key instead of hard-coding `'TELEGRAM'`.
- [x] T010 **Scheduled posts:** `published_posts` insert, and no resend of rows stuck in `sending` (mark them `unknown` and alert instead).

Constitution Check: VI. Every fix gets a regression test first.

## Implementation notes

- **T004 mechanism.** Pool tables (prompts, assets, birthdays): `markError(id, postedKey, reason)` writes
  `posted["error:<postedKey>"] = {at, reason}` into the existing `posted` JSONB; every `getNext`/`countEligible`
  excludes that key next to the posted key (no migration; undo with `posted - 'error:<key>'`). The legacy
  `prompts.status = 'ERROR'` filter is kept for existing rows (curated-prompts still uses it). posted_news
  strategies (generic runner path, game-channel): `DedupService.markError()` inserts `content_type = 'error'`
  with the reason in the title; `getLastPostedType` ignores it. `PostValidator` results now carry `permanent`
  (no response / billing / rate limit / overload → transient retry; SKIP_POST / empty / length / refusal /
  meta-commentary → permanent). `generate()` may return `{ rejected }`, which the runner turns into `markError`.
  Permanent Telegram errors = content/media rejections only (`isPermanentTelegramError`); channel-level and
  transient errors are retried.
- **T006.** Cooldown/in-flight refusals throw `RunSkippedError` → `skipped`; escaped custom-execute and generic
  publish errors → `error`.
- **T007.** Scheduler cron zone is `SCHEDULER_TZ || 'Europe/Kyiv'` for **all** bindings (was the process TZ,
  UTC in Docker) — existing schedules now fire in Kyiv time. Digest retry window `*/10 19-20 * * *` is
  `DIGEST_RETRY_SCHEDULE` and the dashboard form's default for both digest types.
- **T010.** Needs migration `043_scheduled_publications_unknown.sql` (adds status `unknown`).
