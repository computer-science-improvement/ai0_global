import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposerTools, ComposerExtras } from './composer-tools';
import { channelOf } from '../harness/tool';
import { makeCard, makeSpec } from '../post/testing/fixtures';

const UUID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-01T09:00:00Z');

function setup() {
  const calls: any[] = [];
  const draft = (status = 'draft') => ({ id: UUID, chatId: 'c1', channelKey: '@space', spec: makeSpec(), preview: 'p', lint: { ok: true, errors: [], warnings: [] }, status, scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: NOW, updatedAt: NOW }) as any;
  const card = makeCard({ channelKey: '@space' });
  const drafts: any = {
    save: async (i: any) => { calls.push(['save', i]); return i.channel === '@nope' ? { error: 'unknown_channel' } : { ok: true, draft: draft(), card, lint: { ok: true, errors: [], warnings: [] } }; },
    publish: async (id: string) => { calls.push(['publish', id]); return { ok: true, draft: draft('published'), messageId: 5, warnings: [] }; },
    schedule: async (id: string, at: Date) => { calls.push(['schedule', id, at.toISOString()]); return { ok: true, draft: draft('scheduled'), local: '2026-10-02 19:00 (Київ)' }; },
    cancel: async (id: string) => { calls.push(['cancel', id]); return { ok: true, draft: draft('canceled') }; },
    list: async (f: any) => { calls.push(['list', f]); return [draft('scheduled')]; },
  };
  const repo: any = { myChannels: async () => [{ channelKey: '@space', title: 'Космос', hasCard: false, mode: null }] };
  const tools = Object.fromEntries(buildComposerTools({ drafts, repo }).map((t) => [t.name, t]));
  return { tools, calls, card };
}

const ctx = (userIntent: boolean, onDraft?: (d: any) => void) => {
  const extras: ComposerExtras = { chat: { chatId: 'c1', channelKey: null }, userIntent, onDraft };
  return { runId: 'r', role: 'composer' as const, channelKey: null, extras: extras as any };
};

test('composer tools exist only for the composer role and never end the run', () => {
  const { tools } = setup();
  assert.deepEqual(Object.keys(tools).sort(), ['cancel_draft', 'list_drafts', 'list_my_channels', 'publish_draft', 'save_draft', 'schedule_draft']);
  for (const t of Object.values(tools)) {
    assert.deepEqual(t.roles, ['composer']);
    assert.notEqual(t.kind, 'terminal');
  }
});

test('save_draft stores the draft, emits it and switches the chat channel + card', async () => {
  const { tools, calls, card } = setup();
  const seen: any[] = [];
  const c = ctx(false, (d) => seen.push(d.id));
  assert.equal(channelOf(c), null);
  const r: any = await tools.save_draft.execute({ channel: ' @space ', spec: makeSpec() }, c);
  assert.equal(r.draft_id, UUID);
  assert.deepEqual(calls[0][1], { chatId: 'c1', channel: '@space', spec: makeSpec(), draftId: null });
  assert.deepEqual(seen, [UUID]);
  assert.equal(channelOf(c), '@space');
  assert.equal((c.extras as any).card, card);
  assert.equal(((await tools.save_draft.execute({ channel: '@nope', spec: makeSpec() }, ctx(false))) as any).error, 'unknown_channel');
});

test('publish_draft / schedule_draft refuse without an explicit request; cancel and list never need one', async () => {
  const { tools, calls } = setup();
  assert.equal(((await tools.publish_draft.execute({ draft_id: UUID }, ctx(false))) as any).error, 'needs_explicit_request');
  assert.equal(((await tools.schedule_draft.execute({ draft_id: UUID, at: '2026-10-02 19:00' }, ctx(false))) as any).error, 'needs_explicit_request');
  assert.equal(calls.length, 0);

  assert.equal(((await tools.publish_draft.execute({ draft_id: UUID }, ctx(true))) as any).status, 'published');
  const s: any = await tools.schedule_draft.execute({ draft_id: UUID, at: '2026-10-02 19:00' }, ctx(true));
  assert.equal(s.kyiv_time, '2026-10-02 19:00 (Київ)');
  assert.deepEqual(calls.at(-1), ['schedule', UUID, '2026-10-02T16:00:00.000Z']);
  assert.equal(((await tools.schedule_draft.execute({ draft_id: UUID, at: 'завтра о 19' }, ctx(true))) as any).error, 'invalid_time');

  assert.equal(((await tools.cancel_draft.execute({ draft_id: UUID }, ctx(false))) as any).status, 'canceled');
  const l: any = await tools.list_drafts.execute({ status: 'scheduled' }, ctx(false));
  assert.equal(l.drafts[0].status, 'scheduled');
  const ch: any = await tools.list_my_channels.execute({}, ctx(false));
  assert.deepEqual(ch.channels, [{ channel: '@space', title: 'Космос', has_card: false, mode: null }]);
});

test('save_draft retry guard: a failing draft is updated (not stacked) and is not saved after MAX_LINT_RETRIES failures', async () => {
  const calls: any[] = [];
  const bad = { ok: false, errors: [{ code: 'not_ukrainian', message: 'текст має бути українською' }], warnings: [] };
  const IDS = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];
  let n = 0;
  const drafts: any = {
    save: async (i: any) => {
      calls.push(i);
      const id = i.draftId ?? IDS[n++];
      return { ok: true, card: makeCard({ channelKey: '@space' }), lint: bad,
        draft: { id, chatId: 'c1', channelKey: '@space', spec: makeSpec(), preview: 'p', lint: bad, status: 'draft', scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: NOW, updatedAt: NOW } };
    },
  };
  const [save] = buildComposerTools({ drafts, repo: { myChannels: async () => [] } as any }).filter((t) => t.name === 'save_draft');
  const c = ctx(false);
  const r1: any = await save.execute({ channel: '@space', spec: makeSpec() }, c);
  assert.deepEqual([r1.draft_id, r1.attempt], [IDS[0], 1]);
  // The model forgets draft_id: the failing draft is updated, not a second one created.
  const r2: any = await save.execute({ channel: '@space', spec: makeSpec() }, c);
  assert.deepEqual([calls[1].draftId, r2.draft_id, r2.attempt], [IDS[0], IDS[0], 2]);
  const r3: any = await save.execute({ channel: '@space', spec: makeSpec(), draft_id: IDS[0] }, c);
  assert.ok(r3.stop, 'the third failure tells the agent to stop and ask the owner');
  const r4: any = await save.execute({ channel: '@space', spec: makeSpec() }, c);
  assert.equal(r4.error, 'lint_stuck');
  assert.equal(calls.length, 3, 'the fourth attempt is not saved');
  // A new turn (fresh extras) starts over.
  assert.equal(((await save.execute({ channel: '@space', spec: makeSpec(), draft_id: IDS[0] }, ctx(false))) as any).attempt, 1);
});
