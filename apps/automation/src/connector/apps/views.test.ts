import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard, makeSpec } from '../../editor/post/testing/fixtures';
import { renderDraft } from '../../editor/chat/drafts.service';
import type { EditorDraft } from '../../editor/repo/editor-chat.repository';
import type { ConnectorTool } from '../types';
import { LEGACY_RESOURCE_URI_KEY, RESOURCE_MIME_TYPE, TOOL_VIEWS, UI_EXTENSION_ID, withApps, type ViewPorts } from './apps';
import { plainText } from './tg-markup';
import {
  CHAT_DRAFTS_MAX, VIEW_VERSION, channelView, chatView, draftIdsOf, messagesView, postViewOfCheck, postViewOfDraft, postViewOfSlot, scheduleView,
  type PostView,
} from './views';

const card = makeCard({ channelKey: '@chan', title: 'Interior ideas' });
const DRAFT_ID = '11111111-2222-4333-8444-555555555555';
const POST_ID = '99999999-8888-4777-8666-555555555555';

const slot = (over: Record<string, unknown> = {}): any => ({
  id: POST_ID, channelKey: '@chan', kind: 'content', status: 'awaiting_approval', scheduledAt: new Date('2026-11-13T18:00:00Z'), resourceRef: null,
  topic: 'Cozy loft', angle: 'warm light', format: 'photo', createdVia: null, lockedBy: null, scheduleRuleId: null, promo: null, slo: null,
  error: null, lintWarnings: ['caption_long: 900 chars'], critic: { verdict: 'pass', notes: 'fine', reason: 'r' }, postSpec: makeSpec(), ...over,
});
const draft = (over: Partial<EditorDraft> = {}): EditorDraft => ({
  id: DRAFT_ID, chatId: 'chat-1', channelKey: '@chan', spec: makeSpec({ title: 'Loft prompt' }), preview: 'p', lint: { ok: true, errors: [], warnings: [{ code: 'w1', message: 'watch out' }] },
  status: 'draft', scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: new Date('2026-11-13T09:00:00Z'), updatedAt: new Date('2026-11-13T09:00:00Z'),
  ...over,
});

test('spec 104: constants are the SDK\'s (MIME type, extension id, legacy key)', async () => {
  // The package is ESM with an exports map this tsconfig (node10 resolution) cannot type: load it untyped.
  const spec: string = '@modelcontextprotocol/ext-apps/server';
  const server = await import(spec) as { RESOURCE_MIME_TYPE: string; RESOURCE_URI_META_KEY: string; EXTENSION_ID: string };
  assert.equal(RESOURCE_MIME_TYPE, server.RESOURCE_MIME_TYPE);
  assert.equal(LEGACY_RESOURCE_URI_KEY, server.RESOURCE_URI_META_KEY);
  assert.equal(UI_EXTENSION_ID, server.EXTENSION_ID);
  assert.equal(VIEW_VERSION, 1);
});

test('messagesView: Telegram calls become view messages; captions are nodes, media and buttons are http(s) only', () => {
  const { messages, rich } = messagesView([
    { method: 'sendPhoto', photo: 'https://cdn.prompthero.com/a.jpg', caption: '<b>Prompt:</b> <pre><code>x</code></pre>', captionAboveMedia: false,
      buttons: [[{ text: 'Open', url: 'https://t.me/x' }, { text: 'bad', url: 'javascript:alert(1)' }]] },
    { method: 'sendMessage', text: 'hi', preview: { url: 'https://example.com', showAboveText: true }, buttons: [] },
    { method: 'sendMediaGroup', photos: ['https://a.test/1.jpg', 'javascript:x', 'data:image/png;base64,AA'], caption: 'album' },
    { method: 'sendPoll', question: 'Q?', options: ['a', 'b'], quiz: true, correctIndex: 5, explanation: null, anonymous: true },
    { method: 'deleteMessage', chat_id: 1 },
    { method: 'sendRichMessage', fallback: { method: 'sendMessage', text: '<i>rich</i>' } },
  ]);
  assert.equal(rich, true);
  assert.deepEqual(messages.map((m) => m.type), ['photo', 'text', 'album', 'poll', 'text'], 'unknown calls are left out');
  const photo = messages[0] as Extract<typeof messages[number], { type: 'photo' | 'video' }>;
  assert.equal(photo.media, 'https://cdn.prompthero.com/a.jpg');
  assert.deepEqual(photo.buttons, [[{ text: 'Open', url: 'https://t.me/x' }]]);
  assert.deepEqual(photo.caption[0], { t: 'b', c: [{ t: 'text', v: 'Prompt:' }] });
  assert.deepEqual((messages[1] as any).link, { url: 'https://example.com/', above: true });
  assert.deepEqual((messages[2] as any).photos, ['https://a.test/1.jpg']);
  assert.equal((messages[3] as any).correct, null, 'an out-of-range correct index is dropped');
  assert.equal(messagesView('not an array').messages.length, 0);
  assert.equal(messagesView(Array.from({ length: 20 }, () => ({ method: 'sendMessage', text: 'x' }))).messages.length, 6);
});

