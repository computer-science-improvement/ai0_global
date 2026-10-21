/**
 * Spec 059 T4: the two @sysadmin checks of the skill probe — an edit that waits for its probe too long, and an agent
 * whose edits the probe keeps rejecting. Pure checks over facts, no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillProbeRejectFindings, skillProbeStuckFindings, SKILL_CHECKS } from './skills';
import { runChecks } from './index';
import { AUDIT_LIMITS, emptyFacts, type AuditFacts } from '../audit.types';

const NOW = new Date('2026-10-20T06:30:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const facts = (p: Partial<AuditFacts> = {}): AuditFacts => ({ ...emptyFacts(NOW), ...p });

test('thresholds: 3 days waiting, 3 rejections in 30 days', () => {
  assert.deepEqual([AUDIT_LIMITS.probeStuckDays, AUDIT_LIMITS.probeRejectCount, AUDIT_LIMITS.probeRejectDays], [3, 3, 30]);
});

test('a probing edit that waited past the limit is a warning that names the skill, the version and where to look', () => {
  const r = skillProbeStuckFindings(facts({ probes: { stuck: [{ skillId: 's1', name: 'seasonal-hooks', agent: 'news_ch', version: 4, since: daysAgo(5) }], rejects: [] } }));
  assert.equal(r.length, 1);
  assert.equal(r[0].check, 'skill_probe_stuck');
  assert.equal(r[0].severity, 'warn');
  assert.equal(r[0].area, 'skills');
  assert.deepEqual([r[0].subject.type, r[0].subject.label, r[0].subject.agent], ['skill', 'seasonal-hooks', 'news_ch']);
  assert.match(r[0].title, /seasonal-hooks.*v4.*waited 5 days/);
  assert.match(r[0].detail, /SKILL_PROBE_PER_DAY/);
  assert.equal(r[0].fix, undefined, 'no automatic fix: the cause is the probe, not the edit');
  assert.equal(r[0].evidence.version, 4);
});

test('nothing waiting, nothing to say; two versions of one skill are two findings with different keys', () => {
  assert.deepEqual(skillProbeStuckFindings(facts()), []);
  const two = skillProbeStuckFindings(facts({ probes: { stuck: [
    { skillId: 's1', name: 'x-skill', agent: 'a', version: 2, since: daysAgo(4) },
    { skillId: 's1', name: 'x-skill', agent: 'a', version: 3, since: daysAgo(4) },
  ], rejects: [] } }));
  assert.equal(two.length, 2);
  assert.notEqual(two[0].key, two[1].key);
});

test('three or more rejections in the window flag the agent; two do not', () => {
  const r = skillProbeRejectFindings(facts({ probes: { stuck: [], rejects: [
    { agent: 'news_ch', count: 3, skills: ['a-skill', 'b-skill'] },
    { agent: 'quiet_ch', count: 2, skills: ['c-skill'] },
  ] } }));
  assert.equal(r.length, 1);
  assert.equal(r[0].check, 'skill_probe_rejects');
  assert.equal(r[0].severity, 'info');
  assert.deepEqual([r[0].subject.type, r[0].subject.id, r[0].subject.agent], ['agent', 'news_ch', 'news_ch']);
  assert.match(r[0].title, /@news_ch.*keep failing the probe/);
  assert.match(r[0].detail, /self-edits keep failing — consider locking its skills/i);
  assert.match(r[0].detail, /«a-skill», «b-skill»/);
  assert.deepEqual(r[0].evidence, { rejected: 3, days: 30, skills: ['a-skill', 'b-skill'] });
});

test('both checks run with the others, and a report without probe facts stays clean', () => {
  assert.ok(SKILL_CHECKS.includes(skillProbeStuckFindings) && SKILL_CHECKS.includes(skillProbeRejectFindings));
  assert.deepEqual(runChecks(facts()).filter((x) => x.check.startsWith('skill_probe')), []);
  const out = runChecks(facts({ probes: { stuck: [{ skillId: 's1', name: 'x-skill', agent: null, version: 2, since: daysAgo(9) }], rejects: [{ agent: 'a', count: 4, skills: ['x-skill'] }] } }));
  assert.deepEqual(out.filter((x) => x.check.startsWith('skill_probe')).map((x) => x.check).sort(), ['skill_probe_rejects', 'skill_probe_stuck']);
});
