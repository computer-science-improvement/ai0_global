/**
 * Spec 069 FR-007, executor path: publish_post lints against `CriticGate.groundingSources` (the pages and feed items the
 * run read, and the library row of `library_ref`), so a post that copies a page it fetched and says `origin=original`
 * stops with `lint_failed` / `origin_mismatch`. A library-row copy is caught by the chat capture and the skill refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleTools, type RoleToolDeps } from './role-tools';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { CriticGate } from '../critic/critic-gate';
import type { EditorTool } from '../harness/tool';

const NOW = new Date('2026-10-01T09:00:00Z');
const PAGE = 'Телескоп Вебб показав туманність Кільце: оболонки газу, які зоря скинула тисячі років тому, світяться в інфрачервоному діапазоні яскравіше за саму зорю, і це видно навіть на оглядовому знімку.';
const COPY = 'оболонки газу, які зоря скинула тисячі років тому, світяться в інфрачервоному діапазоні яскравіше';

function publisher() {
  const sent: any[] = [];
  const plans: any = {
    getSlot: async (id: string) => ({ id, channelKey: '@chan', status: 'running' }), updateSlot: async () => {}, reservedSlots: async () => [],
    countPublishedSince: async () => 0, lastPostAt: async () => null, sourceAlreadyPosted: async () => false, recentTexts: async () => [],
    insertPublication: async () => 501,
  };
  const d: RoleToolDeps = {
    pool: { query: async () => ({ rows: [] }) } as any, plans,
    memory: { listActive: async () => [], add: async () => 1, retireByReviewer: async () => true },
    channels: { setFormatWeights: async (_k: string, w: any) => w },
    publisher: { send: async (_k: string, m: any) => { sent.push(m); return { messageIds: [900] }; } },
    recordPublish: () => {}, notifyPreview: async () => {}, now: () => NOW,
  };
  return { publish: Object.fromEntries(buildRoleTools(d).map((t) => [t.name, t])).publish_post, sent };
}

function run(fetched: boolean) {
  const gate = new CriticGate({ critic: { review: async () => { throw new Error('not called'); } } as any, plans: { updateSlot: async () => {} } },
    { slotId: 'slot-1', channelKey: '@chan', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} });
  gate.check = async () => ({ kind: 'proceed', critic: { verdict: 'pass', scores: null, notes: 'ok', pass: 1 } as any });
  const [fetch] = gate.wrapTools([{ name: 'web_fetch', execute: async () => ({ url: 'https://nasa.gov/ring', title: 'Ring', text: PAGE }) }] as unknown as EditorTool[]);
  const ctx: any = { runId: 'run-1', role: 'executor', channelKey: '@chan', slotId: 'slot-1', extras: { card: makeCard({ mode: 'live' }), critic: gate } };
  return { ctx, read: async () => { if (fetched) await fetch.execute({ url: 'https://nasa.gov/ring' }, ctx); } };
}

const original = () => makeSpec({ origin: 'original', source: undefined, media: [], format: 'text', body: [{ type: 'lead', text: 'Нова туманність' }, { type: 'p', text: `Дивіться: ${COPY}.` }] });

test('a post that copies a page the run fetched and says origin=original is stopped by the lint', async () => {
  const h = publisher();
  const { ctx, read } = run(true);
  await read();
  const r: any = await h.publish.execute({ spec: original() }, ctx);
  assert.equal(r.error, 'lint_failed');
  assert.ok(r.details.some((e: any) => e.code === 'origin_mismatch'), JSON.stringify(r.details));
  assert.equal(h.sent.length, 0);
});

test('the same post with origin=external and the page as its source goes out; so does an original that read nothing', async () => {
  const ext = publisher();
  const a = run(true);
  await a.read();
  const spec = makeSpec({ origin: 'external', media: [], format: 'text', source: { url: 'https://nasa.gov/ring', label: 'NASA' }, body: [{ type: 'lead', text: 'Нова туманність' }, { type: 'p', text: `Дивіться: ${COPY}.` }] });
  const r: any = await ext.publish.execute({ spec }, a.ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  const orig = publisher();
  const b = run(false);
  await b.read();
  const r2: any = await orig.publish.execute({ spec: original() }, b.ctx);
  assert.equal(r2.ok, true, JSON.stringify(r2));
});
