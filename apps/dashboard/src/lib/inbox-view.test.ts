// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B2: the Inbox page's URL, tabs, grouping, selection and empty-state copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentLabel, autoView, emptyCopy, findNote, groupBySubject, inTab, markedText, newestFirst, parseInboxSearch, resolveView, selectNote,
  singleRows, tabCounts, techLines, toSearch, unreadIdsOf,
} from './inbox-view';
import { planNote, type NoteItem } from './inbox-kinds';
import type { TreeNode } from './inbox-ref';

type N = NoteItem & { createdAt: string };
const note = (id: number, over: Partial<N> = {}): N => ({
  id, agentId: null, kind: 'series_missed', title: `Note ${id}`, body: null, refType: null, refId: null, severity: 'action', readAt: null,
  createdAt: `2026-10-29T12:${String(60 - id % 60).padStart(2, '0')}:00Z`, ...over,
});

// ── the URL ─────────────────────────────────────────────────────────────────

test('parseInboxSearch keeps known values and drops everything else', () => {
  assert.deepEqual(parseInboxSearch({}), {});
  assert.deepEqual(parseInboxSearch({ tab: 'critical', unread: false, note: 5213 }), { tab: 'critical', unread: false, note: 5213 });
  assert.deepEqual(parseInboxSearch({ tab: 'unread' }), { tab: 'unread' });
  assert.deepEqual(parseInboxSearch({ tab: 'approvals' }), { tab: 'approvals' });
  assert.deepEqual(parseInboxSearch({ tab: 'nope', unread: 'maybe', note: -4 }), {});
  assert.deepEqual(parseInboxSearch({ unread: 'false', note: '17' }), { unread: false, note: 17 });
  assert.deepEqual(parseInboxSearch({ unread: '1', note: 1.5 }), { unread: true });
  assert.deepEqual(parseInboxSearch({ tab: ['all'], note: {} }), {});
});

test('legacy links: tab=unread is All with Unread only on, tab=all is All with it off', () => {
  assert.deepEqual(resolveView({ tab: 'unread' }), { tab: 'all', unread: true, note: null });
  assert.deepEqual(resolveView({ tab: 'all' }), { tab: 'all', unread: false, note: null });
  assert.deepEqual(resolveView({ tab: 'approvals' }), { tab: 'approvals', unread: true, note: null });
});

test('the new links: Unread only is on unless the URL turns it off', () => {
  assert.deepEqual(resolveView({ tab: 'all', unread: true }), { tab: 'all', unread: true, note: null });
  assert.deepEqual(resolveView({ tab: 'all', unread: false }), { tab: 'all', unread: false, note: null });
  assert.deepEqual(resolveView({ tab: 'critical' }), { tab: 'critical', unread: true, note: null });
  assert.deepEqual(resolveView({ tab: 'fyi', unread: false, note: 9 }), { tab: 'fyi', unread: false, note: 9 });
});

test('a bare URL leaves the tab to the data', () => {
  assert.deepEqual(resolveView({}), { tab: null, unread: null, note: null });
  assert.deepEqual(resolveView({ note: 12 }), { tab: null, unread: null, note: 12 });
  assert.deepEqual(resolveView({ unread: false }), { tab: null, unread: false, note: null });
});

test('autoView: unread notes win; approvals only when nothing is unread; a deep link opens the list holding the note', () => {
  const some = new Set([1, 2]);
  assert.deepEqual(autoView({ note: null, unreadIds: some, waiting: 3 }), { tab: 'all', unread: true });
  assert.deepEqual(autoView({ note: null, unreadIds: new Set(), waiting: 3 }), { tab: 'approvals', unread: true });
  assert.deepEqual(autoView({ note: null, unreadIds: new Set(), waiting: 0 }), { tab: 'all', unread: true });
  assert.deepEqual(autoView({ note: 2, unreadIds: some, waiting: 3 }), { tab: 'all', unread: true });
  assert.deepEqual(autoView({ note: 99, unreadIds: some, waiting: 3 }), { tab: 'all', unread: false });
  assert.deepEqual(autoView({ note: 5, unreadIds: new Set(), waiting: 3 }), { tab: 'all', unread: false });
});

test('toSearch leaves defaults out, but always says which All it means; resolveView reads it back', () => {
  assert.deepEqual(toSearch({ tab: 'approvals', unread: false }), { tab: 'approvals' });
  assert.deepEqual(toSearch({ tab: 'all', unread: true }), { tab: 'all', unread: true });
  assert.deepEqual(toSearch({ tab: 'all', unread: false }), { tab: 'all', unread: false });
  assert.deepEqual(toSearch({ tab: 'critical', unread: true }), { tab: 'critical' });
  assert.deepEqual(toSearch({ tab: 'action', unread: false, note: 7 }), { tab: 'action', unread: false, note: 7 });
  for (const tab of ['all', 'critical', 'action', 'fyi'] as const) {
    for (const unread of [true, false]) {
      const r = resolveView(toSearch({ tab, unread, note: 4 }));
      assert.deepEqual(r, { tab, unread, note: 4 }, `${tab}/${unread}`);
    }
  }
});

