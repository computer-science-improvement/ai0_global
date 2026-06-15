import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandingController } from './landing.controller';

test('LandingController.list delegates to service.listPublic', async () => {
  const canned = [{ platform: 'telegram', handle: 'x', displayName: null, avatarUrl: null, followerCount: null, url: 'https://t.me/x', order: 1 }];
  const svc = { listPublic: async () => canned } as any;
  const ctrl = new LandingController(svc);
  const out = await ctrl.list();
  assert.equal(out, canned);
});
