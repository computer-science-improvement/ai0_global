# 002: Publish correctness (legacy strategies)

**Status:** TODO · **Depends on:** 001

Fixes for strategies that stay live until 009 retires them. Do only the items for strategies still bound to
live channels at execution time.

## Requirements and tasks
- [ ] T001 **Runner lock leak:** wrap the generic pipeline in `content-strategy.runner.ts` (fetch → publish) in
  `try/finally`. Release the lock when no publish was recorded. Add a TTL to `PostingThrottleService.tryLock` (10 min). Tests: a throw in fetch must not leave the channel locked.
- [ ] T002 **Partial-publish loop:**
  - `telegram.publisher.ts` tier 3 and `publishPrompt`/`publishVideo` treat a failed *reply* after a successful
    photo as success, logging a warning and returning the photo id.
  - Strategies that `markPosted` after publish then mark the item.
  - Tests.
- [ ] T003 **HTML escaping:** escape everything that goes into captions:
  - `recipes.buildCaption`, `buildReply`
  - `quotes` (text, author)
  - `game-channel`, `movies`, `ai0-news`, `ua-news` hrefs (escape `"`)
  - Reuse one `escapeHtml`/`escapeAttr` in `src/common/html.ts`. Tests.
- [ ] T004 **Poisoned items:** add `markError(id, reason)` (or `posted` with an `error:` value) on validator rejection, SKIP_POST, an empty draft and permanent publish errors:
  - ai0-prompts (dead page/image, TG fail)
  - space, movies, on-this-day, daily-photo, game-channel, motivation-biography, assets
  - Add `ORDER BY` to `prompts.getNext`. Tests per strategy.
- [ ] T005 **CrossPostService token:** resolve through `secrets.resolveToken({enc, env})` the same way `DestinationResolver` does. Test.
- [ ] T006 **Run status honesty:** custom-execute Telegram errors and cooldown skips are recorded as `error`/`skipped`, not `ok`, in `strategy_runs`.
- [ ] T007 **Digests:**
  - Retry-window cron (`*/10 19-20 * * *`) documented in the binding defaults.
  - `timeZone: 'Europe/Kyiv'` on CronJob.
  - Clamp `minItems ≤ maxItems`.
  - Drop unlinkable channels before slicing.
  - Use `strategy_type`-aware title cleanup.
- [ ] T008 **ReviewAgent:** check `stop_reason`/finish (a truncated review means keep the draft). Run `cleanFinalText` and `PostValidator` on the review output.
- [ ] T009 **Recipes runway:** `countEligible(postedKey)` takes the key instead of hard-coding `'TELEGRAM'`.
- [ ] T010 **Scheduled posts:** `published_posts` insert, and no resend of rows stuck in `sending` (mark them `unknown` and alert instead).

Constitution Check: VI. Every fix gets a regression test first.
