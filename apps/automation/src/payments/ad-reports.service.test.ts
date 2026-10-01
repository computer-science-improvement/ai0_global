import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdReportsService } from './ad-reports.service';

const POSTED = new Date('2026-10-01T10:00:00Z');
const h = (n: number) => new Date(POSTED.getTime() + n * 3600_000);

function order(over: Record<string, unknown> = {}) {
  return {
    id: '0f3a9c12-aaaa-bbbb-cccc-000000000000', advertiser: 'Школа', status: 'published', published_post_id: '42',
    posted_at: POSTED, ad_format: 'post', report: null, thread_id: 'th1',
    creative: { format: 'text', body: [{ type: 'p', text: 'x' }], cta: { url: 'https://school.ua', label: 'Записатись' } },
    ...over,
  };
}

function setup(due: any[]) {
  const saved: any[] = [];
  const actions: any[] = [];
  const alerts: string[] = [];
  const repo = {
    dueForReport: async () => due,
    reportInputs: async () => ({
      post: { messageId: 7, postedAt: POSTED, format: 'text' },
      channel: { key: '@space_ua', title: 'Космос', username: null, subscribers: 1000 },
      snapshots: [{ capturedAt: h(20), views: 600, forwards: 3, reactionsTotal: 5, replies: 0 }],
    }),
    saveReport: async (id: string, r: any) => { saved.push({ id, r }); return 'TOKEN'; },
  } as any;
  const actionsRepo = { create: async (a: any) => { actions.push(a); return { id: 'a1' }; } } as any;
  const notifier = { notifyAlert: async (t: string) => { alerts.push(t); } } as any;
  const config = { get: (k: string) => (k === 'DASHBOARD_URL' ? 'https://dash.example/' : undefined) } as any;
  return { svc: new AdReportsService(repo, actionsRepo, notifier, config), saved, actions, alerts };
}

test('first (24h) report: stored, and a pending reply with the public link is drafted for the advertiser thread', async () => {
  const s = setup([order()]);
  const n = await s.svc.runOnce(h(25));
  assert.equal(n, 1);
  assert.equal(s.saved[0].r.stage, '24h');
  assert.equal(s.saved[0].r.metrics.views, 600);
  assert.equal(s.actions.length, 1);
  assert.equal(s.actions[0].type, 'reply');
  assert.equal(s.actions[0].threadId, 'th1');
  assert.match(s.actions[0].payload.text, /https:\/\/dash\.example\/report\/TOKEN/);
  assert.equal(s.actions[0].payload.orderId, order().id);
});

test('final (72h) report after the first one: stored as 72h, no second DM draft', async () => {
  const s = setup([order({ report: { stage: '24h' } })]);
  await s.svc.runOnce(h(73));
  assert.equal(s.saved[0].r.stage, '72h');
  assert.equal(s.actions.length, 0);
});

test('no advertiser thread → owner alert with the link instead of a DM draft', async () => {
  const s = setup([order({ thread_id: null })]);
  await s.svc.runOnce(h(25));
  assert.equal(s.actions.length, 0);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0], /report\/TOKEN/);
});

test('digest sponsor report carries the UTM-tagged link (CTR proxy)', async () => {
  const s = setup([order({ ad_format: 'digest_sponsor' })]);
  await s.svc.runOnce(h(25));
  assert.deepEqual(s.saved[0].r.link, { url: 'https://school.ua/?utm_source=ai0&utm_medium=telegram&utm_campaign=0f3a9c12', utm: true });
});

test('too early → nothing stored', async () => {
  const s = setup([order()]);
  await s.svc.runOnce(h(3));
  assert.equal(s.saved.length, 0);
});
