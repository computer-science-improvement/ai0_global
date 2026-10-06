/**
 * Spec 027 T3 against a throwaway Postgres: the revision (updated_at as text)
 * round-trips exactly (microseconds, any session time zone), a stale revision is
 * a conflict, back-to-back saves always move the revision, and reset deletes the
 * row. Runs in its own schema with migration 015's table. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { ConflictException } from '@nestjs/common';
import { NavConfigService } from './nav-config.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const SCHEMA = 'pgt027cfg';
let pool: Pool;

const menu = (n: number) => ({ schemaVersion: 1, groups: [{ id: 'g_home', items: ['overview'] }], pinned: [], hidden: [], custom: [], overrides: { overview: { label: `Home ${n}` } } });

before(async () => {
  if (!url) return;
  const admin = new Pool({ connectionString: url });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await admin.query(`CREATE TABLE ${SCHEMA}.app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA} -c timezone=Europe/Kyiv` });
});
after(async () => {
  if (!url) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

test('revisions round-trip exactly and gate every write', { skip }, async () => {
  const svc = new NavConfigService(pool);
  assert.deepEqual(await svc.get(), { config: null, revision: null });
  const r1 = (await svc.put({ config: menu(1), baseRevision: null })).revision;
  assert.match(r1, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}/);
  const got = await svc.get();
  assert.equal(got.revision, r1);
  assert.equal((got.config as any).overrides.overview.label, 'Home 1');

  // Back-to-back saves: every one moves the revision (no equal timestamps).
  let rev = r1;
  for (let i = 2; i < 12; i++) {
    const next = (await svc.put({ config: menu(i), baseRevision: rev })).revision;
    assert.notEqual(next, rev);
    rev = next;
  }
  // The old revision is stale now — from a pool in another time zone as well.
  const utc = new NavConfigService(new Pool({ connectionString: url, options: `-c search_path=${SCHEMA} -c timezone=UTC` }));
  await assert.rejects(utc.put({ config: menu(99), baseRevision: r1 }), ConflictException);
  // The current one, read in UTC text form, still matches (same instant).
  const utcRev = (await utc.get()).revision!;
  assert.notEqual(utcRev, rev, 'different text…');
  const saved = await utc.put({ config: menu(100), baseRevision: utcRev });
  assert.ok(saved.revision, '…same instant, so the save goes through');
  await assert.rejects(svc.put({ config: menu(101), baseRevision: null }), ConflictException);

  await svc.reset();
  assert.deepEqual(await svc.get(), { config: null, revision: null });
  await assert.rejects(svc.put({ config: menu(102), baseRevision: rev }), ConflictException);
  await (utc as any).pool.end();
});
