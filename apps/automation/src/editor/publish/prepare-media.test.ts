import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorMediaPreparer, MediaPrepDeps } from './prepare-media';
import { makeSpec } from '../post/testing/fixtures';

function fakes(over: Partial<MediaPrepDeps> = {}) {
  const log: any[] = [];
  const d: MediaPrepDeps = {
    renderSlides: async (slides) => { log.push(['render', slides]); return slides.map((_, i) => Buffer.from(`png${i}`)); },
    hosting: {
      available: async () => true,
      upload: async (bufs, prefix) => { log.push(['upload', prefix, bufs.length]); return bufs.map((_, i) => ({ url: `https://cdn.example/${prefix}/slide-${i + 1}.png`, path: `${prefix}/slide-${i + 1}.png` })); },
      delete: async (paths) => { log.push(['delete', paths]); },
    },
    createPage: async (a) => { log.push(['page', a]); return { url: 'https://telegra.ph/Test-10-01', path: 'Test-10-01' }; },
    fetchImage: async (url) => { log.push(['fetch', url]); return url.includes('bad') ? null : Buffer.from('img'); },
    ...over,
  };
  return { prep: new EditorMediaPreparer(d), log };
}

const KEY = { channelKey: '@my_chan', slotId: 'a1b2-c3' };
const carousel = makeSpec({
  format: 'carousel', media: [],
  slides: [{ title: 'Один', text: 'Перший слайд', image: 'https://img.example/1.jpg' }, { title: 'Два', text: 'Другий слайд', image: 'https://img.example/bad.jpg' }, { title: 'Три', text: 'Третій' }],
});

test('carousel: fetches backgrounds, renders, hosts under the slot key, cleanup deletes', async () => {
  const { prep, log } = fakes();
  const r = await prep.prepare(carousel, KEY);
  assert.deepEqual(r.prepared.slideUrls, [1, 2, 3].map((i) => `https://cdn.example/editor/my_chan/a1b2-c3/slide-${i}.png`));
  const render = log.find((l) => l[0] === 'render')[1];
  assert.deepEqual(render.map((s: any) => [s.title, s.image ? 'img' : null]), [['Один', 'img'], ['Два', null], ['Три', null]]);
  assert.deepEqual(log.filter((l) => l[0] === 'fetch').map((l) => l[1]), ['https://img.example/1.jpg', 'https://img.example/bad.jpg']);
  await r.cleanup();
  assert.deepEqual(log.at(-1), ['delete', [1, 2, 3].map((i) => `editor/my_chan/a1b2-c3/slide-${i}.png`)]);
});

test('carousel: no hosting configured → throws before rendering', async () => {
  const { prep, log } = fakes({ hosting: { available: async () => false, upload: async () => [], delete: async () => {} } });
  await assert.rejects(prep.prepare(carousel, KEY), /slide hosting is not configured/);
  assert.equal(log.length, 0);
});

test('longread: creates a Telegraph page with cover and source; text formats need nothing', async () => {
  const { prep, log } = fakes();
  const spec = makeSpec({
    format: 'longread', media: [{ url: 'https://img.example/cover.jpg' }],
    longread: { title: 'Як влаштований Вебб', blocks: [{ type: 'p', text: 'Абзац' }] },
  });
  const r = await prep.prepare(spec, KEY);
  assert.equal(r.prepared.longreadUrl, 'https://telegra.ph/Test-10-01');
  const page = log.find((l) => l[0] === 'page')[1];
  assert.equal(page.title, 'Як влаштований Вебб');
  assert.equal(page.nodes[0].tag, 'figure');
  assert.equal(page.nodes.at(-1).children[1].attrs.href, 'https://nasa.gov/ring');

  const plain = await prep.prepare(makeSpec(), KEY);
  assert.deepEqual(plain.prepared, {});
  assert.equal(log.length, 1);
});
