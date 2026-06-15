import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokAccountsController } from './tiktok-accounts.controller';

function row(over = {}) {
  return {
    id: 'a1', open_id: 'open1', union_id: null, username: 'chef', display_name: 'Chef',
    avatar_url: 'https://x/a.png', access_token: 'SECRET_AT', refresh_token: 'SECRET_RT',
    access_token_expires_at: new Date(), refresh_token_expires_at: new Date(),
    scope: 'video.publish', active: true, last_refreshed_at: null, refresh_error: null, created_at: new Date(),
    ...over,
  };
}

function build(over: any = {}) {
  const calls: any = { deleted: null, setActive: null };
  const repo = {
    list: async () => [row()],
    delete: async (id: string) => { calls.deleted = id; return over.deleteResult ?? true; },
    setActive: async (id: string, a: boolean) => { calls.setActive = { id, a }; },
  };
  return { ctrl: new TikTokAccountsController(repo as any), calls };
}

test('GET / returns a token-free projection', async () => {
  const { ctrl } = build();
  const out = await ctrl.list();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a1');
  assert.equal(out[0].username, 'chef');
  assert.equal('access_token' in out[0], false);
  assert.equal('refresh_token' in out[0], false);
});

test('DELETE /:id calls repo.delete; 404 when missing', async () => {
  const { ctrl, calls } = build();
  await ctrl.remove('a1');
  assert.equal(calls.deleted, 'a1');
  const missing = build({ deleteResult: false });
  await assert.rejects(() => missing.ctrl.remove('nope'), /not found/i);
});

test('PATCH /:id sets active; rejects a non-boolean', async () => {
  const { ctrl, calls } = build();
  await ctrl.patch('a1', { active: false });
  assert.deepEqual(calls.setActive, { id: 'a1', a: false });
  await assert.rejects(() => ctrl.patch('a1', {} as any), /active/i);
});
