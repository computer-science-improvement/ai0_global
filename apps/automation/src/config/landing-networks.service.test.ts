import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LandingNetworksService, buildAdminNetworks, buildNetworks, networkPatchIssues,
  type AgentRow, type GroupRow, type NetworksInput,
} from './landing-networks.service';
import type { LandingFeaturedEntry, LandingPlatform } from './landing-resources.service';
import type { ResourceListItem } from '../editor/agents/resource-catalog';
import { LandingController } from './api/landing.controller';
import { LandingAdminController } from './api/landing-admin.controller';

const G_NEWS = '11111111-1111-4111-8111-111111111111';
const G_FOOD = '22222222-2222-4222-8222-222222222222';

function entry(platform: LandingPlatform, ref: string | null, handle: string, order: number, followers: number | null = null, channelKey: string | null = null): LandingFeaturedEntry {
  return {
    ref, channelKey,
    resource: { platform, handle, displayName: handle.toUpperCase(), avatarUrl: null, followerCount: followers, url: `https://x/${handle}`, order },
  };
}

function item(ref: string, platform: LandingPlatform, groupId: string | null, agent: string | null): ResourceListItem {
  return { ref, platform: platform as any, title: null, username: null, followers: null, groupId, groupName: null, agent };
}

function agent(handle: string, mode: string, extra: Partial<AgentRow> = {}): AgentRow {
  return { handle, name: `Agent ${handle.toUpperCase()}`, emoji: '🤖', mode, status: 'active', scope: 'resource', scope_id: null, ...extra };
}

const GROUPS: GroupRow[] = [
  { id: G_NEWS, name: 'News', landing_blurb_en: '  Fast news, written by agents.  ', landing_order: 2 },
  { id: G_FOOD, name: 'Food', landing_blurb_en: null, landing_order: 1 },
];

/** live, shadow and legacy (no agent) fixtures, plus off and paused agents. */
function fixture(over: Partial<NetworksInput> = {}): NetworksInput {
  return {
    entries: [
      entry('telegram', 'telegram:@news_live', 'news_live', 1, 1000, '@news_live'),
      entry('instagram', 'instagram:m1', 'news_ig', 2, 500),
      entry('telegram', 'telegram:@food_shadow', 'food_shadow', 3, 200, '@food_shadow'),
      entry('telegram', 'telegram:@legacy', 'legacy', 4, 50, '@legacy'),
      entry('tiktok', 'tiktok:k1', 'off_agent', 5),
      entry('threads', 'threads:t1', 'paused_agent', 6),
      entry('facebook', 'facebook:f1', 'approve_agent', 7),
    ],
    catalog: [
      item('telegram:@news_live', 'telegram', G_NEWS, 'news_bot'),
      item('instagram:m1', 'instagram', G_NEWS, 'news_bot'),
      item('telegram:@food_shadow', 'telegram', G_FOOD, 'food_bot'),
      item('telegram:@legacy', 'telegram', null, null),
      item('tiktok:k1', 'tiktok', null, 'off_bot'),
      item('threads:t1', 'threads', null, 'paused_bot'),
      item('facebook:f1', 'facebook', null, 'approve_bot'),
    ],
    agents: [
      agent('news_bot', 'live'),
      agent('food_bot', 'shadow'),
      agent('off_bot', 'off'),
      agent('paused_bot', 'live', { status: 'paused' }),
      agent('approve_bot', 'approve'),
    ],
    groups: GROUPS,
    pricedKeys: ['@news_live'],
    adDm: { username: 'ads_desk', template: "Hi! I'd like to order an ad in {target}. {ref}" },
    ...over,
  };
}

test('aiRun badges: live, approve → live, shadow, and none for legacy, off and paused', () => {
  const out = buildNetworks(fixture());
  const runs = Object.fromEntries(out.flatMap((n) => n.resources).map((r) => [r.handle, r.aiRun]));
  assert.deepEqual(runs, {
    news_live: 'live', news_ig: 'live', food_shadow: 'shadow',
    legacy: 'none', off_agent: 'none', paused_agent: 'none', approve_agent: 'live',
  });
});

