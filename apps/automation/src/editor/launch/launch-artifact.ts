import type { AgentDirectory, ArtifactAdapter } from '../artifacts/artifact-adapters';
import type { ArtifactAction, ArtifactRow } from '../artifacts/artifact.types';
import { refName } from '../steering/steering.repository';
import type { ChannelLaunch } from './launch.types';

/**
 * Spec 052 FR-005: the launch as a 048 artifact (type `launch`) — listed on /app/artifacts and the agent's Artifacts tab,
 * opened in the chat's side panel. Not versioned: the launch keeps its own history (status, plan, checklist).
 */

const LABEL: Record<string, string> = {
  queued: 'queued', preparing: 'reading references', analyzing: 'making the plan', ready: 'plan ready', running: 'running',
  graduated: 'live', failed: 'failed', discarded: 'discarded',
};

export const launchTitle = (l: Pick<ChannelLaunch, 'channelKey'>) => `Launch · ${l.channelKey}`;

export function launchSummary(l: ChannelLaunch): string {
  const refs = l.refs.length ? ` · ${l.refs.map((r) => refName(r.ref)).join(', ')}` : '';
  if (l.status === 'failed' || l.status === 'discarded') return `${LABEL[l.status]}${l.reason ? ` — ${l.reason}` : ''}`;
  if (l.status === 'running') return `in approval since ${l.startedAt ? new Date(l.startedAt).toISOString().slice(0, 10) : '—'}${refs}`;
  if (l.status === 'ready' && l.startRequested) return `starts when the bot is an admin${refs}`;
  return `${LABEL[l.status] ?? l.status}${refs}`;
}

/** The owner's actions now: each one is an endpoint of the launch API. */
export function launchActions(r: Pick<ArtifactRow, 'id' | 'status'>, l: Pick<ChannelLaunch, 'startRequested'> | null): ArtifactAction[] {
  const p = (a: string) => `/api/launches/${r.id}/${a}`;
  const out: ArtifactAction[] = [];
  if (r.status === 'ready' && !l?.startRequested) out.push({ key: 'start', label: 'Start', method: 'POST', path: p('start') });
  if (['preparing', 'ready'].includes(r.status) || (r.status === 'ready' && l?.startRequested)) {
    out.push({ key: 'check', label: 'Check the bot now', method: 'POST', path: p('check') });
  }
  if (r.status === 'running') out.push({ key: 'go_live', label: 'Go live', method: 'POST', path: p('go-live') });
  if (r.status === 'ready' || r.status === 'failed') out.push({ key: 'redo', label: 'Make the plan again', method: 'POST', path: p('redo') });
  if (['queued', 'preparing', 'analyzing', 'ready', 'failed', 'running'].includes(r.status)) {
    out.push({ key: 'discard', label: r.status === 'running' ? 'Stop the launch' : 'Discard', method: 'POST', path: p('discard'), danger: true });
  }
  return out;
}

export function launchAdapter(d: {
  list(f: { channel?: string | null; status?: string | null; limit?: number }): Promise<ChannelLaunch[]>;
  get(id: string): Promise<ChannelLaunch | null>;
  /** The panel's body: the launch with its live checklist and progress. */
  view(l: ChannelLaunch): Promise<unknown>;
}): ArtifactAdapter {
  const row = (l: ChannelLaunch, dir: AgentDirectory): ArtifactRow => ({
    type: 'launch', id: l.id, title: launchTitle(l), agent: dir.byRef.get(l.targetRef) ?? null, channel: l.channelKey,
    target: l.targetRef, status: l.status, version: null, updatedAt: new Date(l.updatedAt).toISOString(), summary: launchSummary(l),
    live: false,
  });
  return {
    type: 'launch',
    async list(f, dir) {
      const ls = await d.list({ channel: f.channel ?? (f.ref?.startsWith('telegram:') ? f.ref.slice('telegram:'.length) : null), status: f.status ?? null, limit: f.limit });
      return ls.map((l) => row(l, dir));
    },
    async get(id, dir) {
      const l = await d.get(id);
      if (!l) return null;
      return { row: row(l, dir), body: await d.view(l) };
    },
    versions: async () => [],
    version: async () => undefined,
    actions(r, body) {
      const b = body as { startRequested?: boolean } | null;
      return launchActions(r, b ? { startRequested: !!b.startRequested } : null);
    },
  };
}
