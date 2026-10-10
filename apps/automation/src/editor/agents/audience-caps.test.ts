/**
 * Spec 034 FR-005: new cards start with text + photo (poll/quiz weight 0), the caps live in format_prefs
 * (schema, prompt rendering, an agent may only lower them), the playbook build no longer requires a CTA
 * and keeps poll/quiz at 0 by default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_CARD_FORMATS, makeChatCard, makeDefaultCard } from '../chat/default-card';
import { AgentCreator } from './agent-creator';
import type { EditorCard } from '../card';
import { FORMAT_PREF_FIELDS, FormatPrefsSchema, OWNER_ONLY_ON, profileCaps, renderFormatPrefs, ResourceProfilesRepository } from './resource-profile';
import { FormatPatchInput } from '../network/format-tools';
import { playbookBuildPrompt } from '../network/network-prompts';
import { rowToCard } from '../repo/editor-channels.repository';
import type { NetworkCtx } from '../network/network-context';

const weight = (c: EditorCard, f: string) => Number(c.formats[f] ?? 0);

test('default card: text and photo only — poll and quiz weight 0; the owner chat still allows every format', () => {
  const c = makeDefaultCard('@new', 'Нове');
  assert.deepEqual(c.formats, { text: 1, photo: 1 });
  assert.deepEqual({ ...DEFAULT_CARD_FORMATS }, { text: 1, photo: 1 });
  assert.equal(weight(c, 'poll'), 0);
  assert.equal(weight(c, 'quiz'), 0);
  (c.formats as Record<string, number>).album = 1; // a copy: the defaults never change
  assert.deepEqual(makeDefaultCard('@x', null).formats, { text: 1, photo: 1 });
  const chat = makeChatCard('@chat', null);
  assert.equal(weight(chat, 'poll'), 1, 'the owner asks for a poll himself in the chat');
});

test('a new agent gets a card with poll weight 0', async () => {
  const inserted: EditorCard[] = [];
  const creator = new AgentCreator({
    agents: {
      findTop: async () => null, handleTaken: async () => false,
      insert: async (a: any) => ({ id: 'a1', ...a }),
    } as any,
    registry: { ensureChildren: async () => {} } as any,
    catalog: { list: async () => [{ ref: 'telegram:@new', platform: 'telegram', agent: null, groupId: null }] } as any,
    profiles: { setProfile: async () => {} } as any,
    channels: { get: async () => null, insertIfMissing: async (c) => { inserted.push(c); return true; } },
  });
  const r = await creator.create({
    resource_ref: 'telegram:@new', name: 'Нова', handle: 'nova034',
    profile: { topic: 'Космос і астрономія', audience: { who: 'дорослі' }, goals: ['growth'] },
  });
  assert.ok(!('error' in r), JSON.stringify(r));
  assert.equal(inserted.length, 1);
  assert.equal(weight(inserted[0], 'poll'), 0);
  assert.equal(weight(inserted[0], 'quiz'), 0);
  assert.deepEqual(Object.keys(inserted[0].formats).sort(), ['photo', 'text']);
});

test('caps in format_prefs: schema, lockable fields, prompt rendering, patch input', () => {
  for (const f of ['content_kind', 'polls_per_week', 'questions_to_readers_per_day'] as const) assert.ok(FORMAT_PREF_FIELDS.includes(f), f);
  assert.deepEqual(FormatPrefsSchema.parse({ content_kind: 'news', polls_per_week: 0, questions_to_readers_per_day: 0 }),
    { content_kind: 'news', polls_per_week: 0, questions_to_readers_per_day: 0 });
  assert.equal(FormatPrefsSchema.safeParse({ content_kind: 'memes' }).success, false);
  assert.equal(FormatPrefsSchema.safeParse({ polls_per_week: 1.5 }).success, false);
  assert.equal(FormatPrefsSchema.safeParse({ questions_to_readers_per_day: -1 }).success, false);
  assert.equal(renderFormatPrefs({ content_kind: 'news', polls_per_week: 1, questions_to_readers_per_day: 0 }),
    'Тип ресурсу: новини\nОпитувань і вікторин на тиждень: до 1\nПитань до читачів у пості: до 0');
  assert.equal(FormatPatchInput.safeParse({ polls_per_week: 0 }).success, true);
  assert.equal(FormatPatchInput.safeParse({ content_kind: null }).success, true);
  assert.deepEqual(profileCaps({ topic: 'Новини Львова', format_prefs: {} }), { kind: 'news', kindInferred: true, pollsPerWeek: 1, questionsPerDay: 0 });
});

test('owner-only: an agent may lower the caps, never raise or clear them, and never set content_kind', () => {
  assert.equal(OWNER_ONLY_ON.polls_per_week!(0), false);
  assert.equal(OWNER_ONLY_ON.polls_per_week!(1), false);
  assert.equal(OWNER_ONLY_ON.polls_per_week!(2), true);
  assert.equal(OWNER_ONLY_ON.polls_per_week!(null), true, 'clearing would restore a possibly higher default');
  assert.equal(OWNER_ONLY_ON.questions_to_readers_per_day!(0), false);
  assert.equal(OWNER_ONLY_ON.questions_to_readers_per_day!(3), true);
  assert.equal(OWNER_ONLY_ON.content_kind!('general'), true);
});

/** A plain query object: patchFormat runs without a transaction (see ResourceProfilesRepository.tx). */
function fakePool(stored: Record<string, unknown>) {
  const writes: any[] = [];
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

test('patchFormat: an agent raising the poll cap is refused with a Ukrainian reason; lowering works; the owner sets anything', async () => {
  const a = fakePool({ topic: 'Космос', format_prefs: {} });
  const repo = new ResourceProfilesRepository(a.pool as any);
  const up = await repo.patchFormat('telegram:@c', { polls_per_week: 3 }, { by: 'agent', reason: 'опитування заходять' });
  assert.equal('error' in up && up.error, 'owner_only');
  assert.match(String((up as any).details), /ліміт опитувань агент може лише знизити/);
  const kind = await repo.patchFormat('telegram:@c', { content_kind: 'quiz' }, { by: 'agent' });
  assert.equal('error' in kind && kind.error, 'owner_only');
  const down = await repo.patchFormat('telegram:@c', { questions_to_readers_per_day: 0 }, { by: 'agent', reason: 'читачі не відповідають' });
  assert.ok('ok' in down && down.ok, JSON.stringify(down));
  assert.equal(a.writes[0].format_prefs.questions_to_readers_per_day, 0);

  const o = fakePool({ format_prefs: {} });
  const owner = await new ResourceProfilesRepository(o.pool as any).patchFormat('telegram:@c', { content_kind: 'quiz', polls_per_week: 14 },
    { by: 'owner', locks: ['polls_per_week'] });
  assert.ok('ok' in owner && owner.ok);
  assert.deepEqual(o.writes[0].format_locks, ['polls_per_week']);
  assert.equal(await new ResourceProfilesRepository(o.pool as any).capsOf('telegram:@c').then((c) => c.kind), 'general', 'capsOf reads the stored profile');
});

test('card join: caps from format_prefs + topic; a row without the join keeps the card unchanged', () => {
  const base = {
    channel_key: '@c', mode: 'live', title: null, language: 'uk', timezone: 'Europe/Kyiv', posts_per_day_min: 1, posts_per_day_max: 3,
    quiet_start_hour: 23, quiet_end_hour: 8, min_gap_minutes: 60, plan_hour: 6, brief: '', formats: { text: 1 }, hashtags: [], hashtag_min: 0,
    hashtag_max: 3, link_style: 'inline', emoji_policy: 'sparse', explore_ratio: 0.2, created_at: new Date(),
  };
  const news = rowToCard({ ...base, format_prefs_json: null, profile_topic: 'Новини Києва' });
  assert.deepEqual([news.readerQuestionsMax, news.pollsPerWeek], [0, 1]);
  const quiz = rowToCard({ ...base, format_prefs_json: { content_kind: 'quiz', questions_to_readers_per_day: 2 }, profile_topic: null });
  assert.deepEqual([quiz.readerQuestionsMax, quiz.pollsPerWeek], [2, null]);
  const plain = rowToCard(base);
  assert.ok(!('readerQuestionsMax' in plain) && !('pollsPerWeek' in plain));
});

test('playbook build prompt: CTA optional, poll/quiz at 0 unless asked or a quiz/education resource', () => {
  const net = { playbook: null, playbookVersion: 0 } as unknown as NetworkCtx;
  const p = playbookBuildPrompt({ net, brief: 'Канал про космос', now: new Date('2026-10-01T05:00:00Z'), tz: 'Europe/Kyiv' });
  assert.ok(!/хештеги, заклик/.test(p), 'the CTA is no longer a required section field');
  assert.match(p, /Заклик \(cta\) — необовʼязковий і за замовчуванням відсутній/);
  assert.match(p, /Опитування й вікторини \(poll, quiz\) — вага 0/);
  assert.match(p, /polls_per_week/);
});

test('skills no longer push polls, CTAs or questions to the audience', () => {
  const dir = join(__dirname, '..', '..', '..', 'editor-skills');
  const PUSHES = [
    /Закінчуй питанням/i, /питання до аудиторії, короткі/i, /коротке питання до читачів/i, /через голосування/i,
    /Як думаєте, коли/i, /заклик до обговорення/i, /хештеги, заклик\./i, /обіцянка або питання/i,
  ];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const re of PUSHES) assert.ok(!re.test(text), `${f}: ${re}`);
  }
  // How to make a good poll stays, behind the weekly cap.
  const poll = readFileSync(join(dir, 'format-poll-quiz.md'), 'utf8');
  assert.match(poll, /polls_per_week/);
  assert.match(poll, /correct_index/);
});
