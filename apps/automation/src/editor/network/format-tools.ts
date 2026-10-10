import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import {
  FORMAT_CHANGES_PER_DAY, FORMAT_PREF_FIELDS, FormatPrefsSchema, renderFormatPrefs, type ResourceProfilesRepository,
} from '../agents/resource-profile';
import { DecisionReason } from './plan-decisions';
import type { NetworkCtx } from './network-context';

/**
 * Spec 024 FR-013: agents own the formatting of each resource. The
 * orchestrator and the planner read and evolve `format_prefs` (≤ 3 changes per
 * resource per local day, owner-locked fields refused); every change is a
 * profile version. Platform hard limits stay in code.
 */

export interface FormatToolDeps {
  profiles: Pick<ResourceProfilesRepository, 'formatOf' | 'patchFormat' | 'formatChangesToday' | 'history'> & Partial<Pick<ResourceProfilesRepository, 'capsOf'>>;
  now?: () => Date;
}

/** A patch: any subset of the fields; null clears a field (back to the agent's judgement). */
const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
const shape = FormatPrefsSchema.shape;
export const FormatPatchInput = z.object({
  tone: nullable(shape.tone.unwrap()), length: nullable(shape.length.unwrap()), emoji: nullable(shape.emoji.unwrap()),
  hashtags: nullable(shape.hashtags.unwrap()), mentions: nullable(shape.mentions.unwrap()), cta: nullable(shape.cta.unwrap()),
  links: nullable(shape.links.unwrap()), line_breaks: nullable(shape.line_breaks.unwrap()), signature: nullable(shape.signature.unwrap()),
  preferred_formats: nullable(shape.preferred_formats.unwrap()), media: nullable(shape.media.unwrap()), notes: nullable(shape.notes.unwrap()),
  rich: nullable(shape.rich.unwrap()), humor: nullable(shape.humor.unwrap()), slang: nullable(shape.slang.unwrap()),
  content_kind: nullable(shape.content_kind.unwrap()), polls_per_week: nullable(shape.polls_per_week.unwrap()),
  questions_to_readers_per_day: nullable(shape.questions_to_readers_per_day.unwrap()),
}).strict().refine((p) => Object.keys(p).length > 0, { message: 'at least one field' });

function refsOf(ctx: ToolContext): string[] | null {
  const net = ctx.extras?.network as NetworkCtx | undefined;
  return net ? net.resources.map((r) => r.ref) : null;
}

export function buildFormatTools(d: FormatToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());

  const getFormat = defineTool({
    name: 'get_resource_format',
    description: 'Налаштування форматування ресурсу (format_prefs): тон, довжина, емодзі, хештеги, посилання, підпис, формати, медіа — і які поля закріпив власник, скільки змін сьогодні, останні зміни з причинами.',
    kind: 'read', roles: ['orchestrator', 'planner', 'executor'],
    input: z.object({ resource_ref: z.string().min(3).max(200) }),
    execute: async ({ resource_ref }, ctx) => {
      const refs = refsOf(ctx);
      if (refs && !refs.includes(resource_ref)) return { error: 'not_in_network', details: refs };
      const f = await d.profiles.formatOf(resource_ref);
      const history = await d.profiles.history([resource_ref], 5);
      return {
        resource_ref, format_prefs: f.prefs, locked_by_owner: f.locks, rendered: renderFormatPrefs(f.prefs, f.locks),
        // Spec 034 FR-005: the effective caps (defaults included) the plan check and the lint enforce.
        ...(d.profiles.capsOf ? { audience_caps: await d.profiles.capsOf(resource_ref) } : {}),
        changes_today: await d.profiles.formatChangesToday(resource_ref, now()), changes_per_day: FORMAT_CHANGES_PER_DAY,
        recent: history.filter((h) => h.kind === 'format').map((h) => ({ version: h.version, by: h.changedBy, at: h.createdAt, reason: h.reason, diff: h.diff })),
      };
    },
  });

  const updateFormat = defineTool({
    name: 'update_resource_format',
    description: [
      `Змінити форматування ресурсу (format_prefs) — частково: поля ${FORMAT_PREF_FIELDS.join(', ')}; null прибирає поле (тоді на твій розсуд).`,
      'Змінюй на підставі KPI або правок власника, не туди-сюди; reason — який сигнал. Поля, закріплені власником, змінити не можна (locked_by_owner).',
      'humor і slang вмикає лише власник (owner_only): ти можеш їх лише вимкнути (humor: none, slang: false).',
      'polls_per_week і questions_to_readers_per_day ти можеш лише знизити (до 1 або менше); content_kind задає власник.',
      `Не більше ${FORMAT_CHANGES_PER_DAY} змін на ресурс за день. Ліміти платформи (довжина підпису, максимум хештегів) все одно перевіряє код.`,
    ].join(' '),
    kind: 'act', roles: ['orchestrator', 'planner'],
    input: z.object({ resource_ref: z.string().min(3).max(200), patch: FormatPatchInput, reason: DecisionReason }),
    execute: async ({ resource_ref, patch, reason }, ctx) => {
      const refs = refsOf(ctx);
      if (!refs) return { error: 'no_network', details: 'format_prefs are changed from an orchestrator or planner run' };
      if (!refs.includes(resource_ref)) return { error: 'not_in_network', details: refs };
      const agent = ctx.extras?.agent as { id?: string } | undefined;
      const r = await d.profiles.patchFormat(resource_ref, patch as Record<string, unknown>, { by: 'agent', agentId: agent?.id ?? null, reason, now: now() });
      if ('error' in r) return r;
      return { ...r, rendered: renderFormatPrefs(r.format_prefs) };
    },
  });

  return [getFormat, updateFormat];
}
