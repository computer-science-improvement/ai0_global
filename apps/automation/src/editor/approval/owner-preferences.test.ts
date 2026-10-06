/** Spec 031 T6: owner edits and reject reasons become owner preferences in the prompts; the stats of a fixture. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { EditorRunnerService } from '../roles/editor-runner.service';
import type { MemoryEntry } from '../repo/editor-memory.repository';
import { ApprovalsService } from './approvals.service';
import { computeApprovalStats, type ApprovalDecisionRow } from './approval-stats';
import { describeEdit, editPreference, rejectPreference, type OwnerPreference } from './owner-preferences';

const BEFORE = {
  format: 'photo', title: 'Туманність', origin: 'external',
  body: [
    { type: 'lead', text: 'Неймовірне відкриття, яке змінить усе, що ви знали про космос' },
    { type: 'p', text: 'Webb показав туманність Кільце. Оболонки газу — рештки зорі. Їм кілька тисяч років. Це справді вражає уяву.' },
  ],
  media: [{ url: 'https://img.example/ring.jpg' }], hashtags: ['космос', 'вау'],
};
const AFTER = {
  ...BEFORE,
  body: [
    { type: 'lead', text: 'Webb показав туманність Кільце' },
    { type: 'p', text: 'Webb показав туманність Кільце. Оболонки газу — рештки зорі. Їм кілька тисяч років.' },
  ],
  hashtags: ['космос'],
};

test('an owner edit is a compact before/after note: intro, length, removed sentence, hashtags', () => {
  const changes = describeEdit(BEFORE, AFTER)!;
  assert.ok(changes.some((c) => /^переписав вступ: «Неймовірне відкриття/.test(c)), changes.join(' | '));
  assert.ok(changes.some((c) => /^скоротив текст \(\d+ → \d+ симв\.\)$/.test(c)));
  assert.ok(changes.includes('прибрав: «Це справді вражає уяву.»'));
  assert.ok(changes.includes('прибрав хештеги #вау'));
  assert.ok(!changes.some((c) => /медіа/.test(c)), 'media unchanged');
  const pref = editPreference({ slotId: 's1', topic: 'Туманність Кільце', resourceRef: null, before: BEFORE, after: AFTER })!;
  assert.equal(pref.kind, 'rule');
  assert.match(pref.text, /^Власник відредагував пост «Туманність Кільце» перед апрувом: /);
  assert.ok(pref.text.length <= 700);
  assert.deepEqual(pref.evidence, { source: 'approval', action: 'edit', slotId: 's1', resourceRef: null, topic: 'Туманність Кільце' });
  assert.equal(editPreference({ slotId: 's1', topic: 't', resourceRef: null, before: BEFORE, after: { ...BEFORE } }), null, 'no visible change, no note');
});

test('platform captions: added text and the resource in the note', () => {
  const before = { format: 'ig_photo', title: 't', caption: 'Туманність Кільце очима Webb.', hashtags: [], media: [] };
  const after = { ...before, caption: 'Туманність Кільце очима Webb.\nДжерело: NASA.', first_comment: 'nasa.gov' };
  const pref = editPreference({ slotId: 's2', topic: 'Кільце', resourceRef: 'instagram:42', before, after })!;
  assert.match(pref.text, /«Кільце» \(instagram:42\)/);
  assert.match(pref.text, /додав: «Джерело: NASA\.»/);
  assert.match(pref.text, /змінив перший коментар/);
});

test('a reject reason is an "avoid" note; a rejection without a reason teaches nothing', () => {
  const r = rejectPreference({ slotId: 's3', topic: 'Затемнення', resourceRef: 'telegram:@space', reason: '  тема була вчора  ' })!;
  assert.deepEqual([r.kind, r.text], ['avoid', 'Власник відхилив пост «Затемнення»: тема була вчора']);
  assert.equal(rejectPreference({ slotId: 's3', topic: 't', resourceRef: null, reason: '   ' }), null);
  assert.equal(rejectPreference({ slotId: 's3', topic: 't', resourceRef: null, reason: null }), null);
});

test('a reject reason appears in the next planner and executor prompts (last 20, own section)', async () => {
  const memory: Array<{ channelKey: string } & OwnerPreference> = [];
  const item = {
    id: 'slot-1', planId: 'p', channelKey: '@space', scheduledAt: new Date('2030-03-04T10:00:00Z'), kind: 'content', format: 'text',
    topic: 'Сонячне затемнення', angle: null, sourceHints: [], isExperiment: false, status: 'awaiting_approval', attempts: 1, runId: null,
    publishedPostId: null, postSpec: BEFORE, renderedPreview: 'x', error: null, planDate: '2030-03-04', planRationale: null, channelTitle: 'Космос',
    timezone: 'Europe/Kyiv', holdHours: 6, idea: null, updatedAt: new Date(),
  };
  const svc = new ApprovalsService({
    repo: {
      get: async () => item, reject: async () => ({ ...item, status: 'skipped' }), insertReplacement: async () => null,
    } as any,
    card: async () => makeCard({ channelKey: '@space' }),
    remember: async (channelKey, pref) => { memory.push({ channelKey, ...pref }); },
    now: () => new Date('2030-03-04T09:55:00Z'),
  });
  await svc.reject('slot-1', { reason: 'тема була вчора в іншому каналі мережі' });
  assert.equal(memory.length, 1);

  const asEntries = (): MemoryEntry[] => memory.map((m, i) => ({ id: i + 1, kind: m.kind, text: m.text, evidence: m.evidence, createdBy: 'owner', createdAt: new Date() }));
  const seen: any[] = [];
  const listed: any[] = [];
  const runner = new EditorRunnerService({
    loop: { run: async (i: any) => { seen.push(i); return { runId: 'r', status: 'ok', terminalTool: 'submit_plan', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0 } } as any; } },
    registry: { forRole: () => [] },
    skills: { get: () => null, list: () => [] } as any,
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...item, status: 'published' }) as any, updateSlot: async () => {} },
    memory: {
      listActive: async (_k: string, _n?: number, o?: any) => { listed.push(o); return [{ id: 99, kind: 'rule', text: 'Без емодзі в заголовках', evidence: null, createdBy: 'owner', createdAt: new Date() }]; },
      ownerPreferences: async (_k: string, n?: number) => { assert.equal(n, 20); return asEntries(); },
    },
    env: () => undefined, notify: async () => {},
  });
  await runner.runPlanner(makeCard({ channelKey: '@space' }));
  assert.match(seen[0].system, /## Вподобання власника/);
  assert.match(seen[0].system, /Власник відхилив пост «Сонячне затемнення»: тема була вчора в іншому каналі мережі/);
  assert.match(seen[0].system, /Без емодзі в заголовках/, 'the rest of the memory stays');
  assert.deepEqual(listed[0], { excludeApprovalPrefs: true }, 'no duplicates in the general memory block');

  await runner.runExecutor({ ...item, status: 'running' } as any, makeCard({ channelKey: '@space', mode: 'live' }));
  assert.match(seen[1].system, /тема була вчора в іншому каналі мережі/);
  await runner.runReviewer(makeCard({ channelKey: '@space' }));
  assert.doesNotMatch(seen[2].system, /## Вподобання власника/, 'the reviewer prompt is unchanged');
});

test('approval stats of a fixture: rates, top reasons (grouped), median time to approve, expired', () => {
  const row = (outcome: ApprovalDecisionRow['outcome'], o: Partial<ApprovalDecisionRow> = {}): ApprovalDecisionRow =>
    ({ channelKey: '@space', resourceRef: 'telegram:@space', outcome, rejectReason: null, waitSeconds: null, ...o });
  const rows: ApprovalDecisionRow[] = [
    row('clean', { waitSeconds: 60 }), row('clean', { waitSeconds: 120 }), row('clean', { waitSeconds: 600 }), row('clean'),
    row('edited', { waitSeconds: 300 }),
    row('rejected', { rejectReason: 'Тема вчорашня' }), row('rejected', { rejectReason: 'тема  вчорашня.' }), row('rejected', { rejectReason: 'Слабке джерело' }),
    row('rejected'),
    row('expired'), row('expired'),
  ];
  assert.deepEqual(computeApprovalStats(rows), {
    approved: 5, approvedClean: 4, edited: 1, rejected: 4, expired: 2,
    approvalRate: 0.556, editRate: 0.2, cleanRate: 0.8,
    medianTimeToApproveSec: 210,
    topRejectReasons: [{ reason: 'Тема вчорашня', count: 2 }, { reason: 'Слабке джерело', count: 1 }],
    rejectedWithoutReason: 1,
  });
  assert.deepEqual(computeApprovalStats([]), {
    approved: 0, approvedClean: 0, edited: 0, rejected: 0, expired: 0, approvalRate: null, editRate: null, cleanRate: null,
    medianTimeToApproveSec: null, topRejectReasons: [], rejectedWithoutReason: 0,
  });
});
