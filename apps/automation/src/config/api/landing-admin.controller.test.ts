import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandingAdminController } from './landing-admin.controller';

test('LandingAdminController.list delegates to service.listAdmin', async () => {
  const canned = [{ platform: 'telegram', id: 't1', handle: 'x', displayName: null, avatarUrl: null, followerCount: null, url: 'https://t.me/x', order: 1, landingVisible: true }];
  const svc = { listAdmin: async () => canned } as any;
  const ctrl = new LandingAdminController(svc, {} as any);
  const out = await ctrl.list();
  assert.equal(out, canned);
});

test('LandingAdminController.patch 400s on unknown platform', async () => {
  const svc = { setFeatured: async () => {} } as any;
  const ctrl = new LandingAdminController(svc, {} as any);
  await assert.rejects(
    () => ctrl.patch('myspace', 'x', { landingVisible: true, landingOrder: 0 } as any),
    /platform/i,
  );
});

test('LandingAdminController.patch calls setFeatured with dto values on a valid platform', async () => {
  let captured: any = null;
  const svc = { setFeatured: async (platform: any, id: any, opts: any) => { captured = { platform, id, opts }; } } as any;
  const ctrl = new LandingAdminController(svc, {} as any);
  const out = await ctrl.patch('instagram', 'm1', { landingVisible: false, landingOrder: 9 } as any);
  assert.deepEqual(captured, { platform: 'instagram', id: 'm1', opts: { visible: false, order: 9 } });
  assert.deepEqual(out, { ok: true });
});

// Spec 026 FR-002/FR-015: the "Public page" settings.
test('LandingAdminController config: PUT passes strings/null through and 400s on other types', async () => {
  let patch: any = null;
  const config = { update: async (p: any) => { patch = p; return { ok: 1 }; }, adminConfig: async () => ({ cfg: 1 }) } as any;
  const ctrl = new LandingAdminController({} as any, config);
  assert.deepEqual(await ctrl.getConfig(), { cfg: 1 });
  await ctrl.putConfig({ adTgUsername: '@x_name', adMessage: null, whiteLabelEnabled: false });
  assert.deepEqual(patch, { adTgUsername: '@x_name', adMessage: null, whiteLabelEnabled: false });
  await ctrl.putConfig({});
  assert.deepEqual(patch, { adTgUsername: undefined, adMessage: undefined, whiteLabelEnabled: undefined }, 'absent fields stay untouched');
  assert.throws(() => ctrl.putConfig({ adTgUsername: 42 }), (e: any) => e.getStatus() === 400 && e.getResponse().issues[0].path === 'adTgUsername');
});

test('LandingAdminController preview forwards only the draft fields', async () => {
  let draft: any = null;
  const config = { preview: async (d: any) => { draft = d; return { valid: true }; } } as any;
  const ctrl = new LandingAdminController({} as any, config);
  await ctrl.preview({ adTgUsername: 'abcde', adMessage: 'Hi {target}', whiteLabelEnabled: false });
  assert.deepEqual(draft, { adTgUsername: 'abcde', adMessage: 'Hi {target}' });
});