// ── tabs ────────────────────────────────────────────────────────────────────

test('tabs filter by severity; To approve shows no notes; counts add up', () => {
  assert.equal(inTab('critical', 'all'), true);
  assert.equal(inTab('info', 'fyi'), true);
  assert.equal(inTab('info', 'action'), false);
  assert.equal(inTab('action', 'action'), true);
  assert.equal(inTab('critical', 'critical'), true);
  assert.equal(inTab('critical', 'approvals'), false);
  const c = tabCounts([note(1), note(2, { severity: 'critical' }), note(3, { severity: 'info' }), note(4, { severity: 'info' })]);
  assert.deepEqual(c, { all: 4, critical: 1, action: 1, fyi: 2 });
  assert.deepEqual(tabCounts([]), { all: 0, critical: 0, action: 0, fyi: 0 });
});

// ── rows ────────────────────────────────────────────────────────────────────

test('newestFirst sorts by time, then id, without touching the input', () => {
  const a = note(1, { createdAt: '2026-10-29T10:00:00Z' });
  const b = note(2, { createdAt: '2026-10-29T12:00:00Z' });
  const c = note(3, { createdAt: '2026-10-29T12:00:00Z' });
  const input = [a, b, c];
  assert.deepEqual(newestFirst(input).map((n) => n.id), [3, 2, 1]);
  assert.deepEqual(input.map((n) => n.id), [1, 2, 3]);
});

test('groupBySubject: repeats of one subject are one row, newest first; no subject, no group', () => {
  const list = [
    note(10, { subject: 'resource:threads:a' }),
    note(11, { subject: null }),
    note(12, { subject: 'resource:threads:a' }),
    note(13, { subject: 'resource:threads:b' }),
    note(14, { subject: '  ' }),
    note(15, { subject: 'resource:threads:a' }),
  ];
  const g = groupBySubject(list);
  assert.deepEqual(g.map((x) => [x.head.id, x.items.map((n) => n.id)]), [[10, [10, 12, 15]], [11, [11]], [13, [13]], [14, [14]]]);
  assert.equal(new Set(g.map((x) => x.key)).size, g.length);
  assert.deepEqual(groupBySubject([]), []);
});

test('singleRows: every note its own row', () => {
  const g = singleRows([note(1, { subject: 's' }), note(2, { subject: 's' })]);
  assert.deepEqual(g.map((x) => x.items.length), [1, 1]);
});

test('unreadIdsOf lists the unread notes of all the rows, group members included', () => {
  const g = groupBySubject([
    note(1, { subject: 'x' }), note(2, { subject: 'x', readAt: '2026-10-29T00:00:00Z' }), note(3, { readAt: '2026-10-29T00:00:00Z' }), note(4),
  ]);
  assert.deepEqual(unreadIdsOf(g), [1, 4]);
  assert.deepEqual(unreadIdsOf([]), []);
});

// ── selection ───────────────────────────────────────────────────────────────

test('selectNote: the wanted note (also an older one of a group), else the first row', () => {
  const g = groupBySubject([note(1, { subject: 'x' }), note(2), note(3, { subject: 'x' })]);
  assert.equal(selectNote(g, null)!.note.id, 1);
  assert.equal(selectNote(g, 2)!.note.id, 2);
  const older = selectNote(g, 3)!;
  assert.equal(older.note.id, 3);
  assert.equal(older.group.head.id, 1);
  assert.equal(older.index, 0);
  assert.equal(selectNote(g, 404)!.note.id, 1);
  assert.equal(selectNote([], 1), null);
});

test('selectNote: when the selected row leaves the list the one that took its place is selected', () => {
  const rows = singleRows([note(1), note(2), note(3)]);
  // row "n:2" (index 1) was selected and has been marked done
  const after = singleRows([note(1), note(3)]);
  assert.equal(selectNote(after, 2, { key: 'n:2', index: 1 })!.note.id, 3);
  // the last row left: the new last row
  assert.equal(selectNote(singleRows([note(1), note(2)]), 3, { key: 'n:3', index: 2 })!.note.id, 2);
  // the row is still there: it stays selected even if the URL has no note
  assert.equal(selectNote(rows, null, { key: 'n:2', index: 1 })!.note.id, 2);
  // the only row left
  assert.equal(selectNote(singleRows([note(9)]), 3, { key: 'n:3', index: 2 })!.note.id, 9);
  // an explicit wanted note beats the previous row
  assert.equal(selectNote(rows, 1, { key: 'n:3', index: 2 })!.note.id, 1);
});

test('findNote finds only what is in the list', () => {
  const g = singleRows([note(1), note(2)]);
  assert.equal(findNote(g, 2)!.index, 1);
  assert.equal(findNote(g, 3), null);
  assert.equal(findNote(g, null), null);
});

// ── copy ────────────────────────────────────────────────────────────────────

