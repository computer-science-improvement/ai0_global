// Spec 026 FR-002: landing settings, username resolution and the public config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { LANDING_KEYS, LandingConfigService } from './landing-config.service';
import { DEFAULT_AD_MESSAGE } from './landing-dm';

/** app_settings + the agent session, answered the way Postgres would. */
function fakePool(init: { settings?: Record<string, string>; sessionUsername?: string | null; sessionsFail?: boolean } = {}) {
  const settings = new Map(Object.entries(init.settings ?? {}));
  let session = init.sessionUsername ?? null;
  const calls: string[] = [];
  const pool = {
    calls,
    settings,
    setSession: (u: string | null) => { session = u; },
    query: async (sql: string, params: any[] = []) => {
      calls.push(sql);
      if (/FROM app_settings WHERE key = ANY/.test(sql)) {
        const keys: string[] = params[0];
        return { rows: keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! })) };
      }
      if (/FROM mtproto_sessions/.test(sql)) {
        if (init.sessionsFail) throw new Error('relation "mtproto_sessions" does not exist');
        return { rows: session ? [{ username: session }] : [] };
      }
      if (/^INSERT INTO app_settings/.test(sql.trim())) { settings.set(params[0], params[1]); return { rows: [] }; }
      if (/^DELETE FROM app_settings/.test(sql.trim())) { settings.delete(params[0]); return { rows: [] }; }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return pool as typeof pool & any; // structurally enough for the service
}

test('no username anywhere: adDm unavailable, no links (form CTA only)', async () => {
  const svc = new LandingConfigService(fakePool());
  const cfg = await svc.publicConfig();
  assert.deepEqual(cfg, { defaultLang: 'en', adDm: { available: false, username: null, urls: {} }, whiteLabelEnabled: true });
  assert.equal(await svc.adDm(), null);
});

test('an invalid stored username and an invalid session username both resolve to null', async () => {
  const svc = new LandingConfigService(fakePool({ settings: { [LANDING_KEYS.adTgUsername]: 'no spaces allowed' }, sessionUsername: 'x' }));
  assert.equal((await svc.publicConfig()).adDm.available, false);
});

test('the username falls back to the active agent session', async () => {
  const svc = new LandingConfigService(fakePool({ sessionUsername: 'ai0_agent' }));
  const cfg = await svc.publicConfig();
  assert.equal(cfg.adDm.available, true);
  assert.equal(cfg.adDm.username, 'ai0_agent');
  assert.deepEqual(Object.keys(cfg.adDm.urls).sort(), ['advertise', 'footer', 'hero', 'howitworks', 'topbar']);
  const hero = new URL(cfg.adDm.urls.hero!);
  assert.equal(hero.host, 't.me');
  assert.equal(hero.pathname, '/ai0_agent');
  assert.equal(hero.searchParams.get('text'), "Hi! I'd like to order an ad in the ai0 network. [ai0web:hero]");
  assert.deepEqual((await svc.adminConfig()).resolved, { username: 'ai0_agent', source: 'agent_session' });
});

test('the setting wins over the session; a missing mtproto table is not an error', async () => {
  const svc = new LandingConfigService(fakePool({ settings: { [LANDING_KEYS.adTgUsername]: 'ads_owner' }, sessionUsername: 'ai0_agent' }));
  assert.deepEqual((await svc.adminConfig()).resolved, { username: 'ads_owner', source: 'setting' });
  const old = new LandingConfigService(fakePool({ sessionsFail: true }));
  assert.equal((await old.publicConfig()).adDm.available, false);
});

test('the public config is cached for 300 s and an admin save drops the cache', async () => {
  let now = 1_000_000;
  const pool = fakePool({ sessionUsername: 'ai0_agent' });
  const svc = new LandingConfigService(pool, () => now);
  assert.equal((await svc.publicConfig()).adDm.username, 'ai0_agent');
  pool.setSession(null); // the agent session is deleted
  now += 299_000;
  assert.equal((await svc.publicConfig()).adDm.username, 'ai0_agent', 'still cached');
  now += 2_000;
  assert.equal((await svc.publicConfig()).adDm.available, false, 'falls back to the form within one cache period');

  await svc.update({ adTgUsername: '@Ads_Desk' });
  assert.equal((await svc.publicConfig()).adDm.username, 'Ads_Desk', 'a save is visible at once');
});

