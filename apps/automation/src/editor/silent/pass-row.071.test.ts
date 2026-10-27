// Spec 071 FR-004 / A2: a library row of a dataset that repeats in rounds is put aside for the round when the failure says the
// row is the problem — keyed on the post's own library_ref (never its source URL), never for a guard or lint code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { isToolError } from '../harness/tool';
import { classifyFailure, libraryRefOf, PublishProbe, shouldPassRow } from './fallback-ladder';
import { makePassRow } from './pass-row';
import { CONTENT_FAILURE_CODES, skipGroupOf } from './skip-reasons';

const NOW = new Date('2026-10-26T09:00:00Z');
const baseSlot: any = { id: 's1', channelKey: '@pdr', resourceRef: 'telegram:@pdr', scheduledAt: NOW, kind: 'content', format: 'text', topic: 'ПДР', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };
const ROW = 'data://pdr_questions/42';
const URL1 = 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF';

type Behaviour = (st: any) => any;
const reject: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: reject (grounding 2): цифр немає в джерелі', critic: { verdict: 'reject', notes: 'цифр немає в джерелі', cost_usd: 0.002 } });
  return { ok: true, skipped: true, critic_rejected: true };
};
const secondRevise = (grounding: number): Behaviour => (st) => {
  Object.assign(st, {
    status: 'skipped', error: 'critic_rejected: second revise — revise: Штампи.',
    critic: { verdict: 'revise', notes: 'Штампи.', scores: { grounding, sense: 4 }, cost_usd: 0.002, history: [{ verdict: 'revise' }] },
  });
  return { ok: true, skipped: true, critic_rejected: true };
};
const shadow: Behaviour = (st) => { Object.assign(st, { status: 'shadowed', error: null, critic: { verdict: 'pass', cost_usd: 0.002 } }); return { ok: true, shadow: true }; };
const guard = (code: string): Behaviour => () => ({ error: code, details: 'x' });

function setup(script: Behaviour[], o: { spec?: (n: number) => Record<string, unknown>; passRow?: (...a: any[]) => Promise<boolean> | boolean | undefined; noPassRow?: boolean; seriesContext?: (slot: any) => Promise<any>; canonicalRef?: (ref: string) => Promise<string> } = {}) {
  const st: any = { ...baseSlot, status: 'running', error: null, critic: null };
  const runs: any[] = [];
  const passed: Array<{ slot: any; ref: string; reason: string }> = [];
  let current: Behaviour = shadow;
  const publish = {
    name: 'publish_post', kind: 'terminal', description: '', input: {} as any, roles: ['executor'],
    // Like the real tool, a stored (rejected) post leaves its spec on the slot.
    execute: async () => { const r = current(st); if (st.status === 'skipped') st.postSpec = runs[runs.length - 1].spec; return r; },
  };
  const spec = o.spec ?? (() => ({ format: 'text', library_ref: ROW, source: { url: URL1 } }));
  const runner = new EditorRunnerService({
    loop: {
      run: async (i: any) => {
        runs.push({ ...i, spec: spec(runs.length + 1) });
        current = script[runs.length - 1] ?? shadow;
        const tool = i.tools.find((t: any) => t.name === 'publish_post');
        const r = await tool.execute({ spec: spec(runs.length) }, {});
        return { runId: `r${runs.length}`, status: isToolError(r) ? 'max_steps' : 'ok', terminalTool: isToolError(r) ? undefined : 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 } } as any;
      },
    },
    registry: { forRole: () => [publish] as any },
    skills: new SkillLibrary(),
    plans: {
      reservedSlots: async () => [],
      getSlot: async () => ({ ...st }),
      updateSlot: async (_id: string, p: any) => { Object.assign(st, p); },
    },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    ladder: { maxExtraSteps: 3 },
    ...(o.seriesContext ? { seriesContext: o.seriesContext } : {}),
    ...(o.canonicalRef ? { canonicalRef: o.canonicalRef } : {}),
    ...(o.noPassRow ? {} : { passRow: async (slot: any, ref: string, reason: string) => { passed.push({ slot, ref, reason }); return o.passRow ? (await o.passRow(slot, ref, reason)) ?? true : true; } }),
  });
  return { runner, st, runs, passed, card: makeCard({}) };
}

