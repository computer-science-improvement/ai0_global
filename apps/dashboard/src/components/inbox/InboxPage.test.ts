// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B2: the Inbox page renders (server-side, from a seeded query cache, no browser): which tab a URL opens, what each
// tab lists, the counts, the selected note and the empty states. Clicks, the sheet and Undo are checked in the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { InboxPage } from './InboxPage';
import { ConfirmProvider } from '../ui/ConfirmDialog';
import type { InboxSearch } from '../../lib/inbox-view';
import type { AgentNode, InboxItem } from '../../api/agents';

const agent = (over: Partial<AgentNode> & { id: string; handle: string }): AgentNode => ({
  kind: 'orchestrator', scope: 'resource', scopeId: null, parentId: null, name: over.handle, emoji: null, description: null, mode: 'approve',
  status: 'active', pausedUntil: null, model: null, reasoningEffort: null, activity: null, paused: false, children: [], ...over,
} as unknown as AgentNode);

const TREE = [agent({ id: 'o1', handle: 'space', name: 'Space', emoji: '🚀', scopeId: 'telegram:@space' })];

const note = (id: number, over: Partial<InboxItem> = {}): InboxItem => ({
  id, agentId: 'o1', kind: 'series_missed', title: `Note ${id}`, body: `Body of note ${id}`, refType: 'resource_day', refId: 'telegram:@space|2026-10-29#ab',
  severity: 'action', readAt: null, createdAt: `2026-10-29T${String(20 - (id % 20)).padStart(2, '0')}:00:00Z`, ...over,
});

const READ = '2026-10-29T21:00:00Z';
const UNREAD_LIST = [
  note(1, { severity: 'critical', kind: 'resource_health', title: 'Threads token is invalid', refType: 'resource', refId: 'threads:t1', agentId: null }),
  note(2), note(3), note(4, { severity: 'info', kind: 'skill_self_edit', refType: 'skill', refId: 's1', title: 'Skill edited' }),
];
const ALL_LIST = [...UNREAD_LIST, note(5, { readAt: READ, title: 'Old decided note' }), note(6, { readAt: READ, severity: 'info', kind: 'resource_health_ok', title: 'Back online' })];

