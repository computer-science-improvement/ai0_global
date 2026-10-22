import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, DocStore, docIdOf, type NewDoc } from './doc-store';

const doc = (url: string, text = 'hello'): NewDoc => ({
  url, fetched_url: null, final_url: url, kind: 'html', title: 'T', description: null, image: null, images: [], published_at: null,
  text, sections: [{ heading: 'H', level: 1, start: 0, end: text.length, images: [], links: [], code_blocks: [] }],
});

test('put gives the document a stable id of its address and numbers its sections', () => {
  const store = new DocStore();
  const d = store.put(doc('https://a.example/x#frag'));
  assert.equal(d.id, docIdOf('https://a.example/x'), 'the fragment is not part of the address');
  assert.equal(d.id, docIdOf('https://A.example/x/'), 'host case and a trailing slash do not matter');
  assert.deepEqual(d.sections.map((s) => s.id), ['s1']);
  assert.equal(store.get(d.id)?.text, 'hello');
  assert.equal(store.getByUrl('https://a.example/x/')?.id, d.id, 'a second fetch of the address finds it (the fetch cache)');
  assert.equal(canonicalUrl('https://a.example/'), 'https://a.example/', 'the root keeps its slash');
  assert.notEqual(docIdOf('https://a.example/x?a=1'), docIdOf('https://a.example/x?a=2'), 'the query is part of the address');
});

test('a document expires after DOC_STORE_HOURS and its id still names the address', () => {
  let now = 1_000_000;
  const store = new DocStore({ ttlHours: 6, now: () => now });
  const d = store.put(doc('https://a.example/x'));
  now += 5 * 3_600_000;
  assert.ok(store.get(d.id), 'inside the lifetime');
  now += 2 * 3_600_000;
  assert.equal(store.get(d.id), null, 'past it');
  assert.equal(store.getByUrl('https://a.example/x'), null);
  assert.equal(store.urlOf(d.id), 'https://a.example/x', 'the tombstone says what to fetch again');
  assert.equal(store.urlOf('doc_unknown'), null);
});

test('the least recently used document goes first when the store is full', () => {
  const store = new DocStore({ max: 3 });
  const a = store.put(doc('https://a.example/1'));
  const b = store.put(doc('https://a.example/2'));
  const c = store.put(doc('https://a.example/3'));
  store.get(a.id);                                     // a is now the newest-used
  const d = store.put(doc('https://a.example/4'));
  assert.equal(store.size, 3);
  assert.equal(store.get(b.id), null, 'b was the least recently used');
  assert.ok(store.get(a.id) && store.get(c.id) && store.get(d.id));
  assert.equal(store.urlOf(b.id), 'https://a.example/2');
});

test('putting an address again replaces its copy and keeps the id', () => {
  const store = new DocStore();
  const first = store.put(doc('https://a.example/x', 'old'));
  const second = store.put(doc('https://a.example/x', 'new text'));
  assert.equal(first.id, second.id);
  assert.equal(store.size, 1);
  assert.equal(store.get(first.id)?.text, 'new text');
});
