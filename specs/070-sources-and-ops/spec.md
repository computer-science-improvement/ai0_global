# 070 — Source resilience and ops batch

Status: planned · Builds on 065/066 (reader, `import_list`), 061 (host strikes, ledger anchors), 034 (content kind), 064 (Meta back-off), 037 (story registry) · No migration

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

## Why

Review 4 found the problems below. P2 #5 and #10 are the main ones; the rest are P3 ops items.

**@pdr_dev_channel is dead by configuration.**
- All 866 `pdr_questions` rows are used, and reuse is `never`. Spec 071 adds repeat rounds for that.
- The only text source is one 269,683-char law page on zakon.rada.gov.ua. The site failed 13 of 31 fetches with TLS resets. A reset is not classified (`net/host-failures.ts:116-122`), so it never blocks the host, and every run retries it.
- `import_list` cannot split a single-section page into clauses, so the ПДР cannot become a dataset.
- The DocStore drops a document after 6 h and has no stale copy.
- The quiz channel is treated as `general` (`post/audience-asks.ts:48-51` infers only `news`), which allows 1 poll a week.

**A page 403 blocks a working feed for days.**
- `blocked()` (`host-failures.ts:147-158`) returns any live host row for `use: 'feed'`.
- A feed's own 403 is recorded on the host (`tools/read-tools.ts:237`) and blocks every page of the host.
- Feed 400 and 404 responses are never recorded, so they are retried every day.

**Ops:**
- **Deploy restarts a half-booted container.** `deploy-develop.yml:121` (and `release-prod.yml:146`) runs `docker compose restart automation` right after `up -d`. Node is PID 1 and has no SIGTERM handler until `enableShutdownHooks`, so Docker kills it after 10 s.
- **Meta.** `page_views_total` on one Facebook page returned 400 on all 98 hourly ticks. The 064 back-off needs Graph code 100 or an "unsupported" message. The log line never shows the Graph error.
- **story_repeat false positive.** On 10-26 an explainer that named ChatGPT and Midjourney as examples counted as "the same story" as a post from 10-15. The `strongScore` bypass in `story/story-match.ts:101-103` let it through.

The lead's code map is at `<scratchpad>/r5/map-070-resilience-ops.md`. It has file:line anchors. Where it and this spec differ, this spec wins.

## What

### FR-001 `import_list` splits a page into records

**Input.** `ImportListInput.split_on?: string` (≤ 200 chars, compiled through the existing `pattern()` with flags `iu`). It applies to markdown, html and text documents. With a JSON document it fails with `wrong_args`.

**`list-extract.ts` `splitEntries(doc, re)`:**
- It walks the text line by line and tests the regex on the first 300 chars of each line. That bounds the cost on a 269k text and gives `^` its natural meaning.
- A record runs from a matching line to the next matching line, or to the end of the section it started in. A record never crosses a section, so footer sections never join the last clause.
- Text before the first match is dropped.
- Images, links and code blocks belong to a record by offset.
- The heading is the matching line. The key is group 1 when the pattern has a group.
- `level` is ignored with `split_on` (a note says so).
- Records are capped at `IMPORT_MAX_ROWS`, with a note.

**Refs.** With a key, `list_ref = canonicalUrl(doc.url) + '#' + key`, made unique for repeats as today. It is not `refOf`, which strips numbers.

**New extractors:**
- `split_key` — group 1 (e.g. `14.6`).
- `url_anchor:<prefix>` — `new URL(doc.url)` with the hash cleared, `.href + '#' + prefix + key`. Example: `url_anchor:п.` gives `https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF/print#п.14.6`.
  - The path is percent-encoded, as in the existing ledger rows; the fragment stays raw. The ledger does not percent-decode, so this spelling must match the anchors of 061 (`data/ledger-anchor.ts`).
- `text` — the whole record, newlines kept, trimmed.
- `text_without:<line regex>` — the record minus the matching lines, e.g. the `{Пункт … в редакції …}` notes.
- `context_line:<regex>` — the nearest preceding line that matches, e.g. the section title «14. ОБГІН».

**Dataset defaults.**
- `text` and `text_without` count as content, so the default `required` is `[[text]]`.
- `text` and `body` are searchable in a created dataset.

**Preview.** It shows the number of records, the longest record (in chars) and a sample of repeated keys (e.g. `1.1 ×2`), so the owner sees sign lines colliding with clauses.

**Re-sync.** `split_on` and the mapping are stored in the payload and in `data_imports.options.list_import`, so the weekly re-sync repeats them.

