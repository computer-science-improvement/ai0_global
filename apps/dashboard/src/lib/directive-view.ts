// Pure view helpers for the MANAGER's directives (spec 025 FR-019): the binding
// and kind filters kept in the URL, the board columns, the verification chip,
// a one-line description of an executor's change, the orchestrator's "Active
// effects" and where an Inbox entry about a directive or a pause links to.
// No React and no runtime imports from api/ (the node:test suite loads this).

import type {
  Directive, DirectiveBinding, DirectiveChange, DirectiveKind, DirectiveStatus, ResourcePause,
} from '../api/manager';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

/** Same order as DIRECTIVE_KINDS in api/manager.ts (kept here so this module has no runtime imports). */
export const KIND_ORDER: readonly DirectiveKind[] = [
  'advice', 'task', 'format_shift', 'frequency', 'repost', 'cross_promo', 'pause_series', 'experiment', 'pause_resource', 'strategy',
];

// ── filters (URL search params) ──

export interface DirectiveFilters {
  binding?: DirectiveBinding;
  kinds:    DirectiveKind[];
}

/** `?binding=directive|advice&kind=frequency,format_shift` → filters; unknown values are dropped. */
export function parseDirectiveFilters(s: { binding?: unknown; kind?: unknown }): DirectiveFilters {
  const binding = s.binding === 'directive' || s.binding === 'advice' ? s.binding : undefined;
  const raw = Array.isArray(s.kind) ? s.kind.join(',') : typeof s.kind === 'string' ? s.kind : '';
  const wanted = new Set(raw.split(',').map((k) => k.trim()).filter(Boolean));
  return { binding, kinds: KIND_ORDER.filter((k) => wanted.has(k)) };
}

/** Filters → search params (empty values are left out so a clean URL stays clean). */
export function directiveFilterSearch(f: DirectiveFilters): { binding?: DirectiveBinding; kind?: string } {
  const kinds = KIND_ORDER.filter((k) => f.kinds.includes(k));
  return { binding: f.binding, kind: kinds.length ? kinds.join(',') : undefined };
}

export function toggleKind(f: DirectiveFilters, k: DirectiveKind): DirectiveFilters {
  return { ...f, kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : KIND_ORDER.filter((x) => x === k || f.kinds.includes(x)) };
}

export const hasFilters = (f: DirectiveFilters) => !!f.binding || f.kinds.length > 0;

/** Client-side mirror of the server filters (the board also filters what it already holds). */
export function matchesFilters(d: Pick<Directive, 'binding' | 'kind'>, f: DirectiveFilters): boolean {
  if (f.binding && d.binding !== f.binding) return false;
  return !f.kinds.length || f.kinds.includes(d.kind);
}

// ── board ──

export type ColumnKey = 'awaiting' | 'new' | 'accepted' | 'applied' | 'evaluated' | 'closed';

export const BOARD_COLUMNS: ReadonlyArray<{ key: ColumnKey; label: string; statuses: DirectiveStatus[]; note: string }> = [
  { key: 'awaiting', label: 'Awaiting you', statuses: ['awaiting_owner', 'contested'], note: 'Structural directives wait for your approval; contested ones for your decision.' },
  { key: 'new', label: 'New', statuses: ['new'], note: 'Delivered to the orchestrator on its next run.' },
  { key: 'accepted', label: 'Accepted', statuses: ['accepted'], note: 'Accepted; the executor applies the change.' },
  { key: 'applied', label: 'Applied', statuses: ['applied'], note: 'The change exists; the code checks plans and publishing, then the effect is evaluated.' },
  { key: 'evaluated', label: 'Evaluated', statuses: ['evaluated'], note: 'Outcome measured against the baseline (verified changes only).' },
  { key: 'closed', label: 'Closed', statuses: ['rejected', 'declined', 'failed', 'expired', 'canceled'], note: 'Rejected, declined advice, failed to apply, or timed out.' },
];

export const CLOSED_STATUSES: readonly DirectiveStatus[] = BOARD_COLUMNS.find((c) => c.key === 'closed')!.statuses;
export const OPEN_STATUSES: readonly DirectiveStatus[] = ['awaiting_owner', 'contested', 'new', 'accepted', 'applied'];

