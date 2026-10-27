/**
 * Spec 069 FR-007 (chat side): what the chat's agent read is kept per chat, in memory, and a chat draft is linted against it
 * (`origin_mismatch`). Executor runs have the critic gate for this; the chat had no sources at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool } from '../harness/tool';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { EditorDraft } from '../repo/editor-chat.repository';
import { buildComposeTools } from '../tools/compose-tools';
import { CAPTURED_TOOLS, ChatReadCapture, readsOf } from './chat-reads';
import { DraftsService, type DraftsDeps } from './drafts.service';
import { TurnRecorder } from './turn-record';

const READ = 'Телескоп Вебб показав туманність Кільце: оболонки газу, які зоря скинула тисячі років тому, світяться в інфрачервоному діапазоні яскравіше за саму зорю, і це видно навіть на оглядовому знімку.';
const COPY = 'оболонки газу, які зоря скинула тисячі років тому, світяться в інфрачервоному діапазоні яскравіше';
const copied = () => makeSpec({ origin: 'original', source: undefined, body: [{ type: 'lead', text: 'Нова туманність' }, { type: 'p', text: COPY }] });

// ── the store ───────────────────────────────────────────────────────────────

test('the capture keeps what a chat read, newest first; the same url is replaced; an unknown chat or no chat has nothing', () => {
  const c = new ChatReadCapture();
  c.add('c1', { url: 'https://a.example/1', text: 'one' });
  c.add('c1', { url: 'https://a.example/2', text: 'two' });
  c.add('c2', { url: 'https://a.example/3', text: 'three' });
  c.add('c1', { url: 'https://a.example/1', text: 'one again' });
  assert.deepEqual(c.sourcesFor('c1').map((s) => [s.url, s.text]), [['https://a.example/1', 'one again'], ['https://a.example/2', 'two']]);
  assert.deepEqual(c.sourcesFor('c2').map((s) => s.url), ['https://a.example/3']);
  assert.deepEqual(c.sourcesFor('nope'), []);
  assert.deepEqual(c.sourcesFor(null), []);
  c.add(null, { url: 'u', text: 'x' }); c.add('c1', { url: 'u', text: '   ' });
  assert.equal(c.size(), 2, 'no chat id and no text are not kept');
  // Only url + text: the image and date checks stay off for chat drafts.
  assert.deepEqual(Object.keys(c.sourcesFor('c2')[0]).sort(), ['text', 'url']);
});

test('a source falls out after 6 hours; the store is capped per chat and in chats', () => {
  let now = 1_000_000;
  const c = new ChatReadCapture({ now: () => now, maxSources: 3, maxChats: 2 });
  c.add('c1', { url: 'a', text: 'a' });
  now += 5 * 3_600_000;
  assert.equal(c.sourcesFor('c1').length, 1);
  now += 2 * 3_600_000;
  assert.deepEqual(c.sourcesFor('c1'), [], 'older than 6 h');
  for (const u of ['1', '2', '3', '4']) c.add('c3', { url: u, text: u });
  assert.deepEqual(c.sourcesFor('c3').map((s) => s.url), ['4', '3', '2'], 'the oldest read falls out');
  now += 1000; c.add('c4', { url: 'x', text: 'x' });
  now += 1000; c.add('c5', { url: 'y', text: 'y' });
  assert.equal(c.size(), 2);
  assert.deepEqual(c.sourcesFor('c3'), [], 'the least recent chat is dropped');
  assert.equal(c.sourcesFor('c5').length, 1);
});

test('a page text is capped', () => {
  const c = new ChatReadCapture();
  c.add('c1', { url: 'u', text: 'x'.repeat(200_000) });
  assert.equal(c.sourcesFor('c1')[0].text!.length, 60_000);
});

// ── what each read tool gives ───────────────────────────────────────────────

test('readsOf: the text of a page, a feed item, a document page, a find hit, a data row and a library item', () => {
  assert.deepEqual(readsOf('web_fetch', { url: 'https://a.example/x' }, { url: 'https://a.example/final', title: 'T', description: 'D', text: 'Body' }),
    [{ url: 'https://a.example/final', text: 'T\nD\nBody' }]);
  assert.deepEqual(readsOf('fetch_feed', {}, { items: [{ link: 'https://f.example/1', title: 'Title', snippet: 'Snip' }, { title: 'no link' }] }),
    [{ url: 'https://f.example/1', text: 'Title Snip' }]);
  assert.deepEqual(readsOf('read_doc', {}, { doc_id: 'doc1', from: 6000, text: 'Page text' }), [{ url: 'doc:doc1@6000', text: 'Page text' }]);
  assert.deepEqual(readsOf('find_in_doc', {}, { doc_id: 'doc1', matches: [{ offset: 120, snippet: 'around it' }] }), [{ url: 'doc:doc1@120', text: 'around it' }]);
  assert.deepEqual(readsOf('query_data', {}, { rows: [{ ref: 'data://prompts/7', prompt_text: 'A prompt', author: 'Ann', n: 3 }] }),
    [{ url: 'data://prompts/7', text: 'A prompt\nAnn' }]);
  assert.deepEqual(readsOf('search_library', {}, { items: [{ library_ref: 'library://recipes/5', title: 'Borsch', text: 'Boil', extra: { steps: 'Slice' } }] }),
    [{ url: 'library://recipes/5', text: 'Borsch\nBoil\nSlice' }]);
  assert.deepEqual(readsOf('web_fetch', { url: 'u' }, null), []);
  assert.deepEqual(readsOf('sql_readonly', {}, { rows: [{ a: 1 }] }), []);
  assert.deepEqual([...CAPTURED_TOOLS].sort(), ['fetch_feed', 'find_in_doc', 'query_data', 'read_doc', 'search_library', 'web_fetch']);
});

test('the turn recorder writes the read tools\' results to the capture under its chat — not errors, not other tools, not without a chat', async () => {
  const added: Array<[string, { url: string; text: string }]> = [];
  const reads = { add: (chat: string, s: { url: string; text: string }) => { added.push([chat, s]); } };
  const tool = (name: string, out: unknown) => defineTool({ name, description: name, kind: 'read', roles: ['composer'], input: z.object({}).passthrough(), execute: async () => out as any });
  const wrapped = new TurnRecorder({ reads, chatId: 'c9' }).wrap([
    tool('web_fetch', { url: 'https://a.example/p', title: 'T', text: 'Body' }),
    tool('query_data', { error: 'unknown_field' }),
    tool('sql_readonly', { rows: [{ text: 'not captured' }] }),
  ]);
  for (const t of wrapped) await t.execute({}, {} as any);
  assert.deepEqual(added, [['c9', { url: 'https://a.example/p', text: 'T\nBody' }]]);
  const none = new TurnRecorder({ reads }).wrap([tool('web_fetch', { url: 'https://a.example/p', text: 'Body' })]);
  await none[0].execute({}, {} as any);
  assert.equal(added.length, 1, 'a recorder without a chat id keeps nothing');
});

// ── the drafts service lints a chat draft against the capture ───────────────

function drafts(sources: () => Array<{ url: string; text?: string | null }>, asked: Array<string | null | undefined> = []) {
  const store = new Map<string, EditorDraft>();
  let n = 0;
  const card = makeCard({ channelKey: '@chan', mode: 'shadow' });
  const d = {
    pool: { query: async () => ({ rows: [] }) },
    repo: {
      insertDraft: async (x: any) => { const id = `d${++n}`; const dr = { id, chatId: x.chatId, channelKey: x.channelKey, spec: x.spec, preview: x.preview, lint: x.lint, status: 'draft', scheduledAt: null, slotId: null, publishedPostId: null, error: null } as unknown as EditorDraft; store.set(id, dr); return dr; },
      updateDraft: async (id: string, p: any) => { const next = { ...store.get(id), ...p } as EditorDraft; store.set(id, next); return next; },
      getDraft: async (id: string) => store.get(id) ?? null,
      findDraftBySlot: async () => null, listDrafts: async () => [...store.values()], myChannels: async () => [],
    },
    channels: { get: async () => card, insertIfMissing: async () => false },
    plans: { reserveSlot: async () => 'slot1', skipPlannedSlot: async () => null, updateSlot: async () => {}, sourceUsed: async () => false, insertPublication: async () => 1 },
    publisher: { send: async () => ({ messageIds: [1] }) },
    recordPublish: () => {}, isPaused: () => false, notify: async () => {},
    chatReads: { sourcesFor: (id: string | null | undefined) => { asked.push(id); return sources(); } },
    now: () => new Date('2026-10-27T09:00:00Z'),
  } as unknown as DraftsDeps;
  return new DraftsService(d);
}

test('save lints a chat draft against what that chat read: a copy labelled original is origin_mismatch', async () => {
  const asked: Array<string | null | undefined> = [];
  const svc = drafts(() => [{ url: 'library://prompts/7', text: READ }], asked);
  const r: any = await svc.save({ chatId: 'chat-1', channel: '@chan', spec: copied() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lint.errors.map((e: any) => e.code), ['origin_mismatch']);
  assert.deepEqual(asked, ['chat-1']);
  const fine: any = await svc.save({ chatId: 'chat-1', channel: '@chan', spec: makeSpec({ origin: 'library', source: undefined, library_ref: 'library://prompts/7', body: [{ type: 'lead', text: 'Нова туманність' }, { type: 'p', text: COPY }] }) });
  assert.equal(fine.lint.ok, true, JSON.stringify(fine.lint));
  const nothing = await drafts(() => []).save({ chatId: 'chat-1', channel: '@chan', spec: copied() }) as any;
  assert.equal(nothing.lint.ok, true, 'nothing read: nothing to compare with');
});

test('publish runs the same lint with the draft\'s chat: a draft saved before the read is stopped at publish', async () => {
  let read: Array<{ url: string; text?: string }> = [];
  const asked: Array<string | null | undefined> = [];
  const svc = drafts(() => read, asked);
  const saved: any = await svc.save({ chatId: 'chat-7', channel: '@chan', spec: copied() });
  assert.equal(saved.lint.ok, true);
  read = [{ url: 'https://nasa.gov/ring', text: READ }];
  const r: any = await svc.publish(saved.draft.id);
  assert.equal(r.error, 'lint_failed');
  assert.ok(r.details.some((e: any) => e.code === 'origin_mismatch'));
  assert.equal(asked.at(-1), 'chat-7');
});

test('lint_post and preview_post in the chat read the same capture through the turn\'s extras', async () => {
  const tools = Object.fromEntries(buildComposeTools().map((t) => [t.name, t])) as Record<string, any>;
  const ctx = (sources: Array<{ url: string; text: string }>) => ({ runId: 'r', role: 'composer', channelKey: null, extras: { card: makeCard(), chatSources: () => sources } }) as any;
  const spec = copied() as unknown as Record<string, unknown>;
  const withSource = await tools.lint_post.execute({ spec }, ctx([{ url: 'https://nasa.gov/ring', text: READ }]));
  assert.equal(withSource.error, 'lint_failed');
  assert.ok(withSource.errors.some((e: any) => e.code === 'origin_mismatch'));
  const without = await tools.lint_post.execute({ spec }, ctx([]));
  assert.equal(without.ok, true, JSON.stringify(without));
  const preview = await tools.preview_post.execute({ spec }, ctx([{ url: 'https://nasa.gov/ring', text: READ }]));
  assert.ok(preview.lint.errors.some((e: any) => e.code === 'origin_mismatch'));
});
