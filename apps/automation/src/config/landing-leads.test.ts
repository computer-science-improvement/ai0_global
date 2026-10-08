import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_ALERT_CAP, leadInboxItem, normalizeContact, parseLead } from './landing-leads';
import { LandingLeadsService } from './landing-leads.service';
import { LandingClientGate } from './landing-client-key';

const ad = (over: Record<string, unknown> = {}) =>
  ({ kind: 'ad', contact: '@ann_ads', target: 'Space UA', message: 'Hello', consent: true, placement: 'mediakit', elapsedMs: 9000, ...over });
const wl = (over: Record<string, unknown> = {}) => ({
  kind: 'white_label', name: 'Ann', contact: 'ann@example.com', company: 'Acme', resources: ['https://t.me/acme'],
  platforms: ['telegram', 'instagram'], audienceSize: '10k_100k', serviceMode: 'dedicated', message: 'We run 3 channels',
  consent: true, elapsedMs: 20000, ...over,
});

// ── validation ────────────────────────────────────────────────────────────────

test('normalizeContact recognises Telegram, email and phone, and nothing else', () => {
  assert.deepEqual(normalizeContact('@ann_ads'), { contact: '@ann_ads', kind: 'telegram' });
  assert.deepEqual(normalizeContact('https://t.me/ann_ads'), { contact: '@ann_ads', kind: 'telegram' });
  assert.deepEqual(normalizeContact(' Ann@Example.COM '), { contact: 'ann@example.com', kind: 'email' });
  assert.deepEqual(normalizeContact('+380 67 123 45 67'), { contact: '+380 67 123 45 67', kind: 'phone' });
  assert.equal(normalizeContact('ann_ads'), null, 'a bare word is ambiguous');
  assert.equal(normalizeContact('@ab'), null);
  assert.equal(normalizeContact('call me'), null);
  assert.equal(normalizeContact('123'), null);
});

