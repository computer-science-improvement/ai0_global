// 002 T004 — poisoned items must be marked errored instead of being retried
// every tick (which loops forever and, for AI strategies, burns tokens), while
// transient failures (no AI response, network) are left unmarked to retry.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PostValidator } from '../common/ai/validators/post.validator';
import { SpaceStrategy } from './space/space.strategy';
import { MoviesStrategy } from './movies/movies.strategy';
import { OnThisDayStrategy } from './on-this-day/on-this-day.strategy';
import { DailyPhotoStrategy } from './daily-photo/daily-photo.strategy';
import { GameChannelStrategy } from './game-channel/game-channel.strategy';
import { MotivationBiographyStrategy } from './motivation-biography/motivation-biography.strategy';
import { AssetsStrategy } from './assets/assets.strategy';
import { Ai0PromptsStrategy } from './ai0-prompts/ai0-prompts.strategy';

afterEach(() => mock.restoreAll());

const REFUSAL = 'I cannot help with this request because it is against the content policy rules.';
const GOOD    = 'Нормальний пост українською мовою, достатньо довгий для валідатора постів.';
const claude  = (reply: string | null) => ({ available: true, chat: async () => reply });
const registry = { register() {} };

// ── Generic-runner strategies: generate() returns a rejection or null ─────────

const RUNNER_CASES: Array<[string, (c: any) => any, any]> = [
  ['space', (c) => new SpaceStrategy(c, new PostValidator(), registry as any, {} as any, {} as any),
    { sourceUrl: 'https://s/1', title: 't', contentType: 'news', data: { source: 'https://s/1', imageUrl: null } }],
  ['movies', (c) => new MoviesStrategy(c, new PostValidator(), registry as any, {} as any, {} as any),
    { sourceUrl: 'https://m/1', title: 't', contentType: 'movie', data: { title: 'T', source: 'https://m/1', releaseDate: null, voteAverage: 7, voteCount: 1, genreNames: [], imageUrl: null } }],
  ['on-this-day', (c) => new OnThisDayStrategy(c, new PostValidator(), registry as any, {} as any),
    { sourceUrl: 'https://b/1/1', title: 't', contentType: 'history', data: { events: [], births: [] } }],
  ['daily-photo', (c) => new DailyPhotoStrategy(c, new PostValidator(), registry as any, {} as any),
    { sourceUrl: 'https://apod/1', title: 't', contentType: 'apod', data: { title: 'T', copyright: null, imageUrl: 'https://i', date: '2026-01-01' } }],
];

for (const [name, make, fetched] of RUNNER_CASES) {
  test(`${name}: a refusal / too-short draft is a permanent rejection`, async () => {
    for (const reply of [REFUSAL, 'too short']) {
      const out = await make(claude(reply)).generate(fetched, {});
      assert.ok(out && typeof out === 'object' && typeof out.rejected === 'string', `${name}: ${JSON.stringify(out)}`);
    }
  });

  test(`${name}: no AI response (call failed) is transient → null`, async () => {
    assert.equal(await make(claude(null)).generate(fetched, {}), null);
  });
}

// ── game-channel (posted_news ledger) ─────────────────────────────────────────

function gameChannel(reply: string | null) {
  const calls = { markError: [] as any[], markPosted: [] as any[], published: 0 };
  const item = { type: 'giveaway', title: 'Free Game', description: 'd', source: 'https://g/1', imageUrl: null, publishedAt: null };
  const s = new GameChannelStrategy(
    claude(reply) as any, new PostValidator(), { review: async (t: string) => t } as any,
    {
      filterUnposted: async (items: any[]) => items,
      getLastPostedType: async () => null,
      markPosted: async (...a: any[]) => { calls.markPosted.push(a); },
      markError:  async (...a: any[]) => { calls.markError.push(a); },
    } as any,
    { download: async () => null } as any,
    { publish: async () => { calls.published++; return '1'; }, publishPrompt: async () => '1' } as any,
    registry as any,
    { fetch: async () => [item] } as any, { fetch: async () => [] } as any,
    { fetch: async () => [] } as any, { fetch: async () => [] } as any,
    { notifyPublished: async () => {} } as any, { insert: async () => {} } as any,
    { afterPublish: async () => {} } as any,
  );
  (s as any).findYoutubeUrl = async () => null;
  return { s, calls };
}

