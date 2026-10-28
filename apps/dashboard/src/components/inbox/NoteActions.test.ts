// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 A3: NoteActions renders (server-side, no browser) the buttons the kinds library plans for a note. The clicks are
// checked by hand in the browser (tasks.md); this pins that the component mounts with its hooks and shows the right steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { NoteActions } from './NoteActions';
import { ConfirmProvider } from '../ui/ConfirmDialog';
import type { AgentNode, InboxItem } from '../../api/agents';

const PAUSE = '0f6a2b6e-1111-4222-8333-444455556666';

const agent = (over: Partial<AgentNode> & { id: string; handle: string }): AgentNode => ({
  kind: 'orchestrator', scope: 'resource', scopeId: null, parentId: null, name: over.handle, emoji: null, description: null, mode: 'approve',
  status: 'active', pausedUntil: null, model: null, reasoningEffort: null, activity: null, paused: false, children: [], ...over,
} as unknown as AgentNode);

const TREE = [agent({ id: 'o1', handle: 'space', scopeId: 'telegram:@space' })];

const note = (over: Partial<InboxItem> & { kind: string }): InboxItem => ({
  id: 7, agentId: null, title: 'Title', body: null, refType: null, refId: null, severity: 'action', readAt: null,
  createdAt: '2026-10-28T10:00:00Z', ...over,
});

async function render(item: InboxItem, size: 'sm' | 'md' = 'md', agents: AgentNode[] | undefined = TREE): Promise<string> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (agents) qc.setQueryData(['agents', 'tree'], { agents });
  const root = createRootRoute({
    component: () => h(QueryClientProvider, { client: qc }, h(ConfirmProvider, null, h(NoteActions, { item, size }))),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(h(RouterProvider, { router }));
}

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1].replace(/&amp;/g, '&'), m[2]]);

test('a paused series: its stored Resume and Keep paused, then a quiet link to the agent', async () => {
  const html = await render(note({
    kind: 'series_paused', agentId: 'o1', refType: 'series_pause', refId: PAUSE,
    actions: [
      { key: `resume:${PAUSE}`, type: 'resume', label: 'Resume', target: { pauseId: PAUSE } },
      { key: `keep:${PAUSE}`, type: 'keep', label: 'Keep paused', target: { pauseId: PAUSE } },
    ],
  }));
  assert.deepEqual(buttons(html), ['Resume', 'Keep paused']);
  assert.deepEqual(links(html), [['/app/agents/space', 'Open active effects']]);
  assert.match(html, /class="btn-primary"/);
  assert.match(html, /class="btn-secondary"/);
});

test('a broken Instagram account: Reconnect is a link into the Meta section', async () => {
  const html = await render(note({ kind: 'resource_health', severity: 'critical', refType: 'resource', refId: 'instagram:u1', parts: ['state:token_invalid'] }));
  assert.deepEqual(buttons(html), []);
  assert.deepEqual(links(html), [['/app/connections?section=meta&tab=instagram', 'Reconnect']]);
});

test('an unknown kind is a single "Got it"', async () => {
  const html = await render(note({ kind: 'something_new', severity: 'info' }));
  assert.deepEqual(buttons(html), ['Got it']);
  assert.deepEqual(links(html), []);
});

test('without the agent tree (not loaded, or the endpoint failed) the note still offers what needs no handle', async () => {
  const html = await render(note({ kind: 'shadow_ended', refType: 'agent', refId: 'space' }), 'md', undefined);
  assert.deepEqual(buttons(html), ['Choose mode']);
  const bare = await render(note({ kind: 'series_paused', refType: 'series_pause', refId: PAUSE }), 'md', undefined);
  assert.deepEqual(buttons(bare), ['Got it']);
});

test('a note that is already read shows its links only; nothing at all when it has none', async () => {
  const read = '2026-10-28T11:00:00Z';
  const withLink = await render(note({ kind: 'resource_health', refType: 'resource', refId: 'instagram:u1', parts: ['state:token_invalid'], readAt: read }));
  assert.deepEqual(buttons(withLink), []);
  assert.match(withLink, /class="btn-secondary"/);
  assert.equal((await render(note({ kind: 'something_new', readAt: read }))).replace(/<!--.*?-->/g, ''), '');
  const decision = await render(note({ kind: 'directive_structural', refType: 'directive', refId: 'd1', readAt: read }));
  assert.deepEqual(buttons(decision), []);
  assert.deepEqual(links(decision), [['/app/agents/manager?tab=directives&directive=d1', 'Open directive']]);
});

test('sm is the compact size for rows', async () => {
  const sm = await render(note({ kind: 'something_new' }), 'sm');
  const md = await render(note({ kind: 'something_new' }), 'md');
  assert.match(sm, /padding:6px 12px/);
  assert.doesNotMatch(md, /padding:6px 12px/);
});
