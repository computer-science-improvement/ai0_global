/**
 * Spec 037 FR-007 (T7): knowledge polls, revealed quiz answers, the poll cap on actual posts, the glossary on poll
 * text, and a quiz with an explanation through render + the publisher + the dry-run Preview.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasQuestionWord, isOpinionQuestion, optionFoundIn, optionKey, optionsAreNamesOrNumbers, revealText,
} from './knowledge-poll';
import { localDayIndex, maxPollsInWindow, pollCapGuard, pollCapIssue, slotSeriesOf, type PollCapGuardInput } from './poll-cap-guard';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';
import { pollCapCheck, pollsCheck } from '../integrity/checks/polls';
import { auditPostFromSpec } from '../integrity/from-post-spec';
import { effectiveStyle } from '../style/resource-style';
import { renderTelegram } from '../render-telegram';
import { buildRoleTools, type RoleToolDeps } from '../../tools/role-tools';
import { PreviewSink } from '../../roles/preview-run';
import { TelegramEditorPublisher } from '../../publish/telegram-editor.publisher';
import type { AuditPost } from '../integrity/types';

const AT = '2026-10-08T12:30:00+03:00';
const codes = (r: { errors: { code: string }[]; warnings: { code: string }[] }) => [...r.errors, ...r.warnings].map((i) => i.code);

const pollSpec = (o: { format?: 'poll' | 'quiz'; question?: string; options?: string[]; correct_index?: number; explanation?: string; intro?: string } = {}) => makeSpec({
  format: o.format ?? 'poll', title: 'Опитування', origin: 'original', media: [], hashtags: [], source: undefined,
  body: o.intro ? [{ type: 'p', text: o.intro }] : [],
  poll: {
    question: o.question ?? 'Яка планета Сонячної системи найбільша?',
    options: o.options ?? ['Сатурн', 'Юпітер', 'Нептун', 'Земля'],
    anonymous: true,
    ...(o.correct_index !== undefined ? { correct_index: o.correct_index } : {}),
    ...(o.explanation ? { explanation: o.explanation } : {}),
  },
});
const card = makeCard({ hashtags: [], hashtagMin: 0 });
const lint = (spec = pollSpec(), previous: AuditPost[] = []) =>
  lintPost(spec, card, { id: 'slot', channel: '@chan', publishedAt: AT, timezone: 'Europe/Kyiv', ctx: { previous } });

const earlier = (id: string, text: string, minutesBefore: number): AuditPost => ({
  id, channel: '@chan', publishedAt: new Date(Date.parse(AT) - minutesBefore * 60_000).toISOString(), timezone: 'Europe/Kyiv',
  text, links: [], buttons: [], hashtags: [], media: null,
});

test('knowledge question vs opinion: question words, names / numbers, the reader\'s taste', () => {
  for (const q of ['Який офісний пакет заявив, що відсутність ШІ — це фіча?', 'Скільки параметрів активні на кожен токен?', 'Хто очолює Xbox?', 'Коли вийде GTA 6?', 'Де зібрали модель?', 'Якою мовою написано ядро?']) {
    assert.ok(hasQuestionWord(q), q);
    assert.ok(!isOpinionQuestion(q), q);
  }
  for (const q of ['Де ви найчастіше запускаєте ШІ-моделі?', 'Що ти робиш із безкоштовними іграми?', 'Яка гра вересня?', 'Яка ваша улюблена модель?', 'Який реліз найкращий цього тижня?', 'Яку гру осені чекаєте найбільше?']) {
    assert.ok(isOpinionQuestion(q), q);
  }
  assert.ok(!isOpinionQuestion('Чи знаєте ви, скільки параметрів у Mistral Large 4?'), 'a guess addressed to the reader is still knowledge');
  assert.ok(optionsAreNamesOrNumbers(['LibreOffice', 'Microsoft Office', 'Google Docs']));
  assert.ok(optionsAreNamesOrNumbers(['Усі 1,05 трлн на кожен токен', '49 мільярдів', '105 мільярдів']));
  assert.ok(optionsAreNamesOrNumbers(['Сатурн', 'Юпітер', 'Нептун']));
  assert.ok(!optionsAreNamesOrNumbers(['Забираю все підряд', 'Тільки те, що реально гратиму', 'Взагалі не стежу']));
  assert.ok(!optionsAreNamesOrNumbers(['Так', 'Ні']));
});

test('an option is found by its numbers (one canonical value), Latin words and Cyrillic stems — every part of it', () => {
  const t = revealText('t', 'Mistral Large 4: 1,05 трлн параметрів, з яких на кожен токен активні лише 49 млрд. Співвідношення 1,05T/49B.');
  assert.ok(optionFoundIn(optionKey('49 мільярдів'), t));
  assert.ok(optionFoundIn(optionKey('49B'), t));
  assert.ok(!optionFoundIn(optionKey('105 мільярдів'), t));
  assert.ok(!optionFoundIn(optionKey('Усі 1,05 трлн на кожен токен'), t), '«усі» is the claim, not in the text');
  const lo = revealText('t', 'The Document Foundation, організація за LibreOffice, заявила: ШІ не зʼявиться.');
  assert.ok(optionFoundIn(optionKey('LibreOffice'), lo));
  assert.ok(!optionFoundIn(optionKey('Microsoft Office'), lo));
  assert.ok(optionFoundIn(optionKey('Юпітер'), revealText('t', 'Найбільша планета — Юпітера не обійти.')), 'cases by stem');
  assert.ok(!optionFoundIn(optionKey('Так'), revealText('t', 'Так, це правда.')), 'yes / no answers carry nothing to find');
  assert.ok(optionFoundIn(optionKey('4'), revealText('t', 'Epic роздає 4 гри.')), 'bare numbers');
  assert.ok(!optionFoundIn(optionKey('4'), revealText('t', 'Epic роздає 14 ігор.')));
});

test('lintPost: a knowledge question as a regular poll is a warning for the writer and the critic; the quiz passes', () => {
  const regular = lint();
  assert.equal(regular.ok, true);
  assert.deepEqual(regular.warnings.filter((w) => w.code === 'knowledge_poll').length, 1);
  const quiz = lint(pollSpec({ format: 'quiz', correct_index: 1, explanation: 'Юпітер у 11 разів ширший за Землю.' }));
  assert.equal(quiz.ok, true, JSON.stringify(quiz.errors));
  assert.ok(!codes(quiz).includes('knowledge_poll'));
  // Opinion polls stay regular and clean.
  const opinion = lint(pollSpec({ question: 'Яку гру осені ви чекаєте найбільше?', options: ['Wolverine', 'Control Resonant', 'Dune: Awakening'] }));
  assert.ok(!codes(opinion).includes('knowledge_poll') && !codes(opinion).includes('quiz_answer_revealed'), JSON.stringify(codes(opinion)));
});

test('lintPost: the right answer in the intro, the companion post or a story post of 24 h blocks; explanation is the place', () => {
  const quiz = (intro?: string) => pollSpec({ format: 'quiz', correct_index: 1, explanation: 'Юпітер — найбільша планета.', intro });
  // In the intro.
  const intro = lint(quiz('Юпітер важчий за всі інші планети разом. Перевірте себе:'));
  assert.equal(intro.ok, false);
  assert.match(intro.errors.find((e) => e.code === 'quiz_answer_revealed')!.message, /Юпітер.*вступ/);
  // A list of every candidate does not tell which one is right.
  assert.ok(!codes(lint(quiz('Сатурн, Юпітер, Нептун чи Земля — хто більший?'))).includes('quiz_answer_revealed'));
  // In the explanation only: fine.
  assert.equal(lint(quiz()).ok, true);
  // The companion post (2 min before) and a post of the same story (20 h before); not a day and a half before.
  const mistral = (prev: AuditPost[]) => lint(pollSpec({
    format: 'quiz', question: 'Скільки параметрів Mistral Large 4 реально активні на кожен токен?',
    options: ['Усі 1,05 трлн', '49 мільярдів', '105 мільярдів'], correct_index: 1, explanation: 'MoE: на токен працюють 49 млрд з 1,05 трлн.',
  }), prev);
  const story = 'Mistral випустив Mistral Large 4 «Le Chonk»: 1,05 трлн параметрів, з яких на кожен токен активні лише 49 млрд. Відкриті ваги наприкінці жовтня.';
  assert.ok(codes(mistral([earlier('p1', story, 2)])).includes('quiz_answer_revealed'), 'companion');
  assert.ok(codes(mistral([earlier('p1', story, 20 * 60)])).includes('quiz_answer_revealed'), 'same story, 20 h');
  assert.ok(!codes(mistral([earlier('p1', story, 36 * 60)])).includes('quiz_answer_revealed'), 'older than 24 h');
  assert.ok(!codes(mistral([earlier('p1', 'Apple показала новий iPad Pro з чипом M6: 49 мільярдів транзисторів.', 3 * 60)])).includes('quiz_answer_revealed'), 'another story');
  // A regular knowledge poll whose answer is next to it: the warning and the error.
  const regular = lint(pollSpec(), [earlier('p1', 'Найбільша планета Сонячної системи — Юпітер.', 1)]);
  assert.deepEqual(['knowledge_poll', 'quiz_answer_revealed'].map((c) => codes(regular).includes(c)), [true, true]);
});

test('glossary (T8) applies to the poll question and options', () => {
  const spec = pollSpec({ question: 'Де ви найчастіше запускаєте моделі?', options: ['Хмара через АПІ', 'Агенти й КЛІ', 'Локально'] });
  const r = lintPost(spec, { ...card, style: effectiveStyle(null, {}) }, { publishedAt: AT, ctx: { previous: [] } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.filter((e) => e.code === 'glossary_violation').length, 2, JSON.stringify(r.errors));
});

test('poll cap on a timeline (export audit): a second poll in any 7 local days over the cap; null = no cap; lintPost skips it', () => {
  const p = (id: string, at: string): AuditPost => auditPostFromSpec(pollSpec({ question: 'Що ви робите з роздачами?', options: ['Забираю', 'Пропускаю'] }), { id, channel: '@chan', publishedAt: at, timezone: 'Europe/Kyiv' });
  const first = p('a', '2026-10-07T21:00:00+03:00');
  const second = p('b', '2026-10-10T20:00:00+03:00');
  assert.deepEqual(pollCapCheck.run(second, { previous: [first] }).map((f) => f.code), ['poll_cap_reached']);
  assert.deepEqual(pollCapCheck.run(second, { previous: [first], card: { pollsPerWeek: 2 } }), []);
  assert.deepEqual(pollCapCheck.run(second, { previous: [first], card: { pollsPerWeek: null } }), []);
  assert.deepEqual(pollCapCheck.run(p('c', '2026-10-14T09:00:00+03:00'), { previous: [first] }), [], '7 local days later');
  assert.equal(pollCapCheck.lintEnforced, true);
  assert.deepEqual(pollsCheck.run(first, { previous: [] }), []);
});

test('maxPollsInWindow / pollCapIssue: the plan validators\' rule on actual posts (7 local days, series, cap)', () => {
  assert.equal(maxPollsInWindow([10, 16], 13), 2, 'both in one week with day 13');
  assert.equal(maxPollsInWindow([3, 20], 13), 0);
  assert.equal(maxPollsInWindow([7, 19], 13), 1, 'never in one window with each other');
  const tz = 'Europe/Kyiv';
  const at = new Date('2026-10-10T17:00:00Z');
  assert.equal(localDayIndex(new Date('2026-10-09T21:30:00Z'), tz), localDayIndex(at, tz), '00:30 Kyiv is the same local day');
  const base: PollCapGuardInput = { channelKey: '@chan', format: 'poll', at, timezone: tz, cap: undefined };
  const day = (d: string) => ({ at: new Date(`${d}T09:00:00Z`), series: null });
  assert.equal(pollCapIssue(base, [day('2026-10-07')])?.error, 'poll_cap_reached', 'default cap 1');
  assert.equal(pollCapIssue(base, [day('2026-10-03')]), null, '7 local days back is out');
  assert.equal(pollCapIssue(base, [day('2026-10-15')])?.error, 'poll_cap_reached', 'a waiting poll later in the week');
  assert.equal(pollCapIssue({ ...base, cap: 2 }, [day('2026-10-07')]), null);
  assert.equal(pollCapIssue({ ...base, cap: null }, [day('2026-10-07')]), null);
  assert.equal(pollCapIssue({ ...base, format: 'text' }, [day('2026-10-07')]), null);
  const owner = [{ name: 'Вікторина пʼятниці', origin: 'owner' }];
  assert.equal(pollCapIssue({ ...base, playbookSeries: owner }, [{ ...day('2026-10-07'), series: 'Вікторина пʼятниці' }]), null, 'owner series do not count');
  assert.equal(pollCapIssue({ ...base, playbookSeries: owner, series: 'Вікторина пʼятниці' }, [day('2026-10-07')]), null, 'and are never blocked');
  assert.equal(pollCapIssue({ ...base, playbookSeries: [{ name: 'Агентська', origin: 'agent' }] }, [{ ...day('2026-10-07'), series: 'Агентська' }])?.error, 'poll_cap_reached');
  assert.equal(slotSeriesOf({ sourceHints: ['feed:x', 'series:Огляд'] }), 'Огляд');
  assert.equal(slotSeriesOf({ seriesName: 'A', sourceHints: ['series:B'] }), 'A');
});

test('pollCapGuard: no query for other formats; the SQL gets the channel, poll formats, the window and the slot', async () => {
  const calls: any[][] = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push([sql, params]); return { rows: [{ at: '2026-10-07T18:00:00Z', series: null }] }; } } as any;
  const i: PollCapGuardInput = { channelKey: '@chan', format: 'text', at: new Date('2026-10-10T17:00:00Z'), timezone: 'Europe/Kyiv', cap: 1, slotId: 's1' };
  assert.equal(await pollCapGuard(pool, i), null);
  assert.equal(calls.length, 0);
  assert.equal((await pollCapGuard(pool, { ...i, format: 'quiz' }))?.error, 'poll_cap_reached');
  assert.deepEqual(calls[0][1].slice(0, 2), ['@chan', ['poll', 'quiz']]);
  assert.equal(calls[0][1][4], 's1');
  assert.equal(await pollCapGuard(pool, { ...i, format: 'poll', cap: null }), null);
  assert.equal(calls.length, 1, 'no cap, no query');
});

// ── publish_post ──────────────────────────────────────────────────────────

const NOW = new Date('2026-10-10T09:00:00Z'); // 12:00 Kyiv

function roleDeps(pollRows: any[]) {
  const sent: any[] = [];
  const updates: any[] = [];
  const plans: any = {
    createPlan: async () => 'plan-1', reservedSlots: async () => [],
    getSlot: async (id: string) => ({ id, channelKey: '@chan', status: 'running', scheduledAt: NOW, sourceHints: [] }),
    updateSlot: async (id: string, p: any) => { updates.push([id, p]); },
    countPublishedSince: async () => 0, lastPostAt: async () => null, sourceAlreadyPosted: async () => false,
    recentTexts: async () => [], insertPublication: async () => 501,
  };
  const d: RoleToolDeps = {
    // Every query but the poll cap's returns nothing (recent posts, quiz ground truth, verbatim).
    pool: { query: async (sql: string) => ({ rows: /FROM published_posts p/.test(sql) ? pollRows : [] }) } as any,
    plans,
    memory: { listActive: async () => [], add: async () => 1, retireByReviewer: async () => false },
    channels: { setFormatWeights: async (_k: string, w: any) => w },
    publisher: { send: async (_k: string, m: any) => { sent.push(m); return { messageIds: [900] }; } },
    recordPublish: () => {},
    now: () => NOW,
  };
  return { tools: Object.fromEntries(buildRoleTools(d).map((t) => [t.name, t])), sent, updates };
}
const roleCtx = (mode: 'live' | 'approve' | 'shadow', extras: Record<string, unknown> = {}) =>
  ({ runId: 'run-1', role: 'executor' as const, channelKey: '@chan', slotId: 'slot-1', extras: { card: makeCard({ mode, hashtags: [], hashtagMin: 0 }), ...extras } });
const opinion = () => pollSpec({ question: 'Що ви робите з роздачами ігор?', options: ['Забираю все', 'Лише те, що гратиму'] });

test('publish_post: a second poll in the week is blocked before anything is sent or stored (live, approval, shadow)', async () => {
  for (const mode of ['live', 'approve', 'shadow'] as const) {
    const h = roleDeps([{ at: '2026-10-07T18:00:00Z', series: null }]);
    const r: any = await h.tools.publish_post.execute({ spec: opinion() }, roleCtx(mode));
    assert.equal(r.error, 'poll_cap_reached', mode);
    assert.equal(h.sent.length + h.updates.length, 0, `${mode}: nothing sent or stored`);
  }
  const ok = roleDeps([]);
  const r: any = await ok.tools.publish_post.execute({ spec: opinion() }, roleCtx('live'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ok.sent[0][0].method, 'sendPoll');
});

test('a quiz with an explanation renders, goes through the publisher payload and the dry-run Preview', async () => {
  const spec = pollSpec({ format: 'quiz', correct_index: 1, explanation: 'Юпітер у 11 разів ширший за Землю.', intro: 'Перевірте себе.' });
  const rendered = renderTelegram(spec, makeCard());
  const poll = rendered.messages.find((m) => m.method === 'sendPoll') as any;
  assert.deepEqual([poll.quiz, poll.correctIndex, poll.explanation], [true, 1, 'Юпітер у 11 разів ширший за Землю.']);
  assert.match(rendered.preview, /✅ Юпітер/);

  const calls: any[] = [];
  const pub = new TelegramEditorPublisher(
    { resolveChannel: () => ({ chatId: '-100123', botToken: 'TOKEN' }), isPublishPausedFor: () => false } as any,
    async (url: string, body: any) => { calls.push({ url, body }); return { data: { ok: true, result: { message_id: calls.length } } }; });
  const res = await pub.send('@c', rendered.messages);
  assert.equal(res.messageIds.length, 2);
  const quiz = calls.find((c) => /sendPoll$/.test(c.url))!.body;
  assert.deepEqual([quiz.type, quiz.correct_option_id, quiz.explanation], ['quiz', 1, 'Юпітер у 11 разів ширший за Землю.']);

  const sink = new PreviewSink();
  const h = roleDeps([]);
  const r: any = await h.tools.publish_post.execute({ spec }, { ...roleCtx('live', { dryRun: sink }), slotId: 'slot-1' });
  assert.deepEqual([r.ok, r.dry], [true, true], JSON.stringify(r));
  assert.equal(h.sent.length, 0, 'dry run sends nothing');
  assert.match(sink.post!.preview, /✅ Юпітер/);
});
