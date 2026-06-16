import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

function make(over: any = {}) {
  const repo = {
    findByExtId: async () => null,
    insert: async (row: any) => ({ id: 'new', ...row }),
    findById: async () => null,
    update: async (id: string, patch: any) => ({ id, ...patch }),
    ...over.repo,
  };
  const cache = { getChannelById: (id: string) => (over.channelExists === false ? null : { id }) };
  const metaAccounts = { findById: async () => (over.accountExists === false ? null : { id: 'acct-1', active: true }) };
  const publisher = { publish: async () => {} };
  return new StrategiesController(
    repo as any,        // repo
    {} as any,          // runsRepo
    {} as any,          // preview
    cache as any,       // cache
    publisher as any,   // publisher
    {} as any,          // crossposts
    {} as any,          // runway
    metaAccounts as any,// metaAccounts
    { types: () => [], supportedPlatforms: () => ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'] } as any,
    { findById: async () => null } as any,
  );
}

test('patch with a new unique ext_id calls update with ext_id and succeeds', async () => {
  let updateArgs: any = null;
  const c = make({
    repo: {
      findById: async () => ({ id: 's1', ext_id: 'old', platform: 'telegram' }),
      findByExtId: async () => null, // new name is free
      update: async (id: string, patch: any) => { updateArgs = { id, patch }; return { id, ...patch }; },
    },
  });
  const row = await c.patch('s1', { ext_id: 'new-name' } as any);
  assert.equal(updateArgs.id, 's1');
  assert.equal(updateArgs.patch.ext_id, 'new-name');
  assert.equal(row!.ext_id, 'new-name');
});

test('patch with an ext_id belonging to a different binding throws ConflictException', async () => {
  const c = make({
    repo: {
      findById: async () => ({ id: 's1', ext_id: 'old', platform: 'telegram' }),
      findByExtId: async () => ({ id: 's2', ext_id: 'taken', platform: 'telegram' }),
    },
  });
  await assert.rejects(
    () => c.patch('s1', { ext_id: 'taken' } as any),
    /ext_id taken already exists/,
  );
});

test('patch where findByExtId returns the same binding is idempotent (no conflict)', async () => {
  let updated = false;
  const c = make({
    repo: {
      findById: async () => ({ id: 's1', ext_id: 'same', platform: 'telegram' }),
      findByExtId: async () => ({ id: 's1', ext_id: 'same', platform: 'telegram' }),
      update: async (id: string, patch: any) => { updated = true; return { id, ...patch }; },
    },
  });
  // ext_id unchanged from existing → skip the dup check entirely; still allowed
  const row = await c.patch('s1', { ext_id: 'same' } as any);
  assert.equal(row!.ext_id, 'same');
  assert.equal(updated, true);
});