/** `broken`: the inbox endpoint answers 404 (a server without it): the queries are in the error state. */
async function page(search: InboxSearch, o: { unread?: InboxItem[]; all?: InboxItem[]; waiting?: number; broken?: boolean } = {}): Promise<string> {
  // retryOnMount off: a query in the error state stays in it while rendering (the browser would try again).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  qc.setQueryData(['agents', 'tree'], { agents: TREE });
  if (o.broken) {
    for (const flag of [true, false]) {
      qc.getQueryCache().build(qc, { queryKey: ['agents', 'inbox', flag] }).setState({
        status: 'error', error: new Error('{"error":"not_found"}'), errorUpdateCount: 1, fetchStatus: 'idle',
      });
    }
  } else {
    qc.setQueryData(['agents', 'inbox', true], { items: o.unread ?? UNREAD_LIST });
    qc.setQueryData(['agents', 'inbox', false], { items: o.all ?? ALL_LIST });
  }
  qc.setQueryData(['approvals', 'count'], { waiting: o.waiting ?? 0 });
  const root = createRootRoute({
    component: () => h(QueryClientProvider, { client: qc }, h(ConfirmProvider, null, h(InboxPage, { search, onNavigate: () => {} }))),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(h(RouterProvider, { router }));
}

const selectedTab = (html: string) => /<button[^>]*aria-selected="true"[^>]*>(.*?)<\/button>/.exec(html)?.[1].replace(/<[^>]*>/g, '') ?? null;
const rowTitles = (html: string) => [...html.matchAll(/inbox-row-title clamp">(.*?)<\/span>/g)].map((m) => m[1]);
const unreadSwitch = (html: string) => /<button[^>]*aria-pressed="(true|false)"[^>]*>Unread only<\/button>/.exec(html)?.[1] ?? null;
const paneTitle = (html: string) => /<h2[^>]*class="inbox-detail-title"[^>]*>(.*?)<\/h2>/.exec(html)?.[1] ?? null;

test('a bare URL opens All with Unread only on, counts on the tabs, and the first note open', async () => {
  const html = await page({}, { waiting: 3 });
  assert.match(html, /<h1[^>]*>Inbox<\/h1>/);
  assert.equal(selectedTab(html), 'All4');
  assert.equal(unreadSwitch(html), 'true');
  assert.ok(rowTitles(html).includes('Threads token is invalid'));
  assert.equal(rowTitles(html).length, 4);
  assert.match(html, /To approve<span[^>]*>3<\/span>/);
  assert.match(html, /Critical<span[^>]*>1<\/span>/);
  assert.match(html, /Action<span[^>]*>2<\/span>/);
  assert.match(html, /FYI<span[^>]*>1<\/span>/);
  assert.match(html, /aria-label="Selected note"/);
  assert.ok(paneTitle(html));
});

test('a bare URL with nothing unread but posts waiting opens To approve', async () => {
  const html = await page({}, { unread: [], waiting: 2 });
  assert.equal(selectedTab(html), 'To approve2');
  assert.equal(unreadSwitch(html), null);
  assert.match(html, /Posts to approve/);
});

test('a bare URL with nothing unread and nothing waiting is the good kind of empty', async () => {
  const html = await page({}, { unread: [], waiting: 0 });
  assert.equal(selectedTab(html), 'All0');
  assert.match(html, /All clear/);
  assert.match(html, /is-clear/);
  assert.doesNotMatch(html, /Selected note/);
});

test('legacy ?tab=unread is All with Unread only on; legacy ?tab=all is every note', async () => {
  const unread = await page({ tab: 'unread' });
  assert.equal(selectedTab(unread), 'All4');
  assert.equal(unreadSwitch(unread), 'true');
  assert.equal(rowTitles(unread).length, 4);
  const all = await page({ tab: 'all' });
  assert.equal(selectedTab(all), 'All6');
  assert.equal(unreadSwitch(all), 'false');
  assert.equal(rowTitles(all).length, 6);
  assert.match(all, /Old decided note/);
  // read rows carry the unread dot logic: only the four unread ones have a dot
  assert.equal((all.match(/inbox-unread-dot/g) ?? []).length, 4);
});

test('?tab=approvals shows the posts; the notes controls are gone', async () => {
  const html = await page({ tab: 'approvals' }, { waiting: 1 });
  assert.equal(selectedTab(html), 'To approve1');
  assert.equal(unreadSwitch(html), null);
  assert.doesNotMatch(html, /inbox-split/);
});

test('a severity tab lists its notes only; with Unread only off it adds the read ones', async () => {
  const crit = await page({ tab: 'critical' });
  assert.equal(selectedTab(crit), 'Critical1');
  assert.deepEqual(rowTitles(crit), ['Threads token is invalid']);
  const fyiRead = await page({ tab: 'fyi', unread: false });
  assert.equal(selectedTab(fyiRead), 'FYI2');
  assert.deepEqual(rowTitles(fyiRead).sort(), ['Back online', 'Skill edited']);
  assert.equal(unreadSwitch(fyiRead), 'false');
});

test('?note= opens that note in the pane; a note that is not in the list falls back to the first row', async () => {
  const html = await page({ tab: 'all', unread: true, note: 3 });
  assert.equal(paneTitle(html), 'Note 3');
  assert.match(html, /Body of note 3/);
  assert.match(html, /is-selected/);
  const gone = await page({ tab: 'all', unread: true, note: 999 });
  assert.ok(paneTitle(gone));
  assert.notEqual(paneTitle(gone), 'Note 999');
});

test('a deep link to a read note opens All with Unread only off, so the list holds it', async () => {
  const html = await page({ note: 5 });
  assert.equal(selectedTab(html), 'All6');
  assert.equal(unreadSwitch(html), 'false');
  assert.equal(paneTitle(html), 'Old decided note');
});

test('the All view collapses repeats of one problem into one row', async () => {
  const items = [note(1, { subject: 'resource:threads:a', title: 'Newest' }), note(2, { subject: 'resource:threads:a', title: 'Older', readAt: READ }), note(3, { title: 'Other' })];
  const all = await page({ tab: 'all', unread: false }, { all: items, unread: [items[0], items[2]] });
  assert.equal(rowTitles(all).length, 2);
  assert.match(all, /x2/);
  // the severity tabs list every note
  const action = await page({ tab: 'action', unread: false }, { all: items, unread: [items[0], items[2]] });
  assert.equal(rowTitles(action).length, 3);
});
