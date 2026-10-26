/**
 * Spec 067 FR-002 (T2): the verdict contract. Pass 1 loses only a post that is about nothing; the second look checks the
 * fixes of the first (`previous_checks`) instead of starting again; praise in quotes and notes alone block nothing. The
 * pass-2 cases are the real slots of agent review 4 (8b2e4bce, 5e038c5e, cca8be36, e80961f0, 13b8f814).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { makeSpec } from '../post/testing/fixtures';
import {
  countedIssues, CRITIC_SCORE_KEYS, decideVerdict, previousItemsOf, type Critique, type CriticIssue, type CriticScores, type PreviousItem, type StoredCritic,
} from './critic';
import { CriticService, criticSecondPassLines, criticUserPrompt, type CriticRequest } from './critic.service';
import { CriticGate } from './critic-gate';
import { isFixableRevise } from '../silent/fallback-ladder';

const NOW = new Date('2026-10-27T09:00:00Z');
const all = (n: number): CriticScores => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const sc = (o: Partial<CriticScores> = {}, base = 5): CriticScores => ({ ...all(base), ...o });

const POST = 'Epic роздає Home безкоштовно до 29 жовтня о 17:00 за Києвом. Це піксельний детективний горор, де ти вирішуєш, що сталося насправді.';
const issue = (o: Partial<CriticIssue> = {}): CriticIssue => ({ quote: 'де ти вирішуєш', fix: 'де ви вирішуєте', axis: 'language', blocking: true, ...o });
const item = (n: number, o: Partial<PreviousItem> = {}): PreviousItem => ({ n, fix: `пункт ${n}`, axis: 'format_fit', ...o });

type In = Partial<Pick<Critique, 'verdict' | 'issues' | 'previous_checks' | 'edits'>> & { scores?: CriticScores };
const decide = (c: In, slop: string[] = [], o: Parameters<typeof decideVerdict>[2] = {}) =>
  decideVerdict({ scores: c.scores ?? all(5), verdict: c.verdict ?? 'pass', ...(c.issues ? { issues: c.issues } : {}), ...(c.previous_checks ? { previous_checks: c.previous_checks } : {}), ...(c.edits ? { edits: c.edits } : {}) }, slop, o);
const second = (c: In, prev: PreviousItem[], o: Parameters<typeof decideVerdict>[2] = {}, slop: string[] = []) =>
  decide(c, slop, { pass: 2, postText: POST, previousBlocking: prev, ...o });

// ── pass 1 ───────────────────────────────────────────────────────────────────

test('067 pass 1: only sense ≤ 2 and a model reject lose the post; any other axis ≤ 2 is a fixable revise', () => {
  assert.deepEqual(decide({ scores: sc({ sense: 2 }) }), { verdict: 'reject', reason: 'score_le_2: sense' });
  assert.deepEqual(decide({ scores: sc({ sense: 1, language: 1 }), verdict: 'revise' }), { verdict: 'reject', reason: 'score_le_2: sense' });
  assert.deepEqual(decide({ verdict: 'reject' }), { verdict: 'reject', reason: 'model_reject' });
  // language 2 + the model's revise → revise (it used to be a reject of a post one rewrite fixes).
  assert.deepEqual(decide({ scores: sc({ language: 2 }), verdict: 'revise' }), { verdict: 'revise', reason: 'score_le_2_fixable: language' });
  assert.deepEqual(decide({ scores: sc({ grounding: 2, voice: 2 }), verdict: 'pass' }), { verdict: 'revise', reason: 'score_le_2_fixable: voice, grounding' });
  assert.deepEqual(decide({ scores: sc({ owner_rules: 2 }) }), { verdict: 'revise', reason: 'score_le_2_fixable: owner_rules' });
  const named = decideVerdict({ scores: sc({ owner_rules: 2 }), verdict: 'pass', broken_rules: [12, 15] });
  assert.deepEqual(named, { verdict: 'revise', reason: 'score_le_2_fixable: owner_rules (#12, #15)' });
  assert.deepEqual(decide({ scores: sc({ voice: 3 }) }), { verdict: 'revise', reason: 'score_le_3: voice' });
  assert.deepEqual(decide({ verdict: 'revise' }), { verdict: 'revise', reason: 'model_revise' });
});

test('067 pass 1: praise in quotes and notes alone block nothing (e80961f0, 13b8f814 pass 1); a blocking issue needs a quote found in the post', () => {
  // e80961f0: 4s, the model said pass, the notes quote the post in praise → it used to be «quoted_problem» and killed the slot.
  assert.deepEqual(decide({ scores: sc({ ai_likeness: 4, grounding: 4 }) }), { verdict: 'pass', reason: 'scores_ok' });
  // 13b8f814 pass 1: «Пост коректний… Можна публікувати» with weak spots listed as advice.
  assert.deepEqual(decide({ scores: sc({ voice: 4 }), issues: [{ fix: 'тон сухуватий', axis: 'voice', blocking: false }] }), { verdict: 'pass', reason: 'scores_ok' });
  // A blocking issue with a quote that is in the post sends it back.
  assert.deepEqual(decide({ issues: [issue()] }, [], { postText: POST }), { verdict: 'revise', reason: 'blocking_issue: language' });
  // …not when the quote is praise, a paraphrase, missing, or a different post's.
  assert.equal(decide({ issues: [issue({ quote: 'Muse Spark' })] }, [], { postText: POST }).verdict, 'pass');
  assert.equal(decide({ issues: [issue({ quote: undefined })] }, [], { postText: POST }).verdict, 'pass');
  assert.equal(decide({ issues: [issue({ blocking: false })] }, [], { postText: POST }).verdict, 'pass');
  // Without the post text (an old call) the quotes are not checked.
  assert.equal(decide({ issues: [issue({ quote: 'Muse Spark' })] }).verdict, 'revise');
  // An edit of the model that contains the quote fixes it.
  assert.deepEqual(decide({ verdict: 'pass_with_edits', edits: [{ from: 'де ти вирішуєш', to: 'де ви вирішуєте' }], issues: [issue()] }, [], { postText: POST }), { verdict: 'pass', reason: 'scores_ok_with_edits' });
});

test('067 issues: the quote is compared with the post whitespace-, quote- and case-normalised; cut marks and ellipses do not count', () => {
  const post = 'Він сказав: «Це  ЗАВЖДИ   працює» — і пішов.';
  const hit = (quote: string) => countedIssues({ verdict: 'pass', issues: [issue({ quote })] }, post).length;
  assert.equal(hit('"Це завжди працює"'), 1, 'straight quotes, case, spaces');
  assert.equal(hit('…завжди працює'), 1, 'a leading ellipsis');
  assert.equal(hit('завжди працює…'), 1, 'a trailing ellipsis');
  assert.equal(hit('ніколи не працює'), 0);
  // At most 8 issues are looked at.
  const many = Array.from({ length: 12 }, (_, i) => issue({ quote: i < 9 ? 'нема такого' : 'завжди', fix: `f${i}` }));
  assert.equal(countedIssues({ verdict: 'pass', issues: many }, post).length, 0, 'the ninth and later are cut, not counted');
});

// ── pass 2 ───────────────────────────────────────────────────────────────────

test('067 pass 2 (8b2e4bce, 5e038c5e, cca8be36): every item of the first pass fixed and 4s → pass, not «second revise: quoted_problem»', () => {
  // 8b2e4bce: pass 1 asked for a poster swap (format_fit 3) and a softer claim (grounding 3); both were done, scores 4.
  const items = [item(1, { fix: 'заміни постер', axis: 'format_fit' }), item(2, { fix: 'обережніше про шлях у налаштуваннях', axis: 'grounding' })];
  const fixed = [{ n: 1, fixed: true }, { n: 2, fixed: true }];
  assert.deepEqual(second({ scores: sc({ grounding: 4, format_fit: 4, ai_likeness: 4 }), previous_checks: fixed }, items), { verdict: 'pass', reason: 'scores_ok' });
  // 5e038c5e: one item (the poster), fixed, the model's own verdict was a (wrong) revise → advice.
  assert.deepEqual(second({ scores: sc({ grounding: 4, format_fit: 4 }), verdict: 'revise', previous_checks: [{ n: 1, fixed: true }] }, [item(1)]), { verdict: 'pass', reason: 'pass2_advice: model_revise' });
  // cca8be36: four blocking items, all fixed; the notes still quote the post but nothing new is blocking.
  const four = [item(1), item(2), item(3), item(4)];
  assert.deepEqual(second({ scores: sc({ sense: 4, language: 4, grounding: 4, ai_likeness: 4 }), previous_checks: four.map((i) => ({ n: i.n, fixed: true })) }, four), { verdict: 'pass', reason: 'scores_ok' });
});

test('067 pass 2: one unfixed item, a missing or partial previous_checks → revise', () => {
  const items = [item(1), item(2)];
  assert.deepEqual(second({ previous_checks: [{ n: 1, fixed: true }, { n: 2, fixed: false }] }, items), { verdict: 'revise', reason: 'previous_unfixed: #2' });
  assert.deepEqual(second({ previous_checks: [{ n: 1, fixed: true }] }, items), { verdict: 'revise', reason: 'previous_unfixed: #2' }, 'a partial answer counts as unfixed');
  assert.deepEqual(second({}, items), { verdict: 'revise', reason: 'previous_checks_missing: #1, #2' });
  // 13b8f814: the tone note (voice 3) was not fixed.
  assert.deepEqual(second({ scores: sc({ voice: 3 }), previous_checks: [{ n: 1, fixed: false }] }, [item(1, { axis: 'voice', fix: 'тон сухий' })]), { verdict: 'revise', reason: 'previous_unfixed: #1' });
  // With nothing to check (a lint-only first revise) the rule does not apply.
  assert.deepEqual(second({}, []), { verdict: 'pass', reason: 'scores_ok' });
});

test('067 pass 2: a new 3 or a model revise with nothing blocking behind it is advice; a new blocking issue, hard lint, slop and voice_off still revise', () => {
  const fixed = { previous_checks: [{ n: 1, fixed: true }] };
  // 13b8f814 variant: the first note was fixed, a new voice 3 appears → advice (it used to bounce the post a third time).
  assert.deepEqual(second({ scores: sc({ voice: 3 }), ...fixed }, [item(1)]), { verdict: 'pass', reason: 'pass2_advice: voice 3' });
  assert.deepEqual(second({ scores: sc({ voice: 3, format_fit: 3 }), verdict: 'revise', ...fixed }, [item(1)]), { verdict: 'pass', reason: 'pass2_advice: voice 3, format_fit 3, model_revise' });
  assert.deepEqual(second({ ...fixed, issues: [issue()] }, [item(1)]), { verdict: 'revise', reason: 'blocking_issue: language' });
  assert.deepEqual(second({ ...fixed, issues: [issue({ blocking: false })] }, [item(1)]).verdict, 'pass');
  // The poster the lint still flags stays a block (8b2e4bce: poster_mismatch).
  assert.deepEqual(second({ ...fixed }, [item(1)], { hardLint: ['poster_mismatch'] }), { verdict: 'revise', reason: 'hard_lint: poster_mismatch' });
  assert.deepEqual(second({ ...fixed }, [item(1)], { hardLint: ['number_not_in_sources'], codeMissing: ['68,9%'] }), { verdict: 'revise', reason: 'hard_lint: number_not_in_sources' });
  assert.deepEqual(second({ ...fixed }, [item(1)], {}, ['slop_em_dash', 'slop_exclamation']), { verdict: 'revise', reason: 'slop_warnings: 2' });
  assert.deepEqual(second({ ...fixed }, [item(1)], {}, ['slop_humor_off']), { verdict: 'revise', reason: 'voice_off: slop_humor_off' });
  assert.deepEqual(second({ ...fixed, scores: sc({ owner_rules: 3 }) }, [item(1)]), { verdict: 'pass', reason: 'pass2_advice: owner_rules 3' });
});

test('067 pass 2: a model reject and a score ≤ 2 reject; grounding ≤ 2 is a revise unless the critic saw the whole source or the code found the number missing', () => {
  const fixed = { previous_checks: [{ n: 1, fixed: true }] };
  assert.deepEqual(second({ verdict: 'reject', ...fixed }, [item(1)]), { verdict: 'reject', reason: 'model_reject' });
  assert.deepEqual(second({ scores: sc({ voice: 2 }), ...fixed }, [item(1)]), { verdict: 'reject', reason: 'score_le_2: voice' });
  assert.deepEqual(second({ scores: sc({ sense: 2 }), ...fixed }, [item(1)]), { verdict: 'reject', reason: 'score_le_2: sense' });
  const g2 = sc({ grounding: 2 });
  // The author read part of a big document and the code found nothing missing: the fact may be elsewhere in it.
  assert.deepEqual(second({ scores: g2, ...fixed }, [item(1)], { coverage: 'read', codeMissing: [] }), { verdict: 'revise', reason: 'score_le_2_fixable: grounding' });
  assert.deepEqual(second({ scores: g2, ...fixed }, [item(1)], { coverage: 'snippet' }), { verdict: 'revise', reason: 'score_le_2_fixable: grounding' });
  assert.deepEqual(second({ scores: g2, ...fixed }, [item(1)], { coverage: 'read', codeMissing: ['14,6'] }), { verdict: 'reject', reason: 'score_le_2: grounding' });
  assert.deepEqual(second({ scores: g2, ...fixed }, [item(1)], { coverage: 'full', codeMissing: [] }), { verdict: 'reject', reason: 'score_le_2: grounding' });
  assert.deepEqual(second({ scores: sc({ grounding: 2, voice: 2 }), ...fixed }, [item(1)], { coverage: 'read' }), { verdict: 'reject', reason: 'score_le_2: voice' }, 'the other axis is not excused');
});

// ── the items of the first pass ──────────────────────────────────────────────

test('067 previousItemsOf: the blocking issues; without them one item per axis ≤ 3 and per failed edit; nothing for a lint-only revise', () => {
  const scores = sc({ voice: 3, grounding: 2 });
  const blocking = previousItemsOf({ scores, issues: [issue({ fix: 'a' }), issue({ blocking: false, fix: 'b' }), issue({ fix: 'c', quote: undefined, axis: 'grounding' })] });
  assert.deepEqual(blocking.map((i) => [i.n, i.fix, i.axis]), [[1, 'a', 'language'], [2, 'c', 'grounding']]);
  const old = previousItemsOf({ scores, edits_failed: [{ from: 'нема такого', to: 'немає того', found: 0 }] });
  assert.deepEqual(old.map((i) => [i.n, i.axis, i.quote ?? null]), [[1, 'voice', null], [2, 'grounding', null], [3, undefined, 'нема такого']]);
  assert.deepEqual(previousItemsOf({ scores: all(5) }), []);
  assert.deepEqual(previousItemsOf(null), []);
});

// ── the service: the second-pass prompt and what is stored ──────────────────

function service(turns: ConstructorParameters<typeof FakeLlm>[0]) {
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  return { llm, service: new CriticService({ loop, env: () => undefined, defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => null, now: () => NOW }) };
}
const answer = (args: Record<string, unknown>) => ({ calls: [{ name: 'submit_critique', args: { scores: all(5), verdict: 'pass', notes: 'Добре.', ...args } }] });
const req = (o: Partial<CriticRequest> = {}): CriticRequest => ({
  channelKey: '@chan', slotId: 's1', mode: 'live', card: { models: {}, dailyBudgetUsd: null }, resourceRef: 'telegram:@chan', platform: 'telegram',
  format: 'photo', topic: 'Epic', text: POST, spec: makeSpec(), voice: {}, slopWarnings: [], ...o,
});
const prev = (o: Partial<NonNullable<CriticRequest['previous']>> = {}): NonNullable<CriticRequest['previous']> =>
  ({ verdict: 'revise', notes: 'Тон сухий.', scores: sc({ voice: 3 }), ...o });

test('067 pass-2 prompt: lists the blocking items numbered, asks for previous_checks, says new remarks are advice and no longer «оціни заново повністю»', () => {
  const lines = criticSecondPassLines(prev({ issues: [issue({ fix: 'де ви вирішуєте' }), issue({ blocking: false, fix: 'ЗАЙВЕ-ЗАУВАЖЕННЯ' }), issue({ quote: 'Epic роздає Home', fix: 'уточни гру', axis: 'grounding' })] })).join('\n');
  assert.match(lines, /### Що треба було виправити/);
  assert.match(lines, /\[1\] \(language\) «де ти вирішуєш» — де ви вирішуєте\n\[2\] \(grounding\) «Epic роздає Home» — уточни гру/);
  assert.doesNotMatch(lines, /ЗАЙВЕ-ЗАУВАЖЕННЯ/, 'advice is not an item');
  assert.match(lines, /previous_checks/);
  assert.match(lines, /blocking: false/);
  assert.doesNotMatch(lines, /заново повністю/);
  // An old-style first verdict: one item for the weak axis.
  assert.match(criticSecondPassLines(prev()).join('\n'), /\[1\] \(voice\) — оцінка voice 3/);
  // Nothing to check: no block, no previous_checks demand.
  const none = criticSecondPassLines(prev({ scores: all(5) })).join('\n');
  assert.doesNotMatch(none, /Що треба було виправити/);
  // It is in the user prompt of a pass-2 request.
  assert.match(criticUserPrompt(req({ previous: prev() })), /## Це переписаний пост[\s\S]*\[1\] \(voice\)/);
});

test('067 service: issues, previous_checks, source_coverage and grounding_missing are stored; hard lint and the code\'s missing numbers decide pass 2', async () => {
  const a = service([answer({ scores: sc({ voice: 4 }), issues: [issue({ fix: 'де ви вирішуєте' }), { fix: 'порада', axis: 'voice', blocking: false }] })]);
  const first = await a.service.review(req({ source: { url: 'https://store.epicgames.com/x', excerpt: null, coverage: 'read', grounding: { found: [], missing: ['68,9%'] } } }));
  assert.ok(first.ok);
  assert.deepEqual([first.critic.verdict, first.critic.reason, first.critic.pass], ['revise', 'blocking_issue: language', 1]);
  assert.equal(first.critic.issues?.length, 2);
  assert.equal(first.critic.source_coverage, 'read');
  assert.deepEqual(first.critic.grounding_missing, ['68,9%']);
  assert.equal(first.critic.previous_checks, undefined, 'pass 1 has none');

  // Pass 2: everything fixed, but the lint still flags the poster.
  const b = service([answer({ previous_checks: [{ n: 1, fixed: true }] })]);
  const lint = [{ code: 'poster_mismatch', message: 'Постер не за темою' }];
  const r = await b.service.review(req({ previous: { ...prev(), ...first.critic }, lintWarnings: lint }));
  assert.ok(r.ok);
  assert.deepEqual([r.critic.verdict, r.critic.reason, r.critic.pass], ['revise', 'hard_lint: poster_mismatch', 2]);
  assert.deepEqual(r.critic.previous_checks, [{ n: 1, fixed: true }]);
  assert.equal(r.critic.source_coverage, 'none');

  // Pass 2 with a number the code found in no text the author read: a block even when lint did not carry the code.
  const c = service([answer({ previous_checks: [{ n: 1, fixed: true }] })]);
  const miss = await c.service.review(req({
    previous: { ...prev(), ...first.critic }, lintWarnings: [],
    source: { url: 'https://store.epicgames.com/x', excerpt: null, coverage: 'read', grounding: { found: [], missing: ['68,9%'] } },
  }));
  assert.ok(miss.ok);
  assert.deepEqual([miss.critic.verdict, miss.critic.reason], ['revise', 'hard_lint: number_not_in_sources']);

  // Clean pass 2 → pass; the model's 4s stay.
  const d = service([answer({ scores: sc({ voice: 4 }), previous_checks: [{ n: 1, fixed: true }] })]);
  const ok = await d.service.review(req({ previous: { ...prev(), ...first.critic } }));
  assert.ok(ok.ok);
  assert.deepEqual([ok.critic.verdict, ok.critic.reason], ['pass', 'scores_ok']);
});

test('067 service: issues over the cap are cut, over-long fields are clipped, not refused', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ fix: `f${i}`, axis: 'voice', blocking: false }));
  const a = service([answer({ issues: [...many, { fix: 'x'.repeat(900), quote: 'q'.repeat(500), axis: 'voice', blocking: false }] })]);
  const r = await a.service.review(req());
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.critic.issues?.length, 8);
});

// ── the gate: the blocking issues go back to the executor ───────────────────

test('067 gate: the revise error carries the blocking issues (quote + fix), then pass 2 checks them and passes', async () => {
  const t = service([
    answer({ scores: sc({ language: 4 }), issues: [issue(), { fix: 'порада', axis: 'voice', blocking: false }], notes: 'Звертання «ти».' }),
    answer({ previous_checks: [{ n: 1, fixed: true }] }),
  ]);
  const updates: any[] = [];
  const gate = new CriticGate(
    { critic: t.service, plans: { updateSlot: async (_id: string, p: any) => { updates.push(p); } } },
    { slotId: 's1', channelKey: '@chan', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} },
  );
  const out = await gate.check({ text: POST, spec: makeSpec(), format: 'photo', warnings: [] });
  assert.equal(out.kind, 'revise');
  const details = (out as any).result.details;
  assert.deepEqual(details.issues, [{ quote: 'де ти вирішуєш', fix: 'де ви вирішуєте', axis: 'language' }]);
  assert.match(details.instruction, /skip_slot з причиною/, 'the sentence 068 edits is untouched');
  // The second pass sees the numbered item and the verdict is a pass.
  const text2 = 'Epic роздає Home безкоштовно до 29 жовтня о 17:00 за Києвом. Це піксельний горор, де ви вирішуєте, що сталося.';
  const out2 = await gate.check({ text: text2, spec: makeSpec({ title: 'Друга' }), format: 'photo', warnings: [] });
  assert.equal(out2.kind, 'proceed');
  assert.match(t.llm.requests[1].messages[1].content as string, /\[1\] \(language\) «де ти вирішуєш» — де ви вирішуєте/);
  const stored = updates.filter((u) => u.critic).at(-1).critic as StoredCritic;
  assert.deepEqual([stored.verdict, stored.pass, stored.history?.[0].verdict], ['pass', 2, 'revise']);
});

// ── the ladder: what a stored verdict says about the source ─────────────────

test('067 isFixableRevise: grounding ≤ 2 bans the source only for a whole source with numbers the code found missing; an old critic keeps the old rule', () => {
  const g2 = { verdict: 'revise', notes: 'x', scores: { grounding: 2 } };
  assert.equal(isFixableRevise(g2), false, 'a verdict stored before 067 has no coverage: today\'s rule');
  assert.equal(isFixableRevise({ ...g2, source_coverage: 'full', grounding_missing: ['68,9%'] }), false, 'whole source, number missing: the source is wrong');
  assert.equal(isFixableRevise({ ...g2, source_coverage: 'full', grounding_missing: [] }), true, 'whole source but the code found every number: fixable');
  assert.equal(isFixableRevise({ ...g2, source_coverage: 'read', grounding_missing: ['14,6'] }), true, 'a document read in part: the fact may be elsewhere');
  assert.equal(isFixableRevise({ ...g2, source_coverage: 'snippet' }), true);
  assert.equal(isFixableRevise({ ...g2, source_coverage: 'none' }), true);
  assert.equal(isFixableRevise({ verdict: 'revise', notes: 'x', scores: { grounding: 3 }, source_coverage: 'full', grounding_missing: ['1'] }), true);
  assert.equal(isFixableRevise({ ...g2, source_coverage: 'read', notes: 'Пост не про тему слота' }), false, 'a wrong topic is still a ban');
  assert.equal(isFixableRevise({ verdict: 'reject', notes: 'x', scores: { grounding: 4 }, source_coverage: 'read' }), false);
});
