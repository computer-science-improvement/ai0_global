import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import { assessStory, boilerplateOf } from './story-match';

// 2026-11-07, @ai0_prompts_dev: every prompt post shares «💬 Prompt:» and «Модель: Nano Banana Pro»; a new prompt was refused
// as story_repeat of the three earlier ones (shared 5, score 0.46).
const card: any = { timezone: 'Europe/Kyiv' };
const promptPost = (id: string, prompt: string, at: string) => auditPostFromSpec({
  format: 'photo', origin: 'library', title: prompt.slice(0, 40), library_ref: `data://nanobanana_prompts/${id}`,
  media: [{ url: `https://example.com/${id}.jpg`, alt: 'x' }], buttons: [], hashtags: [], placement: 'above',
  body: [{ type: 'p', text: '💬 Prompt:' }, { type: 'code', language: 'text', text: prompt }, { type: 'p', text: 'Модель: Nano Banana Pro' }],
} as any, { id, channel: '@ai0_prompts_dev', publishedAt: at, timezone: 'Europe/Kyiv', card });

const previous = [
  promptPost('1', 'Generate a hyperrealistic anime portrait of a female character standing in a completely black background, narrow beam spotlight', '2026-11-01T14:00:00Z'),
  promptPost('2', 'A cozy Scandinavian living room interior, Morning Light through tall windows, oak floor, linen sofa', '2026-11-02T18:00:00Z'),
  promptPost('3', 'Cinematic still of an Old Fisherman mending nets on a Wooden Pier at dawn, film grain', '2026-11-03T10:00:00Z'),
];

test('boilerplate: the template entities of most posts of the resource', () => {
  assert.deepEqual([...boilerplateOf(previous)].sort(), ['name:nano banana', 'name:prompt']);
  assert.deepEqual([...boilerplateOf(previous.slice(0, 2))], [], 'too few posts to tell');
});

test('a new prompt in the same template is not a story_repeat; the same prompt again still is', () => {
  const now = '2026-11-05T10:00:00Z';
  const fresh = promptPost('4', 'combine these emojis: 🍌 + 😎, on a white background as a google emoji design', now);
  assert.deepEqual(assessStory(fresh, { previous, network: [], card, now } as any).findings.map((f) => f.code), []);
  const again = promptPost('5', 'Cinematic still of an Old Fisherman mending nets on a Wooden Pier at dawn, film grain', now);
  assert.deepEqual(assessStory(again, { previous, network: [], card, now } as any).findings.map((f) => f.code), ['story_repeat']);
});