test('networks are ordered by landing_order, standalone resources come last under name null', () => {
  const out = buildNetworks(fixture());
  assert.deepEqual(out.map((n) => n.name), ['Food', 'News', null]);
  const news = out[1];
  assert.equal(news.blurb, 'Fast news, written by agents.', 'the blurb is trimmed');
  assert.deepEqual(news.agent, { name: 'Agent NEWS_BOT', emoji: '🤖', mode: 'live' });
  assert.equal(news.followers, 1500);
  assert.deepEqual(news.platforms, ['telegram', 'instagram']);
  assert.equal(out[0].agent?.mode, 'shadow');
  const standalone = out[2];
  assert.equal(standalone.agent, null);
  assert.equal(standalone.order > news.order, true);
  assert.deepEqual(standalone.resources.map((r) => r.handle), ['legacy', 'off_agent', 'paused_agent', 'approve_agent']);
});

test('the "Ads here" link is set only on a channel with an active price, with the channel in the tag', () => {
  const out = buildNetworks(fixture());
  const all = out.flatMap((n) => n.resources);
  const live = all.find((r) => r.handle === 'news_live')!;
  assert.ok(live.adDmUrl?.startsWith('https://t.me/ads_desk?text='));
  const text = decodeURIComponent(live.adDmUrl!.split('?text=')[1]);
  assert.match(text, /order an ad in NEWS_LIVE\. \[ai0web:resource:news_live\]$/);
  for (const r of all.filter((x) => x.handle !== 'news_live')) assert.equal(r.adDmUrl, null, String(r.handle));
  const news = out.find((n) => n.name === 'News')!;
  assert.match(decodeURIComponent(news.adDmUrl!.split('?text=')[1]), /in News\. \[ai0web:network:news_live\]$/);
  assert.equal(out.find((n) => n.name === 'Food')!.adDmUrl, null);
});

test('no DM account resolved: no ad links at all', () => {
  const out = buildNetworks(fixture({ adDm: null }));
  assert.ok(out.flatMap((n) => [n.adDmUrl, ...n.resources.map((r) => r.adDmUrl)]).every((u) => u === null));
});

test('the public payload carries no ids, agent handles or refs', () => {
  const json = JSON.stringify(buildNetworks(fixture()));
  for (const secret of [G_NEWS, G_FOOD, 'news_bot', 'food_bot', 'approve_bot', 'telegram:@', 'instagram:m1', '"ref"', '"id"', 'channelKey', 'status']) {
    assert.ok(!json.includes(secret), `leaked ${secret}`);
  }
});

test('YouTube shows up as a platform only when a featured YouTube resource exists', () => {
  const base = buildNetworks(fixture());
  const platforms = (ns: typeof base) => new Set(ns.flatMap((n) => n.platforms));
  assert.equal(platforms(base).has('youtube'), false);
  const withYt = fixture();
  withYt.entries.push(entry('youtube', 'youtube:y1', 'yt_channel', 8, null));
  withYt.catalog.push(item('youtube:y1', 'youtube', G_NEWS, 'news_bot'));
  const out = buildNetworks(withYt);
  assert.equal(platforms(out).has('youtube'), true);
  assert.equal(platforms(out).size, platforms(base).size + 1);
  const news = out.find((n) => n.name === 'News')!;
  assert.deepEqual(news.platforms, ['telegram', 'instagram', 'youtube']);
  assert.equal(news.resources.find((r) => r.platform === 'youtube')!.aiRun, 'live');
});

test('network agent: own network orchestrator first, then the Telegram anchor, then a shared agent', () => {
  const input = fixture();
  input.agents.push(agent('net_orch', 'shadow', { scope: 'network', scope_id: G_NEWS }));
  assert.equal(buildNetworks(input).find((n) => n.name === 'News')!.agent?.name, 'Agent NET_ORCH');

  // Mixed agents and no Telegram anchor: no single agent runs the network.
  const mixed = fixture({
    entries: [entry('instagram', 'instagram:a', 'a', 1), entry('facebook', 'facebook:b', 'b', 2)],
    catalog: [item('instagram:a', 'instagram', G_FOOD, 'news_bot'), item('facebook:b', 'facebook', G_FOOD, 'food_bot')],
  });
  assert.equal(buildNetworks(mixed)[0].agent, null);
});

