import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertingService } from './alerting.service';

function make(opts: {
  errs?: Array<{ ext_id: string; consecutive_errors: number; last_error: string | null; last_at: Date }>;
  stuck?: Array<{ ext_id: string; started_at: Date }>;
  env?: Record<string, string | undefined>;
}) {
  const sent: string[] = [];
  let errs = opts.errs ?? [];
  let stuck = opts.stuck ?? [];
  const runsRepo = {
    consecutiveErrorStrategies: async () => errs,
    stuckRunning: async () => stuck,
  } as any;
  const notifier = { notifyAlert: async (t: string) => { sent.push(t); } } as any;
  const config = { get: (k: string) => (opts.env ?? {})[k] } as any;
  const svc = new AlertingService(runsRepo, notifier, config);
  return { svc, sent, setErrs: (e: any) => { errs = e; }, setStuck: (s: any) => { stuck = s; } };
}

test('alerts once per failing strategy and dedupes on the next tick', async () => {
  const { svc, sent } = make({ errs: [{ ext_id: 'news', consecutive_errors: 3, last_error: 'boom', last_at: new Date() }] });
  const r1 = await svc.checkOnce();
  assert.equal(r1.errorsAlerted, 1);
  assert.match(sent[0], /news.*failed 3/s);
  const r2 = await svc.checkOnce(); // same streak — no repeat
  assert.equal(r2.errorsAlerted, 0);
  assert.equal(sent.length, 1);
});

test('re-alerts after a streak clears then fails again', async () => {
  const h = make({ errs: [{ ext_id: 'news', consecutive_errors: 3, last_error: 'x', last_at: new Date() }] });
  await h.svc.checkOnce();
  h.setErrs([]);             // recovered (ok/skipped landed)
  await h.svc.checkOnce();
  h.setErrs([{ ext_id: 'news', consecutive_errors: 4, last_error: 'y', last_at: new Date() }]); // failing again
  const r = await h.svc.checkOnce();
  assert.equal(r.errorsAlerted, 1);
});

test('alerts on a stuck run and dedupes the same run', async () => {
  const started = new Date('2026-01-01T00:00:00Z');
  const { svc, sent } = make({ stuck: [{ ext_id: 'recipes', started_at: started }] });
  const r1 = await svc.checkOnce();
  assert.equal(r1.stuckAlerted, 1);
  assert.match(sent[0], /recipes.*stuck/s);
  const r2 = await svc.checkOnce();
  assert.equal(r2.stuckAlerted, 0);
});

test('ALERT_ENABLED=false disables all alerts', async () => {
  const { svc, sent } = make({
    errs: [{ ext_id: 'news', consecutive_errors: 9, last_error: 'x', last_at: new Date() }],
    env: { ALERT_ENABLED: 'false' },
  });
  const r = await svc.checkOnce();
  assert.deepEqual(r, { errorsAlerted: 0, stuckAlerted: 0 });
  assert.equal(sent.length, 0);
});
