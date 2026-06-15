import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandingResourcesService } from './landing-resources.service';

function makeService(over: {
  meta?: any[];
  tiktok?: any[];
  tracked?: any[];
  spies?: any;
} = {}) {
  const spies = over.spies ?? {};
  const metaRepo = {
    list: async () => over.meta ?? [],
    setLanding: async (id: string, o: any) => { spies.meta = { id, o }; },
  } as any;
  const tiktokRepo = {
    list: async () => over.tiktok ?? [],
    setLanding: async (id: string, o: any) => { spies.tiktok = { id, o }; },
  } as any;
  const trackedRepo = {
    listLandingCandidates: async () => over.tracked ?? [],
    setLanding: async (id: string, o: any) => { spies.tracked = { id, o }; },
  } as any;
  return { svc: new LandingResourcesService(metaRepo, tiktokRepo, trackedRepo), spies };
}

test('listAdmin maps all 5 platforms with id + landingVisible, includes non-visible, sorted', async () => {
  const { svc } = makeService({
    tracked: [
      { id: 't1', channel_key: '@ai0_global', username: 'ai0', title: 'AI0', subs_count: 1200, landing_visible: true, landing_order: 1 },
    ],
    meta: [
      { id: 'm1', platform: 'instagram', username: 'ig_user', display_name: 'IG', followers: 500, picture_url: 'http://pic/ig', active: true, landing_visible: false, landing_order: 2 },
      { id: 'm2', platform: 'facebook', username: 'fb_user', display_name: 'FB', followers: 300, picture_url: 'http://pic/fb', active: true, landing_visible: true, landing_order: 4 },
      { id: 'm3', platform: 'threads', username: 'th_user', display_name: 'TH', followers: 100, picture_url: 'http://pic/th', active: false, landing_visible: false, landing_order: 5 },
    ],
    tiktok: [
      { id: 'k1', username: 'tt_user', display_name: 'TT', avatar_url: 'http://pic/tt', active: true, landing_visible: false, landing_order: 3, access_token: 'SECRET', refresh_token: 'SECRET2' },
    ],
  });

  const out = await svc.listAdmin();
  assert.deepEqual(out.map((r) => r.order), [1, 2, 3, 4, 5]);

  const tg = out[0];
  assert.equal(tg.platform, 'telegram');
  assert.equal(tg.id, 't1');
  assert.equal(tg.handle, 'ai0_global');
  assert.equal(tg.displayName, 'AI0');
  assert.equal(tg.avatarUrl, null);
  assert.equal(tg.followerCount, 1200);
  assert.equal(tg.url, 'https://t.me/ai0_global');
  assert.equal(tg.landingVisible, true);

  const ig = out[1];
  assert.equal(ig.platform, 'instagram');
  assert.equal(ig.id, 'm1');
  assert.equal(ig.handle, 'ig_user');
  assert.equal(ig.avatarUrl, 'http://pic/ig');
  assert.equal(ig.followerCount, 500);
  assert.equal(ig.landingVisible, false); // non-visible included

  const tt = out[2];
  assert.equal(tt.platform, 'tiktok');
  assert.equal(tt.id, 'k1');
  assert.equal(tt.followerCount, null);
  assert.equal(tt.url, 'https://www.tiktok.com/@tt_user');
});

test('listAdmin never leaks token fields', async () => {
  const { svc } = makeService({
    tiktok: [
      { id: 'k1', username: 'tt', display_name: 'TT', avatar_url: null, active: true, landing_visible: false, landing_order: 1, access_token: 'AT', refresh_token: 'RT' },
    ],
  });
  const out = await svc.listAdmin();
  for (const r of out) {
    assert.ok(!('access_token' in r));
    assert.ok(!('refresh_token' in r));
    assert.deepEqual(
      Object.keys(r).sort(),
      ['avatarUrl', 'displayName', 'followerCount', 'handle', 'id', 'landingVisible', 'order', 'platform', 'url'].sort(),
    );
  }
});

test('setFeatured routes telegram -> tracked repo', async () => {
  const { svc, spies } = makeService();
  await svc.setFeatured('telegram', 't1', { visible: true, order: 3 });
  assert.deepEqual(spies.tracked, { id: 't1', o: { visible: true, order: 3 } });
});

test('setFeatured routes instagram/facebook/threads -> meta repo', async () => {
  for (const p of ['instagram', 'facebook', 'threads'] as const) {
    const { svc, spies } = makeService();
    await svc.setFeatured(p, 'm1', { visible: false, order: 7 });
    assert.deepEqual(spies.meta, { id: 'm1', o: { visible: false, order: 7 } });
  }
});

test('setFeatured routes tiktok -> tiktok repo', async () => {
  const { svc, spies } = makeService();
  await svc.setFeatured('tiktok', 'k1', { visible: true, order: 2 });
  assert.deepEqual(spies.tiktok, { id: 'k1', o: { visible: true, order: 2 } });
});

test('setFeatured throws on unknown platform', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.setFeatured('myspace' as any, 'x', { visible: true, order: 0 }), /platform/i);
});