export function columnOf(status: DirectiveStatus): ColumnKey {
  return BOARD_COLUMNS.find((c) => c.statuses.includes(status))?.key ?? 'closed';
}

// ── verification ──

export interface Chip { label: string; tone: Tone; title: string }

/**
 * The verification state of an applied / evaluated directive (FR-019): `applied · checking`, `verified ✓`,
 * `not followed`, `self-reported`; plus `not verified` (evaluated without proof) and `applying` (accepted, the
 * change does not exist yet). Null where it does not apply (open, closed before applying).
 */
export function verificationChip(d: Pick<Directive, 'status' | 'verification' | 'verifiedAt' | 'outcomeDetail' | 'change' | 'kind'>): Chip | null {
  const v = d.verification ?? null;
  if (d.status === 'accepted') {
    return d.change ? { label: 'applying', tone: 'neutral', title: 'Accepted; the change is not in place yet (the executor retries hourly)' } : null;
  }
  if (d.status !== 'applied' && d.status !== 'evaluated' && d.status !== 'failed') return null;
  if (v?.kind === 'self_reported' || d.outcomeDetail?.reason === 'self_reported') {
    return { label: 'self-reported', tone: 'neutral', title: 'Followed advice: the orchestrator says it acted on it; nothing to observe, never scored' };
  }
  if (d.verifiedAt) {
    return { label: 'verified ✓', tone: 'success', title: v?.kind === 'reported' ? 'The orchestrator reported what it made; the code checked the reference' : 'The change was observed in plans and publishing' };
  }
  if (v?.adherence === 'violated' || v?.adherence === 'not_followed') {
    return { label: 'not followed', tone: 'danger', title: v.adherence === 'violated' ? 'The plans or publishing went against the change' : 'The change did not show up in plans or publishing' };
  }
  if (d.status === 'failed') return null;
  if (v?.kind === 'unverified' || d.outcomeDetail?.reason === 'not_verified' || d.status === 'evaluated') {
    return { label: 'not verified', tone: 'warning', title: 'Never observed in plans or publishing, so it was not scored' };
  }
  return { label: 'applied · checking', tone: 'neutral', title: 'The change exists; the hourly check looks for it in plans and publishing' };
}

/** Why an evaluated row has no score (FR-016), as a short phrase; null when it was scored. */
export function unscoredReason(d: Pick<Directive, 'outcomeDetail'>): string | null {
  const o = d.outcomeDetail;
  if (!o?.reason) return null;
  if (o.reason === 'not_verified') {
    const adh = o.adherence === 'violated' ? ' · plans went against it' : o.adherence === 'not_followed' ? ' · not followed' : '';
    return `not verified — inconclusive${adh}`;
  }
  if (o.reason === 'self_reported') return 'self-reported advice — not scored';
  if (o.reason === 'owner_override') return 'you edited it by hand — inconclusive';
  return o.reason.replace(/_/g, ' ');
}

// ── change ──

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const perDay = (x: unknown) => {
  const o = (x ?? {}) as { min?: unknown; max?: unknown };
  const mn = num(o.min);
  const mx = num(o.max);
  return mn == null && mx == null ? '?' : mn === mx ? String(mn) : `${mn ?? '?'}–${mx ?? '?'}`;
};
const weight = (x: unknown) => (num(x) == null ? '?' : `${Math.round((x as number) * 100)}%`);

/** "2026-10-12T09:00:00Z" → "12 Oct" (en-GB, Kyiv). */
export function shortDate(iso: string | undefined | null): string {
  if (!iso) return '?';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Kyiv' });
}