test('a resource whose network was deleted, or a ref the catalog does not know, is standalone', () => {
  const out = buildNetworks(fixture({
    entries: [entry('telegram', 'telegram:@ghost', 'ghost', 1), entry('telegram', null, 'nokey', 2)],
    catalog: [item('telegram:@ghost', 'telegram', 'deleted-group', 'news_bot')],
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, null);
  assert.deepEqual(out[0].resources.map((r) => r.aiRun), ['live', 'none']);
});

test('admin networks list every network with counts; the preview equals the public payload', async () => {
  const input = fixture();
  const admin = buildAdminNetworks(input);
  assert.deepEqual(admin.map((n) => [n.name, n.resources, n.featured]), [['Food', 1, 1], ['News', 2, 2]]);
  assert.equal(admin[1].id, G_NEWS);

  const svc = serviceFor(input);
  const { preview } = await svc.admin();
  assert.deepEqual(preview, await svc.list());
});

function serviceFor(input: NetworksInput, now = () => 0) {
  let loads = 0;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (/FROM agents/.test(sql)) return { rows: input.agents };
      if (/SELECT id, name, landing_blurb_en/.test(sql)) return { rows: input.groups };
      if (/FROM ad_prices/.test(sql)) return { rows: input.pricedKeys.map((channel_key) => ({ channel_key })) };
      if (/UPDATE meta_account_groups/.test(sql)) return { rowCount: input.groups.some((g) => g.id === params![0]) ? 1 : 0, rows: [] };
      if (/SELECT 1 FROM meta_account_groups/.test(sql)) return { rowCount: input.groups.some((g) => g.id === params![0]) ? 1 : 0, rows: [] };
      throw new Error(`unexpected ${sql}`);
    },
  };
  const svc = new LandingNetworksService({
    pool: pool as any,
    resources: { listFeaturedEntries: async () => { loads++; return input.entries; } },
    catalog: { list: async () => input.catalog },
    adDm: async () => input.adDm,
    now,
  });
  return Object.assign(svc, { loads: () => loads });
}

test('the public list is cached for 300 s, an admin edit drops the cache, a failed refresh serves the old value', async () => {
  let t = 0;
  const input = fixture();
  const svc = serviceFor(input, () => t);
  await svc.list();
  await svc.list();
  assert.equal(svc.loads(), 1);
  t = 299_000;
  await svc.list();
  assert.equal(svc.loads(), 1);
  assert.equal(await svc.patchNetwork(G_NEWS, { blurb: 'x' }), true);
  await svc.list();
  assert.equal(svc.loads(), 2, 'the edit invalidated the cache');
  assert.equal(await svc.patchNetwork('33333333-3333-4333-8333-333333333333', { order: 1 }), false);

  t = 1_000_000;
  const broken = svc as any;
  broken.d.catalog = { list: async () => { throw new Error('db down'); } };
  const stale = await svc.list();
  assert.equal(stale.length, 3, 'stale value served');
});

test('network patch validation', () => {
  assert.deepEqual(networkPatchIssues({ blurb: 'ok', order: 3 }), []);
  assert.deepEqual(networkPatchIssues({ blurb: null }), []);
  assert.equal(networkPatchIssues({ blurb: 'x'.repeat(281) })[0].path, 'blurb');
  assert.equal(networkPatchIssues({ blurb: 5 })[0].path, 'blurb');
  assert.equal(networkPatchIssues({ order: -1 })[0].path, 'order');
  assert.equal(networkPatchIssues({ order: 1.5 })[0].path, 'order');
  assert.equal(networkPatchIssues({ order: '2' })[0].path, 'order');
});

test('controllers: public networks sets Cache-Control; admin PATCH validates, 404s and invalidates', async () => {
  const input = fixture();
  const svc = serviceFor(input);
  const headers: Record<string, string> = {};
  const ctrl = new LandingController({} as any, {} as any, {} as any, svc);
  const out = await ctrl.networks({ setHeader: (k: string, v: string) => { headers[k] = v; } } as any);
  assert.equal(out.length, 3);
  assert.equal(headers['Cache-Control'], 'public, max-age=300');

  const admin = new LandingAdminController({ setFeatured: async () => {} } as any, {} as any, svc);
  assert.deepEqual(await admin.patchNetwork(G_NEWS, { blurb: 'Hello', order: 2 }), { ok: true });
  await assert.rejects(admin.patchNetwork(G_NEWS, { order: -3 }), (e: any) => e.getStatus() === 400 && e.getResponse().issues[0].path === 'order');
  await assert.rejects(admin.patchNetwork('not-a-uuid', { order: 1 }), (e: any) => e.getStatus() === 404);
  await assert.rejects(admin.patchNetwork('33333333-3333-4333-8333-333333333333', { order: 1 }), (e: any) => e.getStatus() === 404);

  // A featured toggle also drops the public cache.
  await svc.list();
  const before = svc.loads();
  await admin.patch('youtube', 'y1', { landingVisible: true, landingOrder: 0 } as any);
  await svc.list();
  assert.equal(svc.loads(), before + 1);
});
