import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandingResourcesService, landingUrl } from './landing-resources.service';

function makeService(over: {
  meta?: any[];
  tiktok?: any[];
  tracked?: any[];
} = {}) {
  const metaRepo = { listFeatured: async () => over.meta ?? [] } as any;
  const tiktokRepo = { listFeatured: async () => over.tiktok ?? [] } as any;
  const trackedRepo = { listFeatured: async () => over.tracked ?? [] } as any;
  return new LandingResourcesService(metaRepo, tiktokRepo, trackedRepo);
}

test('landingUrl derives a url per platform', () => {
  assert.equal(landingUrl('telegram', 'ai0_global'), 'https://t.me/ai0_global');
  assert.equal(landingUrl('instagram', 'foo'), 'https://www.instagram.com/foo');
  assert.equal(landingUrl('facebook', 'foo'), 'https://www.facebook.com/foo');
  assert.equal(landingUrl('threads', 'foo'), 'https://www.threads.net/@foo');
  assert.equal(landingUrl('tiktok', 'foo'), 'https://www.tiktok.com/@foo');
});

test('landingUrl returns null when handle is null', () => {
  assert.equal(landingUrl('telegram', null), null);
  assert.equal(landingUrl('tiktok', null), null);
});

test('listPublic maps all 5 platforms with correct fields', async () => {
  const svc = makeService({
    tracked: [
      { id: 't1', channel_key: '@ai0_global', username: 'ai0', title: 'AI0', subs_count: 1200, landing_order: 1 },
    ],
    meta: [
      { platform: 'instagram', username: 'ig_user', display_name: 'IG', followers: 500, picture_url: 'http://pic/ig', landing_order: 2 },
      { platform: 'facebook', username: 'fb_user', display_name: 'FB', followers: 300, picture_url: 'http://pic/fb', landing_order: 4 },
      { platform: 'threads', username: 'th_user', display_name: 'TH', followers: 100, picture_url: 'http://pic/th', landing_order: 5 },
    ],
    tiktok: [
      { username: 'tt_user', display_name: 'TT', avatar_url: 'http://pic/tt', landing_order: 3, access_token: 'SECRET', refresh_token: 'SECRET2' },
    ],
  });

  const out = await svc.listPublic();

  // sorted by order across sources: 1,2,3,4,5
  assert.deepEqual(out.map((r) => r.order), [1, 2, 3, 4, 5]);

  const tg = out[0];
  assert.equal(tg.platform, 'telegram');
  assert.equal(tg.handle, 'ai0_global'); // leading @ stripped
  assert.equal(tg.displayName, 'AI0');
  assert.equal(tg.avatarUrl, null);      // telegram avatar null
  assert.equal(tg.followerCount, 1200);
  assert.equal(tg.url, 'https://t.me/ai0_global');

  const ig = out[1];
  assert.equal(ig.platform, 'instagram');
  assert.equal(ig.handle, 'ig_user');
  assert.equal(ig.displayName, 'IG');
  assert.equal(ig.avatarUrl, 'http://pic/ig');
  assert.equal(ig.followerCount, 500);
  assert.equal(ig.url, 'https://www.instagram.com/ig_user');

  const tt = out[2];
  assert.equal(tt.platform, 'tiktok');
  assert.equal(tt.handle, 'tt_user');
  assert.equal(tt.avatarUrl, 'http://pic/tt');
  assert.equal(tt.followerCount, null); // tiktok followerCount null
  assert.equal(tt.url, 'https://www.tiktok.com/@tt_user');
});

test('listPublic never leaks token fields', async () => {
  const svc = makeService({
    tiktok: [
      { username: 'tt', display_name: 'TT', avatar_url: null, landing_order: 1, access_token: 'AT', refresh_token: 'RT' },
    ],
  });
  const out = await svc.listPublic();
  for (const r of out) {
    assert.ok(!('access_token' in r));
    assert.ok(!('refresh_token' in r));
    assert.deepEqual(
      Object.keys(r).sort(),
      ['avatarUrl', 'displayName', 'followerCount', 'handle', 'order', 'platform', 'url'].sort(),
    );
  }
});

test('telegram handle falls back to username when channel_key is null and strips @', async () => {
  const svc = makeService({
    tracked: [
      { id: 't1', channel_key: null, username: '@fallback', title: null, subs_count: null, landing_order: 1 },
    ],
  });
  const out = await svc.listPublic();
  assert.equal(out[0].handle, 'fallback');
  assert.equal(out[0].url, 'https://t.me/fallback');
});
