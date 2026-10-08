import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SkillLibrary, DEFAULT_SKILLS_DIR } from './skill-library';
import { lintSkill } from '../agents/skill-lint';

const lib = new SkillLibrary();

test('every builtin skill passes skill-lint', () => {
  const failed = lib.all()
    .map((s) => ({ name: s.name, r: lintSkill({ name: s.name, description: s.description, appliesTo: s.appliesTo, body: s.body }) }))
    .filter((x) => !x.r.ok)
    .map((x) => `${x.name}: ${x.r.errors.map((e) => e.code).join(', ')}`);
  assert.deepEqual(failed, []);
});

test('resource-decisions (spec 024 FR-012): orchestrator, planner and executor; covers the four decisions and format_prefs', () => {
  const s = lib.get('resource-decisions');
  assert.ok(s, 'the builtin skill exists');
  assert.deepEqual([...s!.appliesTo].sort(), ['executor', 'orchestrator', 'planner']);
  for (const word of ['duplicate', 'adapt', 'unique', 'skip', 'reason_code', 'format_prefs', 'update_resource_format', 'repurpose_post', 'off_topic']) {
    assert.ok(s!.body.includes(word), `mentions ${word}`);
  }
  for (const role of ['orchestrator', 'planner', 'executor'] as const) {
    assert.ok(lib.list(role).some((m) => m.name === 'resource-decisions'), `listed for ${role}`);
  }
});

/** Spec 024 FR-012: prompts and skills say «дублювати / адаптувати / унікальний пост», never «дзеркало». */
test('no «дзеркало / дзеркалити» in builtin skills and agent prompts', () => {
  const MIRROR = /дзеркал/iu;
  const offenders: string[] = [];
  for (const s of lib.all()) if (MIRROR.test(`${s.description}\n${s.body}`)) offenders.push(`skill ${s.name}`);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : []);
  });
  for (const f of walk(join(__dirname, '..'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (MIRROR.test(line)) offenders.push(`${f.slice(f.indexOf('src/'))}:${i + 1}`); });
  }
  assert.ok(readdirSync(DEFAULT_SKILLS_DIR).length > 20);
  assert.deepEqual(offenders, []);
});
