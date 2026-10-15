import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityOverlap, extractEntities, mergeEntities, newEntities } from './entities';

/** Spec 037 T2: the entities a story is matched by (names, people, numbers, dates, domains) and their overlap. */

const keys = (t: string) => [...extractEntities(t).entities.keys()].sort();

test('names: versions and editions dropped, media and generic terms out, a big brand head added', () => {
  const k = keys('Alibaba випустила Qwen-Image-2.1-Turbo, пише TechCrunch. Gemini Agent уміє більше, ніж AI-помічники.');
  assert.ok(k.includes('name:qwen-image'));
  assert.ok(k.includes('name:gemini agent') && k.includes('name:gemini'));
  assert.ok(!k.some((x) => x.includes('techcrunch')), 'a media outlet is not the story');
  assert.ok(!k.includes('date:01-02'), '2.1 inside a product name is not a date');
  const w = extractEntities('Apple Home Hub і Apple').entities;
  assert.equal(w.get('name:apple home hub')?.weight, 3);
  assert.equal(w.get('name:apple')?.weight, 1);
});

test('numbers, dates, domains and people in one canonical form', () => {
  const k = keys('OpenAI залучила $40 млрд 13 жовтня; деталі на openai.com. Сем Альтман підтвердив.');
  assert.ok(k.includes('num:usd:40000000000'));
  assert.ok(k.includes('date:10-13'));
  assert.ok(k.includes('dom:openai.com'));
  assert.ok(k.some((x) => x.startsWith('person:')));
  assert.ok(keys('OpenAI raises $40 billion').includes('num:usd:40000000000'), 'English scale words are units too');
});

test('overlap: containment of the poorer side; new entities; merge keeps the strongest', () => {
  const a = extractEntities('Apple Home Hub з екраном від LG вийде 13 жовтня');
  const b = extractEntities('Apple Home Hub коштуватиме $349');
  const o = entityOverlap(b, a);
  assert.ok(o.keys.includes('name:apple home hub'));
  assert.ok(o.score > 0.5);
  assert.deepEqual(newEntities(b, a).map((e) => e.key), ['num:usd:349']);
  assert.equal(mergeEntities([a, b]).entities.size, new Set([...a.entities.keys(), ...b.entities.keys()]).size);
});