**Owner steps** (runbook § 29). Import the ПДР into `pdr_rules`:
- fields: `clause` (`split_key`), `title` (heading), `text` (`text_without` for the `{…}` notes), `category` (`context_line`), `source_url` (`url_anchor:п.`), `license` (`const:public domain`);
- `post_requires` is `[[text]]`;
- then add the dataset as a library source on the pdr card and allow the `quiz` format.

Library posts carry `library_ref` and `source.url = row.source_url`. The ledger then records both `data://pdr_rules/N` and the anchored clause, and the critic reads the row.

### FR-002 Connection resets and feeds

**Resets** (`net/host-failures.ts`). `classifyTransient(err)` matches:
- the codes `ECONNRESET`, `EPIPE`, `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_SOCKET`, `UND_ERR_CLOSED`;
- or a message matching `socket hang up | disconnected before secure TLS | other side closed`.

What happens on a match:
- It is recorded with the existing reason `timeout`: a 1-hour block, no strike. The pre-flight and source health already treat `timeout` as transient.
- The agent-facing text is its own: «сайт обірвав з'єднання; година паузи…».
- One immediate retry after about 1 s comes before recording.
- It is used by `fetchPageGuarded` and `fetch_feed`.

**Feeds are scoped to feeds:**
- `blocked(host, 'feed')` ignores a host row whose reason is `refused`. dns, tls and timeout rows still block feeds.
- `fetch_feed` records its own failures on the feed key, not the host:
  - 401, 403, 429 and 451 → reason `feed_refused`;
  - 400, 404 and 410 → reason `feed_missing`.
  Both get a flat 24-hour block with no strikes: `nextBlock` treats any reason starting with `feed_` that way. Add both to `HostFailureReason` and `REASON_TEXT`.
- `sources/source-health.ts` `blockOf` (~:102-109) mirrors the new rule: an RSS source is not blocked by a host `refused` row.

**Tests.** The tests that pin the old behaviour change on purpose: `host-failures.test.ts:63-65` and `host-strikes.061.test.ts:66, 83-84`.

### FR-003 A stale copy when the site fails

**What the DocStore keeps** (`docs/doc-store.ts`). Expired documents stay until LRU eviction or `DOC_STALE_MAX_HOURS` (constant, 168).

**Accessors:**
- `get(doc_id)` returns any kept copy within the stale cap. A `doc_id` names one copy, so `read_doc`, `find_in_doc`, `import_list` and the critic keep working after 6 h instead of answering `doc_expired`.
- `fresh(url)` returns only a copy within the TTL. This is the fetch cache.
- `keptByUrl(url)` returns any kept copy.

**`fetchDocument`** serves a fresh hit as today, otherwise fetches.
- When the refetch fails with `host_blocked`, `host_unreachable` or an HTTP 5xx, 401, 403, 429 or 451, and a kept copy exists, it returns `{ doc: kept, cached: true, stale: { reason } }`.
- It never serves a stale copy for 404, 410 or `unsupported_content`, and never when `fresh: true` (re-sync).
- `webFetchAnswer` adds `stale: true`, `fetched_at` and a Ukrainian note: «копія від <дата>; сайт зараз недоступний».

**Critic.** The critic never fetches. Spec 067 captures the texts at tool time, so the critic reads the same copy as the executor.

### FR-004 A quiz channel is a quiz

- **Inference** (`post/audience-asks.ts`). `QUIZ_TOPIC_RE`, with `iu` flags and letter classes, matches:
  - вікторин, квіз, quiz, trivia;
  - «тестов… запитан/питан»;
  - «екзаменаційн… запитан/питан/білет».

  A bare «тест» does not match: тест-драйв and тестування stay out. The order is explicit field > quiz > news > general. Of the 13 real profile topics, only @pdr_dev_channel's matches.
- **Poll cap.** An inferred quiz gets `QUIZ_INFERRED_POLLS_PER_WEEK = 14`. An explicit quiz stays uncapped, as today.
- **Docs and dashboard.** Update the 034 header comment. The dashboard polls placeholder (`ResourceFormatting.tsx` ~:284) shows `resource.audience.pollsPerWeek`.

### FR-005 Ops

- **Deploy.** Delete the `docker compose --profile prod restart automation` line after `up -d` in `.github/workflows/deploy-develop.yml` (~:121) and `release-prod.yml` (~:146).
- **Boot handler** (`apps/automation/src/main.ts`).
  - Before Nest boots, `process.once('SIGTERM' | 'SIGINT', …)` logs «shutdown during boot» and exits with 143.
  - Both listeners are removed right before `app.enableShutdownHooks()`.
- **`init: true`** in `docker-compose.yml` stays an owner action, because the compose files carry the owner's uncommitted changes. Never edit or commit `docker-compose*.yml`.

