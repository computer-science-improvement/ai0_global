import type { CardSource, EditorCard } from '../card';
import type { PendingAction, SilenceHooks } from '../agents/pending-actions';
import type { UndoRecord } from '../autonomy/autonomy-decisions.repository';
import { sameSource, type SourceChange } from './source-change';
import type { ProbeResult } from './probe';

/**
 * Spec 090 FR-003: a `change_source` card the owner did not answer is applied by code only when it adds a source (or swaps
 * one for a candidate), the new address passed the spec 076 probe in the last 6 h, and the card is not from a chat
 * (chat cards never reach this guard: the registry drops them). A removal, an unprobed or failing address, a source that is
 * not a feed or page: the card expires.
 */
export const SOURCE_PROBE_FRESH_MS = 6 * 3600_000;

export interface SourceSilenceDeps {
  probes:   { latest(urls: string[]): Promise<Map<string, ProbeResult>> };
  channels: { get(key: string): Promise<EditorCard | null> };
  now?:     () => Date;
}

/** Why the card must not be applied on silence, or null. */
export async function changeSourceGuard(a: PendingAction, d: Pick<SourceSilenceDeps, 'probes' | 'now'>): Promise<string | null> {
  if (a.chatId) return 'it came from a chat';
  const c = a.payload as unknown as Partial<SourceChange>;
  if (c.action === 'remove') return 'it removes a source';
  if (c.action !== 'add' && c.action !== 'replace') return 'unknown change';
  const s = c.source;
  if (!s || (s.kind !== 'rss' && s.kind !== 'url')) return 'the new source has no probe (not a feed or page)';
  const hit = (await d.probes.latest([s.ref])).get(s.ref);
  if (!hit) return 'the new source was never probed';
  if (!hit.ok) return `the new source failed its probe (${hit.failure_class ?? 'failed'})`;
  const age = (d.now ? d.now() : new Date()).getTime() - Date.parse(hit.checked_at);
  if (!(age <= SOURCE_PROBE_FRESH_MS)) return 'the probe of the new source is older than 6 h';
  return null;
}

interface Captured { old: CardSource | null }

/** The silence hooks of `change_source`. */
export function changeSourceSilence(d: SourceSilenceDeps): SilenceHooks {
  return {
    guard: (a) => changeSourceGuard(a, d),
    capture: async (a): Promise<Captured> => {
      const c = a.payload as unknown as SourceChange;
      const card = await d.channels.get(String(c.channelKey));
      return { old: c.action === 'replace' && c.sourceId ? card?.sources.find((s) => s.id === c.sourceId) ?? null : null };
    },
    undo: (a, _result, captured): UndoRecord | null => {
      const c = a.payload as unknown as SourceChange;
      if (!c.source) return null;
      const added = { kind: c.source.kind, ref: c.source.ref };
      if (c.action === 'add') return { kind: 'change_source', channelKey: c.channelKey, action: 'remove', added };
      const old = (captured as Captured | undefined)?.old;
      if (c.action === 'replace' && old) return { kind: 'change_source', channelKey: c.channelKey, action: 'restore', added, old };
      return null;
    },
  };
}

/** Undo handler of `change_source`: remove the added source, or put the replaced one back. */
export async function undoSourceChange(
  u: UndoRecord,
  d: { channels: { get(key: string): Promise<EditorCard | null> }; upsert: (key: string, patch: { sources: EditorCard['sources'] }) => Promise<unknown> },
): Promise<void> {
  const channelKey = String(u.channelKey);
  const added = u.added as Pick<CardSource, 'kind' | 'ref'>;
  const card = await d.channels.get(channelKey);
  if (!card) throw new Error(`unknown_channel: ${channelKey} has no card`);
  const at = card.sources.findIndex((s) => sameSource(s, added));
  if (at < 0) throw new Error('the added source is not on the card any more');
  const next = u.action === 'restore' ? card.sources.map((s, i) => (i === at ? (u.old as CardSource) : s)) : card.sources.filter((_, i) => i !== at);
  await d.upsert(card.channelKey, { sources: next });
}
