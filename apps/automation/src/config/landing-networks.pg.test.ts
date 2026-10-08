/**
 * Spec 026 T4 against a throwaway Postgres (init.sql + every migration):
 *   • GET /api/landing/networks groups featured resources by network, with the agent
 *     from the real ResourceCatalog: aiRun is live (live/approve), shadow, or none
 *     (legacy resource without an agent, an agent that is off or paused);
 *   • YouTube appears only for an active AND featured row, and then adds a platform;
 *   • the "Ads here" link needs an active ad price; the payload has no ids or agent handles;
 *   • the admin network patch writes the blurb and the order;
 *   • the admin list hides inactive accounts (BR-MKT-01).
 * Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { ResourceCatalog } from '../editor/agents/resource-catalog';
import { LandingConfigService } from './landing-config.service';
import { LandingNetworksService } from './landing-networks.service';
import { LandingResourcesService } from './landing-resources.service';
import { MetaAccountsRepository } from './meta-accounts.repository';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';
import { YoutubeLandingRepository } from './youtube-landing.repository';

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
  dbName = `${new URL(url).pathname.slice(1) || 'postgres'}_l026n_${process.pid}`.toLowerCase();
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

function services() {
  const plain = { maybeDecrypt: (v: string) => v } as any;
  const resources = new LandingResourcesService(
    new MetaAccountsRepository(pool), new TikTokAccountsRepository(pool, plain),
    new TrackedChannelsConfigRepository(pool), new YoutubeLandingRepository(pool));
  const config = new LandingConfigService(pool);
  const networks = new LandingNetworksService({ pool, resources, catalog: new ResourceCatalog({ pool }), adDm: () => config.adDm() });
  return { resources, config, networks };
}

async function group(name: string, blurb: string | null, order: number): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO meta_account_groups (name, landing_blurb_en, landing_order) VALUES ($1, $2, $3) RETURNING id`, [name, blurb, order]);
  return rows[0].id;
}

async function channel(key: string, title: string, groupId: string | null, order: number, subs: number) {
  await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine, subs_count, group_id, landing_visible, landing_order)
     VALUES ($1, $2, $3, true, $4, $5, true, $6)`, [key, key.slice(1), title, subs, groupId, order]);
}

async function orchestrator(handle: string, scope: 'resource' | 'network', scopeId: string, mode: string, status = 'active') {
  await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, emoji, mode, status)
     VALUES ('orchestrator', $1, $2, $3, $4, '🤖', $5, $6)`, [scope, scopeId, `Agent ${handle.toUpperCase()}`, handle, mode, status]);
}

test('networks: grouping, aiRun from the catalog, ad links, YouTube gating, no ids', { skip }, async () => {
  const news = await group('News network', 'Fast news.', 1);
  const food = await group('Food network', null, 2);
  await channel('@news_live', 'News Live', news, 1, 1000);
  await channel('@food_shadow', 'Food Shadow', food, 2, 300);
  await channel('@legacy_ch', 'Legacy', null, 3, 50);
  await channel('@paused_ch', 'Paused', null, 4, 10);
  await orchestrator('news_orch', 'resource', 'telegram:@news_live', 'approve');
  await orchestrator('food_orch', 'resource', 'telegram:@food_shadow', 'shadow');
  await orchestrator('paused_orch', 'resource', 'telegram:@paused_ch', 'live', 'paused');
  // The Instagram account of the news network inherits the network's anchor agent (spec 020)
  // when the network is independent.
  await pool.query(`UPDATE meta_account_groups SET mode = 'independent' WHERE id = $1`, [news]);
  await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, display_name, followers, group_id, landing_visible, landing_order)
     VALUES ('instagram', 'ig1', 'X', 'ig1', 'news_ig', 'News IG', 400, $1, true, 5),
            ('threads', 'th1', 'X', 'th1', 'off_th', 'Inactive', 1, $1, true, 6)`, [news]);
  await pool.query(`UPDATE meta_accounts SET active = false WHERE account_id = 'th1'`);
  await pool.query(`INSERT INTO ad_prices (channel_key, format, price_uah) VALUES ('@news_live', 'post', 500)`);
  await pool.query(`INSERT INTO ad_prices (channel_key, format, price_uah, active) VALUES ('@food_shadow', 'post', 300, false)`);
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('landing.ad_tg_username', 'ads_desk')`);

  const { networks, resources } = services();
  const out = await networks.list();
  assert.deepEqual(out.map((n) => n.name), ['News network', 'Food network', null]);
  const runs = Object.fromEntries(out.flatMap((n) => n.resources).map((r) => [r.handle, r.aiRun]));
  assert.deepEqual(runs, { news_live: 'live', news_ig: 'live', food_shadow: 'shadow', legacy_ch: 'none', paused_ch: 'none' });
  assert.deepEqual(out[0].agent, { name: 'Agent NEWS_ORCH', emoji: '🤖', mode: 'live' });
  assert.equal(out[0].blurb, 'Fast news.');
  assert.equal(out[0].followers, 1400);
  assert.deepEqual(out[1].agent, { name: 'Agent FOOD_ORCH', emoji: '🤖', mode: 'shadow' });
  assert.equal(out[2].agent, null);

  const withAd = out.flatMap((n) => n.resources).filter((r) => r.adDmUrl);
  assert.deepEqual(withAd.map((r) => r.handle), ['news_live'], 'only the channel with an active price');
  assert.match(decodeURIComponent(withAd[0].adDmUrl!), /^https:\/\/t\.me\/ads_desk\?text=.*News Live.*\[ai0web:resource:news_live\]$/);

  const json = JSON.stringify(out);
  for (const leak of [news, food, 'news_orch', 'food_orch', 'telegram:@']) assert.ok(!json.includes(leak), `leaked ${leak}`);

  // ── YouTube: inactive or not featured → absent; active + featured → a platform more ──
  const platforms = (ns: typeof out) => new Set(ns.flatMap((n) => n.platforms));
  const before = platforms(out).size;
  assert.equal(platforms(out).has('youtube'), false);
  await pool.query(
    `INSERT INTO youtube_accounts (channel_id, title, group_id, active, landing_visible, landing_order, handle)
     VALUES ('UCoff', 'Off', $1, false, true, 7, 'off_yt'), ('UCnf', 'Not featured', $1, true, false, 8, NULL)`, [news]);
  networks.invalidate();
  assert.equal(platforms(await networks.list()).has('youtube'), false);
  assert.equal((await resources.listPublic()).some((r) => r.platform === 'youtube'), false);

  await pool.query(`UPDATE youtube_accounts SET landing_visible = true WHERE channel_id = 'UCnf'`);
  networks.invalidate();
  const after = await networks.list();
  assert.equal(platforms(after).has('youtube'), true);
  assert.equal(platforms(after).size, before + 1);
  const yt = after[0].resources.find((r) => r.platform === 'youtube')!;
  assert.equal(yt.url, 'https://www.youtube.com/channel/UCnf');
  assert.equal(yt.aiRun, 'live', 'YouTube in the news network is run by the network agent');
  assert.equal(yt.followerCount, null, 'subscribers stay null until 019b');

  // ── the admin list hides inactive accounts, shows active YouTube ──
  const adminList = await resources.listAdmin();
  assert.ok(!adminList.some((r) => r.handle === 'off_th' || r.handle === 'off_yt'));
  assert.ok(adminList.some((r) => r.platform === 'youtube' && r.displayName === 'Not featured'));

  // ── the admin network patch, and the preview equals the public payload ──
  assert.equal(await networks.patchNetwork(food, { blurb: '  Recipes by agents.  ', order: 0 }), true);
  const view = await networks.admin();
  assert.deepEqual(view.networks.map((n) => [n.name, n.blurb, n.order]), [
    ['Food network', 'Recipes by agents.', 0], ['News network', 'Fast news.', 1],
  ]);
  assert.deepEqual(view.preview, await networks.list());
  assert.equal(view.preview[0].name, 'Food network');
  assert.equal(await networks.patchNetwork(food, { blurb: null }), true);
  assert.equal((await networks.list())[0].blurb, null);
});
