# 076 — Sources proven from the server

Status: draft · Builds on 049 (source health, `change_source`), 061 (host strikes, slot pre-flight), 065/070 (DocStore, list import, `split_on`, feed blocks), 039 (settings), 060/068 (series pauses) · Migration 100
Linear AI0-254 · Wave 7, W1: built in parallel with 072 and 073, merged 073 → 072 → 076. Runbook § 36. Mock port 3176.

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

The binding contract is `<scratchpad>/w7/contract.md`. The design is `docs/reviews/2026-10-27-channel-onboarding.md` §6 "076" and §7. Anchors are at `feat/editor-agent` 1ecb8160. The code map, with call sites and traps, is `<scratchpad>/w7/map-076.md`.

## Why

The owner, 2026-10-27:

> «мені потрібно щоб коли я додаю новий канал то це було просто, швидко і зручно, щоб не доводилось 2 тижні дебажити його роботу»

Two stage channels show the source side of those two weeks.

- **@pdr_dev_channel.** zakon.rada.gov.ua (the traffic rules, the next source of its quiz posts) is geoblocked from the server, a DigitalOcean droplet in the US. Every read times out or is reset.
  - `fetchPageGuarded` records a timeout or reset as a one-hour `timeout` block with no strike (`net/host-failures.ts:68-73`, `:266-274`). A host that only times out therefore never reaches `STRIKES_FOR_OWNER` (`:26`), and no note is sent.
  - The pre-flight lets timeout blocks through (`preflight/slot-preflight.ts:242`), so every slot still paid for a run. The owner first saw a chat error.
  - `pdr_rules` was imported by a split script on the owner's machine and a file. Its weekly re-sync cannot work from the server, and the failure is only logged (`docs/list-resync.worker.ts:24-28`).
- **@ai0_prompts_dev.** Its card has no sources; its series reads `library:nanobanana_prompts`.
  - `NetworkHealthService` drops a card with no sources (`health/network-health.service.ts:95`), and `playbookSources` lists only feed series and rule URLs (`sources/playbook-feeds.ts:21-25`).
  - So neither /app/health nor the agent's Sources panel showed that source or its runway. The week in which 8 of 9 slots skipped never showed as a source problem.
- **In general.**
  - Nothing reads a source when it is added, bound to a series or imported. `checkCandidate` (`sources/source-change.ts:78-119`) has one caller (`sources/source-tools.ts:80`), and for a page it reports only the status (`:104-107`).
  - A live slot whose feeds all failed still pays for a run: the $0 skip needs `scan.feedsRead > 0` (`roles/editor-runner.service.ts:448`).
  - `SOURCE_PROPOSALS=off` also silences every `host_struck` note (`editor.module.ts:1595-1597`).
  - `claimNote` is keyed by host only (`sources/source-health.repository.ts:62-65`), so only the first channel on a struck host hears about it.
  - `HTTPS_PROXY` works, but process-wide: it would route model calls too (review §3).

This spec closes **F13** (a source the server cannot reach is never probed; timeouts never become strikes) and **F18** (source health is passive and partial).

## What

### FR-001 Probe a source from the server

New `apps/automation/src/editor/sources/probe.ts`. It is $0 and makes no model call.

```ts
export type ProbeFailureClass = 'timeout' | 'refused' | 'tls' | 'dns' | 'http' | 'empty';
export interface ProbeResult {
  ok: boolean;
  failure_class: ProbeFailureClass | null;  // null when ok
  status: number | null;                    // the last HTTP status; null when nothing answered
  kind: 'rss' | 'page';
  feed_url: string | null;                  // the feed read: the URL itself, or the feed a page names
  items: number;
  newest_at: string | null;                 // ISO
  sample_titles: string[];                  // at most 5, each at most 120 chars
  checked_at: string;                       // ISO
  via_proxy: boolean;
  // additive to the contract's list:
  url: string;                              // canonicalUrl of the address (docs/doc-store.ts:24)
  detail: string;                           // one English line: "24 items, newest 2 h ago" / "timed out twice (10 s)"
  ms: number | null;
  cached: boolean;
  blocked_until: string | null;             // set when a host block answered without a request
}
export interface ProbeOpts {
  kind?: 'rss' | 'url';       // the card's kind; when absent, detected from the answer
  force?: boolean;            // skip the 6 h cache and an active host block
  store?: SourceProbeStore;   // the cache (source_probes); without it nothing is cached
  hosts?: HostFailures;       // block check, record and succeeded; without it neither
  http?: HttpSeams;           // test seams (lookup, get)
  now?: () => Date;
}
export function probeSource(url: string, opts?: ProbeOpts): Promise<ProbeResult>;
/** Wired with PgSourceProbes + PgHostFailures; 077 and the worker use this. */
export function sourceProberOf(pool: Pick<Pool, 'query'>): (url: string, o?: Pick<ProbeOpts, 'kind' | 'force'>) => Promise<ProbeResult>;
```

The probe goes through these steps in order.

1. **Not a probe.** A URL that is not http(s), or one the SSRF guard refuses (`net/ssrf-guard.ts`), returns `ok: false`, `failure_class: 'http'`, `status: null` and a detail. It is not cached and not recorded.
2. **Cache.** Without `force`, a `source_probes` row for the canonical URL checked under `PROBE_CACHE_HOURS = 6` hours ago is returned with `cached: true`.
3. **Active block.** Without `force`, an active block answers without a request: `hosts.blocked(host, kind === 'rss' ? 'feed' : 'page')`, plus the feed key for a feed. `blocked_until` is set and nothing is stored. The class follows the block's reason:
   - `timeout` and `unreachable` → `timeout`; `refused` and `feed_refused` → `refused`;
   - `dns` → `dns`; `tls` → `tls`;
   - `feed_missing` and `feed_too_large` → `http`; `feed_unparseable` → `empty`.
4. **Read.** `safeGet` (`net/safe-http.ts:85`) with `timeoutMs: 10_000` and an Accept header for feeds and HTML. A second try happens only after a timeout or reset (`classifyTimeout`, `classifyTransient`, `net/host-failures.ts:120-142`). DNS and TLS errors come from `classifyFetchError` (`:161-167`).
5. **Classify the answer.**
   - Status 401, 403, 429 or 451 → `refused`; any other status ≥ 400 → `http`.
   - A body that parses as RSS or Atom (the parser of `live/feed-items.ts:49-60`) is `kind: 'rss'`: items, newest date and titles. No items → `empty`.
   - Anything else is `kind: 'page'`, read with `extractPageFull` (`net/extract-page.ts:43`).
     - A `<link rel="alternate" type="application/rss+xml|application/atom+xml">` becomes `feed_url`. That feed is read once, by the same rules, and its items and titles are the result. If it fails, the page result stays OK and the detail names the failure.
     - Without a feed link: `items` = `primary_links` (`extract-page.ts:21`), the titles are the first five section headings, and `newest_at` is the page's `published_at`. Under 200 characters of text → `empty`.
6. **Record.** A timeout or reset after both tries → `hosts.record(host, 'timeout')` (FR-002 escalates). DNS or TLS → `record(host, kind)`. A refusal → `record(host, 'refused', status)`. OK → `hosts.succeeded(host)`. A probe never records a `feed_*` reason.
7. **Store.** The result is upserted into `source_probes` by canonical URL.

