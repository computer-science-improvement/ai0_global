/**
 * Spec 090 FR-007 against a throwaway Postgres with every migration applied: the repository query behind the apply-on-silence
 * step, and the `partially_applied` status the existing check constraint already accepts. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { ChannelSetupRepository } from './setup.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;

before(async () => { if (url) db = await createProbeDb(url, 'p090b_setup'); });
after(async () => { await db?.drop(); });

test('readyBefore returns only ready proposals with sections that were last changed before the cut; partially_applied is accepted', { skip }, async () => {
  const repo = new ChannelSetupRepository(db.pool);
  const ins = async (ch: string, status: string, ago: string, sections: unknown = { summary: 's' }) => (await db.pool.query(
    `INSERT INTO channel_setup_proposals (channel_key, resource_ref, status, sections, updated_at) VALUES ($1, $2, $3, $4, now() - $5::interval) RETURNING id`,
    [ch, `telegram:${ch}`, status, sections == null ? null : JSON.stringify(sections), ago])).rows[0].id as string;
  const old = await ins('@old', 'ready', '80 hours');
  await ins('@young', 'ready', '10 hours');
  await ins('@partial', 'partially_applied', '80 hours');
  await ins('@nosections', 'queued', '80 hours', null);
  const cut = new Date(Date.now() - 72 * 3_600_000);
  assert.deepEqual((await repo.readyBefore(cut)).map((p) => p.id), [old]);
  const p = await repo.update(old, { status: 'partially_applied', sectionStatus: { formatting: 'applied' } });
  assert.equal(p?.status, 'partially_applied');
  assert.deepEqual(await repo.readyBefore(cut), []);
});