test('a valid ad lead parses, with the contact normalised and no spam signal', () => {
  const r = parseLead(ad({ contact: 't.me/ann_ads', utm: { utm_source: 'tg', evil: 'x' } }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.spam, false);
  assert.equal(r.lead.contact, '@ann_ads');
  assert.equal(r.lead.contactKind, 'telegram');
  assert.equal(r.lead.target, 'Space UA');
  assert.equal(r.lead.placement, 'mediakit');
  assert.deepEqual(r.lead.utm, { utm_source: 'tg' });
  assert.equal(r.lead.company, null, 'white-label fields never ride on an ad lead');
});

test('validation: contact, consent, lengths, links and white-label specifics, one message per field', () => {
  const issues = (body: unknown) => { const r = parseLead(body); return r.ok ? [] : r.issues; };
  assert.deepEqual(issues(ad({ contact: '' })).map((i) => i.path), ['contact']);
  assert.deepEqual(issues(ad({ contact: 'x'.repeat(201) })).map((i) => i.path), ['contact']);
  assert.deepEqual(issues(ad({ consent: false })).map((i) => i.path), ['consent']);
  assert.deepEqual(issues(ad({ consent: undefined })).map((i) => i.path), ['consent']);
  assert.deepEqual(issues(ad({ message: 'm'.repeat(2001) })).map((i) => i.path), ['message']);
  assert.ok(parseLead(ad({ message: 'm'.repeat(2000) })).ok);
  assert.deepEqual(issues(wl({ name: '' })).map((i) => i.path), ['name']);
  assert.deepEqual(issues(wl({ resources: ['javascript:alert(1)'] })).map((i) => i.path), ['resources']);
  assert.deepEqual(issues(wl({ resources: ['ftp://x.org'] })).map((i) => i.path), ['resources']);
  assert.deepEqual(issues(wl({ resources: Array.from({ length: 11 }, (_, i) => `https://t.me/c${i}`) })).map((i) => i.path), ['resources']);
  assert.ok(parseLead(wl({ resources: Array.from({ length: 10 }, (_, i) => `https://t.me/c${i}`) })).ok);
  assert.deepEqual(issues(wl({ platforms: ['myspace'] })).map((i) => i.path), ['platforms']);
  assert.deepEqual(issues(wl({ audienceSize: 'huge' })).map((i) => i.path), ['audienceSize']);
  assert.deepEqual(issues(wl({ serviceMode: 'licence' })).map((i) => i.path), ['serviceMode']);
  assert.deepEqual(issues({ kind: 'job', contact: '@ann_ads', consent: true }).map((i) => i.path), ['kind']);
  const many = issues({ kind: 'white_label', consent: false });
  assert.deepEqual(many.map((i) => i.path).sort(), ['consent', 'contact', 'name']);
});

test('spam signals: the honeypot and a form sent too fast', () => {
  const hp = parseLead(ad({ website: 'http://spam.example' }));
  assert.ok(hp.ok && hp.spam && hp.spamReason === 'honeypot');
  const fast = parseLead(ad({ elapsedMs: 800 }));
  assert.ok(fast.ok && fast.spam && fast.spamReason === 'too_fast');
  const noTiming = parseLead(ad({ elapsedMs: undefined }));
  assert.ok(noTiming.ok && !noTiming.spam);
  const emptyHoneypot = parseLead(ad({ website: '' }));
  assert.ok(emptyHoneypot.ok && !emptyHoneypot.spam);
});

test('the inbox item carries no name or contact; only the owner alert does', () => {
  const r = parseLead(wl());
  assert.ok(r.ok);
  if (!r.ok) return;
  const item = leadInboxItem('0f0e0d0c-0000-4000-8000-000000000000', r.lead);
  assert.equal(item.title, 'New white-label request from the landing');
  assert.ok(!item.body.includes('ann@example.com') && !item.body.includes('Ann '), 'no personal data in agent_inbox');
  assert.match(item.body, /Company: Acme/);
  assert.match(item.alert.body, /ann@example\.com/);
});

// ── service (fake pool) ──────────────────────────────────────────────────────

function harness(opts: { whiteLabel?: boolean; failDb?: boolean; notifiedToday?: number } = {}) {
  const rows: any[] = [];
  let notified = opts.notifiedToday ?? 0;
  const posts: any[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (opts.failDb) throw new Error('connection refused');
      if (sql.startsWith('SELECT id FROM landing_leads')) {
        const hit = rows.filter((r) => r.ip_hash === params[0] && r.kind === params[1] && r.contact.toLowerCase() === String(params[2]).toLowerCase() && r.status !== 'spam');
        return { rows: hit.slice(-1).map((r) => ({ id: r.id })) };
      }
      if (sql.includes('INSERT INTO landing_leads')) {
        const id = `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`;
        rows.push({ id, kind: params[0], status: params[1], contact: params[3], message: params[11], ip_hash: params[14] });
        return { rows: [{ id }] };
      }
      if (sql.includes('UPDATE landing_leads SET\n         name')) {
        const r = rows.find((x) => x.id === params[0]);
        r.message = params[10] ?? r.message;
        r.updated = (r.updated ?? 0) + 1;
        return { rows: [] };
      }
      if (sql.includes('notified_at >= date_trunc')) return { rows: [{ n: notified }] };
      if (sql.includes('SET notified_at')) { notified++; rows.find((x) => x.id === params[0]).notified = true; return { rows: [] }; }
      throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
    },
  } as any;
  const config = {
    publicConfig: async () => ({ defaultLang: 'en', adDm: { available: true, username: 'ai0_ads', urls: { advertise: 'https://t.me/ai0_ads?text=x' } }, whiteLabelEnabled: opts.whiteLabel ?? true }),
  } as any;
  let t = 0;
  const gate = new LandingClientGate('test-salt', () => t);
  const inbox = { post: async (i: any) => { posts.push(i); return posts.length; } };
  const svc = new LandingLeadsService({ pool, gate, config, inbox });
  return { svc, rows, posts, queries, tick: (ms: number) => { t += ms; } };
}