test('A2: a critic reject that is not fixable puts the post\'s library_ref aside — not its source URL — then the ladder goes on', async () => {
  const s = setup([reject, shadow]);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.passed.length, 1);
  assert.equal(s.passed[0].ref, ROW, 'the library row, never the source.url');
  assert.notEqual(s.passed[0].ref, URL1);
  assert.match(s.passed[0].reason, /^critic_rejected/);
  assert.equal(s.passed[0].slot.id, 's1');
  assert.equal(s.st.status, 'shadowed', 'the next candidate went out');
});

test('A2: a fixable revise keeps its row (revise_source rescues it → nothing passed)', async () => {
  const s = setup([secondRevise(4), shadow]);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.deepEqual(s.passed, []);
  assert.equal(s.st.status, 'shadowed');
});

test('A2: a failed revise_source step puts the row aside (the row had its second chance)', async () => {
  const s = setup([secondRevise(4), secondRevise(4), shadow], { /* default one extra step is fine */ });
  (s.runner as any).d.ladder = { maxExtraSteps: 1 };
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.deepEqual(s.passed.map((p) => p.ref), [ROW], 'once: the fixable first attempt kept the row, the failed revise_source passed it');
});

test('A2: quiz_answer_mismatch puts the row aside; guard and lint codes never do', async () => {
  const quiz = setup([guard('quiz_answer_mismatch'), shadow]);
  await quiz.runner.runExecutor(baseSlot, quiz.card);
  assert.deepEqual(quiz.passed.map((p) => p.ref), [ROW]);
  for (const code of ['not_next_in_order', 'library_item_already_posted', 'series_source_mismatch', 'lint_failed', 'too_similar']) {
    const s = setup([guard(code), shadow]);
    await s.runner.runExecutor(baseSlot, s.card);
    assert.deepEqual(s.passed, [], code);
  }
});

test('A2: a post without a library_ref (only a source URL) has no row to put aside; no passRow dep is no crash; a throwing passRow changes nothing', async () => {
  const urlOnly = setup([reject, shadow], { spec: () => ({ format: 'text', source: { url: URL1 } }) });
  await urlOnly.runner.runExecutor(baseSlot, urlOnly.card);
  assert.deepEqual(urlOnly.passed, []);

  const noDep = setup([reject, shadow], { noPassRow: true });
  await noDep.runner.runExecutor(baseSlot, noDep.card);
  assert.equal(noDep.st.status, 'shadowed');

  const boom = setup([reject, shadow], { passRow: async () => { throw new Error('db down'); } });
  await boom.runner.runExecutor(baseSlot, boom.card);
  assert.equal(boom.passed.length, 1);
  assert.equal(boom.st.status, 'shadowed', 'best-effort: the slot is rescued as before');
});

