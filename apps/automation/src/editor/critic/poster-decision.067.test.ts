/**
 * Spec 067 FR-005 / A5 (T4): the critic is told the code's poster decision instead of judging poster fit, and the owner's
 * picture rules are not asked of it when no poster applies (rule #13 «кожен пост з картинкою» killed correct text-only posts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { makeSpec } from '../post/testing/fixtures';
import type { OwnerRuleLine } from '../rules/owner-rules-prompt';
import { CRITIC_SCORE_KEYS, type CriticScores } from './critic';
import { criticRules, criticUserPrompt, CriticService, isMediaRule, skippedRules, type CriticRequest } from './critic.service';
import { CriticGate } from './critic-gate';
import { criticMediaLines, criticMediaOf } from './critic-media';

const all = (n: number): CriticScores => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const RULES: OwnerRuleLine[] = [{ id: 13, text: 'Кожен пост має мати картинку' }, { id: 4, text: 'Без хештегів' }];
const POSTER = 'https://prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/04-mcp-server.png';

test('criticRules: the owner\'s picture rules go when the code says no poster applies; kept for a fitting poster and without a decision', () => {
  const ids = (d?: Parameters<typeof criticRules>[1]) => criticRules(RULES, d).map((r) => r.id);
  assert.deepEqual(ids(), [13, 4], 'no decision (a chat draft, an old caller): as before');
  assert.deepEqual(ids(null), [13, 4]);
  assert.deepEqual(ids('poster_fits'), [13, 4], 'a poster fits, so «з картинкою» can be asked');
  assert.deepEqual(ids('news_no_poster'), [4]);
  assert.deepEqual(ids('none_fits'), [4]);
  assert.deepEqual(skippedRules(RULES, 'none_fits').map((r) => r.id), [13]);
  assert.deepEqual(skippedRules(RULES, 'poster_fits'), []);
  assert.deepEqual(skippedRules(RULES, undefined), []);
});

test('isMediaRule: narrow — picture words at the start of a word; «фотограф…» and «медіан…» are other things; schedule rules stay out anyway', () => {
  for (const t of ['Кожен пост має мати картинку', 'Пости без зображення не публікуй', 'Постер лише на поясненнях', 'Не бери фото з PromptHero', 'Add an image to every post', 'Використовуй медіа з джерела']) {
    assert.equal(isMediaRule({ text: t }), true, t);
  }
  for (const t of ['Не пиши про фотографів', 'Згадуй медіану зарплат', 'Без хештегів', 'Пиши коротко']) {
    assert.equal(isMediaRule({ text: t }), false, t);
  }
  // A picture rule about the schedule («картинка щодня о 9:00») is already left out by isTextRule, so it is never «skipped» twice.
  assert.deepEqual(skippedRules([{ id: 1, text: 'Картинка щодня о 9:00' }], 'none_fits'), []);
  assert.deepEqual(criticRules([{ id: 1, text: 'Картинка щодня о 9:00' }], 'poster_fits'), []);
});

const req = (o: Partial<CriticRequest> = {}): CriticRequest => ({
  channelKey: 'c', slotId: 's', mode: 'live', resourceRef: 'telegram:c', platform: 'telegram', format: 'text',
  text: 'Пост', spec: {}, voice: {}, slopWarnings: [], ownerRules: RULES, ...o,
});

test('prompt: the decision block is shown for every post (no image too), the picture rule is not in the owner rules, the old poster rule line is gone', () => {
  const none = criticUserPrompt(req({ posterDecision: 'none_fits' }));
  assert.match(none, /## Зображення поста\n- зображень у пості немає\nРішення коду: жоден постер мережі до теми не підходить; пост без зображення тут правильний\./);
  assert.match(none, /Чи підходить постер, вирішує код, не ти: .*poster_mismatch/);
  assert.match(none, /- #4 Без хештегів/);
  assert.doesNotMatch(none, /#13/, 'the picture rule is not asked');
  assert.doesNotMatch(none, /Постер не за темою чи на новині → format_fit ≤ 3/, 'the critic no longer judges the fit');

  const news = criticUserPrompt(req({ posterDecision: 'news_no_poster' }));
  assert.match(news, /Рішення коду: це новина — постер мережі на ній не дозволений/);
  assert.doesNotMatch(news, /#13/);

  const fits = criticUserPrompt(req({ posterDecision: 'poster_fits', media: criticMediaOf({ media: [{ url: POSTER }] }) }));
  assert.match(fits, /## Зображення поста\n- постер мережі «MCP server», use_for: MCP-сервер/);
  assert.match(fits, /Рішення коду: до теми підходить постер мережі/);
  assert.match(fits, /- #13 Кожен пост має мати картинку/, 'a poster fits: the rule is asked');

  const without = criticUserPrompt(req());
  assert.doesNotMatch(without, /Зображення поста/, 'no image and no decision: no block');
  assert.match(without, /- #13 /);
  assert.deepEqual(criticMediaLines(null), []);
  assert.deepEqual(criticMediaLines(null, null), []);
});

function service(llm: FakeLlm) {
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  return new CriticService({ loop, env: () => undefined, defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => 'strong/model', now: () => new Date('2026-10-27T09:00:00Z') });
}
/** The critic checked rule #4 only (the one in its prompt) and gave the axis 5. */
const answer = { calls: [{ name: 'submit_critique', args: { scores: { ...all(5), owner_rules: 5 }, verdict: 'pass', notes: 'Добре.', rule_checks: [{ id: 4, kept: true }] } }] };

