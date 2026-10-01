// End-to-end regression for the partial-publish duplicate loop (002 T002):
// a strategy that marks its row AFTER publishPrompt/publishVideo must still mark
// it when the photo/video went live but the follow-up reply failed — otherwise
// the next tick re-selects the row and posts the photo again.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { TelegramPublisher } from '../publishers/telegram.publisher';
import { RecipesStrategy } from './recipes/recipes.strategy';
import { CuratedPromptsStrategy } from './curated-prompts/curated-prompts.strategy';

afterEach(() => mock.restoreAll());

function realPublisher() {
  // Media send succeeds (message_id 7); the reply sendMessage fails.
  mock.method(axios, 'post', async (url: string) => {
    if (url.endsWith('/sendMessage')) throw new Error('Bad Request: replied message not found');
    return { data: { result: { message_id: 7 } } };
  });
  return new TelegramPublisher(
    { isPublishPausedFor: () => false, resolveChannel: () => ({ chatId: '-100', botToken: 'B' }) } as any,
    { recordPublish: () => {} } as any,
    { publication: () => {} } as any,
    { isEnabled: () => false } as any,
  );
}

test('recipes: reply failure after a live photo still marks the recipe posted', async () => {
  const posted: string[] = [];
  const row = {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'French',
    ingredients: 'x', instructions: 'y',
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Розтопіть масло.',
    telegraph_url: null, telegraph_path: null,
    kcal: '84', protein_g: '4', fat_g: '0.3', carbs_g: '15', serving_size_g: '258',
  };
  const s = new RecipesStrategy(
    { available: true } as any, { check: () => true } as any, { register() {} } as any,
    realPublisher(),
    { available: async () => false } as any,
    {
      getNext: async () => row,
      markPosted: async (id: string) => { posted.push(id); },
    } as any,
    { notifyPublished: async () => {} } as any,
    { insert: async () => {} } as any,
    { afterPublish: async () => {} } as any,
    {} as any,
  );
  (s as any).downloadImage = async () => Buffer.from('img');
  await s.execute('@chan', {});
  assert.deepEqual(posted, ['r1']);
});

test('curated-prompts (video): reply failure after a live video still marks the row posted', async () => {
  const posted: string[] = [];
  const s = new CuratedPromptsStrategy(
    { register() {} } as any,
    realPublisher(),
    {
      getNext: async () => ({
        id: 'v1', category: 'art', title: 'Title', prompt_text: 'p'.repeat(1200),
        source: 'src', media_url: 'https://v/x.mp4', media_type: 'video',
      }),
      markPosted: async (id: string) => { posted.push(id); },
      markError: async () => { throw new Error('must not mark error'); },
    } as any,
    { notifyPublished: async () => {} } as any,
    { insert: async () => {} } as any,
    { afterPublish: async () => {} } as any,
    {} as any,
  );
  await s.execute('@chan', {});
  assert.deepEqual(posted, ['v1']);
});