test('game-channel: validator rejection marks the item errored in posted_news', async () => {
  const { s, calls } = gameChannel(REFUSAL);
  await s.execute('@g', {});
  assert.equal(calls.published, 0);
  assert.equal(calls.markError.length, 1);
  assert.equal(calls.markError[0][0], 'https://g/1');
  assert.equal(calls.markError[0][2], '@g');
});

test('game-channel: no AI response leaves the item unmarked (retry)', async () => {
  const { s, calls } = gameChannel(null);
  await s.execute('@g', {});
  assert.deepEqual(calls.markError, []);
  assert.deepEqual(calls.markPosted, []);
});

// ── motivation-biography (birthdays pool) ─────────────────────────────────────

function biography(opts: { reply?: string | null; wiki?: any; publish?: () => Promise<string> }) {
  const calls = { markError: [] as any[], markPosted: [] as any[] };
  const s = new MotivationBiographyStrategy(
    registry as any,
    {
      getToday: async () => ({ id: 'b1', name: 'Ada Lovelace', month: 12, day: 10, year: 1815 }),
      markPosted: async (...a: any[]) => { calls.markPosted.push(a); },
      markError:  async (...a: any[]) => { calls.markError.push(a); },
    } as any,
    { getSummary: async () => ('wiki' in opts ? opts.wiki : { extract: 'e', description: 'd', pageUrl: 'https://w', imageUrl: null }) } as any,
    claude('reply' in opts ? opts.reply! : GOOD) as any,
    { review: async (t: string) => t } as any,
    new PostValidator(),
    { publish: opts.publish ?? (async () => '5') } as any,
    { notifyPublished: async () => {} } as any,
    { insert: async () => {} } as any,
    { afterPublish: async () => {} } as any,
  );
  return { s, calls };
}

test('motivation-biography: SKIP_POST and empty drafts mark the person errored', async () => {
  for (const reply of ['SKIP_POST', '   ']) {
    const { s, calls } = biography({ reply });
    await s.execute('@m', {});
    assert.equal(calls.markError.length, 1, JSON.stringify(reply));
    assert.deepEqual(calls.markError[0].slice(0, 2), ['b1', '@m']);
    assert.deepEqual(calls.markPosted, []);
  }
});

test('motivation-biography: no AI response leaves the person unmarked (retry)', async () => {
  const { s, calls } = biography({ reply: null });
  await s.execute('@m', {});
  assert.deepEqual(calls.markError, []);
  assert.deepEqual(calls.markPosted, []);
});

test('motivation-biography: missing Wikipedia data is an error mark, not a fake "posted"', async () => {
  const { s, calls } = biography({ wiki: null });
  await s.execute('@m', {});
  assert.equal(calls.markError.length, 1);
  assert.deepEqual(calls.markPosted, []);
});

test('motivation-biography: a permanent Telegram rejection marks the person errored', async () => {
  const { s, calls } = biography({
    publish: async () => { throw new Error("Bad Request: can't parse entities"); },
  });
  await s.execute('@m', {});
  assert.equal(calls.markError.length, 1);
});

test('motivation-biography: a transient Telegram failure leaves the person unmarked', async () => {
  const { s, calls } = biography({ publish: async () => { throw new Error('timeout of 30000ms exceeded'); } });
  await s.execute('@m', {});
  assert.deepEqual(calls.markError, []);
});

// ── assets ────────────────────────────────────────────────────────────────────

function assets(reply: string | null, publish?: () => Promise<string>) {
  const calls = { markError: [] as any[], markPosted: [] as any[], published: 0 };
  const s = new AssetsStrategy(
    registry as any,
    claude(reply) as any,
    { publish: publish ?? (async () => { calls.published++; return '9'; }) } as any,
    { notifyPublished: async () => {}, notifyFailed: async () => {} } as any,
    {
      getNext: async () => ({ id: 'a1', data_source: 'academy-openai', title: 'Case', description: 'Prompt', link: null, source_url: null, category: null, extra: null }),
      markPosted: async (...a: any[]) => { calls.markPosted.push(a); },
      markError:  async (...a: any[]) => { calls.markError.push(a); },
    } as any,
    { insert: async () => {} } as any,
    { afterPublish: async () => {} } as any,
  );
  return { s, calls };
}
const ASSET_PARAMS = { dataSource: 'academy-openai', posterUrl: 'https://p/x.png', tag: '#t' };

