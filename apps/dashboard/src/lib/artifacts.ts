// Spec 048: how the dashboard names, marks and compares artifacts.
import type { IconName } from '../components/ui/Icon';
import type { Tone } from '../components/ui/primitives';
import type { ArtifactType } from '../api/artifacts';

export const ARTIFACT_META: Record<ArtifactType, { label: string; plural: string; icon: IconName }> = {
  setup:      { label: 'Setup',      plural: 'Setups from history', icon: 'sparkles' },
  steering:   { label: 'Steering',   plural: 'Steering',            icon: 'compass' },
  rules:      { label: 'Rules',      plural: 'Owner rules',         icon: 'logs' },
  memory:     { label: 'Memory',     plural: 'Memory',              icon: 'history' },
  skill:      { label: 'Skill',      plural: 'Skills',              icon: 'book' },
  playbook:   { label: 'Playbook',   plural: 'Playbooks',           icon: 'agents' },
  profile:    { label: 'Profile',    plural: 'Profiles',            icon: 'globe' },
  formatting: { label: 'Formatting', plural: 'Formatting',          icon: 'wrench' },
  launch:     { label: 'Launch',     plural: 'Launches',            icon: 'rocket' },
};

const STATUS_TONE: Record<string, Tone> = {
  active: 'success', applied: 'success', partially_applied: 'success',
  ready: 'accent', pending_owner: 'warning',
  queued: 'neutral', collecting: 'neutral', preparing: 'neutral', analyzing: 'neutral', paused: 'warning',
  running: 'accent', graduated: 'success',
  failed: 'danger', no_access: 'danger', too_few_posts: 'warning',
  discarded: 'neutral', superseded: 'neutral',
};

export const artifactTone = (status: string): Tone => STATUS_TONE[status] ?? 'neutral';
export const statusLabel = (status: string) => status.replace(/_/g, ' ');

/** `[[type:id]]` — the reference "Ask the agent" puts into the composer; the agent reads it with get_artifact. */
export const artifactMention = (type: ArtifactType, id: string) => `[[${type}:${id}]]`;

/** `type:id` in the URL (`?art=`) ↔ parts. */
export function parseArtifactParam(v: string | undefined | null): { type: ArtifactType; id: string } | null {
  if (!v) return null;
  const i = v.indexOf(':');
  if (i < 1) return null;
  const type = v.slice(0, i) as ArtifactType;
  const id = v.slice(i + 1);
  return id && type in ARTIFACT_META ? { type, id } : null;
}
export const artifactParam = (type: ArtifactType, id: string) => `${type}:${id}`;

/**
 * A version body as lines for the diff: a skill's text as is, a rules list one rule per line, a steering set one
 * rule per line with its state, anything else as indented JSON.
 */
export function versionText(type: ArtifactType, body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (type === 'skill' && typeof b.body === 'string') return b.body;
    if (Array.isArray(body)) return body.map((r: any) => (r && typeof r === 'object' && 'text' in r ? `#${r.id ?? '?'} ${r.text}` : JSON.stringify(r))).join('\n');
    if (type === 'steering' && Array.isArray(b.rules)) {
      const head = [`status: ${String(b.status ?? '')}`, ...(b.summary ? [`summary: ${String(b.summary)}`] : [])];
      return [...head, ...(b.rules as any[]).map((r) => `${r.id} [${r.kind}]${r.enabled === false ? ' (off)' : ''} ${r.text}`)].join('\n');
    }
  }
  return JSON.stringify(body ?? null, null, 2);
}

/** The Artifacts page's status filter (FR-006): what waits for the owner, what is in use, what is closed. */
export type ArtifactView = 'all' | 'needs-you' | 'in-use' | 'closed';
const NEEDS_YOU = new Set(['ready', 'pending_owner']);
const CLOSED = new Set(['discarded', 'superseded', 'failed', 'no_access', 'too_few_posts', 'none']);
export function artifactView(status: string): Exclude<ArtifactView, 'all'> {
  return NEEDS_YOU.has(status) ? 'needs-you' : CLOSED.has(status) ? 'closed' : 'in-use';
}
export const inView = (view: ArtifactView, status: string) => view === 'all' || artifactView(status) === view;