test('postViewOfSlot: stored render first, else the spec; status note, brief for a planned post, published link', () => {
  const stored = postViewOfSlot({ slot: slot({ renderMessages: { kind: 'telegram', primary: 0, messages: [{ method: 'sendMessage', text: 'STORED' }] } }), planDate: null, runs: [], published: null }, card);
  assert.equal(plainText((stored.messages[0] as any).text), 'STORED');
  assert.equal(stored.note, 'Waiting for approval. Nothing goes out until it is approved.');
  assert.deepEqual(stored.when, { at: '2026-11-13T18:00:00.000Z', local: '2026-11-13 20:00', tz: 'Europe/Kyiv' });
  assert.equal(stored.channel_title, 'Interior ideas');
  assert.deepEqual(stored.critic, { verdict: 'pass', notes: 'fine' });

  const fromSpec = postViewOfSlot({ slot: slot(), planDate: null, runs: [], published: { messageId: 42, postedAt: new Date() } }, card);
  assert.equal(fromSpec.messages[0].type, 'photo');
  assert.equal(fromSpec.link, 'https://t.me/chan/42');
  assert.deepEqual(fromSpec.warnings, ['caption_long: 900 chars']);

  const planned = postViewOfSlot({ slot: slot({ status: 'planned', postSpec: null, critic: null, lintWarnings: null }), planDate: null, runs: [], published: null }, null);
  assert.deepEqual(planned.brief, { topic: 'Cozy loft', angle: 'warm light' });
  assert.equal(planned.messages.length, 0);

  const failed = postViewOfSlot({ slot: slot({ status: 'skipped', error: 'connector: canceled by owner' }), planDate: null, runs: [], published: null }, card);
  assert.ok(failed.reason?.label);
  assert.equal(postViewOfSlot({ slot: slot({ createdVia: 'connector', lockedBy: 'connector' }), planDate: null, runs: [], published: null }, card).origin, 'connector');
});

test('postViewOfDraft and postViewOfCheck: a draft or a check is never presented as scheduled', () => {
  const d = postViewOfDraft(renderDraft(draft(), card), card);
  assert.equal(d.source, 'draft');
  assert.equal(d.status, 'draft');
  assert.match(d.note!, /nothing is published from here/);
  assert.deepEqual(d.warnings, ['w1: watch out']);
  assert.equal(d.messages[0].type, 'photo');
  assert.equal(d.when, null);
  const broken = postViewOfDraft(renderDraft(draft({ spec: { nope: 1 } }), card), card);
  assert.equal(broken.messages.length, 0, 'a spec that does not render draws no message');

  const ok = postViewOfCheck(card, makeSpec({ format: 'text', media: undefined }), { ok: true, errors: [], warnings: [] });
  assert.equal(ok.status, 'passes_checks');
  assert.equal(ok.id, null);
  assert.match(ok.note!, /nothing was saved/);
  const bad = postViewOfCheck(card, { nope: 1 }, { ok: false, errors: [{ code: 'invalid_post', message: 'format: Required' }] });
  assert.equal(bad.status, 'fails_checks');
  assert.deepEqual(bad.errors, ['invalid_post: format: Required']);
});

test('scheduleView and channelView read the text result; odd rows are left out', () => {
  const item = { post_id: POST_ID, channel: '@chan', at: '2026-11-13T18:00:00.000Z', local: '2026-11-13 20:00', tz: 'Europe/Kyiv', status: 'planned', title: 'T', format: 'photo', locked: true, needs_approval: true };
  const s = scheduleView({ hours: 24, items: [item, { nope: 1 }, 'x'], truncated: true }, '@chan');
  assert.equal(s.title, '@chan · next 24 h');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].locked, true);
  assert.equal(s.truncated, true);
  assert.equal(scheduleView({ items: [] }, null).title, 'All channels');
  const c = channelView({ channel: '@chan', title: 'Interior', mode: 'approve', tz: 'Europe/Kyiv', slo_today: { published: 1, target: 2, state: 'behind' }, open_problems: 3, next_posts: [item] });
  assert.deepEqual(c.today, { published: 1, target: 2, state: 'behind' });
  assert.equal(c.problems, 3);
  assert.equal(c.items.length, 1);
});

test('chatView: messages, cards and the newest drafts drawn; the rest counted', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `d${i}`);
  const result = {
    chat_id: 'c1', agent: 'prompts', running: false, cards_waiting: 1,
    messages: [
      { id: 1, agent: 'prompts', text: 'first', at: '2026-11-13T09:00:00.000Z', cards: [], drafts: ids.slice(0, 3).map((id) => ({ id })) },
      { id: 2, agent: 'prompts', text: 'second', at: '2026-11-13T09:05:00.000Z', cards: [{ id: 'k', kind: 'write_skill', status: 'pending', summary: 's' }], drafts: ids.slice(3).map((id) => ({ id })) },
    ],
  };
  const newest = draftIdsOf(result);
  assert.deepEqual(newest, ['d3', 'd4', 'd5', 'd0'].slice(0, CHAT_DRAFTS_MAX));
  const drawn = new Map<string, PostView>(newest.map((id) => [id, { ...postViewOfDraft(renderDraft(draft({ id }), card), card) }]));
  const v = chatView(result, drawn);
  assert.equal(v.messages[1].cards[0].kind, 'write_skill');
  assert.equal(v.messages[1].drafts.length, 3);
  assert.equal(v.more_drafts, 2);
  assert.equal(v.cards_waiting, 1);
});