test('update validates before writing anything', async () => {
  const pool = fakePool();
  const svc = new LandingConfigService(pool);
  await assert.rejects(svc.update({ adTgUsername: 'ok_name', adMessage: 'Hi {channel}' }), (e: any) => {
    assert.ok(e instanceof BadRequestException);
    assert.equal((e.getResponse() as any).error, 'invalid_landing_config');
    assert.deepEqual((e.getResponse() as any).issues.map((i: any) => i.path), ['adMessage']);
    assert.match((e.getResponse() as any).issues[0].message, /Unknown placeholder/);
    return true;
  });
  assert.equal(pool.settings.size, 0, 'nothing written');
  await assert.rejects(svc.update({ adTgUsername: 'bad name' }), BadRequestException);
  await assert.rejects(svc.update({ whiteLabelEnabled: 'yes' as any }), BadRequestException);
});

test('update stores normalized values and clears keys back to defaults', async () => {
  const pool = fakePool();
  const svc = new LandingConfigService(pool);
  const saved = await svc.update({ adTgUsername: 'https://t.me/ads_desk', adMessage: 'Ad in {target}? {ref}', whiteLabelEnabled: false });
  assert.deepEqual(saved.settings, { adTgUsername: 'ads_desk', adMessage: 'Ad in {target}? {ref}', whiteLabelEnabled: false });
  assert.equal((await svc.publicConfig()).whiteLabelEnabled, false);
  assert.equal(new URL((await svc.publicConfig()).adDm.urls.footer!).searchParams.get('text'), 'Ad in the ai0 network? [ai0web:footer]');

  const cleared = await svc.update({ adTgUsername: '', adMessage: null, whiteLabelEnabled: true });
  assert.deepEqual(cleared.settings, { adTgUsername: null, adMessage: null, whiteLabelEnabled: true });
  assert.equal(pool.settings.size, 0, 'defaults are not stored');
  // Saving the default text is the same as clearing it.
  await svc.update({ adMessage: DEFAULT_AD_MESSAGE });
  assert.equal(pool.settings.size, 0);
});

test('a stored template that no longer validates falls back to the default', async () => {
  const svc = new LandingConfigService(fakePool({ settings: { [LANDING_KEYS.adMessage]: 'Hi {oops}' }, sessionUsername: 'ai0_agent' }));
  const dm = await svc.adDm();
  assert.equal(dm?.template, DEFAULT_AD_MESSAGE);
});

test('preview renders a draft without saving it', async () => {
  const pool = fakePool({ sessionUsername: 'ai0_agent' });
  const svc = new LandingConfigService(pool);
  const p = await svc.preview({ adTgUsername: '', adMessage: 'Реклама в {target}\n{ref}' });
  assert.equal(p.valid, true);
  assert.deepEqual({ username: p.username, source: p.source }, { username: 'ai0_agent', source: 'agent_session' });
  assert.equal(p.samples.length, 3);
  assert.equal(p.samples[0].message, 'Реклама в the ai0 network\n[ai0web:hero]');
  assert.equal(p.samples[1].message, 'Реклама в Space Daily\n[ai0web:resource:space_daily]');
  const long = p.samples[2];
  assert.ok(long.length <= p.max && long.message.endsWith('[ai0web:mediakit:long_title_example]'));
  assert.equal(new URL(long.url!).searchParams.get('text'), long.message);
  assert.equal(pool.calls.filter((c) => /INSERT|DELETE/.test(c)).length, 0);

  const bad = await svc.preview({ adTgUsername: 'x y', adMessage: 'Hi {who}' });
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.issues.map((i) => i.path), ['adTgUsername', 'adMessage']);
  assert.equal(bad.username, 'ai0_agent', 'an invalid draft username falls back like the public page would');
});
