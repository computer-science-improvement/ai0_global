import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_SKILLS_DIR, SkillLibrary, parseSkill } from './skill-library';

test('parseSkill reads frontmatter and body', () => {
  const s = parseSkill('a.md', '---\nname: format-hashtags\ndescription: How to tag\napplies_to: [executor]\n---\n# Body\ntext');
  assert.equal(s.name, 'format-hashtags');
  assert.deepEqual(s.appliesTo, ['executor']);
  assert.equal(s.body, '# Body\ntext');
});

test('parseSkill rejects missing frontmatter or fields', () => {
  assert.throws(() => parseSkill('a.md', '# no fm'), /frontmatter/);
  assert.throws(() => parseSkill('a.md', '---\nname: x\n---\nbody'), /description/);
});

test('library lists by role and gets by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  writeFileSync(join(dir, 'a.md'), '---\nname: a\ndescription: A\napplies_to: [planner]\n---\nA body');
  writeFileSync(join(dir, 'b.md'), '---\nname: b\ndescription: B\n---\nB body');
  writeFileSync(join(dir, 'ignore.txt'), 'x');
  const lib = new SkillLibrary(dir);
  assert.deepEqual(lib.list('executor').map((s) => s.name), ['b']);
  assert.deepEqual(lib.list('planner').map((s) => s.name), ['a', 'b']);
  assert.equal(lib.get('a')!.body, 'A body');
});

test('missing dir yields empty library', () => {
  assert.deepEqual(new SkillLibrary('/nonexistent/dir').list(), []);
});

test('shipped editor-skills all parse', () => {
  const lib = new SkillLibrary(DEFAULT_SKILLS_DIR);
  for (const s of lib.list()) {
    assert.ok(s.description.length > 10, s.name);
    assert.ok(lib.get(s.name)!.body.length > 100, `${s.name} body too short`);
  }
});
