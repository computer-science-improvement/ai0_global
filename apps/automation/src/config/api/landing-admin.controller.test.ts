import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandingAdminController } from './landing-admin.controller';

test('LandingAdminController.list delegates to service.listAdmin', async () => {
  const canned = [{ platform: 'telegram', id: 't1', handle: 'x', displayName: null, avatarUrl: null, followerCount: null, url: 'https://t.me/x', order: 1, landingVisible: true }];
  const svc = { listAdmin: async () => canned } as any;
  const ctrl = new LandingAdminController(svc);
  const out = await ctrl.list();
  assert.equal(out, canned);
});

test('LandingAdminController.patch 400s on unknown platform', async () => {
  const svc = { setFeatured: async () => {} } as any;
  const ctrl = new LandingAdminController(svc);
  await assert.rejects(
    () => ctrl.patch('myspace', 'x', { landingVisible: true, landingOrder: 0 } as any),
    /platform/i,
  );
});

test('LandingAdminController.patch calls setFeatured with dto values on a valid platform', async () => {
  let captured: any = null;
  const svc = { setFeatured: async (platform: any, id: any, opts: any) => { captured = { platform, id, opts }; } } as any;
  const ctrl = new LandingAdminController(svc);
  const out = await ctrl.patch('instagram', 'm1', { landingVisible: false, landingOrder: 9 } as any);
  assert.deepEqual(captured, { platform: 'instagram', id: 'm1', opts: { visible: false, order: 9 } });
  assert.deepEqual(out, { ok: true });
});
