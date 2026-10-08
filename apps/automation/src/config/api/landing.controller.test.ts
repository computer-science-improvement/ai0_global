import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandingController } from './landing.controller';

test('LandingController.list delegates to service.listPublic', async () => {
  const canned = [{ platform: 'telegram', handle: 'x', displayName: null, avatarUrl: null, followerCount: null, url: 'https://t.me/x', order: 1 }];
  const svc = { listPublic: async () => canned } as any;
  const ctrl = new LandingController(svc, {} as any, {} as any);
  const out = await ctrl.list();
  assert.equal(out, canned);
});

test('LandingController.publicConfig delegates to the config service', async () => {
  const cfg = { defaultLang: 'en', adDm: { available: false, username: null, urls: {} }, whiteLabelEnabled: true };
  const ctrl = new LandingController({} as any, { publicConfig: async () => cfg } as any, {} as any);
  assert.equal(await ctrl.publicConfig(), cfg);
});
