import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHeading, isBadgeImage, parseMarkdown } from './markdown-doc';
import { NANOBANANA_README, NANOBANANA_RAW_URL } from './testing/nanobanana-fixture';

const base = 'https://example.com/docs/list.md';

test('sections follow the headings of any level and tile the text; code, images and links are bound to their section', () => {
  const md = parseMarkdown([
    'Intro line', '', '# Title', 'About it. See [site](https://a.example/x).', '', '## One', '![pic](./img/one.png)',
    '```js', 'const a = 1;', '```', '', '### One.a', '[rel](../up.html) and <a href="https://b.example/">bee</a>',
  ].join('\n'), base);
  assert.deepEqual(md.sections.map((s) => [s.heading, s.level]), [['', 0], ['Title', 1], ['One', 2], ['One.a', 3]]);
  for (let i = 1; i < md.sections.length; i++) assert.equal(md.sections[i].start, md.sections[i - 1].end, 'no gap, no overlap');
  assert.equal(md.sections.at(-1)!.end, md.text.length);
  const [, title, one, onea] = md.sections;
  assert.deepEqual(title.links.map((l) => [l.text, l.url]), [['site', 'https://a.example/x']]);
  assert.deepEqual(one.images.map((i) => [i.alt, i.src]), [['pic', 'https://example.com/docs/img/one.png']]);
  assert.deepEqual(one.code_blocks.map((c) => [c.lang, c.text]), [['js', 'const a = 1;']]);
  assert.equal(md.text.slice(one.code_blocks[0].start, one.code_blocks[0].end), '```js\nconst a = 1;\n```', 'offsets cover the fences');
  assert.deepEqual(onea.links.map((l) => [l.text, l.url]), [['rel', 'https://example.com/up.html'], ['bee', 'https://b.example/']]);
});

test('a heading-looking line inside a fence is code, not a section; longer fences hold shorter ones', () => {
  const md = parseMarkdown(['## A', '````text', '# not a heading', '```', 'still code', '````', 'after', '## B'].join('\n'), base);
  assert.deepEqual(md.sections.map((s) => s.heading), ['A', 'B']);
  assert.equal(md.sections[0].code_blocks.length, 1);
  assert.equal(md.sections[0].code_blocks[0].text, '# not a heading\n```\nstill code');
});

test('an unclosed fence runs to the end of the file', () => {
  const md = parseMarkdown(['## A', '```text', 'line 1', 'line 2'].join('\n'), base);
  assert.equal(md.sections[0].code_blocks[0].text, 'line 1\nline 2');
  assert.equal(md.sections[0].code_blocks[0].end, md.text.length);
});

test('inline <img> tags become markdown images; a badge link has no words and is not a link; fragments and mailto are skipped', () => {
  const md = parseMarkdown([
    '## Pics', '<img width="10" alt="Cat [x]" src="/c.png" /> <img src=\'https://i.example/d.png\'> <img alt="nothing">',
    '[![badge](https://img.shields.io/b.svg)](https://target.example/) [top](#top) [mail](mailto:a@b.c) [ok](https://ok.example/)',
  ].join('\n'), 'https://example.com/a/b.md');
  const s = md.sections[0];
  assert.deepEqual(s.images.map((i) => [i.alt, i.src]), [['Cat x', 'https://example.com/c.png'], ['', 'https://i.example/d.png'], ['badge', 'https://img.shields.io/b.svg']]);
  assert.deepEqual(s.links.map((l) => l.text), ['ok']);
  assert.ok(md.text.includes('![Cat x](/c.png) ![](https://i.example/d.png) '), 'the text carries the rewritten tag');
  assert.ok(!md.text.includes('<img'));
});

test('a heading is read as plain text', () => {
  assert.equal(cleanHeading('1.1. **Bold** [link](https://x.example) `code`'), '1.1. Bold link code');
  assert.ok(isBadgeImage('https://img.shields.io/badge/x-y-blue.svg'));
  assert.ok(!isBadgeImage('https://github.com/user-attachments/assets/3a056a8d'));
});

// ── the nanobanana fixture (FR-005) ───────────────────────────────────────────────────────────────────────────────────

test('the nanobanana fixture: five entries bind heading, image, whole prompt and source', () => {
  const md = parseMarkdown(NANOBANANA_README, NANOBANANA_RAW_URL);
  const entries = md.sections.filter((s) => s.level === 3 && /^\d/.test(s.heading));
  assert.deepEqual(entries.map((s) => s.heading), [
    '1.1. Hyper-Realistic Crowd Composition', '1.2. 2000s Mirror Selfie', '1.3. Chalkboard Notes (no picture yet)',
    '2.1. Ironing Out Wrinkles', '2.2. Prompt With Hash Lines',
  ]);
  const [crowd, json, noImage, wrinkles, hashes] = entries;
  assert.equal(crowd.code_blocks.length, 1);
  assert.equal(crowd.code_blocks[0].lang, 'text');
  assert.match(crowd.code_blocks[0].text, /^Create a hyper-realistic[\s\S]+\n\nGENERAL STYLE & MOOD:[\s\S]+\n\nTHE ENVIRONMENT:/, 'blank lines inside the prompt are kept');
  assert.deepEqual(crowd.images.map((i) => i.src), ['https://github.com/user-attachments/assets/3a056a8d-904e-4b3e-b0d2-b5122758b7f5']);
  assert.equal(crowd.links[0].text, '@SebJefferies');
  assert.equal(crowd.links[0].url, 'https://x.com/SebJefferies/status/1991531687147360728');

  assert.equal(json.code_blocks[0].lang, 'json');
  assert.match(json.code_blocks[0].text, /^Create a 2000s Mirror Selfie[\s\S]+"style": "very long, voluminous waves with soft wispy bangs"[\s\S]+\}\s*$/);
  assert.equal(json.images.length, 1);

  assert.equal(noImage.images.length, 0, 'the entry without a picture');
  assert.equal(noImage.code_blocks.length, 1);

  assert.deepEqual(wrinkles.images.map((i) => i.alt), ['Original', 'Generated'], 'both pictures of a <p align=center> pair, in order');
  assert.deepEqual(wrinkles.links.map((l) => l.text), ['@emollick', 'Post']);

  assert.deepEqual(hashes.images.map((i) => i.src), ['https://replicate.delivery/pbxt/abc/guy.webp', 'https://replicate.delivery/pbxt/abc/out.webp'], 'a table row of pictures');
  assert.equal(hashes.code_blocks[0].text, '# Scene\nA quiet street at dawn.\n\n## Lighting\nSoft pink light from the left.');
  assert.ok(!md.sections.some((s) => s.heading === 'Scene' || s.heading === 'Lighting'), 'hash lines inside the prompt are not sections');

  const sponsors = md.sections.filter((s) => /^Sponsor/.test(s.heading));
  assert.equal(sponsors.length, 2);
  assert.ok(sponsors.every((s) => s.code_blocks.length === 0), 'sponsor blocks have no prompt');
});
