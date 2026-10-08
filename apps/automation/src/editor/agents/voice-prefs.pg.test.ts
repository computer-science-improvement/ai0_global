/**
 * Spec 034 T1 on a throwaway Postgres: format_prefs.humor / slang are
 * owner-only switches (an agent's attempt to turn them on is refused, turning
 * them off works), lockable, and the Telegram card reads them (and emoji) for
 * the voice block and the slop lint. Skipped unless EDITOR_PG_TEST_URL is set.
 * Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { ResourceProfilesRepository } from './resource-profile';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';
import { buildSystemPrompt } from '../roles/prompts';
import { SkillLibrary } from '../skills/skill-library';
import { lintPost } from '../post/lint-post';
import { makeSpec } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@voice034_pg';
const REF = `telegram:${CH}`;
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
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

test('humour / slang: owner-only on, agent may switch off, the card and the prompt read them', { skip }, async () => {
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'Голос'), mode: 'shadow' });
  const profiles = new ResourceProfilesRepository(pool);

  // Default: no profile row — humour and slang off.
  let card = (await channels.get(CH))!;
  assert.deepEqual([card.humor, card.slang, card.emojiPref], [undefined, undefined, undefined]);
  assert.match(buildSystemPrompt('executor', card, [], new SkillLibrary()), /Гумор: вимкнено.*Сленг: ні/);

  // An agent cannot turn them on (no version is written).
  const refused = await profiles.patchFormat(REF, { humor: 'light' }, { by: 'agent', reason: 'аудиторія молода' });
  assert.equal('error' in refused && refused.error, 'owner_only');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM resource_profile_versions WHERE resource_ref = $1`, [REF])).rows[0].n, 0);

  // The owner turns them on and locks humour; the card and the prompt follow.
  const own = await profiles.patchFormat(REF, { humor: 'light', slang: true, emoji: 'none' }, { by: 'owner', locks: ['humor'], reason: 'owner edit' });
  assert.ok('ok' in own && own.ok, JSON.stringify(own));
  card = (await channels.get(CH))!;
  assert.deepEqual([card.humor, card.slang, card.emojiPref], ['light', true, 'none']);
  assert.match(buildSystemPrompt('executor', card, [], new SkillLibrary()), /Гумор: легкий.*Сленг: дозволено власником/);
  const listed = (await channels.listActive()).find((c) => c.channelKey === CH)!;
  assert.equal(listed.humor, 'light');

  // The lint reads the same card: slang allowed, emoji over format_prefs.emoji warns.
  const l = lintPost(makeSpec({ body: [{ type: 'lead', text: 'Туманність — імба 🌟' }] }), card);
  assert.ok(!l.warnings.some((w) => w.code === 'slop_slang_off'));
  assert.ok(l.warnings.some((w) => w.code === 'slop_emoji_over_pref'));

  // Locked humour stays; unlocked slang can be switched off by an agent.
  const locked = await profiles.patchFormat(REF, { humor: 'none' }, { by: 'agent', reason: 'скарги на жарти' });
  assert.equal('error' in locked && locked.error, 'locked_by_owner');
  const off = await profiles.patchFormat(REF, { slang: false }, { by: 'agent', reason: 'скарги на сленг' });
  assert.ok('ok' in off && off.ok, JSON.stringify(off));
  card = (await channels.get(CH))!;
  assert.deepEqual([card.humor, card.slang], ['light', false]);
});
