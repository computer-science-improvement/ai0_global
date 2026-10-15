import { test } from 'node:test';
import assert from 'node:assert/strict';
import { implementedCodes, INTEGRITY_CHECKS, runIntegrityChecks, timelineContexts } from './registry';
import { INTEGRITY_CODES, parseLabelCode } from './codes';
import { auditPosts, localStamp, renderAuditMarkdown } from './audit-report';
import { bodyText, type AuditPost, type IntegrityCheck } from './types';

const post = (over: Partial<AuditPost> = {}): AuditPost => ({
  id: 'ch:1', channel: 'Канал', publishedAt: '2026-10-08T12:00:00+02:00', timezone: 'Europe/Kyiv',
  text: 'Текст поста.', links: [], buttons: [], hashtags: [], media: null, ...over,
});

test('registry: check ids unique, every declared code is in the 037 catalogue', () => {
  const ids = INTEGRITY_CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const code of implementedCodes()) assert.ok(INTEGRITY_CODES[code], `${code} missing from integrity/codes.ts`);
  assert.ok(implementedCodes().has('banned_term') && implementedCodes().has('slop_em_dash') && implementedCodes().has('reader_questions'));
});

test('registry: the 034 adapters fire like lintPost (phrase error, slop warnings, reader questions over the cap)', () => {
  const p = post({ text: 'Варто зазначити: запуск — завтра — о 10:00 — у Києві.\n\nА ви підете? Як думаєте, буде черга?\n\n→ Джерело\n\n#київ' });
  const f = runIntegrityChecks(p, { previous: [] });
  assert.deepEqual(f.filter((x) => x.code === 'banned_term').map((x) => x.level), ['error']);
  assert.ok(f.some((x) => x.code === 'slop_em_dash' && x.level === 'warning'));
  assert.ok(f.some((x) => x.code === 'reader_questions' && x.level === 'error'), 'two questions over the default cap 1');
  assert.ok(!runIntegrityChecks(p, { previous: [], card: { readerQuestionsMax: 2 } }).some((x) => x.code === 'reader_questions'));
  const owner = runIntegrityChecks(post({ text: 'Доставка завтра.' }), { previous: [], card: { bannedTerms: ['ставк'] } });
  assert.deepEqual(owner.map((x) => [x.code, x.excerpt]), [['banned_term', 'доставка']]);
});

test('registry: a check that throws is reported, the others still run', () => {
  const boom: IntegrityCheck = { id: 'boom', codes: ['x'], run: () => { throw new Error('bad input'); } };
  const ok: IntegrityCheck = { id: 'ok', codes: ['y'], run: () => [{ code: 'y', level: 'warning', message: 'y' }] };
  assert.deepEqual(runIntegrityChecks(post(), { previous: [] }, [boom, ok]).map((f) => [f.code, f.level, f.message]),
    [['check_failed', 'error', 'boom: bad input'], ['y', 'warning', 'y']]);
  assert.deepEqual([...implementedCodes([boom, ok])], ['x', 'y']);
});

test('timeline: previous = same channel newest first, network = other channels before the post', () => {
  const a1 = post({ id: 'a:1', channel: 'A', publishedAt: '2026-10-07T10:00:00+02:00' });
  const b1 = post({ id: 'b:1', channel: 'B', publishedAt: '2026-10-07T11:00:00+02:00' });
  const a2 = post({ id: 'a:2', channel: 'A', publishedAt: '2026-10-07T09:30:00Z' });
  const b2 = post({ id: 'b:2', channel: 'B', publishedAt: '2026-10-08T09:00:00+02:00' });
  const rows = timelineContexts([b2, a2, b1, a1], () => ({ now: 'x' }));
  assert.deepEqual(rows.map((r) => r.post.id), ['a:1', 'b:1', 'a:2', 'b:2']);
  const at = (id: string) => rows.find((r) => r.post.id === id)!.ctx;
  assert.deepEqual(at('a:2').previous.map((p) => p.id), ['a:1']);
  assert.deepEqual(at('a:2').network?.map((p) => p.id), ['b:1']);
  assert.deepEqual(at('b:2').previous.map((p) => p.id), ['b:1']);
  assert.deepEqual(at('b:2').network?.map((p) => p.id), ['a:2', 'a:1']);
  assert.equal(at('a:1').now, 'x');
});

test('bodyText drops the rendered source and hashtag lines only at the end', () => {
  assert.equal(bodyText({ text: 'Перше.\n\n#тег у тексті\n\nДруге.\n\n→ TechCrunch\n\n#ai #google' }), 'Перше.\n\n#тег у тексті\n\nДруге.');
  assert.equal(bodyText({ text: 'Лише текст.' }), 'Лише текст.');
});

test('label codes: `code@Tn` marks a pending extension', () => {
  assert.deepEqual(parseLabelCode('banned_term@T6'), { code: 'banned_term', pendingTask: 'T6' });
  assert.deepEqual(parseLabelCode('story_repeat'), { code: 'story_repeat' });
});

test('audit report: local wall time in the resource zone, a table per channel, summary counts', () => {
  assert.equal(localStamp('2026-10-08T14:13:57+02:00', 'Europe/Kyiv'), '08.10 15:13');
  assert.equal(localStamp('2026-10-25T01:30:00Z', 'Europe/Kyiv'), '25.10 03:30', 'after the DST end Kyiv is UTC+2');
  const rows = auditPosts([
    post({ id: 'a:1', channel: 'A', text: 'Варто зазначити | щось.' }),
    post({ id: 'b:1', channel: 'B', text: 'Чистий текст.' }),
  ]);
  const md = renderAuditMarkdown(rows, { title: 'T', codes: ['banned_term'] });
  assert.match(md, /^# T\n/);
  assert.match(md, /## A\n\n1 posts, 1 with findings: 1 errors, 0 warnings\./);
  assert.match(md, /\| 08\.10 13:00 \| a:1 \| banned_term \| error \| варто зазначити \|/);
  assert.match(md, /## B\n\n1 posts, 0 with findings: 0 errors, 0 warnings\.\n\nNo findings\./);
  assert.match(md, /\| banned_term \| 1 \| 0 \|/);
});
