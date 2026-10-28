// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B4.2: PostComposer renders (server-side, no browser) in both layouts. The first paint is what the owner meets: a
// blank form shows no problems, the preselected channel is pressed, the hint under the buttons names the Kyiv time, "Ask the
// agent" is offered only when the Calendar passes it. The typing and the validation that follows are checked in the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { stubCss } from './stub-css.test';
import type { AskAgent } from './PostComposer';
import type { ScheduledPost } from '../../api/types';

stubCss();
const { PostComposer } = await import('./PostComposer');

const channel = (over: Record<string, unknown> = {}): any => ({ id: 'c1', channelKey: '@space', title: 'Space', username: 'space', isMine: true, botId: 'b1', ...over });

function render(props: Record<string, unknown>, channels = [channel(), channel({ id: 'c2', channelKey: '@food', title: 'Food', botId: null })]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['channels', 'mine', 1, '', undefined], { items: channels, total: channels.length });
  qc.setQueryData(['bots'], [{ id: 'b1', bot_id: '1', username: 'spacebot', is_default: true }]);
  return renderToString(h(QueryClientProvider, { client: qc }, h(PostComposer as any, { onDone: () => {}, ...props })));
}

const ASK: AskAgent = {
  unavailable: () => null, zone: () => 'Europe/Kyiv', hint: () => 'The agent writes it at 12:00 Kyiv.', submit: async () => {},
};

test('drawer: a blank form shows no problems; the channels are toggle chips and the preselected one is pressed', () => {
  const html = render({ variant: 'drawer', initial: { channelId: 'c1', scheduledAt: '2030-01-15T10:00:00.000Z' } });
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /aria-invalid/);
  assert.ok(html.includes('<button type="button" class="chip-toggle" aria-pressed="true" title="@space">Space</button>'));
  assert.ok(html.includes('<button type="button" class="chip-toggle" aria-pressed="false" title="@food">Food</button>'));
  assert.match(html, /<label[^>]*for="pc-text"[^>]*>Post text<\/label>/);
  assert.match(html, /<label[^>]*for="pc-day"[^>]*>Day<\/label>/);
  assert.match(html, /<label[^>]*for="pc-time"[^>]*>Time, Kyiv<\/label>/);
  assert.match(html, /type="date"/);
  assert.ok(html.includes('type="time" value="12:00"'));                                  // 10:00Z is 12:00 in Kyiv (UTC+2 in January)
  assert.match(html, /Goes out at 12:00 Kyiv on Tue, 15 Jan/);
  assert.match(html, /aria-expanded="false"[^>]*aria-controls="pc-more"/);
  assert.match(html, /More options<\/button>/);
  assert.match(html, /class="btn-primary"[^>]*>Schedule</);
  assert.match(html, /class="btn-ghost"[^>]*>Cancel</);
  // the footer is a sibling of the body, so the sheet can stick it to the bottom
  assert.match(html, /^<div class="pc-body">[^]*<\/div><div class="modal-foot pc-foot">/);
});

test('drawer: "Ask the agent" is offered only when the Calendar passes it, and not when editing', () => {
  assert.doesNotMatch(render({ variant: 'drawer' }), /Who writes it/);
  const withAsk = render({ variant: 'drawer', ask: ASK });
  assert.match(withAsk, /Who writes it/);
  assert.match(withAsk, /role="tab"[^>]*aria-selected="true"[^>]*>I’ll write it</);
  assert.match(withAsk, /Ask the agent/);
  const post: ScheduledPost = {
    id: 'p1', channelId: 'c1', sender: 'bot', botId: 'b1', text: 'Hello', mediaType: 'none', mediaUrl: null, mediaPlacement: 'above', buttons: [],
    scheduledAt: '2030-01-15T10:00:00.000Z', status: 'pending', messageId: null, error: null, createdAt: '', updatedAt: '',
  };
  const editing = render({ variant: 'drawer', ask: ASK, editing: post, footerExtra: h('button', { className: 'btn-ghost' }, 'Cancel post') });
  assert.doesNotMatch(editing, /Who writes it/);
  assert.match(editing, />Save changes</);
  assert.match(editing, />Cancel post</);
  assert.match(editing, /<textarea[^>]*>Hello<\/textarea>/);
});

test('drawer: a post with media opens "More options" so nothing the owner set is hidden', () => {
  const post: ScheduledPost = {
    id: 'p2', channelId: 'c1', sender: 'bot', botId: 'b1', text: 'Look', mediaType: 'photo', mediaUrl: 'https://x.test/a.jpg', mediaPlacement: 'above', buttons: [],
    scheduledAt: '2030-01-15T10:00:00.000Z', status: 'pending', messageId: null, error: null, createdAt: '', updatedAt: '',
  };
  const html = render({ variant: 'drawer', editing: post });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /value="https:\/\/x\.test\/a\.jpg"/);
});

test('page: the /app/compose layout keeps its datetime field and shows no problems before the first submit', () => {
  const html = render({ variant: 'page' });
  assert.match(html, /type="datetime-local"/);
  assert.match(html, />Schedule</);
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /Preview/);
});
