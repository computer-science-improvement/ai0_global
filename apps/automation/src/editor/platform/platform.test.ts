import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, implementedFormats, platformOfFormat } from './capabilities';
import { lintPlatformPost, PlatformPostSpecSchema, renderPlatform } from './platform-spec';
import { ResourcePublisher } from './resource-publisher';
import { publishPlatformNow, PublishPlatformDeps } from './publish-platform';
import { PlatformStatsCollector } from './platform-stats.collector';
import { ResourceHealthService } from './resource-health.service';

const spec = (o: any = {}) => PlatformPostSpecSchema.parse({
  format: 'ig_carousel', title: 'П’ять фактів про Марс', caption: '**Марс** — червона планета. Гортай 👉',
  hashtags: ['космос', 'марс', 'наука'],
  slides: [{ title: 'Марс', text: 'Доба на Марсі — 24 год 37 хв.' }, { title: 'Олімп', text: 'Найвища гора Сонячної системи.' }],
  ...o,
});

test('matrix: implemented formats and platform of a format', () => {
  assert.deepEqual(implementedFormats('instagram'), ['ig_photo', 'ig_carousel']);
  assert.ok(implementedFormats('youtube').length === 0, 'youtube waits for 019b');
  assert.equal(platformOfFormat('th_text'), 'threads');
  assert.equal(CAPABILITIES.threads.captionMax, 500);
});

test('lint: a good carousel passes; platform mismatch, unimplemented, counts, links, length', () => {
  assert.equal(lintPlatformPost(spec(), { platform: 'instagram' }).ok, true);
  const wrong = lintPlatformPost(spec(), { platform: 'threads' });
  assert.ok(wrong.errors.some((e) => e.code === 'wrong_platform'));
  assert.ok(lintPlatformPost(spec({ format: 'ig_reel', slides: undefined, media: [{ url: 'https://x/v.mp4', kind: 'video' }] }), { platform: 'instagram' })
    .errors.some((e) => e.code === 'format_not_implemented'));
  assert.ok(lintPlatformPost(spec({ slides: [{ title: 'a', text: 'b' }] }), { platform: 'instagram' }).errors.some((e) => e.code === 'media_count'));
  assert.ok(lintPlatformPost(spec({ caption: 'Деталі тут https://example.com/a' }), { platform: 'instagram' }).errors.some((e) => e.code === 'link_not_clickable'));
  const th = lintPlatformPost(spec({ format: 'th_text', slides: undefined, caption: 'x'.repeat(520) }), { platform: 'threads' });
  assert.ok(th.errors.some((e) => e.code === 'caption_too_long' && /на \d+ задовгий/.test(e.message)));
  assert.ok(lintPlatformPost(spec({ caption: 'Варто зазначити, що Марс…' }), { platform: 'instagram' }).errors.some((e) => e.code === 'banned_phrase'));
  assert.ok(lintPlatformPost(spec({ format: 'tt_photo', title: 'x'.repeat(95) }), { platform: 'tiktok' }).errors.some((e) => e.code === 'title_too_long'));
  assert.ok(lintPlatformPost(spec({ format: 'tt_photo', hashtags: Array.from({ length: 12 }, (_, i) => `t${i}`) }), { platform: 'tiktok' }).errors.some((e) => e.code === 'too_many_hashtags'));
});

