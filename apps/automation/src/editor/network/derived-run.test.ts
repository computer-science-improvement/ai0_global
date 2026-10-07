/**
 * Spec 024 T3 (FR-007): derived slots. Source resolution (wait / skip codes /
 * ready) and the runner's derived path: a duplicate is one short formatting
 * run with the target's format_prefs and the agent's notes; a shadowed source
 * forces shadow; lint fails twice → failed + Inbox note; no retry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DerivedSlots, derivedPrompts } from './derived-slots';
import { EditorRunnerService, lintOnce } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { EditorSlot } from '../repo/editor-plans.repository';

const NOW = new Date('2026-10-05T09:00:00Z');
const SRC = '10000000-0000-4000-8000-000000000001';
const IG = 'instagram:ig1';
const tgPhoto = makeSpec();

const derivedSlot = (o: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 'd1', planId: 'p1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'ig_photo', topic: 'Туманність Кільце', angle: null,
  sourceHints: [], isExperiment: false, status: 'running', attempts: 1, runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null,
  resourceRef: IG, ideaId: null, treatment: 'duplicate', treatmentReason: 'Та сама аудиторія, фото пасує IG', derivedFromSlotId: SRC,
  sourcePost: { via: 'plan', format_notes: 'без емодзі, 3 хештеги' }, ...o,
});

function pool(src: Record<string, unknown> | null, pp: unknown = null): any {
  return {
    query: async (sql: string) => {
      if (/FROM editor_slots WHERE id/.test(sql)) return { rows: src ? [src] : [] };
      if (/FROM platform_posts WHERE slot_id/.test(sql)) return { rows: pp ? [{ spec: pp }] : [] };
      throw new Error(`unexpected ${sql}`);
    },
  };
}
const srcRow = (o: Record<string, unknown> = {}) => ({ id: SRC, channel_key: '@chan', resource_ref: null, status: 'published', post_spec: tgPhoto, ...o });

test('resolve: pending source waits; failed / skipped / expired → source_failed; missing → source_missing', async () => {
  for (const status of ['planned', 'running', 'awaiting_approval', 'approved']) {
    assert.deepEqual(await new DerivedSlots({ pool: pool(srcRow({ status })) }).resolve(derivedSlot()), { kind: 'wait' }, status);
  }
  for (const status of ['failed', 'skipped', 'expired']) {
    const r = await new DerivedSlots({ pool: pool(srcRow({ status })) }).resolve(derivedSlot());
    assert.equal(r.kind === 'skip' && r.code, 'source_failed', status);
  }
  const gone = await new DerivedSlots({ pool: pool(null) }).resolve(derivedSlot());
  assert.equal(gone.kind === 'skip' && gone.code, 'source_missing');
  const noSpec = await new DerivedSlots({ pool: pool(srcRow({ post_spec: null })) }).resolve(derivedSlot());
  assert.equal(noSpec.kind === 'skip' && noSpec.code, 'source_missing');
});

test('resolve: ready with the shadow flag, held slides and format notes; platform sources read platform_posts', async () => {
  const r = await new DerivedSlots({ pool: pool(srcRow({ status: 'shadowed' })), heldUrls: async () => ['https://cdn/a.png'] }).resolve(derivedSlot());
  assert.equal(r.kind, 'ready');
  if (r.kind !== 'ready') return;
  assert.equal(r.shadow, true);
  assert.equal(r.sourceRef, 'telegram:@chan');
  assert.deepEqual(r.slideUrls, ['https://cdn/a.png']);
  assert.equal(r.formatNotes, 'без емодзі, 3 хештеги');
  const igSpec = { format: 'ig_photo', title: 'Туманність', caption: 'Кільце', hashtags: [], media: [{ url: 'https://images.nasa.gov/ring.jpg', kind: 'image' }] };
  const fromIg = await new DerivedSlots({ pool: pool(srcRow({ resource_ref: IG, post_spec: null }), igSpec) })
    .resolve(derivedSlot({ resourceRef: null, format: 'photo' }));
  assert.equal(fromIg.kind === 'ready' && fromIg.source.platform, 'instagram');
});

test('resolve: resource left the network; impossible format; media gone', async () => {
  const left = await new DerivedSlots({ pool: pool(srcRow()), networkRefs: async () => ['telegram:@chan'] }).resolve(derivedSlot());
  assert.equal(left.kind === 'skip' && left.code, 'resource_left_network');
  const unsupported = await new DerivedSlots({ pool: pool(srcRow({ post_spec: makeSpec({ format: 'text', media: [] }) })) }).resolve(derivedSlot({ format: 'ig_carousel' }));
  assert.equal(unsupported.kind === 'skip' && unsupported.code, 'unsupported_format');
  const mediaGone = await new DerivedSlots({ pool: pool(srcRow({ post_spec: makeSpec({ format: 'text', media: [] }) })) }).resolve(derivedSlot({ format: 'ig_photo' }));
  assert.equal(mediaGone.kind === 'skip' && mediaGone.code, 'source_media_gone');
});

test('the formatting prompt carries the source, the draft, format_prefs, the notes and the hard limits', () => {
  const ready = { kind: 'ready' as const, treatment: 'duplicate' as const, source: { platform: 'telegram' as const, spec: tgPhoto }, sourceRef: 'telegram:@chan', shadow: false, slideUrls: [], formatNotes: 'без емодзі, 3 хештеги', sourceSlotId: SRC };
  const p = derivedPrompts({
    slot: derivedSlot(), ready, targetRef: IG, targetPlatform: 'instagram', profile: 'Тема: космос', formatPrefs: 'Емодзі: none\nХештеги: 3, нижній регістр',
    playbook: null, memory: '', mode: 'live',
  });
  assert.match(p.system, /ДУБЛЬ/);
  assert.match(p.system, /## Форматування ресурсу \(format_prefs\)\nЕмодзі: none/);
  assert.match(p.system, /без емодзі, 3 хештеги/);
  assert.match(p.system, /instagram: підпис ≤ 2200/);
  assert.match(p.user, /Чернетка від коду/);
  assert.match(p.user, /"format": "ig_photo"/);
  assert.match(p.user, /Телескоп Вебб показав туманність Кільце/);
});

// ── the runner's derived path ──────────────────────────────────────────────

function runner(resolve: any, o: { after?: Partial<EditorSlot>; loop?: (i: any) => Promise<any> } = {}) {
  const updates: any[] = [];
  const runs: any[] = [];
  const notes: any[] = [];
  const done: string[] = [];
  const released: string[] = [];
  const tools = ['lint_platform_post', 'publish_platform_post', 'skip_slot', 'web_fetch', 'publish_post', 'lint_post']
    .map((name) => ({ name, kind: name.startsWith('publish') || name === 'skip_slot' ? 'terminal' : 'read', execute: async () => ({ ok: true }) }));
  const r = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return o.loop ? o.loop(i) : { runId: 'r1', status: 'ok', terminalTool: 'publish_platform_post' }; } },
    registry: { forRole: () => tools as any },
    skills: new SkillLibrary(),
    plans: {
      reservedSlots: async () => [], getSlot: async () => ({ ...derivedSlot(), status: 'published', ...o.after }) as any,
      updateSlot: async (id: string, p: any) => { updates.push([id, p]); },
    },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    platformContext: async () => ({ profile: 'Тема: космос для Instagram', playbook: null, maxPerDay: 2, vocabulary: [] }),
    onSlotDone: async (s) => { done.push(s.id); },
    derived: {
      resolve, formatPrefs: async () => 'Емодзі: none',
      released: async (id) => { released.push(id); },
      inbox: async (n) => { notes.push(n); },
    },
  });
  return { r, updates, runs, notes, done, released };
}

const READY = (o: Record<string, unknown> = {}) => async () => ({
  kind: 'ready', treatment: 'duplicate', source: { platform: 'telegram', spec: tgPhoto }, sourceRef: 'telegram:@chan', shadow: false,
  slideUrls: [], formatNotes: null, sourceSlotId: SRC, ...o,
});

test('a skipped derived slot never runs the agent', async () => {
  const t = runner(async () => ({ kind: 'skip', code: 'source_failed', details: 'source failed' }));
  const res = await t.r.runExecutor(derivedSlot(), makeCard({ mode: 'live' }));
  assert.equal(t.runs.length, 0);
  assert.equal(res.error, 'source_failed');
  assert.deepEqual(t.updates, [['d1', { status: 'skipped', error: 'source_failed: source failed' }]]);
  assert.deepEqual(t.done, ['d1']);
  const w = runner(async () => ({ kind: 'wait' }));
  await w.r.runExecutor(derivedSlot(), makeCard({ mode: 'live' }));
  assert.equal(w.updates[0][1].status, 'planned');
});

test('duplicate: one short run, only lint / publish / skip, format_prefs in the prompt; a shadowed source forces shadow', async () => {
  const t = runner(READY({ shadow: true }));
  await t.r.runExecutor(derivedSlot(), makeCard({ mode: 'live' }));
  assert.equal(t.runs.length, 1);
  const i = t.runs[0];
  assert.equal(i.maxSteps, 6);
  assert.deepEqual(i.tools.map((x: any) => x.name).sort(), ['lint_platform_post', 'publish_platform_post', 'skip_slot']);
  assert.equal(i.extras.platformSlot.mode, 'shadow');
  assert.equal(i.extras.card.mode, 'shadow');
  assert.match(i.system, /Емодзі: none/);
  assert.match(i.system, /Тема: космос для Instagram/);
  assert.deepEqual(t.released, [SRC]);
  assert.deepEqual(t.done, ['d1']);
});

test('adapt: a native rewrite with the full executor tool set; a run without a result fails (no retry)', async () => {
  const t = runner(READY({ treatment: 'adapt' }), { after: { status: 'running' }, loop: async () => ({ runId: 'r2', status: 'max_steps' }) });
  await t.r.runExecutor(derivedSlot({ treatment: 'adapt' }), makeCard({ mode: 'live' }));
  const i = t.runs[0];
  assert.equal(i.maxSteps, 14);
  assert.ok(i.tools.some((x: any) => x.name === 'web_fetch'));
  assert.ok(!i.tools.some((x: any) => x.name === 'publish_post'), 'Telegram-only tools stay out of a platform target');
  assert.match(i.system, /АДАПТУЄШ/);
  assert.equal(i.extras.platformSlot.mode, 'live');
  assert.equal(t.updates.at(-1)[1].status, 'failed');
});

test('lint fails twice → the slot fails and the owner gets an Inbox note', async () => {
  let calls = 0;
  const failing = { name: 'publish_platform_post', kind: 'terminal', execute: async () => { calls++; return { error: 'lint_failed', details: [{ code: 'caption_too_long' }] }; } } as any;
  const failed: unknown[] = [];
  const wrapped = lintOnce(failing, async (d) => { failed.push(d); });
  assert.deepEqual(await wrapped.execute({}, {} as any), { error: 'lint_failed', details: [{ code: 'caption_too_long' }] }, 'first failure goes back to the agent');
  assert.deepEqual(await wrapped.execute({}, {} as any), { ok: true, failed: 'lint_failed', details: [{ code: 'caption_too_long' }] });
  assert.equal(calls, 2);
  assert.equal(failed.length, 1);

  // Through the runner: the publish tool it hands to the loop is wrapped the same way.
  const t = runner(READY(), {
    after: { status: 'failed' },
    loop: async (i) => {
      const pub = i.tools.find((x: any) => x.name === 'publish_platform_post');
      await pub.execute({}, {});
      await pub.execute({}, {});
      return { runId: 'r3', status: 'ok', terminalTool: 'publish_platform_post' };
    },
  });
  const orig = (t.r as any).d.registry.forRole;
  (t.r as any).d.registry.forRole = () => orig().map((x: any) => (x.name === 'publish_platform_post' ? { ...x, execute: async () => ({ error: 'lint_failed', details: [{ code: 'too_many_hashtags' }] }) } : x));
  await t.r.runExecutor(derivedSlot(), makeCard({ mode: 'live' }));
  assert.ok(t.updates.some(([, p]) => p.status === 'failed' && /lint_failed twice: too_many_hashtags/.test(p.error)));
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0].title, /failed lint twice/);
});
