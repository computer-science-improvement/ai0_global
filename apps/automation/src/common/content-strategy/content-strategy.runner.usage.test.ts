/** Spec 029 T3: the strategy runner opens the LLM attribution context for every strategy run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentStrategyRunner } from './content-strategy.runner';
import { PostingThrottleService } from '../../publishers/posting-throttle.service';
import { currentLlmContext, withLlmContext } from '../ai/usage/llm-context';

function runner() {
  const noop = async () => {};
  return new ContentStrategyRunner(
    { review: async (t: string) => t } as any,
    { filterUnposted: async (i: any[]) => i, markPosted: noop, markError: noop } as any,
    { download: async () => null } as any,
    { publish: async () => '1' } as any,
    { notifyPublished: noop, notifyFailed: noop } as any,
    new PostingThrottleService(undefined, undefined),
    { insert: noop } as any,
    { afterPublish: noop } as any,
  );
}

test('custom execute() and generic generate() both run inside strategy.<id>.generate', async () => {
  const seen: unknown[] = [];
  await runner().run({
    type: 't', getSkills: () => [],
    execute: async () => {
      seen.push(currentLlmContext());
      // A sub-step (e.g. recipe translation) overrides only the feature.
      await withLlmContext({ feature: 'strategy.recipes.translate' }, async () => { seen.push(currentLlmContext()); });
    },
  } as any, '@c', {}, 'recipes-main');
  await runner().run({
    type: 't', getSkills: () => [],
    fetch: async () => { seen.push(currentLlmContext().feature); return null; },
    generate: async () => null,
  } as any, '@d', {}, 'space-1');
  assert.deepEqual(seen, [
    { feature: 'strategy.recipes-main.generate', resourceRef: 'strategy:recipes-main' },
    { feature: 'strategy.recipes.translate', resourceRef: 'strategy:recipes-main' },
    'strategy.space-1.generate',
  ]);
  assert.deepEqual(currentLlmContext(), {}, 'the context does not leak out of run()');
});
