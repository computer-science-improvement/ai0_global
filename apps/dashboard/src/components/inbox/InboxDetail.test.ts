// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B2: the Inbox list and detail render (server-side, no browser). The clicks, the sheet and the sticky pane are
// checked by hand in the browser (tasks.md); this pins what each state shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { InboxList } from './InboxList';
import { InboxDetail } from './InboxDetail';
import { ConfirmProvider } from '../ui/ConfirmDialog';
import { groupBySubject, singleRows } from '../../lib/inbox-view';
import type { AgentNode, InboxItem } from '../../api/agents';

const agent = (over: Partial<AgentNode> & { id: string; handle: string }): AgentNode => ({
  kind: 'orchestrator', scope: 'resource', scopeId: null, parentId: null, name: over.handle, emoji: null, description: null, mode: 'approve',
  status: 'active', pausedUntil: null, model: null, reasoningEffort: null, activity: null, paused: false, children: [], ...over,
} as unknown as AgentNode);

const SPACE = agent({ id: 'o1', handle: 'space', name: 'Space', emoji: '🚀', scopeId: 'telegram:@space' });

const note = (over: Partial<InboxItem> & { id: number }): InboxItem => ({
  agentId: 'o1', kind: 'skill_self_edit', title: 'Space edited a skill', body: 'The skill "daily facts" changed.\n\nIt now asks for sources.',
  refType: 'skill', refId: 's1', severity: 'info', readAt: null, createdAt: '2026-10-29T10:00:00Z', ...over,
});

async function render(node: () => ReactElement): Promise<string> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['agents', 'tree'], { agents: [SPACE] });
  const root = createRootRoute({ component: () => h(QueryClientProvider, { client: qc }, h(ConfirmProvider, null, node())) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(h(RouterProvider, { router }));
}

const noop = () => {};
const detail = (item: InboxItem, over: Partial<Parameters<typeof InboxDetail>[0]> = {}) =>
  h(InboxDetail, { item, group: singleRows([item])[0], agent: SPACE, tree: [SPACE], variant: 'pane', busy: false, onMarkDone: noop, onMarkUnread: noop, onGotIt: noop, onPick: noop, ...over });
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, ''));

// ── list ────────────────────────────────────────────────────────────────────

test('the list: a severity mark, the title, who and kind, the age; the selected row is current', async () => {
  const a = note({ id: 1, severity: 'critical', kind: 'resource_health', title: 'Threads token is invalid' });
  const b = note({ id: 2, title: 'Series missed', kind: 'series_missed', agentId: null, severity: 'action', readAt: '2026-10-29T11:00:00Z' });
  const groups = singleRows([a, b]);
  const html = await render(() => h(InboxList, {
    groups, selectedKey: groups[0].key, onSelect: noop, showUnreadDot: true, popup: false, whoOf: (it) => (it.agentId ? '🚀 @space' : null),
  }));
  assert.match(html, /aria-label="Inbox notes"/);
  assert.match(html, /Threads token is invalid/);
  assert.match(html, /🚀 @space · resource_health/);
  assert.match(html, /severity-mark is-critical/);
  assert.match(html, /severity-mark is-action/);
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.match(html, /inbox-row is-selected"? ?[^>]*aria-current|is-selected[^>]*aria-current/);
  // a read row is quiet and has no unread dot; the unread one has it
  assert.equal((html.match(/inbox-unread-dot/g) ?? []).length, 1);
  assert.match(html, /panel-row inbox-row is-read/);
  assert.doesNotMatch(html, /aria-haspopup/);
});

test('the list: repeats of one problem are one row with a count; rows open a dialog on a narrow screen', async () => {
  const items = [
    note({ id: 3, subject: 'resource:threads:a', title: 'Threads token is invalid' }),
    note({ id: 2, subject: 'resource:threads:a', title: 'Threads token is expiring' }),
    note({ id: 1, subject: null, title: 'Other' }),
  ];
  const groups = groupBySubject(items);
  const html = await render(() => h(InboxList, { groups, selectedKey: null, onSelect: noop, showUnreadDot: false, popup: true, whoOf: () => null }));
  assert.equal(groups.length, 2);
  assert.match(html, /x2/);
  assert.doesNotMatch(html, /Threads token is expiring/);
  assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /inbox-unread-dot/);
  assert.doesNotMatch(html, /aria-current/);
});

// ── detail ──────────────────────────────────────────────────────────────────

test('the detail pane: severity, kind, who, title, What happened, Why it matters, Technical details closed', async () => {
  const html = await render(() => detail(note({ id: 5, severity: 'action', kind: 'directive_structural', refType: 'directive', refId: 'd1', title: 'Approve this change?' })));
  assert.match(html, /class="sev sev-action"/);
  assert.match(html, /directive_structural/);
  assert.match(html, /🚀 Space · @space/);
  assert.match(html, /<h2[^>]*class="inbox-detail-title"[^>]*>Approve this change\?<\/h2>/);
  assert.match(html, /What happened/);
  assert.match(html, /The skill &quot;daily facts&quot; changed\./);
  assert.match(html, /Why it matters/);
  assert.match(html, /waits for your yes/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /createdAt/);
  assert.doesNotMatch(html, /<details/);
  // a decision note: its own buttons, then a quiet Mark as done
  const b = buttons(html);
  assert.deepEqual(b.filter((x) => x === 'Approve' || x === 'Decline' || x === 'Mark as done'), ['Approve', 'Decline', 'Mark as done']);
});

test('the detail: a note whose plan already has "Got it" gets no second button for the same thing', async () => {
  const html = await render(() => detail(note({ id: 6, kind: 'resource_health_ok', refType: 'resource', refId: 'facebook:f1', title: 'Facebook works again' })));
  const b = buttons(html);
  assert.ok(b.includes('Got it'));
  assert.ok(!b.includes('Mark as done'));
});

test('the detail: a read note offers Mark as unread and no decisions', async () => {
  const html = await render(() => detail(note({ id: 7, severity: 'action', kind: 'directive_structural', refType: 'directive', refId: 'd1', readAt: '2026-10-29T11:00:00Z' })));
  const b = buttons(html);
  assert.ok(b.includes('Mark as unread'));
  assert.ok(!b.includes('Approve') && !b.includes('Decline') && !b.includes('Mark as done'));
  assert.match(html, /Done/);
});

test('the detail in the sheet leaves the title to the dialog head', async () => {
  const html = await render(() => detail(note({ id: 8, title: 'A very long title' }), { variant: 'sheet' }));
  assert.doesNotMatch(html, /<h2/);
  assert.match(html, /What happened/);
});

test('the detail: earlier notes about the same problem are listed, the current one marked', async () => {
  const newer = note({ id: 10, subject: 'x', title: 'Newer', createdAt: '2026-10-29T12:00:00Z' });
  const older = note({ id: 9, subject: 'x', title: 'Older', createdAt: '2026-10-29T09:00:00Z', readAt: '2026-10-29T09:30:00Z' });
  const group = groupBySubject([newer, older])[0];
  const html = await render(() => detail(newer, { group }));
  assert.match(html, /Same problem, 2 notes/);
  assert.match(html, /Older/);
  assert.equal((html.match(/inbox-history-row/g) ?? []).length, 2);
  assert.equal((html.match(/inbox-history-row" aria-current="true"|aria-current="true" class="inbox-history-row"/g) ?? []).length, 1);
  // a single note has no history
  assert.doesNotMatch(await render(() => detail(newer)), /Same problem/);
});
