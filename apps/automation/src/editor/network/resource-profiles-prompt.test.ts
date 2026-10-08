import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactProfile, resourceProfilesBlock } from './network-prompts';

test('the planner / orchestrator see each member resource profile (spec 024 FR-012: decisions cite it)', () => {
  const fitness = { topic: 'Фітнес і тренування вдома', audience: { who: 'жінки 25–40', region: 'Україна' }, language: 'uk', goals: ['engagement', 'growth'] as const, taboo: ['їжа', 'рецепти', 'дієти'] };
  assert.equal(compactProfile({ ...fitness, goals: [...fitness.goals] }),
    'тема: Фітнес і тренування вдома; аудиторія: жінки 25–40, Україна; мова: uk; цілі: engagement > growth; табу: їжа, рецепти, дієти');
  const block = resourceProfilesBlock([{ ref: 'instagram:fit', profile: { ...fitness, goals: [...fitness.goals] } }, { ref: 'threads:x', profile: null }]);
  assert.equal(block[1], '## Профілі ресурсів (кожен ресурс — окрема одиниця)');
  assert.match(block.join('\n'), /instagram:fit: тема: Фітнес/);
  assert.doesNotMatch(block.join('\n'), /threads:x/);
  assert.deepEqual(resourceProfilesBlock([{ ref: 'threads:x', profile: null }]), []);
});
