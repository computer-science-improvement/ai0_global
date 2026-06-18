import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DestinationResolver } from './destination-resolver.service';
import { SecretsService } from '../crypto/secrets.service';

function build(account: any) {
  const tiktok = { findById: async (id: string) => (account && account.id === id ? account : null) };
  const secrets = new SecretsService({ get: () => undefined } as any);
  const resolver = new DestinationResolver({ findById: async () => null } as any, { get: () => undefined } as any, tiktok as any, secrets, null as any, null as any);
  return resolver;
}

const BINDING = { id: 'b1', platform: 'tiktok', tiktokAccountId: 'tt1', metaAccountId: null, channelId: '' } as any;

test('resolves an active tiktok account to a TT: destination with no token', async () => {
  const r = build({ id: 'tt1', active: true });
  const dest = await r.resolve(BINDING);
  assert.equal(dest.platform, 'tiktok');
  assert.equal(dest.targetId, 'tt1');
  assert.equal(dest.postedKey, 'TT:tt1');
  assert.equal(dest.throttleKey, 'tiktok:tt1');
  assert.equal(dest.token, undefined);
  assert.equal(dest.metaAccountId, null);
});

test('throws when the tiktok account is missing', async () => {
  const r = build({ id: 'other', active: true });
  await assert.rejects(() => r.resolve(BINDING), /not found/i);
});

test('throws when the tiktok account is inactive', async () => {
  const r = build({ id: 'tt1', active: false });
  await assert.rejects(() => r.resolve(BINDING), /inactive/i);
});

test('throws when tiktok binding has no tiktok_account_id', async () => {
  const r = build({ id: 'tt1', active: true });
  await assert.rejects(() => r.resolve({ ...BINDING, tiktokAccountId: null }), /requires a tiktok_account_id/i);
});
