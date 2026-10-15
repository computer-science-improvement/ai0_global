/**
 * Spec 037 T16 (AI0-110) against a throwaway Postgres with every migration applied: Біржа Ігор posted the
 * same Steam deals at 12:30 and 14:13 on 08.10, the source written once as `https://store.steampowered.com`
 * and once with the root slash. After the first post is out, every publish path's dedup question stops the
 * second spelling: the executor's guard (live and approval write), the chat, the approval publisher's
 * re-check and the live-slot feed filter. The specials search (09.10 18:01) is another page and stays free.
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

test('037 T16: the 12:30 Steam post stops the 14:13 one on every path, whatever the spelling of the homepage', { skip }, async () => {
  const plans = new EditorPlansRepository(pool);
  const approvals = new ApprovalsRepository(pool);
  const second = ['https://store.steampowered.com/', 'https://store.steampowered.com', 'http://store.steampowered.com/', 'https://www.store.steampowered.com/?utm_source=tg'];
  for (const u of second) assert.equal(await plans.sourceAlreadyPosted(CH, u), false, `${u}: nothing out yet`);

  // 12:30: the planned slot goes out (publishSpecNow → insertPublication writes the ledger).
  await plans.insertPublication({ channelKey: CH, messageId: 1230, sourceUrl: 'https://store.steampowered.com', title: 'Знижки Steam', tags: [], format: 'text', slotId: randomUUID() });

  for (const u of second) {
    assert.equal(await plans.sourceAlreadyPosted(CH, u), true, `executor guard: ${u}`);
    assert.equal(await plans.sourceUsed(CH, u), true, `chat guard: ${u}`);
    assert.equal(await approvals.publishedSource(CH, u, randomUUID()), true, `approval re-check: ${u}`);
  }
  assert.deepEqual([...await usedUrls(pool, `telegram:${CH}`, ['https://store.steampowered.com/', 'https://store.steampowered.com/search/?specials=1'])],
    ['https://store.steampowered.com/'], 'live-slot feed filter');

  // 09.10 18:01: the specials search is another page.
  assert.equal(await plans.sourceAlreadyPosted(CH, 'https://store.steampowered.com/search/?specials=1'), false);
  const { rows } = await pool.query(`SELECT source_ref FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`]);
  assert.deepEqual(rows.map((r) => r.source_ref), ['https://store.steampowered.com/'], 'one canonical ledger row');
});
