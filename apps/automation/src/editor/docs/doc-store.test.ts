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

const H = 3_600_000;

test('spec 070: past DOC_STORE_HOURS a document is stale: get and keptByUrl still answer, fresh (the fetch cache) does not', () => {
  let now = 1_000_000;
  const store = new DocStore({ ttlHours: 6, now: () => now });
  const d = store.put(doc('https://a.example/x'));
  now += 5 * H;
  assert.ok(store.get(d.id), 'inside the lifetime');
  assert.ok(store.fresh('https://a.example/x'));
  now += 2 * H;
  assert.equal(store.fresh('https://a.example/x'), null, 'past the lifetime the fetch cache does not serve it');
  assert.equal(store.getByUrl('https://a.example/x'), null, 'getByUrl is the same fetch cache');
  assert.equal(store.get(d.id)?.text, 'hello', 'a doc_id still names the latest kept copy');
  assert.equal(store.keptByUrl('https://a.example/x/')?.id, d.id);
  assert.equal(store.size, 1);
});

test('spec 070: a document is dropped at DOC_STALE_MAX_HOURS (168); its id still names the address', () => {
  let now = 1_000_000;
  const store = new DocStore({ ttlHours: 6, now: () => now });
  const d = store.put(doc('https://a.example/x'));
  now += 167 * H;
  assert.ok(store.get(d.id), 'a week less an hour: kept');
  now += 2 * H;
  assert.equal(store.get(d.id), null, 'past the stale cap');
  assert.equal(store.keptByUrl('https://a.example/x'), null);
  assert.equal(store.size, 0);
  assert.equal(store.urlOf(d.id), 'https://a.example/x', 'the tombstone says what to fetch again');
  assert.equal(store.urlOf('doc_unknown'), null);
  // The cap can be set, and never below the lifetime.
  const short = new DocStore({ ttlHours: 6, staleHours: 1, now: () => now });
  const e = short.put(doc('https://a.example/y'));
  now += 5 * H;
  assert.ok(short.get(e.id), 'the stale cap is at least the lifetime');
});

test('spec 070: a fresh fetch of the address replaces the stale copy under the same id', () => {
  let now = 1_000_000;
  const store = new DocStore({ ttlHours: 6, now: () => now });
  const old = store.put(doc('https://a.example/x', 'old'));
  now += 10 * H;
  assert.equal(store.fresh('https://a.example/x'), null);
  const again = store.put(doc('https://a.example/x', 'new'));
  assert.equal(again.id, old.id);
  assert.equal(store.fresh('https://a.example/x')?.text, 'new');
  assert.equal(store.get(old.id)?.fetched_at, again.fetched_at);
});

test('spec 070: fresh and keptByUrl touch the LRU order like get; a miss touches nothing', () => {
  const store = new DocStore({ max: 3 });
  const a = store.put(doc('https://a.example/1'));
  const b = store.put(doc('https://a.example/2'));
  const c = store.put(doc('https://a.example/3'));
  store.fresh('https://a.example/1');
  store.keptByUrl('https://a.example/2');
  assert.equal(store.fresh('https://a.example/none'), null);
  store.put(doc('https://a.example/4'));                // c was the least recently used
  assert.equal(store.get(c.id), null);
  assert.ok(store.get(a.id) && store.get(b.id));
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
