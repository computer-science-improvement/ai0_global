/**
 * Spec 037 T16 (AI0-110) against a throwaway Postgres with every migration applied: Біржа Ігор posted the
 * same Steam deals at 12:30 and 14:13 on 08.10, the source written once as `https://store.steampowered.com`
 * and once with the root slash. After a post is out, every publish path's dedup question stops another spelling
 * of its source: the executor's guard (live and approval write), the chat, the approval publisher's re-check and
 * the live-slot feed filter. Since 037 T4 a site root is not a source at all (lint `source_is_homepage`) and
 * never enters the ledger, so the dedup runs on the page the post retells.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { EditorPlansRepository } from './editor-plans.repository';
import { ApprovalsRepository } from '../approval/approvals.repository';
import { usedUrls } from '../live/feed-items';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt037t16_birzha';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('037 T16: a posted Steam page stops a repeat on every path, whatever the spelling', { skip }, async () => {
  const plans = new EditorPlansRepository(pool);
  const approvals = new ApprovalsRepository(pool);
  const APP = 'https://store.steampowered.com/app/2050650/Resident_Evil_4/';
  const second = [APP, 'https://store.steampowered.com/app/2050650/Resident_Evil_4', 'http://store.steampowered.com/app/2050650/Resident_Evil_4/', 'https://www.store.steampowered.com/app/2050650/Resident_Evil_4/?utm_source=tg'];
  for (const u of second) assert.equal(await plans.sourceAlreadyPosted(CH, u), false, `${u}: nothing out yet`);

  // 12:30: the planned slot goes out (publishSpecNow → insertPublication writes the ledger).
  await plans.insertPublication({ channelKey: CH, messageId: 1230, sourceUrl: 'https://store.steampowered.com/app/2050650/Resident_Evil_4', title: 'Знижка на Resident Evil 4', tags: [], format: 'text', slotId: randomUUID() });

  for (const u of second) {
    assert.equal(await plans.sourceAlreadyPosted(CH, u), true, `executor guard: ${u}`);
    assert.equal(await plans.sourceUsed(CH, u), true, `chat guard: ${u}`);
    assert.equal(await approvals.publishedSource(CH, u, randomUUID()), true, `approval re-check: ${u}`);
  }
  assert.deepEqual([...await usedUrls(pool, `telegram:${CH}`, [APP, 'https://store.steampowered.com/app/1174180/Red_Dead_Redemption_2/'])],
    [APP], 'live-slot feed filter');

  // Another game is another page.
  assert.equal(await plans.sourceAlreadyPosted(CH, 'https://store.steampowered.com/app/1174180/Red_Dead_Redemption_2/'), false);

  // 037 T4: the store root (the 08.10 source) names a site, not a post — lint blocks it (source_is_homepage), and it
  // never fills the ledger, so one root post cannot block every later post of the store.
  await plans.insertPublication({ channelKey: CH, messageId: 1413, sourceUrl: 'https://store.steampowered.com', title: 'Знижки Steam', tags: [], format: 'text', slotId: randomUUID() });
  const { rows } = await pool.query(`SELECT source_ref FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`]);
  assert.deepEqual(rows.map((r) => r.source_ref), [APP.replace(/\/$/, '')], 'one canonical ledger row, no site root');
});