New `sources/source-probes.repository.ts`, `PgSourceProbes`, with `get(url)`, `put(result)` and `latest(urls): Map<string, ProbeResult>` (for health and for 072's facts at merge).

`checkCandidate` uses the probe for `rss` and `url` when `CandidateDeps.probe` is wired (`sources/source-wiring.ts:19-35`). A candidate page then gets "24 items, newest 2 h ago" as evidence instead of a bare status. Its error codes do not change.

### Migration 100 — `database/migrations/100_source_reach.sql` (+ `down/100_source_reach.down.sql`)

```sql
CREATE TABLE IF NOT EXISTS source_probes (
  url           TEXT PRIMARY KEY,            -- canonicalUrl of the probed address
  host          TEXT NOT NULL,
  ok            BOOLEAN NOT NULL,
  failure_class TEXT CHECK (failure_class IN ('timeout','refused','tls','dns','http','empty')),
  status        INT,
  kind          TEXT NOT NULL CHECK (kind IN ('rss','page')),
  feed_url      TEXT,
  items         INT NOT NULL DEFAULT 0,
  newest_at     TIMESTAMPTZ,
  sample_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail        TEXT NOT NULL DEFAULT '',
  ms            INT,
  via_proxy     BOOLEAN NOT NULL DEFAULT false,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ok OR failure_class IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_source_probes_host ON source_probes (host, checked_at DESC);
-- F13: timeouts in a row become an `unreachable` strike (FR-002). Existing rows start at 0.
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS consecutive_timeouts INT NOT NULL DEFAULT 0;
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS timeouts_since       TIMESTAMPTZ;
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS last_success_at      TIMESTAMPTZ;
INSERT INTO schema_migrations (version) VALUES ('100_source_reach') ON CONFLICT DO NOTHING;
```

The down file drops `source_probes` and the three columns, sets `reason = 'timeout'` where it is `'unreachable'` (the old code does not know that reason), and deletes the `schema_migrations` row. `reason` has no CHECK constraint (migration 079:43-51), so the new reason needs no constraint change.

### FR-002 Repeated timeouts become an `unreachable` strike

Changes in `net/host-failures.ts`:

- **Types.** `HostFailureReason` (`:30`) gains `'unreachable'`. `PrevBlock` (`:52`) gains `timeouts: number` and `timeoutsSince: Date | null`. `NextBlock` gains `reason`, `timeouts` and `timeoutsSince`.
- **`nextBlock`** (`:63-77`) stays pure. A `timeout` (which also covers a reset that survived its retry) works like this:
  - Inside an active `timeout` or `unreachable` block, it is the same attempt and nothing changes. Inside a longer block of another reason, that block is kept, as today. So three counted timeouts are at least an hour apart.
  - Otherwise the count goes up by one. It restarts at 1 when `timeoutsSince` is null or older than `UNREACHABLE_WINDOW_DAYS = 14`.
  - At `UNREACHABLE_TIMEOUTS = 3` or more, the reason becomes `unreachable` and the strike count goes up by one. The block is `strikeHours(strikes)`: 1 d, then 3 d, then 7 d. The next timeout after it, with no success between, is the next strike.
  - Below 3, it is a one-hour `timeout` block with no strike, as today.
  - `refused`, `dns`, `tls` and `feed_*` keep today's rules and leave the count alone.
- **`record`** (`:209-231`) writes the new columns and stores `next.reason`.
- **`succeeded`** (`:234-236`) loses its `strikes > 0` filter.
  - It sets `strikes = 0`, `noted_at = NULL`, `consecutive_timeouts = 0`, `timeouts_since = NULL` and `last_success_at = now()`.
  - It ends an active `timeout` or `unreachable` block (`blocked_until = now()`); other blocks keep their end.
  - Callers: `fetchPageGuarded` (`:288`), the probe, the guarded live scan (FR-007) and `fetch_feed` on success.
- **`blocked`** (`:194-207`): an `unreachable` row stops pages and feeds alike.
- **`REASON_TEXT`** (`:169-178`) gains `unreachable: 'сайт недоступний із сервера (тайм-аути поспіль)'`.

Effects that need no new code:
- `assessUrl` already rejects every block that is not a `timeout` (`preflight/slot-preflight.ts:240-245`). An `unreachable` host therefore skips at $0 as `preflight_host_blocked`, which is skip class `source_unreachable` (`silent/skip-reasons.ts:89`) and the 060 breaker's cause. Only the comment at `:241` changes.
- `needsReplacement` (`sources/source-health.ts:196-197`) counts an `unreachable` block at once.

### FR-003 A per-host egress proxy, for source fetches only

- **Settings.** Two rows in the Integrations block of `settings/catalog.ts` (`:194-200`), both `apply: 'live'`:
  - `EGRESS_PROXY_URL`: type `secret` (stored encrypted), `http://user:pass@host:port`. Help: "Proxy for reading the sources of the hosts below (sites that block the server's country). Model, Telegram and Meta traffic never use it."
  - `EGRESS_PROXY_HOSTS`: type `list`, default `''`, with the host pattern of `LEDGER_REUSABLE_HOSTS` (`:140`). Help: "Hosts (and their subdomains) read through the proxy above."
- **Choosing the proxy.** `safe-http.ts` gets a pure `egressProxyFor(host, env): AxiosProxyConfig | null`.
  - A host matches when it equals a listed host or is a subdomain of one; `www.` is ignored.
  - `guardedGet` (`:32-58`) passes `proxy` only for a listed host. For any other host `proxy` stays `undefined`, so `HTTPS_PROXY`/`NO_PROXY` keep working (axios 1.20.0 `setProxy` with proxy-from-env). axios tunnels HTTPS through `config.proxy` with CONNECT, so no new dependency is needed.
- **SSRF.** `assertPublicUrl` still runs on the target before each hop. A redirect to an unlisted host goes direct.
- **`via_proxy`.** `SafeGetResult` and `SafeGetBytesResult` (`:7-19`) gain `via_proxy: boolean`. The proxy URL is never returned or logged. A malformed URL means the request goes direct, with one warning per distinct value (without the value).
- **Reach.** Only `safe-http` changes. That covers `web_fetch`, `fetch_feed`, the live scan, the reader, list import, probes, and image and API-adapter reads of a listed host. The LLM clients (`common/ai/*`), Telegram and Meta never call `safe-http`.

### FR-004 When sources are probed

- **Card save.** `EditorOpsService.upsertChannel` (`api/editor-ops.service.ts:149-163`): after `channels.upsert`, each `rss`/`url` source that is new or changed against `existing` is probed in the background (`force`). The response does not change.
- **Series bind.** `ScheduleService.commitSeriesChange` (`schedule/schedule.service.ts:630-644`): a stored series whose `source` is a `feed` with an http ref that is new or changed is probed in the background (`force`).
- **Import preview.** `import_list` (`docs/import-list-tools.ts:68-109`) adds `reach` (a `ProbeResult` summary of `plan.url`, cache first) to the preview. A failed probe, or an uploaded doc (FR-005), adds: "The server cannot re-read this page: re-sync of this dataset is manual (upload the page again)."
- **Launch.** 077 calls `sourceProberOf(pool)` in its worker. 076 changes nothing in launch.
- **`SourceProbeWorker`** (new, `sources/source-probe.worker.ts`), factory-provided in `editor.module.ts`. `@Cron` works on factory instances.
  - **Daily at 05:35 Kyiv.** For each card with mode ≠ off and `editor_channels.created_at` within 14 days, it probes the `rss`/`url` sources of the card and its playbook (`playbookSources`, `playbook-feeds.ts:18-44`): cache first, one at a time, 2 s apart. Then it runs `noteStruckHosts` for every active card (FR-006).
  - **Every 6 hours.** For each open `series_pauses` row with cause `source_unreachable` (migration 093), it force-probes the channel's `rss`/`url` sources whose host has an active block or strikes ≥ 1.
    - A success ends the block (FR-002). 072's `pause_cause_gone` and 074's lift read that end.
    - A failure inside the block is not counted again.
- **Button.** `POST /api/editor/sources/probe` `{ url, kind? }` → a forced probe → `ProbeResult`.

A URL gets at most one live request per 6 hours, except on these forced paths: the owner's button, saves, binds and the 6-hourly re-probe of paused channels. The 10-minute doctor sweep (072) reads probes and never makes one.

### FR-005 Upload the page

For a site the server cannot reach, and with no proxy, the owner saves the page in a browser and uploads it.

```ts
const UploadPageBody = z.object({
  url: z.string().url().max(2000),                     // the page's real address; refs and the ledger use it
  content: z.string().min(1).max(5_000_000),           // the saved page or its text
  content_type: z.enum(['text/html', 'text/plain', 'text/markdown']).default('text/html'),
  dataset: z.string().regex(SCHEMA_KEY_RE).optional(), // re-sync this list-import dataset from the page
});
```

- **Parsing.** `POST /api/editor/sources/upload` parses the page exactly as a fetch does.
  - The parse branch of `fetchLive` (`docs/doc-fetch.ts:86-123`) is extracted into `docFromBody(base, res)`, used by both paths.
  - The doc goes into the shared DocStore (`sharedDocStore`, `docs/doc-store.ts:136`) under `canonicalUrl(url)`, with `origin: 'upload'` (a new optional field of `StoredDoc`, `docs/doc-types.ts:34`).
  - A JSON body is refused with `unsupported_content`; JSON APIs stay on spec 066.
- **Same refs as a live import.** Under the same address, the doc id, `list_ref = <canonical url>#<key>` and the `url_anchor:` values all equal those of a live import. Dedup and the ledger therefore match the rows imported earlier.
- **Lifetime.** `DocStore.fresh` (`doc-store.ts:78-81`) treats an uploaded doc as fresh for `DOC_STALE_MAX_HOURS` (7 d) instead of `DOC_STORE_HOURS`. A restart or the LRU of 100 docs (`:14`) still drops it.
- **Without `dataset`.** The answer is `{ doc_id, url, kind, title, sections, chars }`. The chat's `import_list` takes that `doc_id` as it would after `web_fetch`, and `payloadOf` (`docs/import-list.ts:374`) adds `uploaded: true` when the doc came from an upload.
- **With `dataset`.** The dataset's latest list import (`listImports`, `import-list.ts:513`) must have the same canonical URL; otherwise the answer is 409 `url_mismatch` or 404 `no_list_import`.
  - `resyncDataset` (`:523-529`) gains `{ fromUpload: true }`, which runs `runImport` with `fresh: false`, so `fetchDocument` (`doc-fetch.ts:59-62`) serves the upload.
  - The answer is the `ImportResult`. It is undoable like any import.
- **Re-sync is manual.** `ListImportOptions` (`import-list.ts:431`) gains `uploaded?: boolean`. For an upload, `runImport` (`:451`) stores `uploaded: true, auto_resync: false`.
  - `resyncAll` (`list-resync.worker.ts:16-31`) skips such imports.
  - `resync_import` (`import-list-tools.ts:111-125`) answers `resync_manual: "imported from an uploaded page: upload the page again"`.
  - An Apply whose upload is gone (after a restart) fails with `upload_expired`, not with the geoblock error.
- **`pdr_rules`** (runbook § 29): save `…/print` in the browser, upload it with that URL, then import it with the § 29 mapping. This replaces the local split of 10-27.

### FR-006 Source health covers every source and speaks up

**Coverage.**
- `network-health.service.ts:95` loses `.filter((c) => c.sources.length)`; empty reports are skipped instead.
- A new `playbookSeriesSources(body)` in `playbook-feeds.ts` returns library and api series sources as `CardSource` rows (`id = series:<name>`). `playbookSources` stays as it is. `SourceHealthService.sourcesOf` (`source-health.service.ts:31-35`) appends them with origin `playbook`.
- `SourceHealth` (`source-health.ts`) gains:
  - `probe: ProbeSummary | null`, the latest probe of an `rss`/`url` source;
  - `runway: { unposted: number | null; days: number | null; rounds: boolean } | null` for `library`, from `catalogOverview` (`tools/catalog-context.ts:84-97`). `days` is null for a round dataset.
- The report gains `noSources: boolean` and `proxyConfigured: boolean`.

**Owner notes.** Every note goes through `OwnerInbox.postOnce` with a `NoteGate` (`agents/owner-inbox.ts:116`), with an English title and body for the dashboard inbox and a Ukrainian `alert` for Telegram.
- **`host_struck`, per channel and host.**
  - `noteStruckHosts` (`source-health.service.ts:76-98`) posts with gate subject `host_struck:<channel>/<host>` and parts `[reason, strikes:N]`.
  - `struck()` (`source-health.repository.ts:48-59`) drops its `noted_at IS NULL` filter, and `claimNote` is no longer called. The column stays, and `succeeded` still clears it.
  - An `unreachable` host is noted at its first strike. `refused`, `dns` and `tls` keep `STRIKES_FOR_OWNER = 3`.
  - Title: "<host> cannot be reached from the server". The body gives the timeouts since a date, the block's end, and "Route it through the proxy, upload the page, or remove the source." The alert: «<host> недоступний із сервера … Відкрий джерела каналу: проксі, завантажити сторінку або прибрати.»
- **Independent of the orchestrator.** `SourceProbeWorker`'s daily job runs `noteStruckHosts` for every active card, whatever `SOURCE_PROPOSALS` says (`editor.module.ts:1594-1597`) and whether or not the orchestrator ran. `toReplaceToday` (`:104-122`) no longer calls it.
- **`resync_failed`.** `resyncAll`'s catch (`list-resync.worker.ts:24-28`) posts an `action` note.
  - It has `refType: 'dataset'`, gate subject `resync:<dataset>` and parts `[error class]`.
  - Title: "Re-sync of <dataset> failed". The body gives the error and "Upload the page if the server cannot reach <host>".
  - The worker gets the inbox through `@Optional() @Inject('AGENT_INFRA')`. A string token avoids importing `editor.module.ts`, so there is no cycle.

### FR-007 A slot whose sources are all unreachable skips at $0

- **Feed kinds.** `liveFeeds` (`live/feed-items.ts:171-185`) tags each feed `rss` or `url`. A bare URL is `rss` when it matches `FEEDISH` (`playbook-feeds.ts:13`, now exported).
- **The guarded scan.** `scanLive` (`:190-212`) takes `hosts?: HostFailures`.
  - Before an `rss` read, an active block on the feed key or the host counts the feed as `unreachable`, and no request is made.
  - Timeouts, resets, DNS and TLS errors are recorded as `fetch_feed` records them (`tools/read-tools.ts:261-279`) and count as `unreachable`.
  - A parse error or an HTTP status counts only as `failed`. A read calls `succeeded`.
  - `LiveScan` (`live/live-slot.ts:139-146`) gains `feedsUnreachable` and `pageSources`. `editor.module.ts:1652-1656` passes `PgHostFailures`.
- **The runner gate.** In `roles/editor-runner.service.ts:446-450`, after the existing gate, the slot skips when all of these hold:
  - `scan.feedsRead === 0` and `feedsUnreachable > 0`;
  - `feedsUnreachable === feedsFailed`;
  - `pageSources === 0` and there are no `otherSources`.

  It skips with `skipByCode(slot, preflightSkipError('preflight_host_blocked', 'усі стрічки слота недоступні з сервера: <hosts>'))`, which is class `source_unreachable` at $0. Page sources keep working, because the writer can `web_fetch` them. A scan that throws keeps today's path.
- **News watch.** `news-watch.ts:87-99` reads through the same guarded reader.
- **Pre-flight feed hints.** Today a `feed:<id>` or `rss:<id>` hint makes the whole slot unjudgeable (`:186-188`). In `assess` (`slot-preflight.ts:180-204`), such a hint that resolves to an http card source is now checked for host blocks only, by a new `assessFeed` built on the block check of `:238-245`. `api:` and `network_highlights:` hints stay unjudgeable.

### FR-008 Doctor seam: `sourceFindings`, codes and fixes

New pure `sources/source-findings.ts`. It reads no DB and no network. The lead wraps it into `readiness/checks/sources.ts` at merge.

```ts
export interface SourceFact {                 // 072 FR-012's SourceFact plus two fields the lead fills at merge
  url: string; kind: 'rss' | 'url' | 'library' | 'api'; origin: 'card' | `series:${string}`; host: string | null;
  hostBlock: { reason: string; until: string; strikes: number } | null;
  required?: boolean;                         // a required series' source, or the card's only source
  probe?: ProbeSummary | null;                // PgSourceProbes.latest
}
export interface SourceFindingsInput {
  channelKey: string; agent: string | null; now: Date; createdAt: Date;
  sources: SourceFact[]; proxyConfigured: boolean; uploadedImports: string[];
}
export type SourceFix = { kind: 'source_drop'; channel: string; sourceId: string } | { kind: 'host_proxy_add'; host: string };
export type SourceFinding = Omit<Finding, 'area' | 'fix'> & { area: 'channel'; fix?: SourceFix; link: string }; // Finding: sysadmin/audit.types.ts:33
```

| Code | Severity | When | Fix |
|---|---|---|---|
| `source_probe_failed` | `error` when `required`, else `warn` | the latest probe failed with any class but `empty`, or the host block is `unreachable` | `host_proxy_add` when a proxy is configured and the class is `timeout`/`refused`; else `source_drop` for a card source |
| `source_empty` | `warn` | the probe failed as `empty`, or an `rss` probe's newest item is older than 7 days | `source_drop` (card source) |
| `source_untested` | `info` | an `rss`/`url` source with no probe in 7 days, on a channel created in the last 14 days | — |
| `card_without_sources` | `info` | no card source and no series source: "writes from its brief only" | — |
| `dataset_resync_manual` | `info` | a bound dataset whose latest list import is an upload | — |

- **Links.** Findings link to `/app/agents/:agent?tab=settings`; a dataset finding links to `/app/data/:dataset`.
- **The code name.** `source_unreachable` is already a skip class and a pause cause, so the doctor code is `source_probe_failed`.
- **`sources/codes.ts`** copies `ReasonEntry` verbatim from the contract. It exports `SOURCE_REASONS` and `sourceReason(code)`: the five codes above plus `host_unreachable` and `resync_failed` for the notes, all `kind: 'source'`.
- **Fix endpoints**, in `sources/sources.controller.ts` (`@Controller('api/editor/sources')`, `TrackingAuthGuard`). The lead registers them into the shared fix runner at merge.
  - `POST drop` `{ channel, sourceId }`: upserts the card without that source, through `upsertChannel`'s validation.
  - `POST proxy-host` `{ host, url? }`: 409 `proxy_not_configured` when `EGRESS_PROXY_URL` is empty. Otherwise it calls `SettingsService.setValue('EGRESS_PROXY_HOSTS', …)` (the service is global, `settings/settings.service.ts:207`), force-probes `url`, and returns `{ hosts, probe }`.
  - Neither fix is auto-safe: 076 adds nothing to 072's closed list.

### FR-009 Dashboard

- **The Sources panel** (`components/agents/SourcesSection.tsx`, on the Settings tab: `AgentSettings.tsx:21`).
  - **Probe line** on each `rss`/`url` row: "Server read: OK · 24 items · newest 2 h ago · checked 3 h ago · via proxy", or "Server read: timed out twice · checked 1 h ago". An `unreachable` block shows the danger Badge "Unreachable".
  - **Row buttons.** "Test from server" is always there. A failed probe or an `unreachable` block adds "Route via proxy" (only when `proxyConfigured`), "Upload the page" and, for card sources, "Remove" with a confirm.
  - **Library series rows** show "N rows left · ~D days" or "Repeats in rounds". The Badge is warning under 7 days and danger at 0.
  - **No sources.** The panel shows "No sources: the channel writes from its brief only." Today it renders nothing (`SourcesSection.tsx:48`).
  - **Details.** A row click opens `SourceProbeDialog`: URL, kind, feed, status, items, newest, sample titles, ms, when checked, via proxy.
- **`components/sources/UploadPageDialog.tsx`.**
  - **Inputs.** A URL; a file (.html, .htm, .txt or .md, at most 5 MB, read with `FileReader`) or pasted text; an optional dataset select.
  - **With a dataset**, it shows a toast "N new, M changed" and a link.
  - **Without one**, it offers "Continue in chat" → `/app/chat?q=Import the uploaded page <doc_id> (<url>) with import_list`.
  - **Opened from** a Sources row, and from "Upload page" beside "Import file" in the Data header (`routes/app.data.tsx:29-41`).
- **Health page.** The Sources rows (`components/health/NetworkHealthView.tsx:114-141`) show the same probe line and the "Unreachable" label.
- **API and helpers.**
  - New `api/sources.ts`: `useProbeSource`, `useUploadPage`, `useDropSource`, `useAddProxyHost`.
  - The types in `api/agents.ts:300-320` gain `probe`, `runway`, `origin`, `noSources` and `proxyConfigured`.
  - Pure helpers in `lib/source-probe.ts`: `probeLine`, `probeTone`, `rowFixes`, `runwayLine`.
- **Style.** Classes go in `agent-settings.css` (`ast-`). Badge tones only, no inline colour, and all text English.
- **At merge.** 072's Readiness panel takes in the Sources panel, so the probe line and the buttons move with it.

## Not doing

- A process-wide proxy, or a proxy for model, Telegram or Meta traffic. Buying and configuring a proxy is the owner's choice, and the runbook says how.
- Probing datasets or API adapters in `probeSource`. Datasets get 075's postable count; APIs keep their steps.
- Keeping uploaded pages across restarts, or storing list bodies in `list_imports`. An upload is applied right away or uploaded again.
- An auto-safe fix, a mode change or a pause lift. 074 lifts pauses; 076 only gives it fresh reads.
- Probing on 072's 10-minute sweep, or guessing feed paths (`/feed`, `/rss`). Only `<link rel="alternate">` is used.
- Rewriting skill or rule prose that names an unreachable URL, and a Readiness panel (072).
- Skipping a live slot when the scan itself throws. The cause is unknown; it stays logged.

## Tests

No real network: stubbed `get`/`lookup`, fake `HostFailures`, and the service is never started.

- **Unit** (`apps/automation`, `tsx --test`):
  - `probe.076.test.ts`: rss OK; an empty feed; a page with and without a discovered feed; 403 → refused; 404 → http; two timeouts → timeout; a reset then OK → OK; DNS; TLS; a private address; the cache inside and after 6 h; `force`; a block answered without a request; the `record` and `succeeded` calls.
  - `host-unreachable.076.test.ts`: three timeouts at least 1 h apart → `unreachable`, a 1 d block, the next → 3 d; a timeout inside a block is not counted; a window over 14 d starts over; a refusal keeps the count; the 061 cases are unchanged.
  - `egress.076.test.ts`: `egressProxyFor` for a listed host, a subdomain, `www.`, an unlisted host, a malformed URL and an empty list; `guardedGet` passes `proxy` only for listed hosts; a redirect leaves the proxy; SSRF still refuses private targets; `via_proxy`.
  - `live-unreachable.076.test.ts`: `feedsUnreachable` and `pageSources`; the gate skips with `preflight_host_blocked`, classed `source_unreachable`; a page source or a parse error still runs; a pre-flight `feed:` hint on an unreachable host blocks.
  - `upload.076.test.ts`: `docFromBody` for HTML and text; JSON refused; the upload's doc id and `list_ref` equal a live fetch's of the same body; the `uploaded` marks; the `resyncAll` skip; the `resync_import` answer.
  - Health coverage: a library series row with runway; `noSources`; `NetworkHealthService` keeps a card with no sources.
  - `source-findings.076.test.ts`: every code and fix rule.
  - `codes.076.test.ts`: unique codes, no Cyrillic in `en`, a non-empty `uk`.
- **PG** (`source-reach.076.pg.test.ts`, `EDITOR_PG_TEST_URL`, `createProbeDb(url, 'p076_reach')`): migration 100 up and down; escalation through `record` with a clock; `succeeded` ends an `unreachable` block and resets the counters; the `source_probes` cache; two channels on one struck host each get one note, and a second sweep gets none; the `resync_failed` note.
- **Dashboard:** `lib/source-probe.test.ts`, `no-cyrillic-ui.test.ts` and `tsc`. A mock on port 3176 for a look at the panel, the dialogs and the Health rows.
- **Acceptance replays.** The fixtures are hand-written from the 10-27 stage facts, in `sources/fixtures/onboarding-1027.ts`.
  1. **@pdr_dev_channel.**
     - zakon.rada.gov.ua times out on 3 reads at least 1 h apart; the 3rd is an `unreachable` strike.
     - One owner note goes to @pdr_dev_channel.
     - A planned slot with `…/print#п.14.6` as its hint skips at $0 with `preflight_host_blocked`.
     - `sourceFindings` gives `source_probe_failed`, with `host_proxy_add` when a proxy is set.
     - The upload of the saved print page, with the § 29 mapping, gives the same `list_ref`/`source_url` values as a live import, plus a `dataset_resync_manual` info.
  2. **@ai0_prompts_dev.** A card with no sources and a `library:nanobanana_prompts` series: the report lists the series source with its runway, network health keeps the card, and there is no `card_without_sources` finding.
  3. **@ai0_global, healthy series.**
     - OK probes on its feeds, and its library series with runway, give no `error` and no `warn` finding: no false blocker.
     - The live gate does not skip a slot whose feeds answer.

## Lead calls (answered — see Amendments)

1. **When does an `unreachable` host reach the owner?** Recommended: at its first strike (at least 2 h of failures). Keep `STRIKES_FOR_OWNER = 3` for refusals, so the 061 behaviour and tests do not change. Do not lower it to 2 network-wide (F18 verdict).
2. **What does the proxy cover for a listed host?** Recommended: every `safe-http` request — pages, feeds, images and API adapters — as one rule. LLM, Telegram and Meta never use `safe-http`.
3. **What type is `EGRESS_PROXY_URL`?** Recommended: `secret` (it carries credentials), with `apply: 'live'`.
4. **Should uploaded pages persist?** Recommended: no. They stay in memory for 7 days and are applied right away. Persisting the last good list body in `list_imports` is a follow-up (the F13 verdict's "better still").
5. **Which code does the live all-unreachable skip use?** Recommended: reuse `preflight_host_blocked`. It already maps to `source_unreachable` and the breaker's cause, so no new catalogue, breaker or dashboard code is needed.
6. **Should the probe on card save block the request?** Recommended: no, it runs in the background. The panel shows the result when it lands, and "Test from server" is the synchronous path.
7. **Which channels get the scheduled probe?** Recommended: daily for those with `editor_channels.created_at` in the last 14 days, and every 6 h for every channel with an open `source_unreachable` pause, whatever its age.

## Amendments after the builder check

The lead's decisions of 2026-10-29 (`<scratchpad>/w7/contract.md`, section "Decisions after the drafts") and the builder check of the same day (`<scratchpad>/w7/check-076.md`, 32 items) change this spec. Each check item was verified against the code at `feat/editor-agent` 1ecb8160. These rules override the body. Anchors are at 1ecb8160; `A` = `apps/automation/src/editor/`, `D` = `apps/dashboard/src/`.

### Lead decisions

**L1. Lead calls 1–7 are accepted as recommended.** They are rules now:
- An `unreachable` host is noted at its first strike. `refused`, `dns` and `tls` keep `STRIKES_FOR_OWNER = 3`.
- The proxy covers every `safe-http` request to a listed host: pages, feeds, images and API adapters. LLM, Telegram and Meta traffic never uses it.
- `EGRESS_PROXY_URL` is a `secret` with `apply: 'live'`.
- Uploaded pages are not persisted. They stay in memory for 7 days and are applied right away.
- The live all-unreachable skip reuses `preflight_host_blocked`.
- The probe on card save runs in the background.
- Scheduled probes run daily for channels created in the last 14 days, and every 6 h for every channel with an open `source_unreachable` pause, whatever its age.

**L2. `failure_class: 'invalid'`** (contract, "076 Q1–Q7").
- A malformed URL, or one the SSRF guard refuses, is `invalid`.
- It is not cached, not stored and never recorded as a host failure.
- The TS union gains it. The `source_probes` CHECK does not, because the value is never stored. Details are in A11.

**L3. The probe API** (contract, "076 adds").
- `probeSource(url, opts)` takes `opts: { store?, hosts?, force?, maxAgeMs?, cacheOnly? }`, plus the seams `kind`, `http`, `env` and `now`.
- `sourceProberOf(pool)` is the bound prober, with the cache and the host record. 074 and 077 call it.
- The signatures are in A11.

**L4. Codes.**
- The doctor code is `source_probe_failed`. `source_unreachable` stays the skip class and pause cause, and is never a ReasonEntry code.
- The five finding codes of FR-008 have `kind: 'doctor'`, as 072's doctor codes do: `source_probe_failed`, `source_empty`, `source_untested`, `card_without_sources` and `dataset_resync_manual`.
- The two note codes have `kind: 'source'`: `host_struck` (renamed from `host_unreachable`, A31) and `resync_failed`.
- This replaces "all `kind: 'source'`" in FR-008.

**L5. The all-feeds-unreachable live skip** reuses `preflight_host_blocked`. No new skip code, breaker cause or catalogue entry.

**L6. 072's `SourceFact`.**
- 072 gives `SourceFact` the optional `probe?` and `required?: boolean`. `probe?` is a subset of `ProbeResult`: `ok`, `failure_class`, `items`, `newest_at` and `checked_at`.
- The lead fills both fields from 076's latest probe at merge.
- 076's own copy in `source-findings.ts` declares exactly these two optional fields. `sourceFindings` decides only on those five probe fields and on `SourceFact.kind` (A4).

**L7. Fixes.**
- `source_drop` and `host_proxy_add` join the shared Fix union (`sysadmin/audit.types.ts`) and 072's runner (`sysadmin/fix-runner.ts`) at the lead's 076 merge. In W1, 076 does not edit `audit.types.ts`.
- 076 exports the two appliers in new `A/sources/source-fixes.ts`: `applySourceDrop(deps, fix)` and `applyHostProxyAdd(deps, fix)`.
  - Both return the contract's `FixResult` shape, copied locally: `{ ok: boolean; applied?: string; error?: string }`.
  - The controller calls them.
- Neither fix is auto-safe. 076 adds nothing to the closed auto-safe list.

**L8. The Sources panel stays on the agent's Settings tab.**
- The contract's "Paths and facts corrected" says 072's Readiness panel replaces only ConflictsLine on the Overview, and nothing else moves.
- So FR-009's "At merge. 072's Readiness panel takes in the Sources panel…" is void.
- The probe line and the row buttons stay in `SourceRow` on Settings.

**L9. 074's auto-resume reads 076's rows.**
- For a `source_unreachable` pause, "clean" means that `blocked_until` has passed **and** `source_host_failures.last_success_at` is newer than the pause.
- So every success writes `last_success_at`: a page, a feed or a probe, on the host row and, for a feed, also on the feed-key row (A2, A8).
- The 6-hourly job (A18) supplies those reads for paused channels.

**L10. W1 isolation and merge.**
- No 076 file imports `readiness/` (072) or `reasons/` (073).
- `sources/codes.ts` copies `ReasonEntry` verbatim. The lead swaps the copy for 073's import and appends `SOURCE_REASONS` to `REASONS`.
- 076 uses neither of 073's `CONFIG_FAILURE_CODES` and `isConfigCode`: its skips are `source_unreachable`, never `config`.
- 076 merges last in W1 (073 → 072 → 076). The lead resolves the shared lines:
  - `editor.module.ts`, `slot-preflight.ts` and `editor-runner.service.ts`;
  - `schedule.service.ts`, after 073;
  - `editor-ops.service.ts`, after 072's recheck after saves;
  - `settings/catalog.ts`, the runbook and the README.

**L11. Contract rules that bind here unchanged.**
- 076 code never changes a mode and never lifts a pause.
- Dashboard text is English, and the no-Cyrillic test enforces it. Owner-bot and Telegram texts are Ukrainian.
- Tests use fakes and the scratch Postgres. They never start the service, publish or make a paid call.
- Migration 100, runbook § 36, mock port 3176, Linear AI0-254.

### Builder check

**A1. `needsReplacement` and the first `unreachable` strike** (item 1, accepted; the body's fact was wrong).
- `needsReplacement` (`A/sources/source-health.ts:196-197`) needs `failures >= 2 || strikes >= 2 || errors >= 3`.
- A first `unreachable` strike has strikes 1 and failures 1. The counted timeout comes after the previous 1 h block expired, and `record` then resets `failures` to 1 (`A/net/host-failures.ts:226`).
- Add `|| h.blocked?.reason === 'unreachable'` inside the `blocked` branch.
- Delete the body's "`needsReplacement` … counts an `unreachable` block at once" from "Effects that need no new code". The `assessUrl` bullet stays true; only its comment at `slot-preflight.ts:241` changes.
- Test in `sources/sources.049.test.ts`:
  - a first-strike `unreachable` block → true;
  - a first-strike `refused` block with failures 1 and no errors → false, as today.

**A2. `succeeded` knows what worked** (item 2, accepted).
- **Signatures.**
  - `PgHostFailures.succeeded(host: string, use: 'page' | 'feed' = 'page'): Promise<void>`.
  - The interface becomes `HostFailures.succeeded?(host: string, use?: 'page' | 'feed')`.
- **One UPDATE, no SELECT.** `$2` is `this.now()` (A8):
  ```sql
  UPDATE source_host_failures SET
    consecutive_timeouts = 0, timeouts_since = NULL, last_success_at = $2,
    strikes  = CASE WHEN $3 = 'page' OR reason IN ('timeout','unreachable') THEN 0    ELSE strikes  END,
    noted_at = CASE WHEN $3 = 'page' OR reason IN ('timeout','unreachable') THEN NULL ELSE noted_at END,
    blocked_until = CASE WHEN reason IN ('timeout','unreachable') AND blocked_until > $2 THEN $2 ELSE blocked_until END
  WHERE host = $1
  ```
- **A page success** does everything the body says.
- **A feed success:**
  - clears the timeout counters, writes `last_success_at` and ends an active `timeout`/`unreachable` block;
  - resets `strikes`/`noted_at` only of a `timeout`/`unreachable` streak. A `refused`, `dns` or `tls` streak keeps both, so a working feed never wipes the page refusals of its host.
- **Callers:**
  - `fetchPageGuarded` (`:288`) → `'page'` (the default);
  - a `url` probe → `'page'`;
  - `fetch_feed` success, `readFeedGuarded` success (A19) and an `rss` probe → `'feed'`, for the host and the feed key (A8).
- **PG cases:**
  - a feed success keeps a `refused` streak's strikes 2 and its `noted_at`;
  - a feed success ends an `unreachable` block and writes `last_success_at`;
  - a page success resets everything.

**A3. `SourceProbeWorker` is an `@Injectable` class** (item 3, accepted; the body's fact was wrong).
- **Why.** No `@Cron` runs on a factory instance in this repo. The scheduled workers are `@Injectable()` classes listed in `EDITOR_PROVIDERS` (`A/editor.module.ts:2490-2500`):
  - `EditorCron`, `SkillProbeWorker` and `AuditWorker` (`A/editor.module.ts:660-760`);
  - `ListResyncWorker` (`A/docs/list-resync.worker.ts:33-52`).
- **The class.** `A/sources/source-probe.worker.ts` exports `@Injectable() class SourceProbeWorker`.
  - Its constructor is `(@Inject(DB_POOL) pool: Pool, @Inject(ConfigService) config: ConfigService, @Optional() @Inject('AGENT_INFRA') infra?: { inbox: OwnerInbox })`.
  - The string token avoids importing `editor.module.ts` at run time (a type-only import is fine).
  - It builds `EditorChannelsRepository`, `PgSourceProbes`, `PgHostFailures` and `sourceHealthOf(...)` itself.
  - It is appended to `EDITOR_PROVIDERS` before `EditorCron`.
- **Two methods:**
  - `@Cron('35 5 * * *', { name: 'source-probe-daily', timeZone: 'Europe/Kyiv' })`;
  - `@Cron('35 */6 * * *', { name: 'source-probe-paused', timeZone: 'Europe/Kyiv' })`.
  - Both return at once unless `EDITOR_ENABLED === 'true'`, and both catch and log every error.
  - The logic lives in exported `dailyProbe(deps)` and `pausedReprobe(deps)`, so tests call them with fakes.
- **The agent id for `noteStruckHosts`.**
  - `SELECT id FROM agents WHERE parent_id IS NULL AND kind = 'orchestrator' AND scope = 'resource' AND scope_id = $1 LIMIT 1`, with `telegram:<channelKey>`; null when there is none.
  - This is the query of `A/health/network-health.service.ts:70-74`, returning the id.
- **Module test.** `editor.module.test.ts` needs no new stub: `DB_POOL`, `ConfigService` and `AGENT_INFRA` already resolve.

**A4. `SourceFinding`** (item 4, accepted; the body's fact was wrong).
- **The type.** `AUDIT_AREAS` (`A/sysadmin/audit.types.ts:7`) has no `'channel'`, and extending it is 072's job. `source-findings.ts` declares its own type and does not edit `audit.types.ts`:
  ```ts
  export type SourceFinding = Omit<Finding, 'area' | 'fix'> & { area: 'channel'; fix?: SourceFix; link: string };
  ```
- **Fields:**
  - `check` = the code.
  - `key` = `findingKey('channel', code, subject)`. `A/sysadmin/audit-text.ts:36` accepts a string area.
  - `subject` = `{ type: 'channel', id: \`${channelKey}|${url ?? dataset ?? ''}\`, label: host ?? url ?? dataset ?? channelKey, agent: agent ?? undefined, channel: channelKey }`. `'channel'` is a `SUBJECT_TYPES` value (`:11`). `card_without_sources` uses `id = channelKey`.
  - `title` (English):
    - `source_probe_failed` "<label>: the server cannot read this source";
    - `source_empty` "<label>: empty or not a feed";
    - `source_untested` "<label>: not read from the server yet";
    - `card_without_sources` "No sources: <channelKey> writes from its brief only";
    - `dataset_resync_manual` "<dataset>: re-sync is manual (uploaded page)".
  - `detail` is one English line: `probe.detail` when present; else the block line "blocked until <YYYY-MM-DD HH:MM> UTC (<reason>, <strikes> in a row)"; else the code's `en`.
  - `evidence` = `{ url, kind, origin, failure_class, items, newest_at, checked_at, block }`.
  - `link`:
    - `/app/agents/<agent>?tab=settings`, or `/app/editor/<channelKey>` when `agent` is null;
    - `dataset_resync_manual` links to `/app/data/<dataset>`.
- **Decision rules:**
  - Decisions read only the five probe fields of L6.
  - A probe whose `checked_at` is older than 7 days counts as no probe.
  - `uploadedImports` holds the dataset keys already bound to the channel (the facts loader filters them). Each key gives one info finding.
- Record "`area: 'channel'` declared locally" in Deltas.

**A5. Optional `PrevBlock` fields** (item 5, accepted).
- `PrevBlock` becomes `{ reason; blockedUntil; strikes; timeouts?: number; timeoutsSince?: Date | null; lastAt?: Date | null }`. The new fields are read as 0 / null when absent.
- `NextBlock` gains `reason: HostFailureReason; timeouts: number; timeoutsSince: Date | null`. These fields are additive: the 061 tests only read `strikes`/`until`/`keep`.
- `RulesHosts` (`A/net/host-failures.test.ts:29-50`) and the `PrevBlock` literals of `host-strikes.061.test.ts:29-60` stay untouched.
- Every escalation case goes in `host-unreachable.076.test.ts` (pure) and the PG test (through `record`).

**A6. A timeout inside an active block** (item 6, accepted). This replaces "nothing changes":
- **Inside an active block whose reason is `timeout` or `unreachable`:**
  - `timeouts`, `timeoutsSince` and `strikes` do not change;
  - `reason` = `prev.reason`;
  - `until` = max(`prev.until`, now + 1 h);
  - `keep` = (`prev.reason === 'unreachable'`).
- **Inside an active block of another reason that ends more than 1 h from now:** the block is kept as today (`keep: true`, `until` unchanged), and the count does not change.
- **Otherwise:** the count rule of A7.
- `host-strikes.061.test.ts:51-52` (T0+0.25 → T0+1.25) stays green, and an `unreachable` strike is never downgraded to `timeout`.
- Three cases in `host-unreachable.076.test.ts`:
  - a timeout in a timeout block;
  - a timeout in an `unreachable` block with 30 min left: it stays `unreachable` and now ends at now + 1 h;
  - a timeout in a 3 d `refused` block.

**A7. A sliding 14-day window** (item 7, accepted).
- The count restarts at 1 only when `PrevBlock.lastAt` is null or older than `UNREACHABLE_WINDOW_DAYS = 14`. `lastAt` is the row's `last_at`, which `record` reads as well.
- `timeoutsSince` is kept only as the start of the streak, for the note text.
- `strikes` is never reset by the window, only by `succeeded`.
- `last_at` is the last failure of any reason, so a refusal in between keeps a timeout count alive. That is harmless.
- Day-18 case: a host that always times out has strikes on days 0, 1, 4 and 11. The first request on day 18 is strike 5 (7 d), not a plain 1 h block.

**A8. The clock and the feed-key rows** (item 8, accepted).
- **(a) The clock.** `succeeded` passes `this.now()` as `$2` and never uses SQL `now()`, as `record` does at `:210`.
- **(b) The feed key.** `fetch_feed` records each network failure on the host and on the feed key (`A/tools/read-tools.ts:261-280`). So `fetch_feed`, `readFeedGuarded` and an `rss` probe call `succeeded` for the host **and** for `feedKey(url)` after a good read.
- PG case "feed key recovers after a good read":
  - the key row reaches `unreachable` through three timeouts;
  - one good read ends it;
  - `blocked(key, 'feed')` is then null.

**A9. Host notes through the note gate** (item 9, accepted, with a simpler legacy rule).
- **Parts.** `parts = [reason, \`strikes:${N}\`, \`since:${stamp}\`]`.
  - `stamp` is `last_success_at` as `YYYYMMDDTHHMM` UTC, or `never`. The value has no colon, so note-gate's `NUMERIC_PART` (`A/agents/note-gate.ts:70`) does not read it as a number.
  - A success starts a new streak, which is a new part and so a new note at once, as in 061.
  - `strikes` uses the default grow step.
- **Legacy hosts.** `struck()` keeps its `noted_at IS NULL` filter (`A/sources/source-health.repository.ts:53`). This replaces the body's "`struck()` drops its `noted_at IS NULL` filter".
  - The new code never sets `noted_at`: `claimNote` is no longer called, though the method and the column stay. `succeeded` clears the column.
  - So a host that the 061 code already told the owner about stays quiet until a success.
  - The "struck / claimNote" PG test (`host-strikes.061.pg.test.ts:99-122`) stays green and unchanged.
- **Behaviour change**, recorded in Deltas: a running streak is now repeated as "still …" after `OWNER_NOTE_REPEAT_DAYS` (3 d), and demoted to info after `DEMOTE_AFTER` (3) notes with no owner action. 061 told the owner once per streak.
- **Tests that change** (Deltas):
  - `host-strikes.061.test.ts:219-262`:
    - the fake inbox gains `postOnce`;
    - the Ukrainian title assertions move to `alert.title`;
    - "claimed once" becomes "gated once".
  - `host-strikes.061.pg.test.ts:123-158`:
    - it uses a real `OwnerInbox(pool)` or a `postOnce` fake;
    - from T7 on, it calls `noteStruckHosts` directly;
    - "the next streak is noted again" becomes "a success gives a new `since:` part and a new note".

**A10. Thresholds and copy** (item 10, accepted).
- `struck(keys, min)` is called with `min = 1`. It also returns `consecutive_timeouts`, `timeouts_since` and `last_success_at`.
- The service keeps a row when `reason === 'unreachable' || strikes >= STRIKES_FOR_OWNER`.
- A code comment says that the row's **last** reason decides: an `unreachable` streak that turns into a refusal at strike 2 waits for strike 3.
- The note texts per reason are in A31.

**A11. Contract names in `probe.ts`** (item 11, accepted).
- **Types:**
  ```ts
  export type ProbeFailureClass = 'timeout' | 'refused' | 'tls' | 'dns' | 'http' | 'empty' | 'invalid';
  export interface ProbeOpts {
    kind?: 'rss' | 'url';
    force?: boolean;
    maxAgeMs?: number;                        // the cache age that counts; default PROBE_CACHE_HOURS (6 h)
    cacheOnly?: boolean;                      // no request: the stored row within maxAgeMs, else null
    store?: SourceProbeStore;
    hosts?: HostFailures;
    http?: HttpSeams;
    env?: (k: string) => string | undefined;  // the proxy settings (A29)
    now?: () => Date;
  }
  export type ProbeSummary = Pick<ProbeResult, 'ok' | 'failure_class' | 'status' | 'kind' | 'items' | 'newest_at' | 'checked_at' | 'via_proxy' | 'detail'>;
  export function probeSource(url: string, opts: ProbeOpts & { cacheOnly: true }): Promise<ProbeResult | null>;
  export function probeSource(url: string, opts?: ProbeOpts): Promise<ProbeResult>;
  export type ProberOpts = Pick<ProbeOpts, 'kind' | 'force' | 'maxAgeMs' | 'cacheOnly'>;
  export interface SourceProber {
    (url: string, o: ProberOpts & { cacheOnly: true }): Promise<ProbeResult | null>;
    (url: string, o?: ProberOpts): Promise<ProbeResult>;
  }
  export function sourceProberOf(pool: Pick<Pool, 'query'>, env?: (k: string) => string | undefined): SourceProber;
  ```
- **Steps.** These replace the body's steps 1–3; steps 5–7 follow A12 and A33.
  1. **Syntax.** An unparsable or non-http(s) URL → `invalid` (status null, detail "not an http(s) address"). It is not cached and not recorded. This step also runs with `cacheOnly`.
  2. **Cache.** Unless `force`, a stored row checked within `maxAgeMs` is returned with `cached: true`. `cacheOnly` returns this row or `null`, and stops here.
  3. **Active block.** As the body describes.
  4. **Guard.** `assertPublicUrl(url, http.lookup)` (`A/net/ssrf-guard.ts:41-61`).
     - A DNS error code (`classifyFetchError`) or the message "does not resolve" → `dns`, recorded in step 6.
     - Any other guard error → `invalid`, neither cached nor recorded.
  5. **Read**, as the body describes, then classify by A12. An error that no classifier knows → `http` with status null and the message (≤ 120 chars) as detail. Example: a redirect to a private address. It is cached and not recorded.
- **Dashboard.** `probeLine` and the panel show `invalid` as "Not a valid public address".

**A12. Classifying the answer** (item 12, accepted).
- **`opts.kind === 'rss'` and a body that is not RSS/Atom:** `ok: false`, `failure_class: 'empty'`, `kind: 'page'`, detail "not a feed".
  - When the page has a `<link rel="alternate">`, the detail adds "; the page names the feed <feed_url>", and `feed_url` is set. That feed is not read.
  - `fetch_feed` and the live scan fail this source the same way.
- **A `url` page (or no `kind`) without a feed link:**
  - `ok: true` when the text has ≥ 200 characters;
  - `items` = `primary_links.length`, 0 allowed: only aggregator pages have links (`A/net/extract-page.ts:68-75`);
  - detail "page, N chars", never "0 items".
- Both cases go in `probe.076.test.ts`.

**A13. The upload's body size** (item 13, accepted).
- **Middleware.** New `A/sources/upload-body.middleware.ts`: `uploadPageJsonBody`.
  - It is a copy of `dataRowsJsonBody` (`apps/automation/src/data/rows-body.middleware.ts:19-52`).
  - It takes any JSON POST at its mount point, with limit `UPLOAD_BODY_LIMIT`, and answers 413 `too_large` above it.
- **Mount.** `apps/automation/src/main.ts`: `app.use('/api/editor/sources/upload', uploadPageJsonBody)` next to `:52`, before Nest's parser. The global JSON limit is otherwise 100 KB.
- **nginx.** `apps/dashboard/nginx.conf`: `client_max_body_size 12m;` in the API location (`:25`). nginx's default is 1 MB. The backend keeps its own per-route limits, and `/api/data` rows can now reach their 10 MB.
- **Constants**, in `A/sources/upload-page.ts`. The middleware imports them.
  - `UPLOAD_PAGE_MAX_CHARS = 5_000_000`: zod `content.max`.
  - `UPLOAD_BODY_LIMIT = 12 * 1024 * 1024`: 5 M Cyrillic characters are about 10 MB of UTF-8, plus JSON escapes.
- **The dialog** mirrors them: a file ≤ 5 MB and decoded text ≤ 5,000,000 characters, with a comment naming the server constant.
- **Test** `A/sources/upload-body.076.test.ts`:
  - a declared length over the limit → 413;
  - a streamed body over the limit → 413;
  - bad JSON → 400;
  - a non-JSON content type passes to `next`.

**A14. Charset of a saved page** (item 14, accepted).
- `UploadPageDialog` reads the file as an `ArrayBuffer`. It decodes the bytes with a pure `decodePageBytes(bytes: Uint8Array): { text: string; charset: string }` in new `D/lib/page-charset.ts`.
- **Order:**
  - a BOM;
  - then `<meta charset>` or `<?xml encoding>` in the first 4 KB (the order of `declaredCharset` after the header, `A/net/safe-http.ts:61-70`);
  - then `TextDecoder(label)`, with UTF-8 as the fallback for an unknown label.
- Pasted text is sent as it is.
- Test `D/lib/page-charset.test.ts`: UTF-8, a windows-1251 `<meta>` and a UTF-8 BOM.
- The runbook's steps say "Save Page As → Webpage, HTML only".

**A15. Re-sync of uploaded datasets** (item 15, accepted).
- **(a) Zero changes still mark the import.** `resyncDataset(d, li, by, { fromUpload: true })` runs `runImport` with `fresh: false` and `uploaded: true`.
  - A run that changes nothing leaves no row of its own: `runImport` deletes a zero-change row (`A/docs/import-list.ts:497-499`) or returns early (`:488`).
  - So it still patches the latest import, `li.import_id`: `UPDATE data_imports SET options = jsonb_set(options, '{list_import}', (options->'list_import') || '{"uploaded":true,"auto_resync":false}'::jsonb) WHERE id = $1`.
- **(b) `resync_import`** (`A/docs/import-list-tools.ts:116-134`) checks in this order:
  1. `no_list_import`;
  2. then `li.options.uploaded` → `{ error: 'resync_manual', details: 'imported from an uploaded page: upload the page again' }`, with no card and no fetch;
  3. then today's path.

  The `RESYNC_IMPORT_KIND` handler (`:57-61`) refuses an uploaded import with the same error.
- **(c) `upload_expired`.**
  - When `p.uploaded` is true, `runImport` first requires `d.docs.keptByUrl(p.url)` to exist with `origin === 'upload'`. Otherwise it throws `upload_expired: the uploaded page is gone (a restart or the 100-page limit); upload it again`.
  - So a lost upload never falls through to `fetchLive` and the geoblock.
  - The Apply handler (`IMPORT_LIST_KIND`, `:56`) passes the payload as it is, so the same check runs.
- **The mark on the card.** `payloadOf` (`:374`) gains a 4th parameter `o?: { uploaded?: boolean }`. `import_list` passes `{ uploaded: doc.origin === 'upload' }`.
- **Tests:**
  - a zero-change re-sync from an upload still marks the import;
  - `resync_import` answers `resync_manual` without a request;
  - an expired upload throws `upload_expired` and the stubbed `get` is never called.

**A16. `reach` in the `import_list` preview** (item 16, accepted; the wiring anchor is corrected).
- **Where.** The preview is built by the `import_list` tool (`A/docs/import-list-tools.ts:68-109`).
  - Its deps are wired at `A/editor.module.ts:1290-1294` (`buildImportListTools`). `:2018` is the Apply handlers.
  - `ImportToolDeps` gains `probe?: SourceProber`, wired from `sourceProberOf(pool, env)` at `:1290`.
- **`reach`:**
  - `doc.kind === 'json'` → no `reach`; JSON APIs stay on spec 066.
  - `doc.origin === 'upload'` → `{ ok: false, resync: 'manual', detail: 'uploaded page' }`, with no probe, plus the manual re-sync line.
  - A doc fetched live within `PROBE_CACHE_HOURS` (`fetched_at`, not an upload) → `{ ok: true, resync: 'auto', detail: 'read just now' }`, with no probe.
  - Otherwise `probe(plan.url, { kind: 'url' })`, from the cache first. A failed probe adds the line.
- Without the port there is no `reach`, so the existing tests do not change.

**A17. Migration 100** (item 17, accepted).
- **Up.** Append the guarded GRANT of `database/migrations/079_agent_reliability.sql:83-88`:
  ```sql
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
      EXECUTE 'GRANT SELECT ON public.source_probes TO editor_ro';
    END IF;
  END $$;
  ```
- **Down.** Every statement is idempotent:
  - `DROP TABLE IF EXISTS source_probes`;
  - `ALTER TABLE source_host_failures DROP COLUMN IF EXISTS`, once for each of the three columns;
  - `UPDATE source_host_failures SET reason = 'timeout' WHERE reason = 'unreachable'`. `blocked_until` is kept: the old code simply waits it out;
  - `DELETE FROM schema_migrations WHERE version = '100_source_reach'`.
- **Test.** The PG test, on its own `createProbeDb` database, runs the down file twice, then the up file again.
- **Deploy.** Migration 100 must be applied before the code that writes the new columns. `record` and `succeeded` swallow their errors, so without the migration no block would be stored at all.

**A18. What the 6-hourly job re-probes** (item 18, accepted). `pausedReprobe`:
- **Channels.** Each card with an open `series_pauses` row: `cause = 'source_unreachable'` and `resumed_at IS NULL`.
- **Keys.** The hosts and feed keys of the card's and the playbook's `rss`/`url` sources.
- **Rows.** `SELECT host FROM source_host_failures WHERE host = ANY($1) AND (blocked_until > $2 OR strikes >= 1 OR consecutive_timeouts >= 1)`.
- **Probes.**
  - One forced probe per host per run, of the first source on that host, with that source's kind.
  - A URL whose `source_probes.checked_at` is under 30 minutes old is skipped: a button or a save has just probed it.
  - Probes run 2 s apart.

**A19. `readFeedGuarded`** (item 19, accepted).
- **New in `A/live/feed-items.ts`:**
  ```ts
  export type GuardedFeed =
    | { ok: true; feed: { title: string | null; items: FeedItem[] } }
    | { ok: false; unreachable: true; host: string; why: 'blocked' | 'dns' | 'tls' | 'timeout' }
    | { ok: false; unreachable: false; error: string };
  export async function readFeedGuarded(url: string, now: Date, d: { http?: HttpSeams; hosts?: HostFailures; retryMs?: number }): Promise<GuardedFeed>;
  ```
- **Behaviour:**
  - It checks for a block on the host, then on `feedKey(url)`, with use `'feed'` (as `A/tools/read-tools.ts:229-233` does).
  - It reads with `retryReset(() => readFeed(...), retryMs)` (`:236`).
  - DNS, TLS, timeout and reset errors are recorded on the host and the key (as at `:265-280`) and come back as unreachable.
  - An HTTP status or a `FeedParseError` is `failed` and is **not** recorded. The scan reads `url`-kind entries with `readFeed`, and a `feed_*` row on a page's key would make that page count as unreachable next time.
  - Any other error is `failed`.
  - A success calls `succeeded(host, 'feed')` and `succeeded(key, 'feed')`.
- **`scanLive`.**
  - It takes `d: { pool; http?; hosts?; retryMs? }` and reads every entry through `readFeedGuarded`.
  - `feedsFailed` counts every non-ok entry, and `feedsUnreachable` counts the unreachable ones.
  - `pageSources` = the number of entries tagged `url`. They are still read, and a parse failure is `failed`.
- **News watch.**
  - `NewsWatchDeps` (`A/live/news-watch.ts:20-26`) gains `hosts?: HostFailures`.
  - `run()` (`:91-99`) reads through `readFeedGuarded`. A failure is still logged and counted.
- **Wiring:**
  - `A/editor.module.ts:1654` → `scanLive({ pool, hosts: new PgHostFailures(pool) }, …)`;
  - `:1757` → `new NewsWatchService({ …, hosts: new PgHostFailures(pool) })`.

**A20. `liveFeeds` and `LiveScan`** (item 20, accepted).
- **`liveFeeds` entries** gain `kind: 'rss' | 'url'`: the card source's kind, or `FEEDISH` for a bare URL.
  - The `deepEqual` at `A/live/feed-items.test.ts:51-57` is updated to include `kind`. Record this in Deltas.
- **`LiveScan`** gains the optional `feedsUnreachable?: number` and `pageSources?: number`, read as 0.
  - The typed fakes still compile: `A/live/live-slot.test.ts:134` and `A/silent/fallback-ladder.test.ts:293`, `:464`.
  - The new gate never skips such a fake.
- **The gate:** `scan.feedsRead === 0 && (scan.feedsUnreachable ?? 0) > 0 && scan.feedsUnreachable === scan.feedsFailed && (scan.pageSources ?? 0) === 0 && !scan.otherSources.length`.

**A21. Pre-flight feed hints** (item 21, accepted; the anchor is corrected).
- **Anchors.** The live early return is `A/preflight/slot-preflight.ts:184`, and the unjudgeable rule is `:185-188`. `:157` is `withNextRow`.
- **The rule in `assess`:**
  - A `feed:<id>` or `rss:<id>` hint whose id resolves (as `liveFeeds` resolves it) to a card source of kind `rss` or `url` with an http ref joins `material`.
  - `assessFeed(url, kind)` returns `preflight_host_blocked` when `hosts.blocked(host, use)` is non-null with a reason other than `timeout`. `use` is `'feed'` for `rss` and `'page'` for `url`. For `rss`, `hosts.blocked(feedKey(url), 'feed')` counts as well.
  - The reason text: «стрічка <id> недоступна з сервера до <YYYY-MM-DDTHH:MM>Z (<reason>)».
  - Otherwise `assessFeed` returns `null`: the source is usable, and one usable source is enough.
  - An unresolved id stays unjudgeable.
- **Plan time.** `assessPlanned` (`:252`) uses the same `assess`. So the planner's plan-time check (`A/preflight/plan-time.ts:27-37`) now refuses such slots too, and tells the planner to change the source.
- **Tests** in new `A/preflight/slot-preflight.076.test.ts`:
  - a blocked feed hint → `preflight_host_blocked`;
  - an unblocked feed hint beside a blocked URL → ok;
  - an unresolved id → ok.
  - `slot-preflight.068.test.ts:133-139` stays green.

**A22. Health coverage** (item 22, accepted).
- **`source-health.ts`:**
  - A series library source whose runway is `{ rounds: false, unposted: 0 }` gets state `exhausted`, with the detail "no unposted rows left".
  - `isTroubled` (`:190`) is also true for `h.probe && !h.probe.ok`.
  - `needsReplacement` does not change for series sources. They carry origin `playbook`, and `needingReplacement` excludes that origin (`A/sources/source-health.service.ts:59`).
- **Network health.**
  - `A/health/network-health.service.ts:95` drops `.filter((c) => c.sources.length)`.
  - It skips a report whose `noSources` is true (`:98-99`).
  - The cost is one report per active card per Health load.
- **Replay 2** asserts that the @ai0_prompts_dev series row appears in `NetworkHealthService.health().sources` when its dataset has 0 unposted rows.

**A23. Series sources and runway** (item 23, accepted; the `days` formula is corrected).
- **`playbookSeriesSources(body, cardSources)`** in `A/sources/playbook-feeds.ts`:
  - Each active series whose `source.kind` is `library` or `api` gives `{ id: 'series:<name>', kind: 'library' | 'api', ref: source.table | source.source }`.
  - Feed series are left out: `playbookSources` already lists them (`:21-25`).
  - A (kind, ref) that the card already lists is skipped, and there is one row per (kind, ref).
- **`sourcesOf`** (`A/sources/source-health.service.ts:31-35`) appends these rows and counts them as playbook rows (origin `playbook`).
- **`runway`** of a `library` source, card or series:
  - It comes from `catalogOverview(pool, { resource: 'telegram:<channelKey>' })` (`A/tools/catalog-context.ts:84-97`), from the row whose `dataset` equals `ref`.
  - It is `{ unposted: unposted_here ?? null, days: runway_days ?? null, rounds: !!repeat }`.
  - `runway_days` (`:75`, `:92`) is already unposted ÷ max(series per day, 28-day use per day), and null for rounds. No new formula.
- **Deps.**
  - `SourceHealthDeps` gains `runway?: (resourceRef: string) => Promise<CatalogOverviewRow[]>`, `probes?: Pick<PgSourceProbes, 'latest'>` and `env?` (for `proxyConfigured`, via `egressProxyConfigured`, A29).
  - `sourceHealthOf(pool, channels, inbox?)` (`A/sources/source-wiring.ts:13-15`) builds all three from `pool` and `process.env`, so its callers in `editor.module.ts` (`:1301`, `:1597`, `:1948`, `:2266`) do not change.
  - Its `inbox` type widens to `Pick<OwnerInbox, 'post' | 'postOnce'>`.
- **The no-card fallback.** `AgentsService.sources` (`A/agents/agents.service.ts:384`) returns `{ channelKey, days: 0, sources: [], otherHosts: [], noSources: false, proxyConfigured: false }`.
- **Dashboard types** (`D/api/agents.ts:300-320`, `D/api/health.ts:15`) make `probe`, `runway`, `origin`, `noSources` and `proxyConfigured` optional, so an older server still renders.

**A24. Inbox kinds** (item 24, accepted; `inbox-ref.ts` does not change).
- **A new `resync_failed` entry** in `D/lib/inbox-kinds.ts`:
  - why: "A dataset made from a web page could not be re-read; its new entries are missing until the page is uploaded again."
  - steps: `c.ref ? link('Open dataset', '/app/data/$key', { params: { key: c.ref.base } }) : link('Open data', '/app/data')`, then `read()`.
  - `c.ref` is `parseRefId(refId)` (`:439`), so `<dataset>#<hash>` already gives the key. `low_runway` (`:277-280`) works the same way.
- **`host_struck`** (`:307-313`):
  - why: "A website refuses the server or cannot be reached from it, so the sources that depend on it stay empty."
  - primary step: `agentLink(c, 'Open sources', 'settings')`, then "Open network health".
  - The test at `D/lib/inbox-kinds.test.ts:383` changes to 'Open sources'. Record this in Deltas.
- **Test data.** `inbox-kinds.test.ts` gains a `resync_failed` row in `FIXTURES` (`refType: 'dataset'`, `refId: 'pdr_rules#ab12cd34'`) and in `BRIEF_KINDS` (`:86-91`).

**A25. Row controls follow `apps/dashboard/CLAUDE.md`** (item 25, accepted).
- `SourceRow` stays a `.panel-row`, and the row itself is not clickable.
- **Buttons.** `RowActions` with `TableAction` (`D/components/ui/table.tsx:39-90`):
  - "Test from server" (`action="verify"`);
  - "Details", which opens `SourceProbeDialog`;
  - "Route via proxy";
  - "Upload the page".
- **"Remove"** goes in `RowActions danger`, with `ACTION.delete` and `useConfirm` (`D/components/ui/ConfirmDialog.tsx:89`).
- Icons come from `Icon.tsx` only.
- The row wraps at 375 px, through an `ast-` class with `flex-wrap`.
- This replaces "A row click opens `SourceProbeDialog`".

**A26. Task order around host notes** (item 26, accepted). T5 keeps the `noteStruckHosts` call in `toReplaceToday`. T7 removes it in the same commit that adds the worker.

**A27. Order and splits** (item 27, accepted). The new order:
- T1 (FR-002);
- T2 proxy (was T3);
- T3 probe (was T2);
- T4, T5;
- T6a, T6b;
- T7, T8;
- T9a, T9b;
- T10.

See tasks.md. Record the split in Deltas.

**A28. Docs** (item 28, accepted).
- **Runbook.** `## 36. Sources proven from the server (spec 076)` is written as one contiguous block at the end of `docs/runbooks/agent-platform.md`. The last section at HEAD is § 31 (`:994`). §§ 32–35 come from the other wave-7 specs, and the lead resolves the order at merge.
- **§ 29.** Under step 1 (`:894`), one line: "Now: save the page in a browser and upload it (§ 36)."
- **`specs/README.md`:**
  - the 076 row goes between 071 (`:78`) and 078 (`:79`);
  - the landed-migrations list on line 87 gains "100 spec 076 (source probes, unreachable strikes: apply before deploying the code that writes them)".

**A29. Proxy settings** (item 29, accepted).
- **Reading the settings.** `SafeOpts` gains `env?: (k: string) => string | undefined`, defaulting to `(k) => process.env[k]` and read on every request.
  - The same field goes on the inline opts of `safeGet` (`A/net/safe-http.ts:87`) and `safeGetBytes` (`:105`).
  - `SettingsService.setValue` writes `process.env` at once (`apps/automation/src/settings/settings.service.ts:207-222`).
- **`egressProxyFor(host, env)`:**
  - `EGRESS_PROXY_URL` must parse as an `http:` or `https:` URL.
  - Anything else is malformed, `socks5://` included: the request goes direct, with one warning per distinct value. The warning is keyed by a hash and never shows the value.
  - Listed hosts are lower-cased and lose a leading `www.`.
- **`egressProxyConfigured(env): boolean`** is true when a valid URL is set. The report's `proxyConfigured` and the 409 of `proxy-host` use it.
- **Help text.** The help of `EGRESS_PROXY_URL` ends with "http or https proxy only."
- `catalog.test.ts`'s rules already fit.

**A30. Triggers and wiring** (item 30, accepted).
- **"Changed"** = a source of the saved card whose `(id, kind, ref)` is not in `existing.sources`, matched by id. Only `rss`/`url` sources with an http ref count.
- **Probe ports.** `EditorOpsDeps.probe?: SourceProber` and `ScheduleServiceDeps.probe?: SourceProber` are optional.
  - After the write: `void this.d.probe(url, { kind, force: true }).catch(() => {})`.
  - Tests that do not pass the port do not change.
- **`commitSeriesChange`.**
  - It looks at a series whose source is `feed`.
  - A non-URL ref is resolved against `sc.card.sources` (by id or ref); otherwise it is skipped.
  - "New or changed" is checked against the series in the playbook as read before `:641` overwrites `sc.net.playbook`.
- **`SourcesController`** (`A/sources/sources.controller.ts`, `@Controller('api/editor/sources')`, `@UseGuards(TrackingAuthGuard)`):
  - It injects `@Inject(DB_POOL) pool`, `@Inject(EDITOR_OPS) ops`, `SettingsService` (global) and `ConfigService`. `EDITOR_OPS` comes from `A/api/editor.controller.ts:7`, so there is no cycle.
  - It builds its own prober (`sourceProberOf`) and `ImportDeps` (`{ pool, docs: sharedDocStore(env), hosts: new PgHostFailures(pool), env }`).
  - It is added to `controllers` (`A/editor.module.ts:2506`).
- **`drop`** = `ops.upsertChannel(channel, { sources: card.sources.filter((s) => s.id !== sourceId) })`. `mergeCard` replaces the array (`A/api/card-input.ts:103-111`). An id that is not on the card gives 404 `source_not_found`.
- **Test:** a save that leaves the sources unchanged (a mode-only save) probes nothing.

**A31. Owner-facing text** (item 31, accepted). The dashboard texts are English and the Telegram alerts are Ukrainian.
- **Formats.** `<date>` is YYYY-MM-DD, `<time>` is YYYY-MM-DD HH:MM UTC, N = `consecutive_timeouts` and S = `strikes`.
- **`host_struck`** notes have severity `action`.

| reason | title (en) | body (en) | alert title (uk) | alert body (uk) |
|---|---|---|---|---|
| `unreachable` | `<host> cannot be reached from the server` | `Timed out N times in a row since <date>; blocked until <time>. Route it through the proxy, upload the page, or remove the source.` | «<host> недоступний із сервера» | «Тайм-аутів поспіль: N (з <дата>); наступна спроба після <час>. Відкрий джерела каналу: проксі, завантажити сторінку або прибрати джерело.» |
| `refused` | `<host> refuses the server` | `Refused S times in a row (status <code>); blocked until <time>. Route it through the proxy or remove the source.` | «<host> відмовляє серверу» | «Відмов поспіль: S (status <код>); заблоковано до <час>. Відкрий джерела каналу: проксі або прибрати джерело.» |
| `dns` | `<host> does not resolve` | `DNS failed S times in a row; blocked until <time>. Check the address or remove the source.` | «Домен <host> не знаходиться (DNS)» | «Збоїв DNS поспіль: S; заблоковано до <час>. Перевір адресу або прибери джерело.» |
| `tls` | `<host> has a TLS error` | `TLS failed S times in a row; blocked until <time>. Check the address or remove the source.` | «<host>: помилка TLS-сертифіката» | «Збоїв TLS поспіль: S; заблоковано до <час>. Перевір адресу або прибери джерело.» |

- **Where the host is.** Both bodies end with a sentence about where the host is (the 061 sentences, `A/sources/source-health.service.ts:92-93`):
  - a card source: "A card source: the channel agent looks for a replacement and shows an Apply / Discard card." / «Джерело картки: агент шукає заміну і покаже картку Apply / Discard.»;
  - in the playbook: "The address is in the channel's playbook: remove it there (a directive to the manager) or keep it if the site may come back." / «Адреса є в плейбуку каналу — прибери її з плейбука (директива менеджеру) або залиш, якщо сайт ще оживе.»
- **`resync_failed`** has severity `action`, `refType: 'dataset'`, `refId: <dataset>`, gate subject `resync:<dataset>` and parts `[<error class>]`.
  - The error class is the text before the first `:` when it is snake_case (`host_unreachable`, `host_blocked`, `http_error`, `upload_expired`), else `error`.
  - Title "Re-sync of <dataset> failed".
  - Body "<error, ≤ 200 chars>. If the server cannot reach <host>, upload the page (Data → Upload page)."
  - Alert «Не вдалося оновити датасет <dataset>» / «<помилка>. Якщо сервер не бачить <host>, завантаж сторінку вручну.»
- **`SOURCE_REASONS`** in `A/sources/codes.ts`. The note code is `host_struck`, the note's own Inbox kind, instead of `host_unreachable`. `host_unreachable` is already a tool error code, which 073's `reasonOfError` would misread.

| code | kind | en | uk | fix.en | fix.uk | link |
|---|---|---|---|---|---|---|
| `source_probe_failed` | doctor | The server cannot read this source | Сервер не може прочитати це джерело | Route the site through the proxy, upload the page, or remove the source. | Пусти сайт через проксі, завантаж сторінку вручну або прибери джерело. | `/app/agents/:agent?tab=settings` |
| `source_empty` | doctor | The source is empty or not a feed | Джерело порожнє або це не стрічка | Check the address, then replace or remove the source. | Перевір адресу, потім заміни або прибери джерело. | `/app/agents/:agent?tab=settings` |
| `source_untested` | doctor | The server has not read this source yet | Сервер ще не читав це джерело | Press "Test from server" on the source. | Натисни «Test from server» біля джерела в налаштуваннях агента. | `/app/agents/:agent?tab=settings` |
| `card_without_sources` | doctor | No sources: the channel writes from its brief only | Без джерел: канал пише лише з брифу | Add a feed, a page or a dataset if posts need facts. | Додай стрічку, сторінку або датасет, якщо постам потрібні факти. | `/app/agents/:agent?tab=settings` |
| `dataset_resync_manual` | doctor | Imported from an uploaded page: re-sync is manual | Імпортовано із завантаженої сторінки: оновлення лише вручну | Upload the page again to add new entries. | Щоб додати нові записи, завантаж сторінку ще раз. | `/app/data/:dataset` |
| `host_struck` | source | A site refuses the server or cannot be reached from it | Сайт відмовляє серверу або недоступний із нього | Route it through the proxy, upload the page, or remove the source. | Пусти його через проксі, завантаж сторінку або прибери джерело. | `/app/agents/:agent?tab=settings` |
| `resync_failed` | source | Re-sync of an imported dataset failed | Не вдалося оновити імпортований датасет | Upload the page if the server cannot reach the site. | Якщо сервер не бачить сайту, завантаж сторінку вручну. | `/app/data/:dataset` |

**A32. The mock for the browser check** (item 32, accepted).
- T9b builds a throwaway mock at `<worktree>/tmp/mock076/server.mjs`, on port 3176. `tmp/` is never committed.
- It serves the built dashboard and answers:
  - `GET /api/agents/:handle/sources`, with `probe`, `runway`, `noSources` and `proxyConfigured`;
  - the network-health GET;
  - `POST /api/editor/sources/probe|upload|drop|proxy-host`;
  - `GET /api/data/schemas`.
- If the check cannot run, the final report lists it under "what the lead should check in the browser".

**A33. A feed's refusal is not a host refusal** (found while verifying).
- **The problem.** Body step 6 records `record(host, 'refused', status)` for any refusal. For an `rss` probe, that blocks the host's pages for a day because its feed answered 403. Spec 070 separates the two on purpose: `fetch_feed` records `feed_refused` on the feed key (`A/tools/read-tools.ts:243-246`).
- **The rule:**
  - An `rss` probe records network failures (host and key, A8) and records **nothing** for an HTTP status.
  - A `url` probe records a refusal on the host, as `fetchPageGuarded` does (`A/net/host-failures.ts:277-278`).
  - A probe never records a `feed_*` reason (unchanged).
- **Reachability.** Any answer with status < 400 calls `succeeded` (A2), even when the body is empty or not a feed. The server reached the host.

### Open for the lead

- **074 and 077 name a probe without its cache.**
  - 077 (`specs/077-material-aware-bring-up/spec.md:73`) says "`probeSource(url, {})` (076), $0, served from its 6 h cache". 074 (`specs/074-changes-take-effect/spec.md:173-176`) also names `probeSource(url)`.
  - A bare `probeSource` has no `store`, so it neither caches nor records the host (L3).
  - Recommended: both call `sourceProberOf(pool)` (the contract's "076 adds"). 074's auto-resume uses `{ force: true }` only from its own 6-hourly path, and otherwise uses the default cache.
  - The lead tells the 074 and 077 maintainers. 076 changes nothing for this.

## Lead decisions after the integration review (2026-10-29)

These override everything above, including the Amendments. They come from a cross-spec review of all six specs (the item numbers I1… are that review's).

- **I18:** the probe on card save reuses any `source_probes` row younger than 24 h (`maxAgeMs` 24 h). There is no forced probe on write, so a launch's own probe is not repeated.
- **I15:** the 6-hourly forced `pausedReprobe` is the only live re-probe of paused hosts. 074 reads its rows and never forces a probe.
- **I9:** the `host_struck` note stays 076's single owner note for an unreachable host; 072's readiness card leaves `source_probe_failed` out.
