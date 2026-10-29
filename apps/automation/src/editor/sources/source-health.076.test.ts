/**
 * Spec 076 FR-006 (A9, A10, A22, A23, A31): source health covers every source (playbook series too), carries the server's probe and
 * the runway, and a struck host is told to the owner in the words of the table. Fake repository, fake overview, fake probes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSource } from '../card';
import { makeCard } from '../post/testing/fixtures';
import { playbookSeriesSources, playbookSources } from './playbook-feeds';
import { hostStruckNote, sinceStamp, SourceHealthService } from './source-health.service';
import { isTroubled, needsReplacement, withReach, type SourceHealth } from './source-health';
import type { StruckHost } from './source-health.repository';
import type { ProbeResult } from './probe';
import { errorClassOf, resyncFailedNote } from '../docs/list-resync.worker';

const T0 = new Date('2026-10-29T12:00:00Z');
const FEED: CardSource = { id: 'verge', kind: 'rss', ref: 'https://www.theverge.com/rss/index.xml' };

const overviewRow = (dataset: string, o: Record<string, unknown> = {}): any => ({ dataset, title: dataset, entity: 'x', rows: 40, unposted_here: 12, runway_days: 6, ...o });
const probeRow = (url: string, ok: boolean, o: Partial<ProbeResult> = {}): ProbeResult => ({
  ok, failure_class: ok ? null : 'timeout', status: ok ? 200 : null, kind: 'rss', feed_url: url, items: ok ? 6 : 0, newest_at: null, sample_titles: [],
  checked_at: T0.toISOString(), via_proxy: false, url, detail: ok ? '6 items, newest 2 h ago' : 'no answer in 10 s', ms: 120, cached: false, blocked_until: null, ...o,
});

function service(o: { card: ReturnType<typeof makeCard>; playbook?: unknown; overview?: any[]; probes?: ProbeResult[]; env?: Record<string, string>; overviewFails?: boolean }) {
  const asked: string[] = [];
  const svc = new SourceHealthService({
    repo: { steps: async () => [], blocks: async () => [], playbookOf: async () => o.playbook ?? null },
    channels: { get: async () => o.card }, now: () => T0,
    runway: async (ref) => { asked.push(ref); if (o.overviewFails) throw new Error('db down'); return o.overview ?? []; },
    probes: { latest: async (urls: string[]) => new Map((o.probes ?? []).filter((p) => urls.includes(p.url)).map((p) => [p.url, p])) } as any,
    env: (k) => o.env?.[k],
  });
  return { svc, asked };
}

const PROMPTS_PB = { series: [{ name: 'Prompt of the day', source: { kind: 'library', table: 'prompts' }, active: true }], rules: [] };

test('playbookSeriesSources: library and api series become rows; feeds, inactive series and addresses the card has are left out; one row per (kind, ref)', () => {
  const body = {
    series: [
      { name: 'Prompt of the day', source: { kind: 'library', table: 'prompts' } },
      { name: 'Prompt reruns', source: { kind: 'library', table: 'prompts' } },
      { name: 'Space photo', source: { kind: 'api', source: 'nasa_apod' } },
      { name: 'AI news', source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' } },
      { name: 'Paused', source: { kind: 'library', table: 'recipes' }, active: false },
      { name: 'Recipes', source: { kind: 'library', table: 'recipes_card' } },
      { name: 'Highlights', source: { kind: 'network_highlights', scope: 'network' } },
      { source: { kind: 'library', table: 'nameless' } },
    ],
    rules: [],
  };
  const card: CardSource[] = [{ id: 'r', kind: 'library', ref: 'recipes_card' }];
  assert.deepEqual(playbookSeriesSources(body, card), [
    { id: 'series:Prompt of the day', kind: 'library', ref: 'prompts' },
    { id: 'series:Space photo', kind: 'api', ref: 'nasa_apod' },
  ]);
  assert.deepEqual(playbookSeriesSources(null), []);
  assert.deepEqual(playbookSeriesSources({ series: 'x' }), []);
  assert.equal(playbookSources(body, card).length, 1, 'the feed series is still listed by playbookSources, and only there');
});

test('@ai0_prompts_dev: no card sources and a library series show one source row with its runway', async () => {
  const card = makeCard({ channelKey: '@prompts', sources: [] });
  const { svc, asked } = service({ card, playbook: PROMPTS_PB, overview: [overviewRow('prompts'), overviewRow('other')] });
  const r = await svc.forCard(card);
  assert.equal(r.noSources, false);
  assert.deepEqual(r.sources.map((s) => [s.id, s.kind, s.ref, s.origin, s.state, s.runway, s.probe]), [
    ['series:Prompt of the day', 'library', 'prompts', 'playbook', 'unused', { unposted: 12, days: 6, rounds: false }, null],
  ]);
  assert.deepEqual(asked, ['telegram:@prompts']);
  assert.deepEqual(await svc.needingReplacement(card), [], 'a playbook row is never offered for a card replacement');
});

test('runway: a dataset that repeats in rounds has rounds true and no days; unknown unposted stays null; a dataset the overview lacks has none', async () => {
  const card = makeCard({ channelKey: '@c', sources: [{ id: 'lib', kind: 'library', ref: 'rounds_ds' }, { id: 'lib2', kind: 'library', ref: 'plain_ds' }, { id: 'lib3', kind: 'library', ref: 'ghost' }] });
  const { svc } = service({ card, overview: [
    overviewRow('rounds_ds', { repeat: { order: 'in_order' }, runway_days: null, unposted_here: 30 }),
    overviewRow('plain_ds', { unposted_here: undefined, runway_days: undefined }),
  ] });
  const byId = Object.fromEntries((await svc.forCard(card)).sources.map((s) => [s.id, s.runway]));
  assert.deepEqual(byId.lib, { unposted: 30, days: null, rounds: true });
  assert.deepEqual(byId.lib2, { unposted: null, days: null, rounds: false });
  assert.equal(byId.lib3, null);
});

test('the exhausted state: a series library source with no unposted rows and no rounds; a card source, rounds and rows left are not', async () => {
  const card = makeCard({ channelKey: '@c', sources: [{ id: 'cardlib', kind: 'library', ref: 'card_ds' }] });
  const playbook = { series: [
    { name: 'Empty', source: { kind: 'library', table: 'empty_ds' } },
    { name: 'Looping', source: { kind: 'library', table: 'loop_ds' } },
    { name: 'Stocked', source: { kind: 'library', table: 'stock_ds' } },
  ], rules: [] };
  const { svc } = service({ card, playbook, overview: [
    overviewRow('empty_ds', { unposted_here: 0, runway_days: 0 }), overviewRow('loop_ds', { unposted_here: 0, repeat: { order: 'in_order' }, runway_days: null }),
    overviewRow('stock_ds', { unposted_here: 3 }), overviewRow('card_ds', { unposted_here: 0 }),
  ] });
  const r = await svc.forCard(card);
  const state = Object.fromEntries(r.sources.map((s) => [s.id, s.state]));
  assert.deepEqual(state, { 'series:Empty': 'exhausted', 'series:Looping': 'unused', 'series:Stocked': 'unused', cardlib: 'unused' });
  const empty = r.sources.find((s) => s.id === 'series:Empty')!;
  assert.equal(empty.detail, 'no unposted rows left');
  assert.equal(isTroubled(empty), true);
  assert.equal(needsReplacement(empty), true, 'exhausted counts, but needingReplacement leaves playbook rows out');
  assert.deepEqual(await svc.needingReplacement(card), []);
  assert.equal(r.sources[0].id, 'series:Empty', 'the exhausted row is listed first');
});

test('an api series row; a series that duplicates a card source is skipped', async () => {
  const card = makeCard({ channelKey: '@c', sources: [{ id: 'apod', kind: 'api', ref: 'nasa_apod' }] });
  const playbook = { series: [{ name: 'Space photo', source: { kind: 'api', source: 'nasa_apod' } }, { name: 'Quotes', source: { kind: 'api', source: 'quotes' } }], rules: [] };
  const r = await service({ card, playbook }).svc.forCard(card);
  assert.deepEqual(r.sources.map((s) => [s.id, s.kind, s.ref, s.origin, s.runway]), [['apod', 'api', 'nasa_apod', 'card', null], ['series:Quotes', 'api', 'quotes', 'playbook', null]]);
});

test('noSources and proxyConfigured; a failing overview is not fatal', async () => {
  const blank = makeCard({ channelKey: '@blank', sources: [] });
  const none = await service({ card: blank, env: { EGRESS_PROXY_URL: 'http://proxy.example:3128' } }).svc.forCard(blank);
  assert.deepEqual([none.noSources, none.proxyConfigured, none.sources.length], [true, true, 0]);
  const bad = await service({ card: blank, env: { EGRESS_PROXY_URL: 'socks5://nope' } }).svc.forCard(blank);
  assert.equal(bad.proxyConfigured, false, 'only an http(s) proxy counts');
  assert.equal((await service({ card: blank }).svc.forCard(blank)).proxyConfigured, false);
  const card = makeCard({ channelKey: '@c', sources: [{ id: 'lib', kind: 'library', ref: 'ds' }] });
  const r = await service({ card, overviewFails: true }).svc.forCard(card);
  assert.deepEqual([r.noSources, r.sources[0].runway], [false, null]);
});

test('a failed probe makes the row troubled and says so; a good probe does not; a library source has no probe', async () => {
  const other: CardSource = { id: 'page', kind: 'url', ref: 'https://pages.example/list' };
  const card = makeCard({ channelKey: '@c', sources: [FEED, other, { id: 'lib', kind: 'library', ref: 'ds' }] });
  const { svc } = service({ card, probes: [probeRow(FEED.ref, false), probeRow(other.ref, true, { kind: 'page' })] });
  const r = await svc.forCard(card);
  const byId = Object.fromEntries(r.sources.map((s) => [s.id, s]));
  assert.equal(byId.verge.probe?.ok, false);
  assert.equal(byId.verge.probe?.failure_class, 'timeout');
  assert.equal(isTroubled(byId.verge), true);
  assert.equal(byId.verge.state, 'unused', 'the run-trace state is untouched');
  assert.match(byId.verge.detail, /; the server could not read it \(timeout: no answer in 10 s\)$/);
  assert.equal(needsReplacement(byId.verge), false, 'a failed probe alone does not start a replacement');
  assert.equal(isTroubled(byId.page), false);
  assert.equal(byId.page.probe?.ok, true);
  assert.equal(byId.lib.probe, null);
  assert.equal(r.sources[0].id, 'verge', 'the unreadable source is listed before the others');
  assert.ok(!('sample_titles' in (byId.verge.probe as object)), 'only the summary is carried');
});

test('withReach leaves a pure health row alone without probe or runway', () => {
  const h: SourceHealth = {
    id: 'x', kind: 'rss', ref: 'https://x.example/rss', state: 'ok', calls: 3, ok: 3, empty: 0, errors: 0, successRate: 1, lastOkAt: null, lastError: null, blocked: null, slotsLost: 0, detail: '3 of 3 reads worked in 14 d',
  };
  assert.deepEqual(withReach(h, {}), { ...h, probe: null, runway: null });
  assert.equal(isTroubled(withReach(h, {})), false);
});

// ── the host notes ───────────────────────────────────────────────────────────────────────────────────────────────────
const struck = (o: Partial<StruckHost> = {}): StruckHost => ({
  host: 'theverge.com', reason: 'refused', statusCode: 403, until: new Date('2026-10-30T06:30:00Z'), failures: 3, strikes: 3, notedAt: null,
  timeouts: 0, timeoutsSince: null, lastSuccessAt: null, ...o,
});
const where = { inCard: false, inPlaybook: false };

test('the since part: YYYYMMDDTHHMM UTC of the last success, or never; it has no colon', () => {
  assert.equal(sinceStamp(new Date('2026-10-12T09:41:30Z')), '20261012T0941');
  assert.equal(sinceStamp(null), 'never');
  assert.doesNotMatch(sinceStamp(new Date()), /:/);
});

test('A31 texts: one title and body in English and one alert in Ukrainian per reason, with the status and the times', () => {
  const unreachable = hostStruckNote(struck({ reason: 'unreachable', statusCode: null, strikes: 1, timeouts: 4, timeoutsSince: new Date('2026-10-26T07:00:00Z') }), where)!;
  assert.deepEqual([unreachable.title, unreachable.body], [
    'theverge.com cannot be reached from the server',
    'Timed out 4 times in a row since 2026-10-26; blocked until 2026-10-30 06:30 UTC. Route it through the proxy, upload the page, or remove the source.',
  ]);
  assert.deepEqual(unreachable.alert, {
    title: 'theverge.com недоступний із сервера',
    body: 'Тайм-аутів поспіль: 4 (з 2026-10-26); наступна спроба після 2026-10-30 06:30 UTC. Відкрийте джерела каналу: там можна пустити сайт через проксі, завантажити сторінку або прибрати джерело.',
  });
  assert.deepEqual(unreachable.parts, ['unreachable', 'strikes:1', 'since:never']);

  const refused = hostStruckNote(struck(), where)!;
  assert.deepEqual([refused.title, refused.body], ['theverge.com refuses the server', 'Refused 3 times in a row (status 403); blocked until 2026-10-30 06:30 UTC. Route it through the proxy or remove the source.']);
  assert.deepEqual(refused.alert, {
    title: 'theverge.com відмовляє серверу',
    body: 'Відмов поспіль: 3 (status 403); заблоковано до 2026-10-30 06:30 UTC. Відкрийте джерела каналу: там можна пустити сайт через проксі або прибрати джерело.',
  });
  assert.equal(hostStruckNote(struck({ statusCode: null }), where)!.body.startsWith('Refused 3 times in a row; blocked until'), true, 'no status, no parentheses');

  const dns = hostStruckNote(struck({ reason: 'dns', statusCode: null }), where)!;
  assert.deepEqual([dns.title, dns.body, dns.alert.title, dns.alert.body], [
    'theverge.com does not resolve', 'DNS failed 3 times in a row; blocked until 2026-10-30 06:30 UTC. Check the address or remove the source.',
    'Домен theverge.com не знаходиться (DNS)', 'Збоїв DNS поспіль: 3; заблоковано до 2026-10-30 06:30 UTC. Перевірте адресу або приберіть джерело.',
  ]);
  const tls = hostStruckNote(struck({ reason: 'tls', statusCode: null }), where)!;
  assert.deepEqual([tls.title, tls.body, tls.alert.title, tls.alert.body], [
    'theverge.com has a TLS error', 'TLS failed 3 times in a row; blocked until 2026-10-30 06:30 UTC. Check the address or remove the source.',
    'theverge.com: помилка TLS-сертифіката', 'Збоїв TLS поспіль: 3; заблоковано до 2026-10-30 06:30 UTC. Перевірте адресу або приберіть джерело.',
  ]);
  assert.equal(hostStruckNote(struck({ reason: 'timeout' }), where), null, 'a one-hour timeout block is not a streak to report');
  assert.equal(hostStruckNote(struck({ reason: 'feed_refused' }), where), null);
});

test('A31 where the host is: the card sentence, the playbook sentence, both', () => {
  const card = hostStruckNote(struck(), { inCard: true, inPlaybook: false })!;
  assert.match(card.body, / A card source: the channel agent looks for a replacement and shows an Apply \/ Discard card\.$/);
  assert.match(card.alert.body, / Джерело картки: агент шукає заміну і покаже картку Apply \/ Discard\.$/);
  const pb = hostStruckNote(struck(), { inCard: false, inPlaybook: true })!;
  assert.match(pb.body, / The address is in the channel's playbook: remove it there \(a directive to the manager\) or keep it if the site may come back\.$/);
  assert.match(pb.alert.body, / Адреса є в плейбуку каналу — приберіть її з плейбука \(директива менеджеру\) або залиште, якщо сайт ще оживе\.$/);
  const both = hostStruckNote(struck(), { inCard: true, inPlaybook: true })!;
  assert.match(both.body, /Apply \/ Discard card\. The address is in the channel's playbook/);
  assert.doesNotMatch(hostStruckNote(struck(), where)!.body, /card source|playbook/);
});

test('the since part follows the last success, so a recovery makes the next note a new one', () => {
  const before = hostStruckNote(struck({ lastSuccessAt: null }), where)!.parts;
  const after = hostStruckNote(struck({ lastSuccessAt: new Date('2026-10-28T10:15:00Z') }), where)!.parts;
  assert.deepEqual(before, ['refused', 'strikes:3', 'since:never']);
  assert.deepEqual(after, ['refused', 'strikes:3', 'since:20261028T1015']);
});

// ── the re-sync note ─────────────────────────────────────────────────────────────────────────────────────────────────
test('A31 resync_failed: severity action, the dataset as the reference, gate resync:<dataset> with the error class', () => {
  const n = resyncFailedNote('pdr_rules', 'host_unreachable: zakon.rada.gov.ua: сайт не відповів вчасно', 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF/print');
  assert.deepEqual([n.kind, n.refType, n.refId, n.severity], ['resync_failed', 'dataset', 'pdr_rules', 'action']);
  assert.equal(n.title, 'Re-sync of pdr_rules failed');
  assert.equal(n.body, 'host_unreachable: zakon.rada.gov.ua: сайт не відповів вчасно. If the server cannot reach zakon.rada.gov.ua, upload the page (Data → Upload page).');
  assert.deepEqual(n.alert, {
    title: 'Не вдалося оновити датасет pdr_rules',
    body: 'host_unreachable: zakon.rada.gov.ua: сайт не відповів вчасно. Якщо сервер не бачить zakon.rada.gov.ua, завантажте сторінку вручну.',
  });
  assert.deepEqual(n.gate, { subject: 'resync:pdr_rules', parts: ['host_unreachable'] });
  assert.ok(resyncFailedNote('d', 'x'.repeat(500), undefined).body?.startsWith(`${'x'.repeat(200)}. If the server cannot reach the site`), 'the error is cut to 200 characters');
});

test('the error class is the snake_case text before the first colon, else error', () => {
  assert.equal(errorClassOf('host_blocked: x'), 'host_blocked');
  assert.equal(errorClassOf('http_error: status 503'), 'http_error');
  assert.equal(errorClassOf('upload_expired: the uploaded page is gone'), 'upload_expired');
  assert.equal(errorClassOf('socket hang up'), 'error');
  assert.equal(errorClassOf('Some Sentence: with a colon'), 'error');
  assert.equal(errorClassOf(''), 'error');
});