/** The executor's change in one line, e.g. "posts a day 2–4 → 3–5 on telegram:@space". */
export function describeChange(c: DirectiveChange | null | undefined): string | null {
  if (!c || typeof c !== 'object') return null;
  const on = c.resource_ref ? ` on ${c.resource_ref}` : '';
  switch (c.op) {
    case 'per_day':        return `posts a day ${perDay(c.before)} → ${perDay(c.after)}${on}`;
    case 'format_weight':  return `${c.format ?? 'format'} weight ${weight(c.before)} → ${weight(c.after)}${on}`;
    case 'series_active':
      if (c.after === false) return `series “${c.series}” paused${c.resume_on ? ` until ${shortDate(c.resume_on)}` : ''}${c.resumed_at ? ' · resumed' : ''}`;
      return `series “${c.series}” active again`;
    case 'pause_resource': return `${c.resource_ref ?? 'resource'} paused for ${c.days ?? '?'} d until ${shortDate(c.until)}`;
    case 'experiment':     return `${c.slots ?? 1} experiment slot${c.slots === 1 ? '' : 's'}${on} by ${shortDate(c.deadline)}${c.format ? ` · ${c.format}` : ''}`;
    case 'playbook_build': return c.version != null
      ? `playbook v${c.version} built from the brief${c.activated_at ? ' · activated' : ' · waits for your activation'}`
      : 'playbook rebuild from the brief · building';
    default:               return c.op ? c.op.replace(/_/g, ' ') : null;
  }
}

// ── orchestrator: active effects ──

export interface ActiveEffect {
  directive: Directive;
  kind:      'playbook' | 'series' | 'experiment' | 'strategy' | 'card' | 'other';
  text:      string;
  /** Until when the effect holds (series pause, experiment deadline), ISO. */
  until?:    string;
  /** The playbook version the directive wrote. */
  version?:  number;
}

/**
 * What MANAGER directives have changed for this orchestrator right now: applied (or accepted with a pending
 * change) rows with an executor change. Resource pauses come from /api/resources/pauses and are shown apart.
 */
export function activeEffectsOf(directives: readonly Directive[], now = new Date()): ActiveEffect[] {
  const out: ActiveEffect[] = [];
  for (const d of directives) {
    if (d.shadow || !d.change || (d.status !== 'applied' && d.status !== 'accepted')) continue;
    const c = d.change;
    if (c.op === 'pause_resource') continue;
    const text = describeChange(c) ?? d.kind;
    if (c.op === 'series_active') {
      if (c.after !== false || c.resumed_at) continue;
      out.push({ directive: d, kind: 'series', text, until: c.resume_on, version: c.version });
    } else if (c.op === 'experiment') {
      if (c.deadline && new Date(c.deadline).getTime() < now.getTime() && d.verifiedAt) continue;
      out.push({ directive: d, kind: 'experiment', text, until: c.deadline });
    } else if (c.op === 'playbook_build') {
      out.push({ directive: d, kind: 'strategy', text, version: c.version });
    } else if (c.target === 'card') {
      out.push({ directive: d, kind: 'card', text });
    } else if (c.op === 'per_day' || c.op === 'format_weight') {
      out.push({ directive: d, kind: 'playbook', text, version: c.version });
    } else {
      out.push({ directive: d, kind: 'other', text });
    }
  }
  return out;
}

/** The active pauses that belong to this orchestrator (by agent id or handle). */
export function pausesOf(pauses: readonly ResourcePause[], agent: { id: string; handle: string }): ResourcePause[] {
  return pauses.filter((p) => p.active && (p.agentId === agent.id || p.agentHandle === agent.handle))
    .sort((a, b) => a.until.localeCompare(b.until));
}

/** Time left until `iso`: "in 3 d", "in 5 h", "in 20 min", or "ended". */
export function timeLeft(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'ended';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${Math.max(min, 1)} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
}

// ── inbox ──

export type InboxTarget =
  | { to: 'directive'; id: string }
  | { to: 'pauses'; handle: string | null }
  | null;

/**
 * Where an Inbox entry links (FR-019): every `directive_*` / `resource_paused|resumed` entry with
 * `refType='directive'` opens the directive on the @manager board; a `resource` pause entry (no directive behind
 * it) opens the orchestrator's Overview, where Active effects lists the pauses.
 */
export function inboxTarget(it: { kind: string; refType: string | null; refId: string | null }, agentHandle: string | null): InboxTarget {
  if (it.refType === 'directive' && it.refId) return { to: 'directive', id: it.refId };
  if (it.refType === 'resource' && (it.kind === 'resource_paused' || it.kind === 'resource_resumed')) return { to: 'pauses', handle: agentHandle };
  return null;
}
