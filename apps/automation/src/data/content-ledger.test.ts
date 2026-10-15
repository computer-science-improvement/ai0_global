// Spec 023 T1: the ContentLedger client — resource refs, spec refs, best-effort recording and the
// queries it sends (the rules themselves run in SQL; see content-ledger.pg.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentLedger, ledgerResource, specRefs } from './content-ledger';

function fakePool(answer: (sql: string, params: unknown[]) => any[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: answer(sql, params), rowCount: 0 }; } } as any,
  };
}

test('ledgerResource: a channel key becomes telegram:<key>; a resource ref stays', () => {
  assert.equal(ledgerResource('@chan'), 'telegram:@chan');
  assert.equal(ledgerResource('telegram:@chan'), 'telegram:@chan');
  assert.equal(ledgerResource('instagram:42'), 'instagram:42');
});

test('specRefs: library item and source URL, blanks dropped', () => {
  assert.deepEqual(specRefs({ library_ref: 'data://recipes/1', source: { url: 'https://x' } }), ['data://recipes/1', 'https://x']);
  assert.deepEqual(specRefs({ library_ref: null, source: null }), []);
  assert.deepEqual(specRefs(null), []);
});

test('record: calls content_ledger_record with the resource ref, drops a non-uuid slot id; blanks never query', async () => {
  const f = fakePool(() => [{ added: true }]);
  const l = new ContentLedger(f.pool);
  assert.equal(await l.record('', { resourceRef: '@c', origin: 'editor', status: 'published' }), false);
  assert.equal(f.calls.length, 0);
  assert.equal(await l.record('https://x.example/a', { resourceRef: '@c', origin: 'chat', status: 'published', slotId: 'not-a-uuid', publishedPostId: 5 }), true);
  assert.match(f.calls[0].sql, /content_ledger_record/);
  assert.deepEqual(f.calls[0].params.slice(0, 7), ['telegram:@c', 'https://x.example/a', 'chat', 'published', 5, null, null]);
});

test('recordRefs: dedups refs, never throws, logs a failure', async () => {
  const logs: string[] = [];
  let n = 0;
  const pool = { query: async () => { n++; if (n === 1) throw new Error('db down'); return { rows: [{ added: true }] }; } } as any;
  const l = new ContentLedger(pool, (m) => logs.push(m));
  const recorded = await l.recordRefs(['https://a.example/1', 'https://a.example/1', null, undefined, ' ', 'https://b.example/1'], { resourceRef: '@c', origin: 'editor', status: 'published' });
  assert.equal(recorded, 1);
  assert.equal(n, 2, 'one query per distinct ref');
  assert.match(logs[0], /db down/);
});

test('check: aliases first, then the ledger with scope/publishedOnly/excludeSlotId; waiting only when asked', async () => {
  const f = fakePool((sql) => (sql.includes('content_ref_aliases') ? [{ refs: ['data://q/1', 'library://quotes/7'] }] : []));
  const l = new ContentLedger(f.pool);
  assert.deepEqual(await l.check('@c', '  '), { used: false });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await l.check('@c', 'library://quotes/7'), { used: false });
  assert.equal(f.calls.length, 2, 'no waiting query by default');
  assert.deepEqual(f.calls[1].params.slice(0, 3), ['telegram:@c', ['data://q/1', 'library://quotes/7'], 'resource']);
  await l.check('@c', 'library://quotes/7', { waiting: true, excludeSlotId: '7d4f8a52-0d0b-4c9e-9f3c-1f2e3d4c5b6a' });
  assert.equal(f.calls.length, 5);
  assert.match(f.calls[4].sql, /awaiting_approval/);
  assert.equal(f.calls[4].params[2], '7d4f8a52-0d0b-4c9e-9f3c-1f2e3d4c5b6a');
});

test('check: a ledger hit answers with its status, resource and time', async () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const f = fakePool((sql) => (sql.includes('content_ref_aliases') ? [{ refs: ['https://x.example/a'] }]
    : sql.includes('content_ledger_blocking') ? [{ status: 'error', resource_ref: 'telegram:@o', source_ref: 'https://x.example/a', used_at: at }] : []));
  const v = await new ContentLedger(f.pool).check('@c', 'https://x.example/a', { waiting: true });
  assert.deepEqual(v, { used: true, status: 'error', resourceRef: 'telegram:@o', ref: 'https://x.example/a', at });
  assert.equal(f.calls.length, 2, 'a ledger hit skips the waiting query');
});

test('037 T4: a site root or a section index is never recorded nor checked (it names a site, not an item)', async () => {
  const logs: string[] = [];
  const f = fakePool(() => [{ added: true, refs: ['x'] }]);
  const l = new ContentLedger(f.pool, (m) => logs.push(m));
  for (const root of ['https://store.steampowered.com/', 'https://www.marktechpost.com', 'https://itch.io/new-and-popular', 'https://store.epicgames.com/en-US/free-games']) {
    assert.equal(await l.record(root, { resourceRef: '@c', origin: 'editor', status: 'published' }), false, root);
    assert.deepEqual(await l.check('@c', root, { waiting: true }), { used: false }, root);
  }
  assert.equal(f.calls.length, 0, 'no query for a site root');
  assert.match(logs[0], /site root/);
  assert.equal(await l.recordRefs(['https://store.steampowered.com/', 'https://store.steampowered.com/app/1174180'], { resourceRef: '@c', origin: 'editor', status: 'published' }), 2);
  assert.equal(f.calls.length, 1, 'only the game page reaches the ledger');
});