test('A2 pure: shouldPassRow, libraryRefOf, and classifyFailure carries the post\'s own library_ref', () => {
  const crit = { kind: 'critic_reject' as const, code: 'critic_rejected', libraryRef: ROW };
  assert.equal(shouldPassRow({ ...crit, fixable: false }, 'initial'), true);
  assert.equal(shouldPassRow({ ...crit, fixable: true }, 'initial'), false);
  assert.equal(shouldPassRow({ ...crit, fixable: true }, 'revise_source'), true);
  assert.equal(shouldPassRow({ ...crit, fixable: false, libraryRef: null }, 'initial'), false);
  assert.equal(shouldPassRow({ kind: 'guard', code: 'quiz_answer_mismatch', libraryRef: ROW }, 'initial'), true);
  assert.equal(shouldPassRow({ kind: 'guard', code: 'too_similar', libraryRef: ROW }, 'revise_source'), false);
  assert.equal(shouldPassRow({ kind: 'lint', code: 'lint_failed', libraryRef: ROW }, 'revise_source'), false);
  assert.equal(libraryRefOf({ library_ref: ' data://a_b/1 ' }), 'data://a_b/1');
  assert.equal(libraryRefOf({ source: { url: URL1 } }), null);

  // A stored rejected post: its library_ref, while sourceUrl stays the URL (the ladder's avoid list).
  const f = classifyFailure({ status: 'skipped', error: 'critic_rejected: reject', critic: { verdict: 'reject', notes: 'x' }, postSpec: { library_ref: ROW, source: { url: URL1 } } }, null)!;
  assert.deepEqual([f.libraryRef, f.sourceUrl], [ROW, URL1]);
  // A guard failure: what the publish tool saw.
  const probe = new PublishProbe();
  probe.last = { code: 'quiz_answer_mismatch', details: 'x' };
  probe.libraryRef = ROW;
  assert.equal(classifyFailure({ status: 'running', error: null }, probe)!.libraryRef, ROW);
  // A platform slot keeps its post in platformSpec.
  assert.equal(classifyFailure({ status: 'skipped', error: 'critic_rejected: reject', critic: { verdict: 'reject' }, platformSpec: { library_ref: ROW } }, null)!.libraryRef, ROW);
  assert.equal(classifyFailure({ status: 'skipped', error: 'critic_rejected: reject', critic: { verdict: 'reject' } }, null)!.libraryRef, undefined);
});

test('the PublishProbe records the library_ref of the post it was given', async () => {
  const probe = new PublishProbe();
  const [wrapped] = probe.wrap([{ name: 'publish_post', execute: async () => ({ ok: true }) } as any]);
  await wrapped.execute({ spec: { library_ref: ROW, source: { url: URL1 } } }, {} as any);
  assert.deepEqual([probe.libraryRef, probe.source], [ROW, URL1]);
  await wrapped.execute({ spec: { source: { url: 'https://b.example/' } } }, {} as any);
  assert.deepEqual([probe.libraryRef, probe.source], [ROW, 'https://b.example/'], 'a later post without a row keeps the last one seen');
});

test('R5: a row the guards refused is forgotten — a later post without a row, then a non-fixable reject, has no row to put aside', async () => {
  for (const code of ['not_next_in_order', 'library_item_already_posted', 'series_source_mismatch']) {
    const probe = new PublishProbe();
    let result: any = { error: code, details: 'x' };
    const [wrapped] = probe.wrap([{ name: 'publish_post', execute: async () => result } as any]);
    await wrapped.execute({ spec: { library_ref: 'data://pdr_questions/9', source: { url: URL1 } } }, {} as any);
    assert.equal(probe.libraryRef, null, `${code}: the refused row is dropped`);
    result = { ok: true };
    await wrapped.execute({ spec: { source: { url: 'https://b.example/' } } }, {} as any);
    const f = classifyFailure({ status: 'skipped', error: 'critic_rejected: reject', critic: { verdict: 'reject' } }, probe)!;
    assert.equal(f.libraryRef, undefined, code);
    assert.equal(shouldPassRow({ ...f, fixable: false }, 'initial'), false, 'nothing to put aside');
  }
  // Any other answer keeps the sticky row (the post reached the checks that judge its content).
  const probe = new PublishProbe();
  const [wrapped] = probe.wrap([{ name: 'publish_post', execute: async () => ({ error: 'too_similar', details: 'x' }) } as any]);
  await wrapped.execute({ spec: { library_ref: ROW } }, {} as any);
  assert.equal(probe.libraryRef, ROW);
});

const ROW2 = 'data://pdr_questions/43';
const seriesNoteFor = (row: string) => `## Серія: бери ${row}`;

