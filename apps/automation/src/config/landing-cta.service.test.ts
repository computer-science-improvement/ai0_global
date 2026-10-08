import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandingCtaService, parseCtaClick } from './landing-cta.service';
import { LandingController } from './api/landing.controller';
import { LandingClientGate } from './landing-client-key';

test('parseCtaClick accepts known CTAs and placements only, and always stores lang en', () => {
  assert.deepEqual(parseCtaClick({ cta: 'ad_dm', placement: 'hero', lang: 'uk' }), { cta: 'ad_dm', placement: 'hero', lang: 'en' });
  assert.deepEqual(parseCtaClick({ cta: 'ad_form', placement: 'mediakit' }), { cta: 'ad_form', placement: 'mediakit', lang: 'en' });
  assert.equal(parseCtaClick({ cta: 'buy', placement: 'hero' }), null);
  assert.equal(parseCtaClick({ cta: 'ad_dm', placement: 'sidebar' }), null);
  assert.equal(parseCtaClick(null), null);
  assert.equal(parseCtaClick('ad_dm'), null);
});

function recordingPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [] }; } } as any };
}

test('record upserts the day counter with the CTA, placement and lang only — no IP or hash', async () => {
  const { calls, pool } = recordingPool();
  await new LandingCtaService(pool).record({ cta: 'ad_dm', placement: 'footer', lang: 'en' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO landing_cta_daily \(day, cta, placement, lang, clicks\)/);
  assert.deepEqual(calls[0].params, ['ad_dm', 'footer', 'en']);
});

test('POST /api/landing/cta: records a valid click, ignores junk, 429s past 60/min, and never passes the IP on', async () => {
  const { calls, pool } = recordingPool();
  let t = 0;
  const gate = new LandingClientGate('salt', () => t);
  const ctrl = new LandingController({} as any, {} as any, {} as any, undefined, new LandingCtaService(pool), gate);
  const req = { ip: '203.0.113.9' } as any;
  await ctrl.cta({ cta: 'ad_dm', placement: 'hero', lang: 'en' }, req);
  await ctrl.cta({ cta: 'nope', placement: 'hero' }, req);
  assert.equal(calls.length, 1);
  for (const c of calls) assert.ok(!JSON.stringify(c).includes('203.0.113.9'), 'the IP never reaches the DB');
  for (let i = 0; i < 58; i++) await ctrl.cta({ cta: 'ad_dm', placement: 'hero' }, req);
  await assert.rejects(() => ctrl.cta({ cta: 'ad_dm', placement: 'hero' }, req), (e: any) => e.getStatus() === 429);
  // Another client is not affected; the window slides.
  await ctrl.cta({ cta: 'ad_dm', placement: 'hero' }, { ip: '198.51.100.1' } as any);
  t += 60_001;
  await ctrl.cta({ cta: 'ad_dm', placement: 'hero' }, req);
});

test('a DB error on a click is swallowed (a beacon never gets a 500)', async () => {
  const pool = { query: async () => { throw new Error('db down'); } } as any;
  const ctrl = new LandingController({} as any, {} as any, {} as any, undefined, new LandingCtaService(pool), new LandingClientGate('s'));
  await ctrl.cta({ cta: 'ad_dm', placement: 'hero' }, { ip: '1.1.1.1' } as any);
});

test('stats merge clicks, tagged threads and leads per placement, in page order', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM landing_cta_daily')) return { rows: [
        { placement: 'footer', cta: 'ad_dm', clicks: 2 }, { placement: 'hero', cta: 'ad_dm', clicks: 10 },
        { placement: 'hero', cta: 'ad_form', clicks: 3 }, { placement: 'hero', cta: 'white_label', clicks: 1 },
      ] };
      if (sql.includes("fields->>'source' = 'landing'")) return { rows: [{ placement: 'hero', threads: 4 }, { placement: 'zzz', threads: 1 }] };
      if (sql.includes('IS DISTINCT FROM')) return { rows: [{ n: 2 }] };
      if (sql.includes('FROM landing_leads')) return { rows: [{ placement: 'hero', leads: 1 }] };
      return { rows: [{ since: '2026-09-09' }] };
    },
  } as any;
  const s = await new LandingCtaService(pool).stats('30');
  assert.equal(s.days, 30);
  assert.deepEqual(s.rows.map((r) => r.placement), ['hero', 'footer', 'zzz']);
  assert.deepEqual(s.rows[0], { placement: 'hero', dmClicks: 10, formClicks: 3, whiteLabelClicks: 1, dmThreads: 4, leads: 1 });
  assert.deepEqual(s.totals, { dmClicks: 12, formClicks: 3, whiteLabelClicks: 1, dmThreads: 5, leads: 1 });
  assert.equal(s.untaggedAdThreads, 2);
  assert.equal((await new LandingCtaService(pool).stats('9999')).days, 30, 'out-of-range days fall back to 30');
});