### FR-006 Meta metrics back off on repeated 400s

`config/meta-insight-backoff.ts`:
- **Counting.** `failed(platform, targetId, metric, err)` counts consecutive 400s per key. It ignores code 190 (expired token, handled elsewhere) and the rate-limit and transient codes 1, 2, 4, 17, 32 and 613.
- **Back-off.** At 3 it sets a 24-hour back-off, re-armed after each further failure (one request a day), and logs a warn once per UTC day.
- **Reset.** `ok(key)` on success resets the count.
- **Unchanged.** The existing 7-day path for "unsupported" answers stays.
- **Error text.** `graphErrorText(err)` gives `status 400 code=<code>/<subcode> <type>: <message>` (token redacted, ≤ 200 chars, with `fbtrace_id`). It is used in the warn and the debug line of `meta-graph.client.ts` `fetchInsights`.

### FR-007 story_repeat needs strong evidence

`story/story-match.ts` `isStoryOverlap`:
- **The bypass.** The `strongScore` bypass (score ≥ 0.8 without the stem share) applies only when one of these is shared:
  - 5 or more entities;
  - a weight-3 name;
  - a person;
  - a number or a date.
- **Evergreen posts.** It never applies when either post is evergreen or an explainer (`isEvergreenPost`, or declared evergreen).
- **Golden set.** It is unchanged; the lead replayed it.

**Tests:**
- the review-4 case: an earlier prompt post naming ChatGPT and Midjourney, and the explainer «Нейромережа і ШІ: в чому різниця» naming both as examples → not a repeat;
- a real repeat with a number still matches.

## Out of scope

- Repeat rounds for datasets (071).
- The manager's prompt cache (069 owns `manager-runner.ts`).
- `extract_images` reading from the DocStore.

## Acceptance

Unit tests with injected HTTP getters and fake clocks; PG tests for the `import_list` Apply of a split page. No network in tests. The code map lists the files and patterns.

- **Split (`docs/testing/pdr-fixture.ts`):**
  - an HTML fixture with a preamble, the section title «1. ЗАГАЛЬНІ ПОЛОЖЕННЯ», clauses 1.1 and 1.6 with `{…}` notes, 1.10 with a dash list, 8.7.3, a sign line without a trailing dot, and footer sections;
  - record count, keys, `list_ref …#14.6`, the `url_anchor` spelling, `text_without`, `context_line`;
  - the last record stops before the footer;
  - a JSON doc with `split_on` errors, the preview notes and the row cap;
  - PG: Apply creates `pdr_rules` with `post_requires [[text]]`, and a re-sync with one amended clause updates 1 row.
- **Resets and feeds:**
  - `socket hang up` → one retry, then a `timeout` row;
  - a page 403 row does not block `fetch_feed`;
  - a feed 403 → `feed_refused` on the feed key, and pages still fetch;
  - a feed 404 → `feed_missing` for 1 day;
  - source health mirrors this.
- **DocStore:**
  - `get` past the TTL still answers;
  - `fresh` does not;
  - the stale cap and LRU still evict;
  - a reset after a first success serves the stale copy with `fetched_at`;
  - 404 and `fresh: true` never serve a stale copy.
- **Quiz:** inferred from the pdr topic; тест-драйв stays general; explicit beats inferred; the inferred cap is 14.
- **Meta:** three 400s with code 10 → the 4th call is skipped and the warn contains `code=10`; 190 is not counted; success resets.
- **Story:** see FR-007. `post/integrity/golden-set.test.ts` stays green.

`npm test` and `npm run build` pass, and so do the dashboard checks.

## Amendments after the builder check

The builder check (2026-10-27) found gaps. These rules override the body.

