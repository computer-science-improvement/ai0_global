/**
 * Spec 026 T5 against a throwaway Postgres (init.sql + every migration):
 *   • a DM carrying the landing tag is stored with fields.source='landing', the placement
 *     and the channel, categorised `ad`, with a price-list draft filtered to that channel;
 *   • an untagged follow-up keeps the attribution (fields are merged in SQL, not overwritten);
 *   • CTA clicks land in landing_cta_daily with no visitor data, and the CTA stats set them
 *     against the tagged threads.
 * The MTProto client and the model are fakes: nothing is sent, no LLM is called.
 * Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { AgentInboxPoller } from './agent-inbox.poller';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentActionsRepository } from './agent-actions.repository';
import { AdPricesRepository } from '../payments/ad-prices.repository';
import { LandingCtaService } from '../config/landing-cta.service';

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
  dbName = `${new URL(url).pathname.slice(1) || 'postgres'}_l026a_${process.pid}`.toLowerCase();
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

function poller(dialogs: () => any[], category: string) {
  const client = { hasSession: async () => true, fetchRecentDialogs: async () => dialogs() } as any;
  const triage = { triage: async () => ({ category, summary: 's', fields: {}, draftReply: '', score: 50 }) } as any;
  const config = { get: (k: string) => (k === 'AGENT_ENABLED' ? 'true' : undefined) } as any;
  return new AgentInboxPoller(client, triage, new AgentInboxRepository(pool), config, new AgentActionsRepository(pool), new AdPricesRepository(pool));
}

const dm = (messageId: number, text: string) =>
  ({ peerId: '4242', peerUsername: 'advertiser', peerName: 'Ann', messageId, text, date: new Date(), out: false });

test('a tagged DM is attributed, categorised ad and gets a price list of the tagged channel; an untagged follow-up keeps the source', { skip }, async () => {
  await pool.query(`INSERT INTO ad_prices (channel_key, format, price_uah) VALUES ('@space_ua','post',1500), ('@recipes_ua','post',800)`);

  let dialogs = [dm(10, "Hi! I'd like to order an ad in Recipes UA. [ai0web:resource:recipes_ua]")];
  await poller(() => dialogs, 'other').pollOnce();
  const { rows: [t1] } = await pool.query(`SELECT id, category, fields FROM agent_dm_threads WHERE peer_id = '4242'`);
  assert.equal(t1.category, 'ad');
  assert.deepEqual(t1.fields, { source: 'landing', placement: 'resource', channel: 'recipes_ua' });
  const { rows: drafts } = await pool.query(`SELECT payload FROM agent_actions WHERE thread_id = $1 AND type = 'reply' AND status = 'pending'`, [t1.id]);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].payload.text, /@recipes_ua/);
  assert.doesNotMatch(drafts[0].payload.text, /@space_ua/);

  // An untagged follow-up the model calls a question: still a landing ad thread.
  dialogs = [dm(11, 'Is next Tuesday free?')];
  await poller(() => dialogs, 'question').pollOnce();
  const { rows: [t2] } = await pool.query(`SELECT category, fields, last_text FROM agent_dm_threads WHERE peer_id = '4242'`);
  assert.equal(t2.last_text, 'Is next Tuesday free?');
  assert.equal(t2.category, 'ad');
  assert.equal(t2.fields.source, 'landing');
  assert.equal(t2.fields.placement, 'resource');
  assert.equal(t2.fields.channel, 'recipes_ua');
});

test('CTA clicks are day counters without visitor data, and stats match them with tagged threads', { skip }, async () => {
  const cta = new LandingCtaService(pool);
  await cta.record({ cta: 'ad_dm', placement: 'resource', lang: 'en' });
  await cta.record({ cta: 'ad_dm', placement: 'resource', lang: 'en' });
  await cta.record({ cta: 'ad_form', placement: 'hero', lang: 'en' });
  const { rows } = await pool.query(`SELECT * FROM landing_cta_daily ORDER BY placement`);
  assert.deepEqual(rows.map((r) => [r.cta, r.placement, r.lang, r.clicks]), [['ad_form', 'hero', 'en', 1], ['ad_dm', 'resource', 'en', 2]]);
  // The table has no column that could hold a client address.
  const { rows: cols } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'landing_cta_daily' ORDER BY ordinal_position`);
  assert.deepEqual(cols.map((c) => c.column_name), ['day', 'cta', 'placement', 'lang', 'clicks']);

  const s = await cta.stats(30);
  const resource = s.rows.find((r) => r.placement === 'resource')!;
  assert.equal(resource.dmClicks, 2);
  assert.equal(resource.dmThreads, 1);
  assert.equal(s.rows.find((r) => r.placement === 'hero')!.formClicks, 1);
  assert.equal(s.untaggedAdThreads, 0);
});
