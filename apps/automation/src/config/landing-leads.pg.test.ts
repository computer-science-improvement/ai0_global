/**
 * Spec 026 T6 against a throwaway Postgres (init.sql + every migration):
 *   • a lead is stored (ip hash, never the IP), posts one agent_inbox item without the
 *     contact, and shows in the owner's Leads list (which never returns ip_hash);
 *   • a duplicate within 24 h updates the row; honeypot spam is stored as spam, hidden from
 *     the default list; the 20-a-day alert cap holds;
 *   • the owner sets a status and a note; retention purges lost/spam text after 180 days;
 *   • the agents' editor_ro role cannot read landing_leads.
 * The Telegram alert is a recorder: nothing is sent.
 * Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { LandingLeadsService } from './landing-leads.service';
import { LandingClientGate } from './landing-client-key';
import { LandingConfigService } from './landing-config.service';
import { OwnerInbox } from '../editor/agents/owner-inbox';
import { RetentionService } from '../common/retention/retention.service';
import { DAILY_ALERT_CAP } from './landing-leads';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');

let admin: Client;
let pool: Pool;
let dbName: string;

function withDb(u: string, db: string): string {
  const x = new URL(u);
  x.pathname = '/' + db;
  return x.toString();
}

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${new URL(url).pathname.slice(1) || 'postgres'}_l026l_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new Client({ connectionString: withDb(url, dbName), options: '-c client_min_messages=warning' });
  await c.connect();
  try {
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query('BEGIN');
      try { await c.query(readFileSync(join(MIGRATIONS, f), 'utf8')); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.end();
  }
  pool = new Pool({ connectionString: withDb(url, dbName) });
});

after(async () => {
  if (!url) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  await admin.end();
});

function service(alerts: string[]) {
  const gate = new LandingClientGate('pg-test-salt');
  const inbox = new OwnerInbox(pool, async (t) => { alerts.push(t); }, null);
  return new LandingLeadsService({ pool, gate, config: new LandingConfigService(pool), inbox });
}

const IP = '203.0.113.50';

test('a white-label lead is stored without the IP, reaches agent_inbox without the contact, and appears in Leads', { skip }, async () => {
  const alerts: string[] = [];
  const svc = service(alerts);
  const body = {
    kind: 'white_label', name: 'Ann', contact: 'ann@example.com', company: 'Acme Media', resources: ['https://t.me/acme'],
    platforms: ['telegram'], audienceSize: '10k_100k', serviceMode: 'dedicated', message: 'Three channels', consent: true, elapsedMs: 15000,
  };
  assert.equal((await svc.submit(body, IP)).outcome, 'created');

  const { rows: [raw] } = await pool.query(`SELECT * FROM landing_leads`);
  assert.equal(raw.status, 'new');
  assert.equal(raw.contact_kind, 'email');
  assert.equal(raw.lang, 'en');
  assert.match(raw.ip_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(raw).includes(IP), 'no column holds the IP');
  assert.ok(raw.notified_at);

  const { rows: inbox } = await pool.query(`SELECT * FROM agent_inbox WHERE kind = 'landing_lead'`);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].severity, 'action');
  assert.equal(inbox[0].ref_type, 'landing_lead');
  assert.equal(inbox[0].ref_id, raw.id);
  assert.ok(!`${inbox[0].title} ${inbox[0].body}`.includes('ann@example.com'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /ann@example\.com/);

  const list = await svc.list({ kind: 'white_label' });
  assert.equal(list.length, 1);
  assert.equal(list[0].company, 'Acme Media');
  assert.deepEqual(list[0].resources, ['https://t.me/acme']);
  assert.ok(!('ipHash' in list[0]) && !('ip_hash' in list[0]));

  // Duplicate: updated, no new alert.
  assert.equal((await svc.submit({ ...body, message: 'Four channels now' }, IP)).outcome, 'updated');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM landing_leads`)).rows[0].n, 1);
  assert.equal((await svc.list({}))[0].message, 'Four channels now');
  assert.equal(alerts.length, 1);

  // Owner actions.
  const patched = await svc.patch(raw.id, { status: 'contacted', ownerNote: 'Called on Monday' });
  assert.equal(patched?.status, 'contacted');
  assert.equal(patched?.ownerNote, 'Called on Monday');
  assert.equal(await svc.patch('00000000-0000-4000-8000-000000000000', { status: 'won' }), null);
  await assert.rejects(() => svc.patch(raw.id, { status: 'maybe' }), /invalid_lead_patch|Bad Request/);
});

test('spam is stored but hidden by default, and the daily alert cap holds', { skip }, async () => {
  await pool.query(`DELETE FROM landing_leads`);
  await pool.query(`DELETE FROM agent_inbox`);
  const alerts: string[] = [];
  const svc = service(alerts);
  assert.equal((await svc.submit({ kind: 'ad', contact: '@bot_user', consent: true, website: 'http://x.example' }, '198.51.100.1')).outcome, 'spam');
  assert.equal((await svc.list({})).length, 0);
  assert.equal((await svc.list({ status: 'spam' })).length, 1);

  // Pretend the cap is nearly spent today.
  await pool.query(
    `INSERT INTO landing_leads (kind, contact, consent_at, notified_at)
     SELECT 'ad', '@filler_' || g, now(), now() FROM generate_series(1, $1) g`, [DAILY_ALERT_CAP - 1]);
  await svc.submit({ kind: 'ad', contact: '@real_one', consent: true }, '198.51.100.2');
  await svc.submit({ kind: 'ad', contact: '@real_two', consent: true }, '198.51.100.3');
  assert.equal(alerts.length, 1, 'the 20th alert goes out, the 21st does not');
  const { rows } = await pool.query(`SELECT contact, notified_at FROM landing_leads WHERE contact IN ('@real_one','@real_two') ORDER BY contact`);
  assert.ok(rows[0].notified_at);
  assert.equal(rows[1].notified_at, null);
});

test('retention purges the text of old lost and spam leads only', { skip }, async () => {
  await pool.query(`DELETE FROM landing_leads`);
  await pool.query(
    `INSERT INTO landing_leads (kind, status, contact, message, resources, consent_at, updated_at) VALUES
       ('white_label', 'lost', '@old_lost', 'old text', '["https://t.me/a"]', now(), now() - interval '200 days'),
       ('white_label', 'won',  '@old_won',  'keep me',  '["https://t.me/b"]', now(), now() - interval '200 days'),
       ('ad',          'spam', '@new_spam', 'recent',   '[]',                 now(), now() - interval '10 days')`);
  const retention = new RetentionService(pool, { get: (k: string) => (k === 'RETENTION_ENABLED' ? 'true' : undefined) } as any);
  await retention.pruneOnce();
  const { rows } = await pool.query(`SELECT contact, message, resources, purged_at FROM landing_leads ORDER BY contact`);
  const by = Object.fromEntries(rows.map((r) => [r.contact, r]));
  assert.equal(by['@old_lost'].message, null);
  assert.deepEqual(by['@old_lost'].resources, []);
  assert.ok(by['@old_lost'].purged_at);
  assert.equal(by['@old_won'].message, 'keep me');
  assert.equal(by['@new_spam'].message, 'recent');
});

test('the agents read-only role cannot read landing_leads', { skip }, async () => {
  const { rows: [role] } = await pool.query(`SELECT 1 AS ok FROM pg_roles WHERE rolname = 'editor_ro'`);
  if (!role) return; // the role is created by 042 only where the migrator may create roles
  const { rows: [p] } = await pool.query(`SELECT has_table_privilege('editor_ro', 'public.landing_leads', 'SELECT') AS can`);
  assert.equal(p.can, false);
});
