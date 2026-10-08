/**
 * Spec 034 FR-002: format_prefs.humor / slang — schema, prompt rendering, owner
 * locks, and the owner-only rule (an agent may switch them off, never on).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT_PREF_FIELDS, FormatLocksSchema, FormatPrefsSchema, renderFormatPrefs, ResourceProfilesRepository } from './resource-profile';
import { FormatPatchInput } from '../network/format-tools';
import { rowToCard } from '../repo/editor-channels.repository';

test('humor / slang: optional, strict values, lockable fields', () => {
  assert.deepEqual(FormatPrefsSchema.parse({ humor: 'light', slang: true }), { humor: 'light', slang: true });
  assert.equal(FormatPrefsSchema.safeParse({ humor: 'lots' }).success, false);
  assert.equal(FormatPrefsSchema.safeParse({ slang: 'yes' }).success, false);
  assert.ok(FORMAT_PREF_FIELDS.includes('humor') && FORMAT_PREF_FIELDS.includes('slang'));
  assert.deepEqual(FormatLocksSchema.parse(['humor', 'slang']), ['humor', 'slang']);
  assert.equal(FormatPatchInput.safeParse({ humor: 'none', slang: false }).success, true);
  assert.equal(FormatPatchInput.safeParse({ humor: null }).success, true, 'null clears');
});

test('humor / slang in the prompt rendering', () => {
  assert.equal(renderFormatPrefs({ humor: 'none', slang: false }), 'Гумор: вимкнено\nСленг: ні');
  assert.equal(renderFormatPrefs({ humor: 'light', slang: true }, ['humor']), 'Гумор: легкий (дозволив власник) (закріплено власником)\nСленг: дозволено власником');
});

/** A plain query object: patchFormat runs without a transaction (see ResourceProfilesRepository.tx). */
function fakePool(stored: Record<string, unknown>) {
  const writes: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/SELECT profile FROM resource_profiles/.test(sql)) return { rows: [{ profile: stored }] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO resource_profile_versions/.test(sql)) return { rows: [{ version: 2 }] };
      if (/INSERT INTO resource_profiles/.test(sql)) { writes.push(JSON.parse(String(params[1]))); return { rows: [], rowCount: 1 }; }
      throw new Error(`unexpected ${sql}`);
    },
  };
  return { pool, writes };
}

test('owner-only: an agent cannot switch humour or slang on, may switch them off; the owner can, and can lock them', async () => {
  const ref = 'instagram:ig1';
  const off = fakePool({ format_prefs: {} });
  const repo = new ResourceProfilesRepository(off.pool as any);
  const on = await repo.patchFormat(ref, { humor: 'light' }, { by: 'agent', reason: 'аудиторія любить жарти' });
  assert.equal('error' in on && on.error, 'owner_only');
  const slang = await repo.patchFormat(ref, { slang: true, tone: 'дружній' }, { by: 'agent' });
  assert.equal('error' in slang && slang.error, 'owner_only', 'the whole patch is refused');
  assert.equal(off.writes.length, 0);

  const allowed = fakePool({ format_prefs: { humor: 'light', slang: true } });
  const r = await new ResourceProfilesRepository(allowed.pool as any).patchFormat(ref, { humor: 'none', slang: false }, { by: 'agent', reason: 'скарги' });
  assert.ok('ok' in r && r.ok, JSON.stringify(r));
  assert.deepEqual((allowed.writes[0] as any).format_prefs, { humor: 'none', slang: false });

  const owner = fakePool({ format_prefs: {} });
  const o = await new ResourceProfilesRepository(owner.pool as any).patchFormat(ref, { humor: 'light', slang: true }, { by: 'owner', locks: ['humor', 'slang'] });
  assert.ok('ok' in o && o.ok);
  assert.deepEqual((owner.writes[0] as any).format_locks, ['humor', 'slang']);

  const locked = fakePool({ format_prefs: { humor: 'light' }, format_locks: ['humor'] });
  const l = await new ResourceProfilesRepository(locked.pool as any).patchFormat(ref, { humor: 'none' }, { by: 'agent' });
  assert.equal('error' in l && l.error, 'locked_by_owner', 'a locked humour stays as the owner set it');
});

test('the Telegram card carries format_prefs humor / slang / emoji joined in on read', () => {
  const base = { channel_key: '@c', mode: 'live', language: 'uk', timezone: 'Europe/Kyiv', link_style: 'inline', emoji_policy: 'sparse' };
  const c = rowToCard({ ...base, humor_pref: 'light', slang_pref: 'true', emoji_pref: 'none' });
  assert.deepEqual([c.humor, c.slang, c.emojiPref], ['light', true, 'none']);
  const d = rowToCard({ ...base, humor_pref: null, slang_pref: 'false', emoji_pref: 'weird' });
  assert.deepEqual([d.humor, d.slang, d.emojiPref], [undefined, false, undefined]);
});
