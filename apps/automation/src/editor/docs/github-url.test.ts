import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRawCandidates, isMarkdownPath } from './github-url';

const raw = (path: string) => `https://raw.githubusercontent.com/${path}`;

test('a repository page is its README: main first, then master', () => {
  assert.deepEqual(githubRawCandidates('https://github.com/ZeroLu/awesome-nanobanana-pro'), [
    raw('ZeroLu/awesome-nanobanana-pro/main/README.md'), raw('ZeroLu/awesome-nanobanana-pro/master/README.md'),
  ]);
  assert.deepEqual(githubRawCandidates('https://www.github.com/o/r/'), [raw('o/r/main/README.md'), raw('o/r/master/README.md')]);
  assert.deepEqual(githubRawCandidates('https://github.com/o/r.git'), [raw('o/r/main/README.md'), raw('o/r/master/README.md')]);
  assert.deepEqual(githubRawCandidates('https://github.com/o/r?tab=readme-ov-file#readme'), [raw('o/r/main/README.md'), raw('o/r/master/README.md')]);
});

test('/tree/<branch> tries that branch first', () => {
  assert.deepEqual(githubRawCandidates('https://github.com/o/r/tree/dev'), [raw('o/r/dev/README.md'), raw('o/r/main/README.md'), raw('o/r/master/README.md')]);
  assert.deepEqual(githubRawCandidates('https://github.com/o/r/tree/main'), [raw('o/r/main/README.md'), raw('o/r/master/README.md')]);
});

test('a blob (or raw) page is that file, raw', () => {
  assert.deepEqual(githubRawCandidates('https://github.com/o/r/blob/main/docs/guide/intro.md'), [raw('o/r/main/docs/guide/intro.md')]);
  assert.deepEqual(githubRawCandidates('https://github.com/o/r/raw/v2/list.md'), [raw('o/r/v2/list.md')]);
});

test('other addresses are not mapped', () => {
  for (const u of [
    'https://example.com/o/r', 'https://github.com/', 'https://github.com/o', 'https://github.com/settings/profile', 'https://github.com/orgs/x',
    'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/3', 'https://github.com/o/r/tree/main/docs', 'https://gist.github.com/o/abc',
    'https://raw.githubusercontent.com/o/r/main/README.md', 'not a url',
  ]) assert.equal(githubRawCandidates(u), null, u);
});

test('markdown by path', () => {
  assert.ok(isMarkdownPath('https://x.example/a/readme.MD?x=1'));
  assert.ok(isMarkdownPath('https://x.example/notes.markdown'));
  assert.ok(!isMarkdownPath('https://x.example/a.html'));
});