test('render: plain caption, link policy per platform, slides replace media', () => {
  const ig = renderPlatform(spec({ link: { url: 'https://t.me/x', label: 'Telegram' } }), 'instagram', ['https://h/1.png', 'https://h/2.png']);
  assert.match(ig.caption, /^Марс — червона планета/);
  assert.match(ig.caption, /Посилання в біо/);
  assert.match(ig.caption, /#космос #марс #наука$/);
  assert.deepEqual(ig.imageUrls, ['https://h/1.png', 'https://h/2.png']);
  assert.equal(ig.carousel, true);
  const th = renderPlatform(spec({ format: 'th_text', slides: undefined, caption: 'Новий марсохід [читати](https://n.example/a)', link: undefined, hashtags: [] }), 'threads');
  assert.equal(th.caption, 'Новий марсохід читати (https://n.example/a)');
  assert.deepEqual(th.imageUrls, []);
});

test('resource publisher: Meta via the dispatcher (escaped caption), TikTok photo, YouTube not yet', async () => {
  const calls: any[] = [];
  const pub = new ResourcePublisher({
    metaAccount: async (id) => ({ platform: id === 'ig1' ? 'instagram' : 'threads', targetId: `t-${id}`, token: 'tok', active: true, username: 'acc' }),
    dispatcher: {
      publish: async (p, payload, target) => { calls.push(['single', p, payload.text, target.id]); return 'm1'; },
      publishCarousel: async (p, payload, urls) => { calls.push(['carousel', p, payload.text, urls.length]); return 'm2'; },
    },
    tiktok: { publishCarousel: async (acc, urls, cap) => { calls.push(['tiktok', acc, urls.length, cap]); return 'pub-1'; } },
    igComment: async (id, _t, msg) => { calls.push(['comment', id, msg]); },
  });
  const r = await pub.publish('instagram:ig1', { caption: 'A & B', imageUrls: ['u1', 'u2'], videoUrl: null, carousel: true, title: 't', firstComment: 'Джерело: …', link: null });
  assert.deepEqual(calls[0], ['carousel', 'instagram', 'A &amp; B', 2]);
  assert.deepEqual(calls[1], ['comment', 'm2', 'Джерело: …']);
  assert.equal(r.externalId, 'm2');
  const th = await pub.publish('threads:th1', { caption: 'Hi', imageUrls: [], videoUrl: null, carousel: false, title: 't', firstComment: null, link: null });
  assert.equal(th.url, 'https://www.threads.net/@acc/post/m1');
  const tt = await pub.publish('tiktok:a1', { caption: 'Опис', imageUrls: ['u1'], videoUrl: null, carousel: false, title: 'Заголовок', firstComment: null, link: null });
  assert.equal(tt.externalId, 'pub-1');
  assert.deepEqual(calls.at(-1), ['tiktok', 'a1', 1, 'Заголовок\n\nОпис']);
  await assert.rejects(pub.publish('youtube:y1', { caption: '', imageUrls: [], videoUrl: 'v', carousel: false, title: 't', firstComment: null, link: null }), /019b/);
  await assert.rejects(pub.publish('instagram:ig1', { caption: 'x', imageUrls: [], videoUrl: null, carousel: false, title: 't', firstComment: null, link: null }), /at least one image/);
});

function deps(o: Partial<{ posted: boolean; count: number; last: Date | null; health: any; recent: string[]; fail: boolean }> = {}) {
  const inserted: any[] = [];
  const published: any[] = [];
  let cleaned = 0;
  const d: PublishPlatformDeps = {
    posts: {
      insert: async (p: any) => { inserted.push(p); return { id: inserted.length, ...p } as any; },
      alreadyPosted: async () => !!o.posted,
      countPublishedSince: async () => o.count ?? 0,
      lastPostAt: async () => o.last ?? null,
      recentCaptions: async () => o.recent ?? [],
    },
    publisher: { publish: async (ref, r) => { if (o.fail) throw new Error('Graph: invalid image'); published.push([ref, r]); return { externalId: 'x1', url: null, warnings: [] }; } },
    hostSlides: async (slides) => ({ prepared: { slideUrls: slides.map((_, i) => `https://h/${i}.png`) }, cleanup: async () => { cleaned++; } }),
    health: async () => o.health ?? null,
    now: () => new Date('2026-10-02T10:00:00Z'),
  };
  return { d, inserted, published, cleaned: () => cleaned };
}

test('publishPlatformNow: shadow records without an API call; live renders slides, publishes, cleans up', async () => {
  const s = deps();
  const r: any = await publishPlatformNow(s.d, { resourceRef: 'instagram:ig1', spec: spec(), mode: 'shadow' });
  assert.equal(r.shadow, true);
  assert.equal(s.published.length, 0);
  assert.equal(s.inserted[0].status, 'shadowed');

  const l = deps();
  const lr: any = await publishPlatformNow(l.d, { resourceRef: 'instagram:ig1', spec: spec(), mode: 'live', slotId: 's1' });
  assert.equal(lr.ok, true, JSON.stringify(lr));
  assert.deepEqual(l.published[0][1].imageUrls, ['https://h/0.png', 'https://h/1.png']);
  assert.equal(l.inserted[0].status, 'published');
  assert.equal(l.cleaned(), 1);
});

test('publishPlatformNow: guards — lint, health, dedup, similarity, cap, gap, failure row', async () => {
  const bad: any = await publishPlatformNow(deps().d, { resourceRef: 'instagram:ig1', spec: spec({ slides: [] }), mode: 'live' });
  assert.equal(bad.error, 'lint_failed');
  assert.equal(((await publishPlatformNow(deps({ health: { state: 'token_invalid', detail: 'x' } }).d, { resourceRef: 'instagram:ig1', spec: spec(), mode: 'live' })) as any).error, 'resource_unavailable');
  assert.equal(((await publishPlatformNow(deps({ posted: true }).d, { resourceRef: 'instagram:ig1', spec: spec({ source: { url: 'https://a/b' } }), mode: 'live' })) as any).error, 'already_posted');
  const caption = 'Марс — червона планета. Гортай, щоб дізнатися пʼять фактів про сусіда Землі.';
  assert.equal(((await publishPlatformNow(deps({ recent: [`${caption}\n\n#космос #марс #наука`] }).d, { resourceRef: 'instagram:ig1', spec: spec({ caption }), mode: 'live' })) as any).error, 'too_similar');
  assert.equal(((await publishPlatformNow(deps({ count: 2 }).d, { resourceRef: 'instagram:ig1', spec: spec(), mode: 'live', maxPerDay: 2 })) as any).error, 'daily_cap_reached');
  assert.equal(((await publishPlatformNow(deps({ last: new Date('2026-10-02T09:30:00Z') }).d, { resourceRef: 'instagram:ig1', spec: spec(), mode: 'live' })) as any).error, 'min_gap');
  const f = deps({ fail: true });
  const fr: any = await publishPlatformNow(f.d, { resourceRef: 'instagram:ig1', spec: spec(), mode: 'live' });
  assert.equal(fr.error, 'publish_failed');
  assert.equal(f.inserted[0].status, 'failed');
  assert.equal(f.cleaned(), 1, 'slides are cleaned even on failure');
  assert.equal(((await publishPlatformNow(deps().d, { resourceRef: 'telegram:@x', spec: spec(), mode: 'live' })) as any).error, 'not_a_platform_resource');
});

test('stats collector: per-post Meta metrics and the daily rollup; errors never throw', async () => {
  const metrics: any[] = [];
  const daily: any[] = [];
  const c = new PlatformStatsCollector({
    // Spec 024: the day of each resource comes from SQL (resource_tz of the ref at `now`).
    pool: { query: async (sql: string, params?: any[]) => {
      if (/FROM meta_accounts/.test(sql)) {
        assert.match(sql, /resource_tz\(m\.platform \|\| ':' \|\| m\.id\)/);
        assert.equal(params?.[0]?.toISOString(), '2026-10-02T10:00:00.000Z');
        return { rows: [{ id: 'ig1', platform: 'instagram', followers: 1200, reach: 3400, impressions: 5000, day: '2026-10-02' }] };
      }
      if (/editor_v_channel_daily/.test(sql)) return { rows: [{ channel_id: '@space', subscribers: 5400, day: '2026-10-02' }] };
      return { rows: [] };
    } } as any,
    posts: {
      needingMetrics: async () => [
        { id: 1, resourceRef: 'instagram:ig1', externalId: 'm1' }, { id: 2, resourceRef: 'threads:th1', externalId: 't1' }, { id: 3, resourceRef: 'facebook:fb1', externalId: 'boom' },
      ] as any,
      addMetrics: async (id, m) => { metrics.push([id, m]); },
      upsertDaily: async (ref, day, v) => { daily.push([ref, day, v]); },
    },
    metaToken: async () => 'tok',
    graphGet: async (url) => {
      if (url.endsWith('/m1')) return { like_count: 10, comments_count: 2 };
      if (url.endsWith('/m1/insights')) return { data: [{ name: 'reach', values: [{ value: 900 }] }, { name: 'saved', values: [{ value: 7 }] }] };
      if (url.endsWith('/t1/insights')) return { data: [{ name: 'views', values: [{ value: 300 }] }, { name: 'reposts', values: [{ value: 2 }] }, { name: 'quotes', values: [{ value: 1 }] }] };
      throw new Error('Graph down');
    },
    graphBase: { facebook: 'https://g/v1', threads: 'https://th/v1' },
    now: () => new Date('2026-10-02T10:00:00Z'),
  });
  const r = await c.run();
  assert.deepEqual(r, { posts: 2, failed: 1, resources: 2 });
  assert.equal(metrics[0][1].reach, 900);
  assert.equal(metrics[0][1].saves, 7);
  assert.equal(metrics[1][1].views, 300);
  assert.equal(metrics[1][1].shares, 3);
  assert.deepEqual(daily.map((x) => x[0]), ['instagram:ig1', 'telegram:@space']);
  assert.equal(daily[0][1], '2026-10-02');
});

test('health: a change into a bad state notifies once; unknown stays usable', async () => {
  const store = new Map<string, any>();
  const posts: any[] = [];
  let state = 'ok';
  const h = new ResourceHealthService({
    catalog: { list: async () => [{ ref: 'tiktok:a1' }] as any, access: async () => ({ state: state as any, detail: 'd' }) },
    profiles: {
      setHealth: async (ref, hh) => { const prev = store.get(ref)?.state ?? null; store.set(ref, hh); return prev; },
      get: async (ref) => (store.has(ref) ? { health: store.get(ref) } as any : null),
    },
    inbox: { post: async (i) => { posts.push(i); return 1; } },
  });
  assert.equal(await h.usable('tiktok:a1'), true, 'never checked');
  await h.run();
  state = 'token_invalid';
  await h.run();
  await h.run();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].severity, 'critical');
  assert.equal(await h.usable('tiktok:a1'), false);
});
