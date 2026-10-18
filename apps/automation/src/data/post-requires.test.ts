import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePostRequires, postMissing, valuePresent } from './post-requires';
import { catalogEntry, summarize } from './data-catalog';
import { queryDataset } from './data-query';
import { catalogPromptSummary } from '../editor/tools/catalog-context';
import { postRequiresSchema, schemaInputSchema } from './data.types';
import { BOOKS } from './testing/books-schema';

const PROMPTS = [['page_url'], ['prompt_text', 'media_url']];

test('valuePresent: missing, null, blank text, [] and {} are empty; 0 and false are values', () => {
  for (const v of [undefined, null, '', '   ', [], {}]) assert.equal(valuePresent(v), false, JSON.stringify(v));
  for (const v of ['x', 0, false, ['a'], { a: 1 }]) assert.equal(valuePresent(v), true, JSON.stringify(v));
});

test('postMissing: every group needs one filled field (a bare string is a group of one)', () => {
  assert.deepEqual(postMissing(PROMPTS, { page_url: 'https://prompthero.com/prompt/1', media_url: 'https://cdn/x' }), []);
  assert.deepEqual(postMissing(PROMPTS, { page_url: 'https://prompthero.com/prompt/1', prompt_text: ' ' }), ['prompt_text or media_url']);
  assert.deepEqual(postMissing(PROMPTS, {}), ['page_url', 'prompt_text or media_url']);
  assert.deepEqual(postMissing(['title'], { title: 'T' }), []);
  assert.deepEqual(postMissing(undefined, {}), []);
  assert.deepEqual(describePostRequires(PROMPTS), ['page_url', 'prompt_text or media_url']);
});

test('post_requires in a dataset definition: groups of 1–10 known field names', () => {
  assert.equal(postRequiresSchema.safeParse(PROMPTS).success, true);
  assert.equal(postRequiresSchema.safeParse([[]]).success, false);
  assert.equal(postRequiresSchema.safeParse([['Bad-Name']]).success, false);
  const base = { key: 'pp', title: 'P', fields: [{ name: 'page_url', type: 'url' as const, description: '' }] };
  assert.equal(schemaInputSchema.safeParse({ ...base, post_requires: [['page_url']] }).success, true);
  const bad = schemaInputSchema.safeParse({ ...base, post_requires: [['media_url']] });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /post_requires points to unknown field media_url/);
});

test('query_data for agents adds the postable filter; the owner listing and rule-less datasets do not', async () => {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const pool = { query: async (sql: string, p: unknown[] = []) => { calls.push(sql); params.push(p); return { rows: [] }; } } as any;
  const today = { month: 1, day: 1 };
  await queryDataset(pool, { ...BOOKS, post_requires: [['title'], ['summary', 'birthday']] }, { audience: 'agent', limit: 5, today });
  assert.match(calls[0], /data_postable\(\$\d+::jsonb, d\.data\)/);
  assert.ok(params[0].includes('[["title"],["summary","birthday"]]'));
  await queryDataset(pool, { ...BOOKS, post_requires: [['title']] }, { audience: 'owner', limit: 5, today });
  assert.doesNotMatch(calls[1], /data_postable/);
  await queryDataset(pool, { ...BOOKS, post_requires: [['title']] }, { audience: 'owner', limit: 5, today, postableOnly: true });
  assert.match(calls[2], /data_postable/);
  await queryDataset(pool, BOOKS, { audience: 'agent', limit: 5, today });
  assert.doesNotMatch(calls[3], /data_postable/);
});

test('catalog: the rule in words and the not-postable count; the prompt summary counts only usable rows', () => {
  const e = catalogEntry({ ...BOOKS, post_requires: [['title'], ['summary', 'birthday']] }, { rows: 4839, unposted_here: 75, not_postable: 4764 });
  assert.deepEqual(e.post_requires, ['title', 'summary or birthday']);
  assert.equal(e.not_postable, 4764);
  assert.equal(summarize(e).not_postable, 4764);
  const clean = catalogEntry(BOOKS, { rows: 10, not_postable: 0 });
  assert.equal('post_requires' in clean, false);
  assert.equal('not_postable' in clean, false);
  assert.equal('not_postable' in summarize(clean), false);
  const s = catalogPromptSummary({ datasets: [summarize(e)], apis: [], feeds: [] });
  assert.match(s, /невикористаних тут 75 з 75 \(ще 4764 без даних для поста\)/);
});
