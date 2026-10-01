import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService, RETENTION_POLICIES, SCRUB_POLICIES } from './retention.service';

function makeSvc(env: Record<string, string | undefined>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rowCount: 1 }; },
  } as any;
  const config = { get: (k: string) => env[k] } as any;
  return { svc: new RetentionService(pool, config), calls };
}

const TOTAL = RETENTION_POLICIES.length + SCRUB_POLICIES.length;

test('does nothing when RETENTION_ENABLED is not true', async () => {
  const { svc, calls } = makeSvc({});
  const res = await svc.pruneOnce();
  assert.deepEqual(res, []);
  assert.equal(calls.length, 0);
});

test('prunes every delete-policy table when enabled, parameterizing the day window', async () => {
  const { svc, calls } = makeSvc({ RETENTION_ENABLED: 'true' });
  const res = await svc.pruneOnce();
  assert.equal(calls.length, TOTAL);
  // Delete policies run first, in declaration order, binding the default window.
  for (let i = 0; i < RETENTION_POLICIES.length; i++) {
    const p = RETENTION_POLICIES[i];
    assert.match(calls[i].sql, new RegExp(`DELETE FROM ${p.table} WHERE ${p.col} <`));
    assert.deepEqual(calls[i].params, [p.defaultDays]);
  }
  assert.equal(res.length, TOTAL);
});

test('covers the spec 007 delete windows (strategy_runs 90d, editor_run_steps 30d, editor_runs 180d)', () => {
  const byTable = Object.fromEntries(RETENTION_POLICIES.map(p => [p.table, p]));
  assert.equal(byTable.strategy_runs?.defaultDays, 90);
  assert.equal(byTable.strategy_runs?.col, 'started_at');
  assert.equal(byTable.editor_run_steps?.defaultDays, 30);
  assert.equal(byTable.editor_run_steps?.col, 'created_at');
  assert.equal(byTable.editor_runs?.defaultDays, 180);
  assert.equal(byTable.editor_runs?.col, 'started_at');
  // bot_logs is a dedup ledger until spec 009 — it must never be pruned.
  assert.ok(!('bot_logs' in byTable), 'bot_logs must not be pruned');
  // Steps are pruned before their parent runs (cheaper than relying on the cascade).
  const order = RETENTION_POLICIES.map(p => p.table);
  assert.ok(order.indexOf('editor_run_steps') < order.indexOf('editor_runs'));
});

test('scrub policies null out text columns instead of deleting rows', async () => {
  const { svc, calls } = makeSvc({ RETENTION_ENABLED: 'true' });
  await svc.pruneOnce();
  const scrubCalls = calls.slice(RETENTION_POLICIES.length);
  assert.equal(scrubCalls.length, SCRUB_POLICIES.length);
  for (let i = 0; i < SCRUB_POLICIES.length; i++) {
    const p = SCRUB_POLICIES[i];
    const { sql, params } = scrubCalls[i];
    assert.match(sql, new RegExp(`^UPDATE ${p.table} SET `));
    assert.doesNotMatch(sql, /DELETE/);
    for (const c of p.columns) {
      assert.ok(sql.includes(`${c.name} = ${c.empty}`), `${p.table}.${c.name} should be set to ${c.empty}`);
      // Only touch rows that still hold data (keeps the nightly UPDATE cheap and idempotent).
      assert.ok(sql.includes(`${c.name} IS DISTINCT FROM ${c.empty}`));
    }
    assert.match(sql, new RegExp(`WHERE ${p.col} < now\\(\\) - \\(\\$1 \\* interval '1 day'\\)`));
    assert.deepEqual(params, [p.defaultDays]);
  }
});

test('covers the spec 007 scrub windows', () => {
  const byTable = Object.fromEntries(SCRUB_POLICIES.map(p => [p.table, p]));
  const cols = (t: string) => byTable[t]?.columns.map(c => c.name).sort();

  assert.equal(byTable.tracked_posts?.defaultDays, 30);
  assert.deepEqual(cols('tracked_posts'), ['text']);

  assert.equal(byTable.agent_dm_threads?.defaultDays, 90);
  assert.deepEqual(cols('agent_dm_threads'), ['draft_reply', 'last_text', 'sent_reply']);

  assert.equal(byTable.agent_opportunities?.defaultDays, 90);
  assert.deepEqual(cols('agent_opportunities'), ['message_text']);

  // raw_payload is NOT NULL jsonb → emptied to '{}' rather than NULL.
  assert.equal(byTable.candidate_channels?.defaultDays, 30);
  assert.deepEqual(byTable.candidate_channels?.columns, [{ name: 'raw_payload', empty: "'{}'::jsonb" }]);
});

test('a per-table window of 0 disables that table only', async () => {
  const { svc, calls } = makeSvc({ RETENTION_ENABLED: 'true', AI_LOGS_RETENTION_DAYS: '0' });
  await svc.pruneOnce();
  assert.ok(!calls.some(c => /DELETE FROM ai_logs/.test(c.sql)), 'ai_logs should be skipped');
  assert.equal(calls.length, TOTAL - 1);
});

test('a scrub window of 0 disables that scrub only', async () => {
  const { svc, calls } = makeSvc({ RETENTION_ENABLED: 'true', TRACKED_POST_TEXT_RETENTION_DAYS: '0' });
  await svc.pruneOnce();
  assert.ok(!calls.some(c => /UPDATE tracked_posts/.test(c.sql)), 'tracked_posts scrub should be skipped');
  assert.equal(calls.length, TOTAL - 1);
});

test('env override changes the day window', async () => {
  const { svc, calls } = makeSvc({
    RETENTION_ENABLED: 'true', AI_LOGS_RETENTION_DAYS: '7', AGENT_DM_TEXT_RETENTION_DAYS: '14',
  });
  await svc.pruneOnce();
  const aiCall = calls.find(c => /DELETE FROM ai_logs/.test(c.sql));
  assert.deepEqual(aiCall!.params, [7]);
  const dmCall = calls.find(c => /UPDATE agent_dm_threads/.test(c.sql));
  assert.deepEqual(dmCall!.params, [14]);
});

test('a failing table (e.g. not migrated yet) does not stop the others', async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      if (/editor_run_steps/.test(sql)) throw new Error('relation "editor_run_steps" does not exist');
      return { rowCount: 0 };
    },
  } as any;
  const svc = new RetentionService(pool, { get: (k: string) => (k === 'RETENTION_ENABLED' ? 'true' : undefined) } as any);
  const res = await svc.pruneOnce();
  assert.equal(calls.length, TOTAL);
  assert.equal(res.length, TOTAL - 1);
  assert.ok(!res.some(r => r.table === 'editor_run_steps'));
});