const IP = '203.0.113.7';

test('a new lead is stored with an IP hash (never the IP) and alerts the owner once', async () => {
  const h = harness();
  assert.deepEqual(await h.svc.submit(ad(), IP), { ok: true, outcome: 'created' });
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].status, 'new');
  assert.match(h.rows[0].ip_hash, /^[0-9a-f]{64}$/);
  for (const q of h.queries) assert.ok(!JSON.stringify(q.params).includes(IP), 'the raw IP never reaches the DB');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].kind, 'landing_lead');
  assert.equal(h.posts[0].severity, 'action');
  assert.equal(h.posts[0].refId, h.rows[0].id);
  assert.ok(h.rows[0].notified);
});

test('honeypot and too-fast submissions are stored as spam with a 201 and no alert', async () => {
  const h = harness();
  assert.equal((await h.svc.submit(ad({ website: 'x' }), IP)).outcome, 'spam');
  assert.equal((await h.svc.submit(ad({ elapsedMs: 100 }), '198.51.100.2')).outcome, 'spam');
  assert.deepEqual(h.rows.map((r) => r.status), ['spam', 'spam']);
  assert.equal(h.posts.length, 0);
});

test('a duplicate (same client, contact and kind within 24 h) updates the row without a new alert', async () => {
  const h = harness();
  await h.svc.submit(ad({ message: 'first' }), IP);
  const second = await h.svc.submit(ad({ contact: '@ANN_ADS', message: 'second' }), IP);
  assert.equal(second.outcome, 'updated');
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].message, 'second');
  assert.equal(h.posts.length, 1);
  // A different kind or another client is a new lead.
  assert.equal((await h.svc.submit(wl({ contact: '@ann_ads' }), IP)).outcome, 'created');
  assert.equal((await h.svc.submit(ad(), '198.51.100.9')).outcome, 'created');
});

test('the daily alert cap: leads past it are stored but not announced', async () => {
  const h = harness({ notifiedToday: DAILY_ALERT_CAP - 1 });
  await h.svc.submit(ad({ contact: '@first_one' }), '10.0.0.1');
  await h.svc.submit(ad({ contact: '@second_one' }), '10.0.0.2');
  assert.equal(h.rows.length, 2);
  assert.equal(h.posts.length, 1);
  assert.ok(h.rows[0].notified && !h.rows[1].notified);
});

test('rate limit: the sixth submission within an hour from one client is a 429', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.svc.submit(ad({ contact: `@person_${i}x` }), IP);
  await assert.rejects(() => h.svc.submit(ad({ contact: '@person_6x' }), IP), (e: any) => e.getStatus() === 429);
  h.tick(3_600_001);
  assert.equal((await h.svc.submit(ad({ contact: '@person_7x' }), IP)).outcome, 'created');
});

test('white label with the flag off is a 403 and stores nothing; ad leads still work', async () => {
  const h = harness({ whiteLabel: false });
  await assert.rejects(() => h.svc.submit(wl(), IP), (e: any) => e.getStatus() === 403);
  assert.equal(h.rows.length, 0);
  assert.equal((await h.svc.submit(ad(), IP)).outcome, 'created');
});

test('invalid bodies are a 400 with field issues; the DB down is a 503 with the Telegram link', async () => {
  const h = harness();
  await assert.rejects(() => h.svc.submit(ad({ contact: 'nope' }), IP), (e: any) => {
    assert.equal(e.getStatus(), 400);
    assert.deepEqual(e.getResponse().issues.map((i: any) => i.path), ['contact']);
    return true;
  });
  const down = harness({ failDb: true });
  await assert.rejects(() => down.svc.submit(ad(), IP), (e: any) => {
    assert.equal(e.getStatus(), 503);
    assert.equal(e.getResponse().adDmUrl, 'https://t.me/ai0_ads?text=x');
    return true;
  });
});