**A1. Feed strikes (FR-002), lead decision (i).**
- `feed_*` blocks carry no strikes. A dead feed reaches the owner only through source health `failing` (3 or more failed reads in 14 days).
- The 061 owner note no longer covers a feed's own 403. This is accepted.
- Rewrite `host-strikes.061.test.ts:115-125` with a `url` source or a `dns` host row, and list it among the tests that change on purpose.
- Edge case: a root-path feed has `feedKey === host`. Store its feed failures under `${host}/`, so that a `feed_refused` write never replaces a host `refused` row.
- A reset in `fetch_feed` is recorded on the host as `timeout` (like today's feed timeout, `read-tools.ts:253-255`), not on the feed key.

**A2. Doc ids (FR-003).** This replaces "A `doc_id` names one copy".
- A `doc_id` names the latest kept copy of its URL. `docIdOf` hashes the canonical URL, and a refetch replaces the copy under the same id. Do not change `docIdOf`.
- `get(doc_id)` ignores the TTL up to `DOC_STALE_MAX_HOURS` (168), so `read_doc`, `find_in_doc` and `import_list` keep working after 6 h.
- Readers that need the exact copy they were shown (067's critic) hold the text or compare `doc.fetched_at`.
- Keep the names `get` and `urlOf`. Keep `getByUrl(url)` as an alias of `fresh(url)`: `import-list-json.test.ts:184` and `import-list-json.pg.test.ts:106` call it.
- `fresh()` and `keptByUrl()` touch the LRU order, like `get`.
- `webFetchAnswer` returns early for JSON docs through `jsonAnswer` (`doc-fetch.ts:108`). Add the stale flag, `fetched_at` and the note on that path too. `FetchedDoc` gains `stale?: { reason }`.
- Also change `doc-tools.test.ts:95-106`, which expects `doc_expired` 7 h after a 6 h TTL. Keep its tombstone and `urlOf` part, with a doc evicted by LRU or older than 168 h.

**A3. Default `required` with `split_on` (FR-001).**
- With `split_on`, the `heading` extractor does not count as content, because every record has one.
- The default `required` is the fields read by `text` or `text_without`. The owner mapping therefore gives `post_requires [[text]]`, as the acceptance test expects.

**A4. `split_on` details (FR-001).**
- `context_line:` is computed in `splitEntries`' single line walk over the whole `doc.text`, looking at the lines before the record start. Store the value on the entry. Evaluate the regex per line, on the line's first 300 chars, like `split_on`.
- A record ends before a line that matches the mapping's `context_line` pattern, so section titles like «14. ОБГІН» are not swallowed into the previous clause.
- Line regexes for `split_on`, `text_without:` and `context_line:` use the same `iu` flags through `pattern()`. Under `i`, `\p{Lu}` and `[А-Я]` also match lower case, so owner patterns must rely on numbering, not on case. Say this in the tool description.
- With `split_on`, set `plan.level = 0`, skip `entryLevel`, store the level as it is, and keep the re-sync ignoring it.
- `split_key` and `url_anchor` without `split_on` fail with `ExtractError` `wrong_extractor` «needs split_on».
- Add every new extractor name to `EXTRACTORS`, so that the JSON guard (`MARKDOWN_NAMES`) rejects them on JSON docs.
- Row cap: pass `importCaps(env).maxRows` to `buildPlan` on both the preview path (`import-list-tools.ts:69`) and Apply, for example through the `src` argument. Cap split records with a note.
- Shared files with 069: add the new fields at the end of `ImportListInput`, `ImportPayload`, `payloadOf`, `argsOf` and `ListImportOptions` (spread, no reordering). Put the `split_on` and extractor documentation as a separate sentence appended to the end of the tool description.

**A5. Retry timing (FR-002).**
- Export `RESET_RETRY_MS = 1000`, or take a parameter that defaults to 1000, so tests can pass 0. `fetchPageGuarded` and `fetch_feed` have no injectable sleep today.
- Keep `classifyTimeout` unchanged and add `classifyTransient` as a separate function. `host-strikes.061.test.ts:65` stays valid.
- Update the `MemoryHosts` test double (`host-failures.test.ts:10-18`) to the new rule, or test the rule through `PgHostFailures` with a fake pool (the pattern at `:89-107`).

**A6. Quiz placeholder (FR-004).**
- An explicit choice in the unsaved form wins: `quiz` shows «no limit», any other explicit kind shows «1 (default)».
- Only when the select is empty («From the topic») show `resource.audience.pollsPerWeek`: «no limit» for null, and 14 for an inferred quiz.

**A7. Restart removal (FR-005).** Say in the commit and in the runbook why the restart line can go. 40d9a951 added it so that config-only deploys reload the bind-mounted `channels.json`. Config is now `COPY`'d into the image (`Dockerfile:32`), so a config change recreates the container on `up -d`. Only `*.local.json` is gitignored.

**A8. Meta back-off (FR-006).**
- The API is `failed(platform, targetId, metric, err)` and `ok(platform, targetId, metric)`.
- A non-400 failure (5xx, network) leaves the count unchanged.

**A9. Story evidence (FR-007).**
- `isStoryOverlap(o)` only sees numbers and keys. Add the fields it needs to `Overlap`, computed in `entityOverlap` (for example `strong: boolean`), or pass an options argument from `storyMatch`.
- `story.repository.ts:203-204` (registry joins, no posts) uses the strong-evidence rule without the evergreen part.

**A10. Runbook §29.** Add: «after 071 ships, set pdr_rules reuse to "Repeat in rounds" (see §30)».

**Merge order.** 070 merges after 067 and 068, before 069 and 071.
