// Spec 023 T7 phase B: the boot safety net for bindings that are still enabled but no longer run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLegacyBindings, describeBindings, legacyBindingsNote, LegacyBindingsCheck,
  LEGACY_BINDINGS_KIND, LEGACY_BINDINGS_REF_TYPE,
} from './legacy-bindings.check';

const ROWS = [
  { ext_id: 'quotes:a', type: 'quotes', platform: 'telegram', target: '@ai0_quotes' },
  { ext_id: 'recipes:a', type: 'recipes', platform: 'telegram', target: '@ai0_quotes' },
  { ext_id: 'recipe-carousel:ig', type: 'recipe-carousel', platform: 'instagram', target: '@ai0.recipes' },
];

function fakePool(bindings: any[], opts: { failBindings?: boolean; failRuns?: boolean; orphaned?: number } = {}) {
  const sql: string[] = [];
  return {
    sql,
    pool: {
      query: async (q: string) => {
        sql.push(q);
        if (/UPDATE strategy_runs/.test(q)) {
          if (opts.failRuns) throw new Error('runs boom');
          return { rows: [], rowCount: opts.orphaned ?? 0 };
        }
        if (opts.failBindings) throw new Error('relation "strategy_bindings" does not exist');
        return { rows: bindings, rowCount: bindings.length };
      },
    } as any,
  };
}

function fakeInbox() {
  const posted: any[] = [];
  const seen = new Set<string>();
  return {
    posted,
    inbox: {
      postOnce: async (i: any) => {
        const key = `${i.kind}|${i.refType}|${i.refId}`;
        if (seen.has(key)) return null;
        seen.add(key);
        posted.push(i);
        return posted.length;
      },
    },
  };
}

const log = () => {
  const warns: string[] = [];
  return { warns, log: { warn: (m: string) => { warns.push(m); }, log: () => {} } };
};

test('the read-only query: enabled and not retired, resolved to a channel / account', () => {
  const { pool, sql } = fakePool([]);
  return checkLegacyBindings({ pool, inbox: null, log: log().log }).then(() => {
    const q = sql.find((s) => /FROM strategy_bindings/.test(s))!;
    assert.match(q, /WHERE sb\.enabled AND sb\.retired_at IS NULL/);
    assert.doesNotMatch(q, /\b(INSERT|UPDATE|DELETE)\b/);
  });
});

test('nothing enabled → no warning, no note', async () => {
  const { pool } = fakePool([]);
  const { inbox, posted } = fakeInbox();
  const l = log();
  const r = await checkLegacyBindings({ pool, inbox, log: l.log });
  assert.deepEqual(r.bindings, []);
  assert.equal(r.noted, null);
  assert.deepEqual(posted, []);
  assert.deepEqual(l.warns, []);
});

test('enabled bindings → a warning and ONE English Inbox note per Kyiv day', async () => {
  const { pool } = fakePool(ROWS);
  const { inbox, posted } = fakeInbox();
  const l = log();
  const now = () => new Date('2026-10-15T22:30:00Z'); // 01:30 Kyiv on the 16th
  const first = await checkLegacyBindings({ pool, inbox, log: l.log, now });
  assert.equal(first.bindings.length, 3);
  assert.equal(first.noted, 1);
  assert.match(l.warns[0], /3 legacy strategy binding\(s\) are enabled but no longer run/);
  const n = posted[0];
  assert.equal(n.kind, LEGACY_BINDINGS_KIND);
  assert.equal(n.severity, 'action');
  assert.equal(n.refType, LEGACY_BINDINGS_REF_TYPE);
  assert.equal(n.refId, '2026-10-16', 'the Kyiv day, not the UTC one');
  assert.match(n.body, /^Legacy strategy bindings are enabled but no longer run: @ai0_quotes \(quotes, recipes\); instagram @ai0\.recipes \(recipe-carousel\)\. Content for these channels is written by agents; migrate or disable them\./);
  assert.match(n.alert.body, /migrate or disable them/);

  // A second boot the same day: still warned in the log, no second note.
  const again = await checkLegacyBindings({ pool, inbox, log: l.log, now });
  assert.equal(again.noted, null);
  assert.equal(posted.length, 1);
  assert.equal(l.warns.filter((w) => /no longer run/.test(w)).length, 2);

  // The next day: a new note.
  const next = await checkLegacyBindings({ pool, inbox, log: l.log, now: () => new Date('2026-10-16T22:30:00Z') });
  assert.equal(next.noted, 2);
  assert.equal(posted[1].refId, '2026-10-17');
});

test('best-effort: a failing query, a failing inbox or no inbox never throws', async () => {
  const l = log();
  const broken = await checkLegacyBindings({ pool: fakePool([], { failBindings: true, failRuns: true }).pool, inbox: fakeInbox().inbox, log: l.log });
  assert.deepEqual(broken, { bindings: [], noted: null, orphanedRuns: 0 });
  assert.ok(l.warns.some((w) => /legacy bindings check failed/.test(w)));
  assert.ok(l.warns.some((w) => /legacy run reconcile failed/.test(w)));

  const inboxDown = await checkLegacyBindings({
    pool: fakePool(ROWS).pool, inbox: { postOnce: async () => { throw new Error('inbox down'); } }, log: l.log,
  });
  assert.equal(inboxDown.bindings.length, 3);
  assert.equal(inboxDown.noted, null);
  assert.ok(l.warns.some((w) => /Inbox note failed: inbox down/.test(w)));

  const noInbox = await checkLegacyBindings({ pool: fakePool(ROWS).pool, inbox: null, log: l.log });
  assert.equal(noInbox.noted, null);
});

test('closes runs a previous process left at running', async () => {
  const l = log();
  const r = await checkLegacyBindings({ pool: fakePool([], { orphaned: 2 }).pool, inbox: null, log: l.log });
  assert.equal(r.orphanedRuns, 2);
  assert.match(l.warns[0], /Closed 2 legacy strategy run/);
});

test('the Nest hook runs in the background and swallows a crash', async () => {
  const hook = new LegacyBindingsCheck({ pool: { query: async () => { throw new Error('db down'); } } as any, inbox: null });
  assert.equal(hook.onApplicationBootstrap(), undefined, 'returns at once, the boot does not wait');
  new LegacyBindingsCheck(null).onApplicationBootstrap();
  await new Promise((r) => setTimeout(r, 10));
});

test('describeBindings / legacyBindingsNote', () => {
  assert.equal(describeBindings([{ extId: 'x', type: 'facts', platform: 'telegram', target: '@f' }]), '@f (facts)');
  const n = legacyBindingsNote([{ extId: 'x', type: 'facts', platform: 'telegram', target: '@f' }], '2026-10-15');
  assert.equal(n.title, 'Legacy strategy bindings are enabled but no longer run (1)');
  assert.equal(n.refId, '2026-10-15');
});