test('R3: after a row is put aside the series note is built again — the next step names the new next row, not the old one; the caller\'s note stays once', async () => {
  let next = ROW;
  const s = setup([reject, shadow], {
    seriesContext: async () => ({ note: seriesNoteFor(next), nextRow: next }),
    passRow: async () => { next = ROW2; return true; },
  });
  await s.runner.runExecutor(baseSlot, s.card, 'ПРОМО-БРИФ');
  assert.equal(s.runs.length, 2);
  assert.ok(s.runs[0].user.includes(seriesNoteFor(ROW)));
  assert.ok(s.runs[1].user.includes(seriesNoteFor(ROW2)), 'the second step names R2');
  assert.ok(!s.runs[1].user.includes(seriesNoteFor(ROW)), 'and no longer R1');
  assert.equal(s.runs[1].user.split('ПРОМО-БРИФ').length - 1, 1, 'the caller\'s own note is carried, once');
  assert.equal(s.st.status, 'shadowed');
});

test('R3: a row that was not put aside keeps the series note; a series with nothing left ends the ladder with its skip', async () => {
  // A passRow that reports false changes nothing: the series is not asked again.
  let asked = 0;
  const kept = setup([reject, shadow], { seriesContext: async () => { asked++; return { note: seriesNoteFor(ROW), nextRow: ROW }; }, passRow: async () => false });
  await kept.runner.runExecutor(baseSlot, kept.card);
  assert.equal(asked, 1, 'asked once, before the first attempt');
  assert.ok(kept.runs[1].user.includes(seriesNoteFor(ROW)));

  // The row put aside was the last one of the round: the series answers with a skip and the ladder stops there.
  let n = 0;
  const done = setup([reject, shadow], {
    seriesContext: async () => (++n === 1 ? { note: seriesNoteFor(ROW), nextRow: ROW } : { note: null, skip: 'series_done: рядків більше немає' }),
  });
  await done.runner.runExecutor(baseSlot, done.card);
  assert.equal(done.runs.length, 1, 'no second attempt');
  assert.equal(done.st.status, 'skipped');
  assert.match(done.st.error, /series_done/);
  assert.equal(done.st.fallback.final.code, 'series_skip');
});

test('R4: a failure that does not put the series\' next row aside fixes that row — it is not «take other material»', async () => {
  const series = { seriesContext: async () => ({ note: seriesNoteFor(ROW), nextRow: ROW }) };
  const s = setup([guard('too_similar'), shadow], series);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.deepEqual(s.passed, []);
  assert.equal(s.runs.length, 2);
  assert.equal(s.st.fallback.steps[1].step, 'revise_source', 'the same row, rewritten');
  assert.ok(s.runs[1].user.includes('Запасний крок (revise_source)'));
  assert.ok(!s.runs[1].user.includes('Не бери повторно'), 'the next row is not on the avoid list');
  assert.ok(!s.runs[1].user.includes('ІНШИЙ матеріал'));
  assert.equal(s.st.status, 'shadowed');

  // Without a series the ladder is as before: the next candidate.
  const plain = setup([guard('too_similar'), shadow]);
  await plain.runner.runExecutor(baseSlot, plain.card);
  assert.equal(plain.st.fallback.steps[1].step, 'next_candidate');
  assert.ok(plain.runs[1].user.includes('Не бери повторно'));

  // A post on another row than the one the series waits for is not "the next row": the ladder is as before.
  const other = setup([guard('too_similar'), shadow], { ...series, spec: () => ({ format: 'text', library_ref: ROW2, source: { url: URL1 } }) });
  await other.runner.runExecutor(baseSlot, other.card);
  assert.equal(other.st.fallback.steps[1].step, 'next_candidate');
});