// ── tool wiring ─────────────────────────────────────────────────────────────

const tool = (name: string): ConnectorTool => ({ name, title: name, description: 'd', inputSchema: { type: 'object' }, scope: 'mcp:read', call: async () => ({}) });

function ports(over: Partial<ViewPorts> = {}): ViewPorts & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    card: async (k) => { seen.push(`card:${k}`); return k === '@chan' ? card : null; },
    slotDetail: async (id) => { seen.push(`slot:${id}`); return id === POST_ID ? { slot: slot(), planDate: null, runs: [], published: null } : null; },
    draft: async (id) => { seen.push(`draft:${id}`); return id === DRAFT_ID ? renderDraft(draft(), card) : null; },
    ...over,
  };
}

test('withApps: every tool is model-only; the preview tools name the view (both keys) and build {ai0_view, view}', async () => {
  const uri = 'ui://ai0/preview-abc.html';
  const names = ['list_channels', ...Object.keys(TOOL_VIEWS)];
  const out = withApps(names.map(tool), ports(), uri);
  for (const t of out) {
    const ui = (t._meta as any).ui;
    assert.deepEqual(ui.visibility, ['model'], t.name);
    if (t.name === 'list_channels') {
      assert.equal(ui.resourceUri, undefined);
      assert.equal(t.view, undefined);
    } else {
      assert.equal(ui.resourceUri, uri, t.name);
      assert.equal((t._meta as any)[LEGACY_RESOURCE_URI_KEY], uri, t.name);
      assert.equal(typeof t.view, 'function', t.name);
    }
  }
  assert.deepEqual(Object.keys(TOOL_VIEWS).sort(), ['check_post', 'get_channel', 'get_draft', 'get_post', 'list_schedule', 'plan_post', 'prepare_post', 'read_agent_chat', 'talk_to_agent', 'update_post']);
  const byName = new Map(out.map((t) => [t.name, t]));
  const getPost: any = await byName.get('get_post')!.view!({ post_id: POST_ID }, { post_id: POST_ID });
  assert.equal(getPost.ai0_view, 1);
  assert.equal(getPost.view.kind, 'post');
  assert.equal(getPost.view.id, POST_ID);
  const getDraft: any = await byName.get('get_draft')!.view!({}, { draft_id: DRAFT_ID });
  assert.equal(getDraft.view.source, 'draft');
  const check: any = await byName.get('check_post')!.view!({ post: makeSpec() }, { channel: '@chan', ok: true, errors: [], warnings: [] });
  assert.equal(check.view.source, 'check');
  const sched: any = await byName.get('list_schedule')!.view!({ channel: '@chan' }, { hours: 48, items: [] });
  assert.equal(sched.view.title, '@chan · next 48 h');
  const chat: any = await byName.get('read_agent_chat')!.view!({}, { chat_id: 'c', messages: [{ id: 1, text: 'x', drafts: [{ id: DRAFT_ID }, { id: 'not-a-uuid' }] }] });
  assert.equal(chat.view.messages[0].drafts[0].id, DRAFT_ID);
  assert.equal(chat.view.more_drafts, 1);
});

test('withApps views: no view for a missing post, a non-uuid id or a channel without a card; nothing is looked up by a bad id', async () => {
  const p = ports();
  const byName = new Map(withApps(Object.keys(TOOL_VIEWS).map(tool), p, 'ui://ai0/preview.html').map((t) => [t.name, t]));
  assert.equal(await byName.get('get_post')!.view!({}, { post_id: 'nope' }), null);
  assert.equal(await byName.get('get_post')!.view!({}, { post_id: '00000000-0000-4000-8000-000000000000' }), null);
  assert.equal(await byName.get('get_draft')!.view!({}, { draft_id: "' or 1=1 --" }), null);
  assert.equal(await byName.get('check_post')!.view!({ post: {} }, { channel: '@other' }), null);
  assert.equal(await byName.get('prepare_post')!.view!({}, 'not an object'), null);
  assert.ok(!p.seen.some((s) => s.includes('nope') || s.includes('or 1=1')), 'bad ids never reach a query');
  const noDrafts = new Map(withApps([tool('get_draft')], ports({ draft: undefined }), 'u').map((t) => [t.name, t]));
  assert.equal(await noDrafts.get('get_draft')!.view!({}, { draft_id: DRAFT_ID }), null);
});