test('agentLabel and the counts read in plain English', () => {
  assert.equal(agentLabel({ handle: 'space', emoji: '🚀' }), '🚀 @space');
  assert.equal(agentLabel({ handle: 'space', name: 'Space', emoji: null }, true), 'Space · @space');
  assert.equal(agentLabel({ handle: 'space', name: 'space' }, true), '@space');
  assert.equal(markedText(1), 'Marked as done');
  assert.equal(markedText(3), 'Marked 3 notes as done');
});

test('every tab has an empty state; Unread only turns it into the good kind', () => {
  for (const tab of ['all', 'critical', 'action', 'fyi'] as const) {
    const clear = emptyCopy(tab, true);
    const plain = emptyCopy(tab, false);
    assert.equal(clear.tone, 'clear', tab);
    assert.equal(plain.tone, 'neutral', tab);
    assert.ok(clear.title && clear.note && plain.title && plain.note, tab);
  }
  assert.equal(emptyCopy('all', true).title, 'All clear');
});

test('techLines aligns key and value and shows the five facts of the spec', () => {
  const out = techLines({ id: 5213, kind: 'series_missed', severity: 'action', refType: 'resource_day', refId: 'telegram:@x|2026-10-29#ab', createdAt: '2026-10-29T12:09:52.026Z' });
  const lines = out.split('\n');
  assert.deepEqual(lines.map((l) => l.split(/\s{2,}/)[0]), ['id', 'kind', 'severity', 'refType', 'refId', 'createdAt']);
  assert.ok(lines.every((l) => /^\S+\s+/.exec(l)![0].length === 'createdAt'.length + 2), 'values start in one column');
  assert.match(techLines({ id: 1, kind: 'k', severity: 'info', refType: null, refId: null, createdAt: 'x', subject: 'resource:x' }), /subject\s+resource:x/);
  assert.match(techLines({ id: 1, kind: 'k', severity: 'info', refType: null, refId: null, createdAt: 'x' }), /refType\s+—/);
});

// ── the links the old page had still lead somewhere ─────────────────────────

const TREE: TreeNode[] = [{
  id: 'm1', handle: 'manager', kind: 'manager', scopeId: null, children: [
    { id: 'o1', handle: 'space', kind: 'orchestrator', scopeId: 'telegram:@space', children: [] },
  ],
}];

/** The page links of a note's plan (primary, secondary, extras). */
function planLinks(it: NoteItem): Array<{ to: string; params?: Record<string, string>; search?: Record<string, unknown> }> {
  const p = planNote(it, { tree: TREE });
  return [p.primary, p.secondary, ...p.extra].flatMap((s) => (s && s.type === 'link' ? [s.link] : []));
}

test('the old InboxLinks all survive as steps of NoteActions', () => {
  const base = { agentId: 'o1', body: null, severity: 'info' as const, readAt: null };
  const skill = planLinks({ ...base, id: 1, kind: 'skill_self_edit', title: 't', refType: 'skill', refId: 's1' });
  assert.ok(skill.some((l) => l.to === '/app/agents/$handle' && l.params?.handle === 'space' && l.search?.tab === 'skills'), 'Open skills');

  const auto = planLinks({ ...base, id: 2, kind: 'ready_for_autonomy', title: 't', refType: 'channel', refId: '@space' });
  assert.ok(auto.some((l) => l.to === '/app/agents/$handle' && l.params?.handle === 'space'), 'Review and switch');

  const loadout = planLinks({ ...base, id: 3, kind: 'loadout_suggestions', title: 't', refType: 'loadout', refId: '2026-W43' });
  assert.ok(loadout.some((l) => l.search?.tab === 'loadout'), 'Open loadout');

  const lead = planLinks({ ...base, id: 4, kind: 'landing_lead', title: 't', refType: 'landing_lead', refId: 'l1', severity: 'action' });
  assert.ok(lead.some((l) => l.to === '/app/landing' && l.search?.tab === 'leads'), 'Open leads');

  for (const kind of ['directive_contested', 'directive_ignored', 'directive_failed', 'directive_expired', 'directive_structural']) {
    const d = planLinks({ ...base, id: 5, kind, title: 't', refType: 'directive', refId: 'd1', severity: 'action' });
    assert.ok(d.some((l) => l.params?.handle === 'manager' && l.search?.tab === 'directives' && l.search?.directive === 'd1'), kind);
  }

  const fx = planLinks({ ...base, id: 6, kind: 'resource_resumed', title: 't', refType: 'resource', refId: 'instagram:x' });
  assert.ok(fx.some((l) => l.to === '/app/agents/$handle' && l.params?.handle === 'space'), 'Open active effects');

  const audit = planLinks({ ...base, id: 7, kind: 'audit_report', title: 't', refType: 'audit', refId: 'a1', severity: 'action' });
  assert.ok(audit.some((l) => l.to === '/app/artifacts' && l.search?.open === 'audit:a1'), 'Open audit report');
});