test('assets: SKIP_POST / empty AI text marks the asset errored (never published)', async () => {
  for (const reply of ['SKIP_POST', '']) {
    const { s, calls } = assets(reply);
    await s.execute('@a', ASSET_PARAMS);
    assert.equal(calls.published, 0);
    assert.equal(calls.markError.length, 1, JSON.stringify(reply));
    assert.deepEqual(calls.markError[0].slice(0, 2), ['a1', '@a']);
  }
});

test('assets: null AI text (call failed) leaves the asset unmarked (retry)', async () => {
  const { s, calls } = assets(null);
  await s.execute('@a', ASSET_PARAMS);
  assert.deepEqual(calls.markError, []);
});

test('assets: a permanent Telegram rejection marks the asset errored', async () => {
  const { s, calls } = assets(GOOD, async () => { throw new Error('Bad Request: message caption is too long'); });
  await s.execute('@a', ASSET_PARAMS);
  assert.equal(calls.markError.length, 1);
});

// ── ai0-prompts (prompts pool) ────────────────────────────────────────────────

function httpError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

function prompts(opts: {
  page?: () => Promise<any>; image?: () => Promise<any>; extract?: any;
  publishPrompt?: () => Promise<string>;
}) {
  mock.method(axios, 'get', async (_url: string, cfg: any) =>
    cfg?.responseType === 'arraybuffer'
      ? (opts.image ?? (async () => ({ data: Buffer.from('img') })))()
      : (opts.page ?? (async () => ({ data: '<html></html>' })))());
  const calls = { markError: [] as any[], markPosted: [] as any[] };
  const s = new Ai0PromptsStrategy(
    registry as any,
    { publishPrompt: opts.publishPrompt ?? (async () => '1') } as any,
    {
      getNext: async () => ({ id: 'https://img/p.png', prompt_source: 'https://ph/p', category: 'art', status: null, posted: null }),
      markPosted: async (...a: any[]) => { calls.markPosted.push(a); },
      markError:  async (...a: any[]) => { calls.markError.push(a); },
    } as any,
    {
      extractMeta: () => ('extract' in opts ? opts.extract : { prompt: 'x'.repeat(80) }),
      buildMessage: () => ({ isError: false, caption: 'A caption that is long enough', replyText: null }),
    } as any,
    { notifyPublished: async () => {} } as any,
    { insert: async () => {} } as any,
    { afterPublish: async () => {} } as any,
    {} as any,
    { fanOut: async () => {} } as any,
    {} as any,
    { span: (_s: any, _a: any, f: any) => f(), event() {} } as any,
  );
  (s as any).categories = ['art'];
  return { s, calls };
}

test('ai0-prompts: a dead prompt page (404/410) marks the row errored', async () => {
  for (const status of [404, 410]) {
    const { s, calls } = prompts({ page: async () => { throw httpError(status); } });
    await s.execute('@p', {});
    assert.equal(calls.markError.length, 1, String(status));
    assert.deepEqual(calls.markError[0].slice(0, 2), ['https://img/p.png', 'TELEGRAM']);
  }
});

test('ai0-prompts: a page timeout / 5xx is transient (unmarked)', async () => {
  for (const err of [new Error('timeout of 15000ms exceeded'), httpError(503)]) {
    const { s, calls } = prompts({ page: async () => { throw err; } });
    await s.execute('@p', {});
    assert.deepEqual(calls.markError, [], err.message);
  }
});

test('ai0-prompts: a page without an extractable prompt marks the row errored', async () => {
  const { s, calls } = prompts({ extract: null });
  await s.execute('@p', {});
  assert.equal(calls.markError.length, 1);
});

test('ai0-prompts: a dead image (404) marks the row errored; a timeout does not', async () => {
  let r = prompts({ image: async () => { throw httpError(404); } });
  await r.s.execute('@p', {});
  assert.equal(r.calls.markError.length, 1);
  r = prompts({ image: async () => { throw new Error('socket hang up'); } });
  await r.s.execute('@p', {});
  assert.deepEqual(r.calls.markError, []);
});

test('ai0-prompts: a permanent Telegram rejection marks the row errored; a transient one does not', async () => {
  let r = prompts({ publishPrompt: async () => { throw new Error('Bad Request: PHOTO_INVALID_DIMENSIONS'); } });
  await r.s.execute('@p', {});
  assert.equal(r.calls.markError.length, 1);
  assert.deepEqual(r.calls.markPosted, []);
  r = prompts({ publishPrompt: async () => { throw new Error('Too Many Requests: retry after 5'); } });
  await r.s.execute('@p', {});
  assert.deepEqual(r.calls.markError, []);
});
