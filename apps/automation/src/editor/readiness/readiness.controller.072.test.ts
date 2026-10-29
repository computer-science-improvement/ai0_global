import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { FixBody, ReadinessController } from './readiness.controller';
import { CH } from './testing/facts-fixture';
import { harness, mkF, MIN } from './testing/fake-readiness';

/** Spec 072 T6, FR-007, A11: the three routes over a real service on fakes. */

function ctl() {
  const h = harness();
  h.state.autoFix = false;
  return { h, c: new ReadinessController(h.svc) };
}

const body = async (p: Promise<any>) => { try { return await p; } catch (e: any) { return { thrown: e }; } };

test('no card is a 404 channel_not_found on all three routes', async () => {
  const { c } = ctl();
  for (const run of [() => c.get('@nobody'), () => c.recheck('@nobody'), () => c.fix('@nobody', {})]) {
    const r = await body(run());
    assert.ok(r.thrown instanceof NotFoundException);
    assert.equal(r.thrown.getStatus(), 404);
    assert.equal((r.thrown.getResponse() as any).error, 'channel_not_found');
  }
});

test('GET: a row 30 seconds old is returned without loading facts; ?fresh=1 is one recheck', async () => {
  const { h, c } = ctl();
  h.repo.rows.set(CH, { channelKey: CH, findings: [mkF('a', 'error')], blockers: 1, warnings: 0, configHash: 'stored', appliedHash: null, checkedAt: new Date(h.clock.now.getTime() - 30_000), notifiedAt: null, notifiedBlockers: [] });
  const stored = await c.get(CH);
  assert.equal(h.calls.load, 0);
  assert.equal(stored.configHash, 'stored');
  assert.equal(stored.blockers, 1);
  const fresh = await c.get(CH, '1');
  assert.equal(h.calls.load, 1);
  assert.notEqual(fresh.configHash, 'stored');
  await c.get(CH, 'true');
  assert.equal(h.calls.load, 2, 'true is read as 1');
  await c.get(CH, '0');
  assert.equal(h.calls.load, 2, 'only 1 and true skip the window');
});

test('GET never fixes and never stamps, even for a channel in the sweep set', async () => {
  const { h, c } = ctl();
  h.state.autoFix = true;
  const hashtag = mkF('hashtag_min_without_vocabulary', 'error', { fix: { kind: 'hashtag_min_zero', channel: CH } });
  h.state.findings = [hashtag];
  h.clock.advance(10 * MIN);
  await c.get(CH, '1');
  await c.get(CH, '1');
  assert.equal(h.calls.hashtag.length, 0);
  assert.ok(h.repo.upserts.every((w) => w.notifiedBlockers === undefined && w.notifiedAt === undefined));
});

test('POST recheck is an owner recheck: it auto-fixes and stamps like the sweep does', async () => {
  const { h, c } = ctl();
  h.state.autoFix = true;
  h.state.findings = [mkF('hashtag_min_without_vocabulary', 'error', { fix: { kind: 'hashtag_min_zero', channel: CH } })];
  h.onFix.current = () => { h.state.findings = []; };
  const reasons: string[] = [];
  h.svc.afterRecheck((e) => { reasons.push(e.reason); });
  const v = await c.recheck(CH);
  assert.deepEqual(reasons, ['owner']);
  assert.equal(h.calls.hashtag.length, 1);
  assert.equal(v.blockers, 0);
  assert.ok(v.findings.some((f) => f.code === 'auto_fixed'));
});

test('POST fix: the zod body takes codes and keys and nothing else; a bad body is a 400', () => {
  assert.deepEqual(FixBody.parse({}), {});
  assert.deepEqual(FixBody.parse({ codes: ['a'], keys: ['k'] }), { codes: ['a'], keys: ['k'] });
  for (const bad of [{ codes: 'a' }, { keys: [1] }, { codes: [''] }, { extra: true }, { codes: Array(101).fill('a') }]) {
    assert.equal(FixBody.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const { c } = ctl();
  assert.throws(() => c.fix(CH, { codes: 'a' }), (e: any) => e.getStatus() === 400 && e.getResponse().error === 'invalid_body');
  assert.throws(() => c.fix(CH, { surprise: 1 }), (e: any) => e.getStatus() === 400);
});

test('POST fix with an empty body is Fix all; with keys it applies those findings only', async () => {
  const { h, c } = ctl();
  const a = mkF('series_source_contradicted', 'error', { id: 'a', fix: { kind: 'skill_disable', agent: 'fx072', skill: 'one' } });
  const b = mkF('series_source_contradicted', 'error', { id: 'b', fix: { kind: 'skill_disable', agent: 'fx072', skill: 'two' } });
  h.state.findings = [a, b];
  await c.recheck(CH);
  const one = await c.fix(CH, { keys: [b.key] });
  assert.deepEqual(h.calls.skills, ['two']);
  assert.equal(one.applied.length, 1);
  const all = await c.fix(CH, undefined);
  assert.deepEqual(h.calls.skills, ['two', 'one', 'two']);
  assert.equal(all.applied.length, 2);
  assert.equal(all.view.channelKey, CH);
});