test('a dropped picture rule never comes back as owner_rules_missing; its id is stored in rules_skipped; without the decision the same answer is a revise', async () => {
  const withDecision = await service(new FakeLlm([answer])).review(req({ posterDecision: 'none_fits' }));
  assert.ok(withDecision.ok);
  if (!withDecision.ok) return;
  assert.equal(withDecision.critic.verdict, 'pass', withDecision.critic.reason);
  assert.deepEqual(withDecision.critic.rules_skipped, [13]);
  assert.deepEqual(withDecision.critic.rule_checks, [{ id: 4, kept: true }]);

  // The model reports the dropped rule as broken anyway: it is not in the prompt, so it is ignored.
  const stray = { calls: [{ name: 'submit_critique', args: { scores: { ...all(5), owner_rules: 5 }, verdict: 'pass', notes: 'Добре.', rule_checks: [{ id: 4, kept: true }, { id: 13, kept: false, quote: 'Пост' }], broken_rules: [13] } }] };
  const ignored = await service(new FakeLlm([stray])).review(req({ posterDecision: 'news_no_poster' }));
  assert.ok(ignored.ok && ignored.critic.verdict === 'pass' && !ignored.critic.broken_rules, JSON.stringify(ignored));

  const control = await service(new FakeLlm([answer])).review(req());
  assert.ok(control.ok);
  if (!control.ok) return;
  assert.equal(control.critic.verdict, 'revise');
  assert.match(control.critic.reason, /owner_rules_missing/);
  assert.equal(control.critic.rules_skipped, undefined);

  // A fitting poster: the rule is asked, and the same answer is missing the verdict for #13.
  const fits = await service(new FakeLlm([answer])).review(req({ posterDecision: 'poster_fits' }));
  assert.ok(fits.ok && fits.critic.verdict === 'revise' && /owner_rules_missing/.test(fits.critic.reason));
});

test('the gate hands the publish tool\'s decision to the critic (and nothing when the tool gave none)', async () => {
  const seen: CriticRequest[] = [];
  const gate = new CriticGate(
    {
      critic: { review: async (r: CriticRequest) => { seen.push(r); return { ok: false as const, error: 'x', runIds: [], costUsd: 0 }; } },
      plans: { updateSlot: async () => null as any },
    },
    { slotId: 's1', channelKey: '@chan', mode: 'approve', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {}, ownerRules: RULES },
  );
  const spec = makeSpec({ origin: 'library', library_ref: 'data://facts/12', media: [] });
  await gate.check({ text: 'Пост', spec, format: 'text', warnings: [], poster: 'none_fits' });
  await gate.check({ text: 'Пост 2', spec: makeSpec({ origin: 'library', library_ref: 'data://facts/13', media: [] }), format: 'text', warnings: [] });
  assert.equal(seen[0].posterDecision, 'none_fits');
  assert.equal('posterDecision' in seen[1], false);
});
