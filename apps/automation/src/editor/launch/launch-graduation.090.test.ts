import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { graduationSettings, type GraduationFacts } from './launch-graduation';
import { LaunchService } from './launch.service';
import type { LaunchDeps } from './launch.service';
import { MemoryLaunchRepo } from './testing/launch-fixtures';

/**
 * Spec 090 FR-008: LAUNCH_GRADUATION defaults to auto, readiness blockers still hold the switch, and a graduation made by code
 * is logged with an undo back to approval mode.
 */

const KEY = '@coffee_home';
const START = new Date('2026-11-01T10:00:00Z');
const DAY8 = new Date(START.getTime() + 8 * 86_400_000);
const FACTS: GraduationFacts = {
  decisions: [...Array(9).fill('clean'), 'edited', 'clean', 'clean'] as GraduationFacts['decisions'],
  critic: { pass: 9, revise: 1, reject: 0 }, usable: true,
};

async function rig(o: { blockers?: number | 'throws' | null; env?: Record<string, string>; liveEnv?: Record<string, string> } = {}) {
  const repo = new MemoryLaunchRepo(() => START);
  const l = (await repo.insert({ channelKey: KEY, title: 'Coffee', brief: 'b'.repeat(40), refs: [], createdBy: 'owner' }))!;
  await repo.update(l.id, { status: 'running', startedAt: START } as any);
  const calls: string[] = [];
  const rows: any[] = [];
  const env = o.env ?? {};
  const d = {
    repo,
    graduation: {
      settings: () => graduationSettings((k) => env[k]),
      facts: async () => FACTS,
      mode: async () => 'approve' as const,
      goLive: async (key: string) => { calls.push(`goLive:${key}`); },
      note: async () => { calls.push('note'); },
      ...(o.blockers === null ? {} : { blockers: async () => { if (o.blockers === 'throws') throw new Error('unreadable'); return o.blockers ?? 0; } }),
    },
    setMode: async (key: string, mode: string) => { calls.push(`setMode:${key}:${mode}`); },
    decisions: { record: async (r: any) => { rows.push(r); return rows.length; } },
    env: (k: string) => env[k],
    now: () => DAY8,
  } as unknown as LaunchDeps;
  const svc = new LaunchService(d);
  return { svc, repo, calls, rows, id: l.id };
}

test('the default is auto: with nothing set the settings read auto', () => {
  assert.equal(graduationSettings(() => undefined).mode, 'auto');
});

test('under the default (auto) a channel without a readiness blocker graduates, with a decision row and an undo to approval mode', async () => {
  const r = await rig({ blockers: 0 });
  const next = await r.svc.checkGraduation((await r.repo.get(r.id))!, true);
  assert.equal(next?.status, 'graduated');
  assert.equal(next?.graduation?.by, 'auto');
  assert.deepEqual(r.calls.filter((c) => c.startsWith('goLive')), [`goLive:${KEY}`]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].gate, 'launch_graduation');
  assert.equal(r.rows[0].action, 'applied');
  assert.equal(r.rows[0].channelKey, KEY);
  assert.deepEqual(r.rows[0].undo, { kind: 'launch_graduation', channelKey: KEY, launchId: r.id });

  const undo = new AutonomyUndo({} as any);
  r.svc.registerUndo(undo);
  await (undo as any).handlers.get('launch_graduation')(r.rows[0].undo, {});
  assert.ok(r.calls.includes(`setMode:${KEY}:approve`));
});

test('under the default (auto) a channel with a readiness blocker does not graduate and writes no decision', async () => {
  const r = await rig({ blockers: 2 });
  const next = await r.svc.checkGraduation((await r.repo.get(r.id))!, true);
  assert.equal(next?.status, 'running');
  assert.equal(next?.graduation?.heldBy, 'readiness');
  assert.equal(next?.graduation?.heldBlockers, 2);
  assert.equal(r.calls.filter((c) => c.startsWith('goLive')).length, 0);
  assert.equal(r.rows.length, 0);

  const unreadable = await rig({ blockers: 'throws' });
  const held = await unreadable.svc.checkGraduation((await unreadable.repo.get(unreadable.id))!, true);
  assert.equal(held?.status, 'running', 'a count that cannot be read holds it too');
  assert.equal(unreadable.rows.length, 0);
});

test('LAUNCH_GRADUATION=propose and OWNER_SILENCE=wait propose instead of switching', async () => {
  for (const env of [{ LAUNCH_GRADUATION: 'propose' }, { OWNER_SILENCE: 'wait' }] as Array<Record<string, string>>) {
    const r = await rig({ blockers: 0, env });
    const next = await r.svc.checkGraduation((await r.repo.get(r.id))!, true);
    assert.equal(next?.status, 'running', JSON.stringify(env));
    assert.ok(next?.graduation?.proposedAt, JSON.stringify(env));
    assert.equal(r.calls.filter((c) => c.startsWith('goLive')).length, 0);
    assert.equal(r.rows.length, 0);
  }
});
