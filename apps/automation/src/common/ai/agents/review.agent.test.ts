import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewAgent } from './review.agent';

const DRAFT = 'Оригінальна чернетка поста українською, достатньо довга для перевірки.';
const FIXED = 'Виправлений пост українською мовою, достатньо довгий для валідатора.';

function agent(reply: { text: string | null; stopReason: string | null }) {
  const claude = { available: true, chatWithMeta: async () => reply };
  return new ReviewAgent(claude as any);
}

test('a complete review (end_turn) replaces the draft', async () => {
  assert.equal(await agent({ text: FIXED, stopReason: 'end_turn' }).review(DRAFT), FIXED);
});

test('a truncated review (max_tokens) keeps the original draft', async () => {
  const cut = FIXED.slice(0, 50);
  assert.equal(await agent({ text: cut + ' і далі', stopReason: 'max_tokens' }).review(DRAFT), DRAFT);
});

test('review output is cleaned: preamble and stray markdown are stripped', async () => {
  const out = await agent({ text: `Ось готовий пост:\n\n**${FIXED}**`, stopReason: 'end_turn' }).review(DRAFT);
  assert.equal(out, `<b>${FIXED}</b>`);
});

test('review output that fails PostValidator keeps the original draft', async () => {
  for (const bad of [
    'I cannot help with proofreading this text because of the content policy.',
    'Here is the post: ' + FIXED,
    'занадто коротко',
  ]) {
    assert.equal(await agent({ text: bad, stopReason: 'end_turn' }).review(DRAFT), DRAFT, bad);
  }
});

test('no response keeps the draft; agent unavailable returns the draft untouched', async () => {
  assert.equal(await agent({ text: null, stopReason: null }).review(DRAFT), DRAFT);
  const off = new ReviewAgent({ available: false } as any);
  assert.equal(await off.review(DRAFT), DRAFT);
});
