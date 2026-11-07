// Spec 090 FR-011 item 3: the closed set of note kinds posted as info (no Telegram card, no alert), pinned.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { INFO_ONLY_NOTE_KINDS, OwnerInbox, isInfoOnlyNote, setInboxCardSink } from './owner-inbox';

afterEach(() => setInboxCardSink(null));

test('the info-only set is pinned: adding or removing a kind is a reviewed decision', () => {
  assert.deepEqual([...INFO_ONLY_NOTE_KINDS].sort(), [
    'audit_report', 'dark_day', 'directive_failed', 'directive_ignored', 'directive_structural', 'escalation', 'event_not_covered', 'evergreen_fallback',
    'host_struck', 'loadout_suggestions', 'low_runway', 'playbook_pending', 'series_missed', 'series_paused',
  ]);
  // The FR-009 kinds that reach the owner on their own never join the set.
  for (const k of ['connection_broken', 'resource_health', 'budget_blocked', 'critic_failed']) assert.equal(isInfoOnlyNote(k), false, k);
});

function pool() {
  const inserted: unknown[][] = [];
  return {
    inserted,
    async query(text: string, params: unknown[] = []) {
      if (/INSERT INTO agent_inbox/.test(text)) { inserted.push(params); return { rows: [{ id: 100 + inserted.length }] }; }
      if (/UPDATE agent_inbox/.test(text)) return { rows: [] };
      throw new Error(`unexpected SQL: ${text}`);
    },
  } as any;
}

test('post: an info-only kind is stored as info and sends no alert, even critical and without the card sink', async () => {
  for (const kind of INFO_ONLY_NOTE_KINDS) {
    const p = pool();
    const alerts: string[] = [];
    await new OwnerInbox(p, async (t) => { alerts.push(t); }).post({ kind, severity: 'critical', title: 't' });
    assert.equal(p.inserted[0][6], 'info', kind);
    assert.deepEqual(alerts, [], kind);
  }
});

test('post: the card sink sees an info note for those kinds; other kinds keep severity and alert', async () => {
  const seen: Array<string | undefined> = [];
  setInboxCardSink(async (_id, i) => { seen.push(i.severity); return true; });
  await new OwnerInbox(pool()).post({ kind: 'low_runway', severity: 'action', title: 't' });
  assert.deepEqual(seen, ['info']);
  setInboxCardSink(null);

  const p = pool();
  const alerts: string[] = [];
  await new OwnerInbox(p, async (t) => { alerts.push(t); }).post({ kind: 'connection_broken', severity: 'critical', title: 'Broken' });
  assert.equal(p.inserted[0][6], 'critical');
  assert.equal(alerts.length, 1);
});

test('postOnce: the same rule for the once-per-day notes', async () => {
  const p = pool();
  const alerts: string[] = [];
  const id = await new OwnerInbox(p, async (t) => { alerts.push(t); }).postOnce({ kind: 'dark_day', severity: 'action', title: 'Dark', refType: 'resource_day', refId: 'telegram:@x|2026-10-22' });
  assert.equal(id, 101);
  assert.equal(p.inserted[0][6], 'info');
  assert.deepEqual(alerts, []);
});