test('R4: a failed revise_source on the next row does not turn into next_candidate; the legacy alias counts as the same row', async () => {
  const series = { seriesContext: async () => ({ note: seriesNoteFor(ROW), nextRow: ROW }) };
  const s = setup([guard('too_similar'), guard('too_similar'), shadow], series);
  (s.runner as any).d.ladder = { maxExtraSteps: 3 };
  await s.runner.runExecutor(baseSlot, s.card);
  const steps = s.st.fallback.steps as any[];
  assert.deepEqual(steps.map((x) => [x.step, x.outcome]).slice(0, 3), [['initial', 'guard'], ['revise_source', 'guard'], ['next_candidate', 'no_candidate']]);
  assert.equal(s.runs.filter((r) => r.user.includes('ІНШИЙ матеріал')).length, 0, 'no run was told to take other material');
  assert.deepEqual(s.passed, [], 'too_similar never puts a row aside');

  // library://… is the same row as data://… (canonicalRef is the module\'s resolveContentRef).
  const alias = setup([guard('too_similar'), shadow], {
    ...series, spec: () => ({ format: 'text', library_ref: 'library://pdr_questions/42', source: { url: URL1 } }),
    canonicalRef: async (r) => r.replace('library://', 'data://'),
  });
  await alias.runner.runExecutor(baseSlot, alias.card);
  assert.equal(alias.st.fallback.steps[1].step, 'revise_source');
  const noCanon = setup([guard('too_similar'), shadow], { ...series, spec: () => ({ format: 'text', library_ref: 'library://pdr_questions/42', source: { url: URL1 } }) });
  await noCanon.runner.runExecutor(baseSlot, noCanon.card);
  assert.equal(noCanon.st.fallback.steps[1].step, 'next_candidate', 'without the canonical resolver the alias is another ref');
});

test('R4: the check is made again after each step — a step that lands on the next row stops banning its source', async () => {
  const A = 'https://a.example/z';
  const B = 'https://b.example/x';
  const specs: Array<Record<string, unknown>> = [
    { format: 'quiz', library_ref: ROW2, source: { url: A } },
    { format: 'quiz', library_ref: ROW, source: { url: B } },
    { format: 'text', library_ref: ROW, source: { url: B } },
  ];
  const s = setup([guard('too_similar'), guard('too_similar'), shadow], {
    spec: (n) => specs[n - 1], seriesContext: async () => ({ note: seriesNoteFor(ROW), nextRow: ROW }),
  });
  const quizSlot = { ...baseSlot, format: 'quiz' };
  await s.runner.runExecutor(quizSlot, s.card);
  assert.deepEqual((s.st.fallback.steps as any[]).map((x) => x.step), ['initial', 'next_candidate', 'lighter_format']);
  assert.ok(s.runs[1].user.includes(A), 'step 1 bans the row it was not meant to use (A)');
  assert.ok(s.runs[2].user.includes(`Не бери повторно: ${A}`), 'step 2 still bans A');
  assert.ok(!s.runs[2].user.includes(B), 'but not the source of the next row (B)');
});

test('not_next_in_order is a content failure the ladder retries and the digest groups with lint', () => {
  assert.ok((CONTENT_FAILURE_CODES as readonly string[]).includes('not_next_in_order'));
  assert.equal(skipGroupOf('not_next_in_order: серія бере рядки по черзі'), 'lint');
});

test('makePassRow: the slot\'s resource, the editor origin, the slot id and the reason as the note; an error is logged and returns false', async () => {
  const calls: any[] = [];
  const pass = makePassRow({ pass: async (ref: string, u: any) => { calls.push({ ref, u }); return true; } } as any);
  assert.equal(await pass({ id: 's9', channelKey: '@pdr' }, ROW, 'critic_rejected: x'), true);
  assert.deepEqual(calls[0], { ref: ROW, u: { resourceRef: 'telegram:@pdr', origin: 'editor', slotId: 's9', note: 'critic_rejected: x' } });
  await pass({ id: 's9', channelKey: '@pdr', resourceRef: 'instagram:42' }, ROW, 'r');
  assert.equal(calls[1].u.resourceRef, 'instagram:42');
  const logs: string[] = [];
  const bad = makePassRow({ pass: async () => { throw new Error('boom'); } } as any, (m) => logs.push(m));
  assert.equal(await bad({ id: 's9', channelKey: '@pdr' }, ROW, 'r'), false);
  assert.match(logs[0], /passRow data:\/\/pdr_questions\/42 on slot s9: boom/);
});
