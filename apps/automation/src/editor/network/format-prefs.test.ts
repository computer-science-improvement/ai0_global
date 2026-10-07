/**
 * Spec 024 T8 (FR-013): format_prefs in the profile, their prompt rendering,
 * the update_resource_format tool (locked fields, daily cap — via the repo),
 * the executor prompts that carry a target's format_prefs (fixture), and the
 * soft gaps that became prompt hints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffFormatPrefs, FormatPrefsSchema, renderFormatPrefs, ResourceProfileSchema, storedFormat,
} from '../agents/resource-profile';
import { buildFormatTools, FormatPatchInput } from './format-tools';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { validateNetworkPlan } from './network-plan';
import { PlaybookSchema } from './playbook';
import { networkPlannerBlock } from './network-prompts';
import type { NetworkCtx } from './network-context';

const PREFS = FormatPrefsSchema.parse({
  tone: 'дружній, без канцеляриту', length: { target: 300, max: 600 }, emoji: 'light',
  hashtags: { count: 3, style: 'нижній регістр', fixed: ['космос'] }, links: 'bio', preferred_formats: ['ig_carousel'],
  media: { aspect: '4:5', cover_style: 'великий заголовок' }, notes: 'Перший рядок — питання',
});

test('format_prefs: every field optional, strict, rendered for prompts with owner locks marked', () => {
  assert.deepEqual(FormatPrefsSchema.parse({}), {});
  assert.equal(FormatPrefsSchema.safeParse({ colour: 'red' }).success, false, 'unknown fields are refused');
  assert.equal(FormatPrefsSchema.safeParse({ length: { target: 900, max: 600 } }).success, false);
  assert.equal(FormatPrefsSchema.safeParse({ emoji: 'lots' }).success, false);
  const text = renderFormatPrefs(PREFS, ['emoji'])!;
  assert.match(text, /^Тон: дружній, без канцеляриту$/m);
  assert.match(text, /^Довжина: ~300 символів, максимум 600$/m);
  assert.match(text, /^Емодзі: кілька \(закріплено власником\)$/m);
  assert.match(text, /^Хештеги: 3, нижній регістр, завжди: #космос$/m);
  assert.match(text, /^Посилання: посилання в біо$/m);
  assert.equal(renderFormatPrefs({}), null);
  assert.deepEqual(diffFormatPrefs({ emoji: 'light' }, { emoji: 'none', tone: 'сухий' }), { tone: { from: null, to: 'сухий' }, emoji: { from: 'light', to: 'none' } });
});

test('a profile carries format_prefs and owner locks; invalid stored formatting never loses the profile', () => {
  const base = { topic: 'Космос для Instagram', audience: { who: 'дорослі' }, goals: ['growth'] };
  const p = ResourceProfileSchema.parse({ ...base, format_prefs: PREFS, format_locks: ['emoji', 'links'] });
  assert.deepEqual(p.format_locks, ['emoji', 'links']);
  assert.equal(ResourceProfileSchema.safeParse({ ...base, format_locks: ['colour'] }).success, false);
  assert.deepEqual(storedFormat({ ...base, format_prefs: { emoji: 'lots' }, format_locks: ['emoji'] }), { prefs: {}, locks: ['emoji'] });
  assert.deepEqual(storedFormat(null), { prefs: {}, locks: [] });
});

test('update_resource_format: a partial patch with null to clear; only for network resources; errors come from the repo', async () => {
  assert.equal(FormatPatchInput.safeParse({}).success, false);
  assert.equal(FormatPatchInput.safeParse({ emoji: null, tone: 'сухий' }).success, true);
  assert.equal(FormatPatchInput.safeParse({ colour: 'red' }).success, false);
  const calls: any[] = [];
  let next: any = { ok: true, version: 4, format_prefs: { tone: 'сухий' }, changed: ['tone', 'emoji'] };
  const [get, update] = buildFormatTools({
    profiles: {
      formatOf: async () => ({ prefs: PREFS, locks: ['emoji'], updatedAt: null }),
      patchFormat: async (ref, patch, meta) => { calls.push({ ref, patch, meta }); return next; },
      formatChangesToday: async () => 2,
      history: async () => [],
    },
  });
  assert.deepEqual(update.roles, ['orchestrator', 'planner']);
  const ctx = { runId: 'r', role: 'orchestrator', channelKey: '@space', extras: { network: { resources: [{ ref: 'instagram:ig1' }] }, agent: { id: 'o1' } } } as any;
  const ok: any = await update.execute({ resource_ref: 'instagram:ig1', patch: { tone: 'сухий', emoji: null }, reason: 'Пости без емодзі мали +20% збережень' }, ctx);
  assert.equal(ok.version, 4);
  assert.match(ok.rendered, /Тон: сухий/);
  assert.deepEqual(calls[0].meta.by, 'agent');
  assert.equal(calls[0].meta.agentId, 'o1');
  assert.equal(((await update.execute({ resource_ref: 'threads:x', patch: { tone: 'x' }, reason: 'Причина з KPI ресурсу' }, ctx)) as any).error, 'not_in_network');
  assert.equal(((await update.execute({ resource_ref: 'instagram:ig1', patch: { tone: 'x' }, reason: 'Причина з KPI ресурсу' }, { ...ctx, extras: {} })) as any).error, 'no_network');
  next = { error: 'locked_by_owner', details: ['emoji'] };
  assert.equal(((await update.execute({ resource_ref: 'instagram:ig1', patch: { emoji: 'rich' }, reason: 'Причина з KPI ресурсу' }, ctx)) as any).error, 'locked_by_owner');
  const g: any = await get.execute({ resource_ref: 'instagram:ig1' }, ctx);
  assert.deepEqual([g.locked_by_owner, g.changes_today, g.changes_per_day], [['emoji'], 2, 3]);
});

test('the executor prompt of a target carries its format_prefs (platform, Telegram and derived runs)', async () => {
  const runs: any[] = [];
  const rendered = renderFormatPrefs(PREFS, ['emoji']);
  const runner = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r', status: 'ok', terminalTool: 'publish_platform_post' } as any; } },
    registry: { forRole: () => [] },
    skills: new SkillLibrary(),
    plans: { reservedSlots: async () => [], getSlot: async () => null, updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {},
    platformContext: async () => ({ profile: 'Тема: космос', playbook: null, maxPerDay: 2, vocabulary: [], formatPrefs: rendered }),
  });
  const slot: any = { id: 's1', channelKey: '@space', scheduledAt: new Date(), format: 'ig_carousel', topic: 'Сатурн', angle: null, sourceHints: [], attempts: 1, resourceRef: 'instagram:ig1' };
  await runner.runExecutor(slot, makeCard({ channelKey: '@space' }));
  assert.match(runs[0].system, /## Форматування ресурсу \(format_prefs\)\nТон: дружній, без канцеляриту/);
  assert.match(runs[0].system, /Емодзі: кілька \(закріплено власником\)/);
  await runner.runExecutor({ ...slot, resourceRef: null, format: 'photo' }, makeCard({ channelKey: '@space' }));
  assert.match(runs[1].user, /Форматування цього ресурсу \(format_prefs\):\nТон: дружній/);
});

test('soft gaps are hints now: platform slots 10 min apart pass; the Telegram card gap stays; the planner prompt names the hint', () => {
  const net: NetworkCtx = {
    orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
    resources: [{ ref: 'telegram:@space', platform: 'telegram' }, { ref: 'instagram:ig1', platform: 'instagram' }],
    playbook: PlaybookSchema.parse({ platforms: [
      { resource_ref: 'telegram:@space', role: 'core', formats: { photo: 1 }, per_day: { min: 0, max: 3 }, series: [] },
      { resource_ref: 'instagram:ig1', role: 'discovery', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 3 } },
    ], series: [{ name: 'Ранок', cadence: 'daily@10:00', resource_ref: 'instagram:ig1', format: 'ig_carousel', brief: 'Ранкова добірка новин' },
      { name: 'Обід', cadence: 'daily@10:10', resource_ref: 'instagram:ig1', format: 'ig_carousel', brief: 'Обідня добірка новин' },
      { name: 'Фото дня', cadence: 'daily@10:00', resource_ref: 'telegram:@space', format: 'photo', brief: 'Фото дня для каналу' },
      { name: 'Друге фото', cadence: 'daily@10:10', resource_ref: 'telegram:@space', format: 'photo', brief: 'Друге фото для каналу' }] } as any),
    playbookVersion: 1, telegramFormats: ['photo'],
  };
  const s = (ref: string, time: string, series: string, format: string) => ({ resource_ref: ref, time, format, topic: `Тема ${series}`, series, source_hints: [] });
  const card = { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60 };
  const v = validateNetworkPlan({ rationale: 'Два пости поспіль', slots: [
    s('instagram:ig1', '10:00', 'Ранок', 'ig_carousel'), s('instagram:ig1', '10:10', 'Обід', 'ig_carousel'),
    s('telegram:@space', '10:00', 'Фото дня', 'photo'), s('telegram:@space', '10:10', 'Друге фото', 'photo'),
  ] }, { net, card, planDate: '2026-10-05', weekday: 1, now: new Date('2026-10-05T05:00:00Z'), ideas: new Map(), reservedAt: [] });
  const e = v.ok ? '' : v.errors.join('\n');
  assert.ok(!e.includes('instagram:ig1: інтервал'), e);
  assert.ok(e.includes('telegram:@space: інтервал між постами менше 60 хв'), e);
  assert.match(networkPlannerBlock({ net, accepted: [], now: new Date('2026-10-05T05:00:00Z'), tz: 'Europe/Kyiv' }), /орієнтир: ≥ 60 хв/);
});
