import { z } from 'zod';
import { channelOf, defineTool, type EditorTool, type ToolContext } from '../harness/tool';
import type { EditorCard } from '../card';
import type { PendingAction, PendingActionsService } from '../agents/pending-actions';
import { mergeCard } from '../api/card-input';
import type { SourceHealthService } from './source-health.service';
import { applySourceChange, checkCandidate, sourceLabel, SOURCE_CHANGE_KIND, type CandidateDeps, type SourceChange } from './source-change';

export interface SourceToolDeps {
  health:    Pick<SourceHealthService, 'forChannel'>;
  channels:  { get(key: string): Promise<EditorCard | null> };
  actions:   Pick<PendingActionsService, 'propose'>;
  candidate: CandidateDeps;
  /** A change card for this source already waits (or was discarded this week). */
  handled?:  (channelKey: string, sourceId: string | null, ref: string | null) => Promise<'pending' | 'declined' | null>;
}

const NewSource = z.object({
  id:   z.string().trim().min(1).max(64).optional().describe('Новий id (без нього — з домену; заміна зберігає старий id)'),
  kind: z.enum(['rss', 'url', 'library', 'api']),
  ref:  z.string().trim().min(1).max(2000).describe('rss/url — повна адреса; library — назва датасету; api — назва джерела fetch_api'),
  note: z.string().max(300).optional(),
}).strict();

const normKey = (k: string): string => (k.trim().startsWith('@') || /^-?\d+$/.test(k.trim()) ? k.trim() : `@${k.trim()}`);

function channelFor(ctx: ToolContext, given?: string): string | null {
  return given?.trim() ? normKey(given.replace(/^telegram:/, '')) : channelOf(ctx);
}

/** Spec 049 FR-003 / FR-004: read the card's source health; propose a source change as an owner card. */
export function buildSourceTools(d: SourceToolDeps): EditorTool[] {
  const getHealth = defineTool({
    name: 'get_source_health',
    description: 'Стан джерел картки каналу за 14 днів: для кожного — скільки читань вдалися, остання помилка, останнє вдале читання, блокування хоста, втрачені слоти; плюс заблоковані сторонні хости, які ти читав.',
    kind: 'read', roles: ['orchestrator', 'manager', 'composer', 'builder', 'planner'],
    input: z.object({ channel: z.string().max(100).optional().describe('@channel; без нього — твій канал') }),
    execute: async ({ channel }, ctx) => {
      const key = channelFor(ctx, channel);
      if (!key) return { error: 'no_channel', details: 'назви канал (@channel)' };
      const r = await d.health.forChannel(key);
      if (!r) return { error: 'unknown_channel', details: `${key} не має картки` };
      return {
        channel: key, days: r.days,
        sources: r.sources.map((s) => ({ id: s.id, kind: s.kind, ref: s.ref, state: s.state, detail: s.detail, ...(s.origin === 'playbook' ? { origin: 'playbook' } : {}) })),
        other_blocked_hosts: r.otherHosts,
      };
    },
  });

  const propose = defineTool({
    name: 'propose_source_change',
    description: [
      'Запропонувати власнику зміну джерел картки каналу: replace — замінити джерело, що не працює; add — додати ще одне; remove — прибрати мертве.',
      'Нове джерело код читає одразу (стрічка має свіжі записи, сторінка відповідає, API дає записи, датасет має рядки) — неробоче не пройде.',
      'Власник бачить картку з Apply / Discard; картка не змінюється до його кліку.',
    ].join(' '),
    kind: 'act', roles: ['orchestrator', 'composer', 'builder'],
    input: z.object({
      channel:   z.string().max(100).optional().describe('@channel; без нього — твій канал'),
      action:    z.enum(['replace', 'add', 'remove']),
      source_id: z.string().max(64).optional().describe('id джерела картки для replace / remove'),
      source:    NewSource.optional().describe('Нове джерело для replace / add'),
      reason:    z.string().trim().min(10).max(500).describe('Чому: що зі старим джерелом (з get_source_health) і чим нове краще'),
    }),
    execute: async (i, ctx) => {
      const key = channelFor(ctx, i.channel);
      if (!key) return { error: 'no_channel', details: 'назви канал (@channel)' };
      const card = await d.channels.get(key);
      if (!card) return { error: 'unknown_channel', details: `${key} не має картки` };
      const next = applySourceChange(card.sources, { action: i.action, sourceId: i.source_id ?? null, source: i.source ?? null });
      if ('error' in next) return next;
      const merged = mergeCard(key, card, { sources: next });
      if (!merged.ok) return { error: 'invalid_source', details: merged.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') };
      const seen = d.handled ? await d.handled(key, i.source_id ?? null, i.source?.ref ?? null) : null;
      if (seen === 'pending') return { error: 'already_proposed', details: 'картка зміни цього джерела вже чекає на власника' };
      if (seen === 'declined') return { error: 'owner_declined', details: 'власник відхилив цю зміну цього тижня — не пропонуй її знову' };
      let evidence = '';
      if (i.source) {
        const c = await checkCandidate(i.source, d.candidate);
        if (!c.ok) return { error: c.error, details: `${c.details}. Нове джерело не працює — знайди інше або не пропонуй заміну.` };
        evidence = c.evidence;
      }
      const old = i.source_id ? card.sources.find((s) => s.id === i.source_id) : null;
      const added = i.action === 'remove' ? null : next.find((s) => !card.sources.some((o) => o.id === s.id && o.ref === s.ref)) ?? null;
      const what = i.action === 'replace' ? `Replace source «${old!.id}» (${sourceLabel(old!)}) with ${sourceLabel(added!)}`
        : i.action === 'add' ? `Add source «${added!.id}» (${sourceLabel(added!)})`
        : `Remove source «${old!.id}» (${sourceLabel(old!)})`;
      const payload: SourceChange = { channelKey: key, action: i.action, sourceId: i.source_id ?? null, source: added, reason: i.reason };
      const x = ctx.extras as { chat?: { chatId?: string | null }; agent?: { id?: string }; orchestrator?: { id?: string }; onAction?: (a: PendingAction) => void } | undefined;
      const action = await d.actions.propose({
        chatId: x?.chat?.chatId ?? null, agentId: x?.orchestrator?.id ?? x?.agent?.id ?? null, kind: SOURCE_CHANGE_KIND,
        payload: payload as unknown as Record<string, unknown>,
        summary: `${what} on ${key}. Why: ${i.reason}${evidence ? ` Checked now: ${evidence}.` : ''}`,
      });
      try { x?.onAction?.(action); } catch { /* UI stream only */ }
      return { ok: true, pending_action: action.id, note: 'Власник побачить картку з Apply / Discard; джерела картки зміняться лише після його кліку.' };
    },
  });

  return [getHealth, propose];
}

/** The `change_source` card handler: the change on the card as it is now (the card may have changed since). */
export async function applySourceChangeAction(
  p: Record<string, unknown>,
  d: { channels: { get(key: string): Promise<EditorCard | null> }; upsert: (key: string, patch: { sources: EditorCard['sources'] }) => Promise<unknown> },
): Promise<{ channel: string; sources: number }> {
  const c = p as unknown as SourceChange;
  const card = await d.channels.get(String(c.channelKey));
  if (!card) throw new Error(`unknown_channel: ${c.channelKey} has no card`);
  const next = applySourceChange(card.sources, c);
  if ('error' in next) throw new Error(`${next.error}: ${next.details}`);
  await d.upsert(card.channelKey, { sources: next });
  return { channel: card.channelKey, sources: next.length };
}
