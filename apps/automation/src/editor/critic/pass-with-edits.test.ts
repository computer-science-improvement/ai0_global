/**
 * Spec 041 FR-002 (T2): `pass_with_edits` — exact replacements code applies to the spec (and the lint's euphony
 * fixes), the guards run again on the edited spec, no new LLM turn; a 4 with a quoted problem and no edits revises.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySpecEdits, lintFixes, occurrences } from './spec-edits';
import { CRITIC_SCORE_KEYS, decideVerdict, type CriticScores } from './critic';
import { CriticGate } from './critic-gate';
import { CriticService } from './critic.service';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { makeSpec } from '../post/testing/fixtures';

const NOW = new Date('2026-10-17T09:00:00Z');
const all = (n: number): CriticScores => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;

test('applySpecEdits: reader text only, exactly one match, failures reported with the count', () => {
  const spec = makeSpec({
    body: [
      { type: 'lead', text: 'Perplexity відкрила код SPACE' },
      { type: 'p', text: 'Код опублікований за ліцензією Apache 2.0, її можуть використовувати інші команди.' },
      { type: 'list', items: ['один пункт', 'другий пункт'] },
    ],
    source: { url: 'https://example.com/її', label: 'Example' },
  });
  const r = applySpecEdits(spec, [
    { from: 'Apache 2.0, її можуть', to: 'Apache 2.0, його можуть' },
    { from: 'пункт', to: 'рядок' },
    { from: 'немає такого', to: 'x' },
  ]);
  assert.deepEqual(r.applied.map((e) => e.to), ['Apache 2.0, його можуть']);
  assert.deepEqual(r.failed.map((e) => [e.from, e.found]), [['пункт', 2], ['немає такого', 0]]);
  assert.match((r.spec.body[1] as any).text, /його можуть/);
  assert.equal(r.spec.source?.url, 'https://example.com/її', 'URLs are never edited');
  assert.equal(occurrences(spec, 'її'), 1, 'the URL is not counted as text');
  // A slide title is reader text; the internal post title is not.
  const slides = applySpecEdits({ title: 'Марс', slides: [{ title: 'Марс', text: 'т' }] }, [{ from: 'Марс', to: 'Марсі' }]);
  assert.deepEqual(slides.spec, { title: 'Марс', slides: [{ title: 'Марсі', text: 'т' }] });
  assert.deepEqual(lintFixes([{ code: 'a', message: 'm' }, { code: 'language_euphony', message: 'm', fix: { from: 'У інших', to: 'В інших' } } as any]), [{ from: 'У інших', to: 'В інших' }]);
});

test('decideVerdict: pass_with_edits is a pass; a 4 quoting a problem without edits revises; praise stays a pass', () => {
  const s = { ...all(5), sense: 4 };
  const edits = [{ from: 'її можуть', to: 'його можуть' }];
  assert.deepEqual(decideVerdict({ scores: s, verdict: 'pass_with_edits', edits, notes: '«її» — про код, не ліцензію.' }), { verdict: 'pass', reason: 'scores_ok_with_edits' });
  assert.deepEqual(decideVerdict({ scores: s, verdict: 'pass', notes: '«її» відсилає до ліцензії, а мається на увазі код.' }), { verdict: 'revise', reason: 'quoted_problem: sense' });
  assert.deepEqual(decideVerdict({ scores: s, verdict: 'pass', notes: 'Факти збігаються з джерелом.' }), { verdict: 'pass', reason: 'scores_ok' });
  assert.deepEqual(decideVerdict({ scores: all(5), verdict: 'pass', notes: 'Добре, «Muse Spark» названо правильно.' }), { verdict: 'pass', reason: 'scores_ok' }, 'all fives: a quote is no problem');
  assert.deepEqual(decideVerdict({ scores: { ...all(5), language: 3 }, verdict: 'pass' }), { verdict: 'revise', reason: 'score_le_3: language' });
});

function gateOver(turns: ConstructorParameters<typeof FakeLlm>[0]) {
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const service = new CriticService({ loop, env: () => undefined, defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => null, now: () => NOW });
  const updates: any[] = [];
  const gate = new CriticGate(
    { critic: service, plans: { updateSlot: async (_id: string, p: any) => { updates.push(p); } } },
    { slotId: 's1', channelKey: '@chan', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} },
  );
  return { gate, llm, updates };
}
const answer = (verdict: string, o: { scores?: Partial<CriticScores>; edits?: Array<{ from: string; to: string }>; notes?: string } = {}) =>
  ({ calls: [{ name: 'submit_critique', args: { scores: { ...all(5), ...o.scores }, verdict, notes: o.notes ?? 'Добре.', ...(o.edits ? { edits: o.edits } : {}) } }] });

const post = () => makeSpec({ body: [{ type: 'lead', text: 'Огляд показав приріст' }, { type: 'p', text: 'Код за ліцензією Apache 2.0, її можуть брати всі. У інших задачах менше.' }] });

test('gate: the critic edits and the lint euphony fix are applied, the guards run again, no second critic call', async () => {
  const g = gateOver([answer('pass_with_edits', { scores: { sense: 4 }, edits: [{ from: 'Apache 2.0, її можуть', to: 'Apache 2.0, його можуть' }], notes: '«її» — про код.' })]);
  const relinted: any[] = [];
  const out = await g.gate.check({
    text: 't', spec: post(), format: 'photo',
    warnings: [{ code: 'language_euphony', message: 'm', fix: { from: 'У інших', to: 'В інших' } }],
    relint: async (s) => { relinted.push(s); return { ok: true, state: 'guards-ok' }; },
  });
  assert.equal(out.kind, 'proceed');
  assert.ok(out.kind === 'proceed' && out.edited);
  const text = ((out as any).edited.spec.body[1]).text as string;
  assert.equal(text, 'Код за ліцензією Apache 2.0, його можуть брати всі. В інших задачах менше.');
  assert.equal((out as any).edited.state, 'guards-ok');
  assert.equal(relinted.length, 1);
  assert.equal(g.llm.requests.length, 1, 'one critic call');
  const stored = g.updates.at(-1).critic;
  assert.deepEqual(stored.edits_applied.map((e: any) => e.to), ['Apache 2.0, його можуть', 'В інших']);
  assert.equal(stored.verdict, 'pass');
  assert.equal(stored.model_verdict, 'pass_with_edits');
  // A retry of the same post returns the same edited spec without a new review.
  const again = await g.gate.check({ text: 't', spec: post(), format: 'photo', warnings: [], relint: async () => ({ ok: true }) });
  assert.equal((again as any).edited.spec.body[1].text, text);
  assert.equal(g.llm.requests.length, 1);
});

test('gate: an edit that does not match once revises on the first pass; the guards refusing the edit revises too; later passes publish as written', async () => {
  const miss = gateOver([answer('pass_with_edits', { edits: [{ from: 'нема такого', to: 'немає того' }] })]);
  const r1 = await miss.gate.check({ text: 't', spec: post(), format: 'photo', warnings: [], relint: async () => ({ ok: true }) });
  assert.equal(r1.kind, 'revise');
  assert.match(JSON.stringify((r1 as any).result.details), /нема такого/);
  assert.match((r1 as any).critic.reason, /^edits_failed/);

  const lintNo = gateOver([answer('pass_with_edits', { edits: [{ from: 'брати всі', to: 'брати всі!!!' }] })]);
  const r2 = await lintNo.gate.check({ text: 't', spec: post(), format: 'photo', warnings: [], relint: async () => ({ ok: false, errors: ['lint_failed: slop'] }) });
  assert.equal(r2.kind, 'revise');
  assert.match((r2 as any).critic.reason, /^edits_lint: lint_failed/);

  // Second pass (after a revise): failed edits are recorded, the post goes out as the writer wrote it.
  const late = gateOver([answer('revise', { scores: { sense: 3 }, notes: 'Переписати лід.' }), answer('pass_with_edits', { edits: [{ from: 'нема такого', to: 'немає того' }] })]);
  assert.equal((await late.gate.check({ text: 't', spec: post(), format: 'photo', warnings: [] })).kind, 'revise');
  const r3 = await late.gate.check({ text: 't2', spec: makeSpec({ title: 'Друга версія' }), format: 'photo', warnings: [], relint: async () => ({ ok: true }) });
  assert.equal(r3.kind, 'proceed');
  assert.equal((r3 as any).edited, undefined);
  assert.equal(late.updates.at(-1).critic.edits_failed[0].found, 0);
});

test('gate: without relint (chat drafts) the edits stay on the verdict as advice', async () => {
  const g = gateOver([answer('pass_with_edits', { edits: [{ from: 'брати всі', to: 'використовувати всі' }] })]);
  const out = await g.gate.check({ text: 't', spec: post(), format: 'photo', warnings: [] });
  assert.equal(out.kind, 'proceed');
  assert.equal((out as any).edited, undefined);
  assert.deepEqual(g.updates.at(-1).critic.edits, [{ from: 'брати всі', to: 'використовувати всі' }]);
});

// ── spec 063 FR-004: safe edits ───────────────────────────────────────────────

import { dropsWord, guardEdits, wordTokens } from './safe-edits';
import { dashFixes } from '../post/dash-fix';

test('063: an edit that drops a word is rejected (pp1732 «— це ліміт»); a word-for-word replacement stays', () => {
  assert.deepEqual(wordTokens('(context window) — це ліміт'), ['context', 'window', 'це', 'ліміт']);
  assert.equal(dropsWord('(context window) — це ліміт', '(context window) ліміт'), true, 'pp1732');
  assert.equal(dropsWord('тими самі', 'ті самі'), false);
  assert.equal(dropsWord('У інших', 'В інших'), false);
  assert.equal(dropsWord('що що вийшло', 'що вийшло'), false, 'a duplicated word may go');
  assert.equal(dropsWord('коротка — і ясна', 'коротка, і ясна'), false, 'punctuation is not a word');
  assert.equal(dropsWord('брати участь', 'брати'), true);
  const text = 'Контекстне вікно (context window) — це ліміт. Вони говорили про тими самі речі.';
  const g = guardEdits(text, [
    { from: '(context window) — це ліміт', to: '(context window) ліміт' },
    { from: 'тими самі речі', to: 'ті самі речі' },
  ]);
  assert.deepEqual(g.ok.map((e) => e.to), ['ті самі речі']);
  assert.deepEqual(g.rejected.map((e) => [e.from, e.why]), [['(context window) — це ліміт', 'word_dropped']]);
});

test('063: the Ukrainian lexicon runs on the edited text: an edit that makes a new finding is reverted', () => {
  const text = 'Сервіс працює швидко. Він вийшов у Києві.';
  const g = guardEdits(text, [
    { from: 'Сервіс працює швидко', to: 'Сервіс являється швидким' },
    { from: 'Він вийшов у Києві', to: 'Він з’явився у Києві' },
  ]);
  assert.deepEqual(g.rejected.map((e) => [e.to, e.why]), [['Сервіс являється швидким', 'language_regression']]);
  assert.match(g.rejected[0].detail ?? '', /являється/);
  assert.equal(g.ok.length, 1, 'the harmless edit stays');
  // A finding the post already had is not blamed on the edit.
  const had = guardEdits('Це являється проблемою. Ціна 5 доларів.', [{ from: 'Ціна 5 доларів', to: 'Ціна 6 доларів' }]);
  assert.equal(had.rejected.length, 0);
});

test('063: dashFixes — the excess dashes become commas or a colon in code; «— це», dialogue and ranges stay', () => {
  const long = (s: string) => `${s} ${'Слово. '.repeat(120)}`; // > 800 chars: 2 dashes allowed
  assert.deepEqual(dashFixes('Модель вийшла — вона швидша.'), [], 'one dash is allowed');
  const base = 'Модель вийшла — вона швидша. Є одна проблема — ціна. Контекстне вікно — це ліміт.';
  const fixes = dashFixes(base);
  assert.ok(fixes.length >= 1);
  const out = applySpecEdits({ t: base }, fixes).spec.t;
  assert.match(out, /Є одна проблема: ціна/);
  assert.match(out, /вікно — це ліміт/, '«— це» stays');
  assert.equal(out.match(/—/g)?.length, 1, 'the lint allowance is one dash: the protected one');
  // A parenthetical pair becomes two commas; the edit applies exactly once.
  const pair = 'Компанія випустила модель — повільну й дорогу — минулого тижня. Вона перша — і остання.';
  const p = applySpecEdits({ t: pair }, dashFixes(pair));
  assert.equal(p.failed.length, 0);
  assert.ok((p.spec.t.match(/—/g)?.length ?? 0) <= 1, 'within the allowance of a short text (a pair is converted whole)');
  assert.match(p.spec.t, /модель, повільну й дорогу, минулого тижня/);
  // Dialogue, a range and a quote after the dash stay.
  const keep = 'Він спитав:\n— Куди?\nДіапазон 10 — 20 днів. Один — «Два». Три — Чотири. Ще — ось так.';
  assert.deepEqual(dashFixes(keep), []);
  // The text is long: the allowance grows with it.
  assert.deepEqual(dashFixes(long('Модель — вона швидша. Друга — теж.')), []);
});

test('gate 063: a word-dropping critic edit is refused and recorded; the safe lint fix and the dash transform still go out', async () => {
  const body = 'Контекстне вікно (context window) — це ліміт. Вони тими самі речі. Код вийшов — швидкий. Далі — повільний.';
  const spec = makeSpec({ body: [{ type: 'lead', text: 'Огляд' }, { type: 'p', text: body }] });
  const g = gateOver([answer('pass_with_edits', {
    scores: { sense: 4 }, notes: '«(context window) — це ліміт» — тире.',
    edits: [{ from: '(context window) — це ліміт', to: '(context window) ліміт' }, { from: 'тими самі речі', to: 'ті самі речі' }],
  })]);
  const out = await g.gate.check({
    text: `Огляд\n${body}`, spec, format: 'photo',
    warnings: [{ code: 'slop_em_dash', message: '4 тире' }],
    relint: async () => ({ ok: true }),
  });
  assert.equal(out.kind, 'proceed');
  const text = ((out as any).edited.spec.body[1]).text as string;
  assert.match(text, /\(context window\) — це ліміт/, 'pp1732 stays as written');
  assert.match(text, /ті самі речі/);
  assert.match(text, /Далі: повільний|Далі, повільний/, 'the dash transform in code');
  const stored = g.updates.at(-1).critic;
  assert.deepEqual(stored.edits_rejected.map((e: any) => [e.from, e.why]), [['(context window) — це ліміт', 'word_dropped']]);
  assert.ok(stored.edits_applied.some((e: any) => e.to === 'ті самі речі'));
});
