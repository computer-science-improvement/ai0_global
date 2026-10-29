// Shared bits of the network tabs on /app/agents/$handle (spec 020): platform
// glyphs with a small per-destination tint, resource chips, status tones,
// a 1–5 score meter, the "no network" handling and date helpers.
// Spec 078 D3: the look is classes (amg-* in agent-manager.css; the per-destination tints live there too).

import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { EmptyState, type Tone } from '../ui/primitives';
import { describeError } from '../ui/Toast';
import { errorBody } from '../../api/agents';
import { parseRef, useResourceLabels, type IdeaOrigin, type IdeaStatus, type NetworkMode, type Platform, type PlaybookStatus } from '../../api/network';

export const PLATFORM_LABEL: Record<Platform, string> = {
  telegram: 'Telegram', facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube',
};

const PLATFORM_ICON: Record<Platform, IconName> = {
  telegram: 'telegram', facebook: 'facebook', instagram: 'instagram', threads: 'threads', tiktok: 'tiktok', youtube: 'globe',
};

export const NETWORK_MODE_TONE: Record<NetworkMode, Tone> = { single: 'neutral', legacy_duplicate: 'neutral', independent: 'success' };
export const NETWORK_MODE_LABEL: Record<NetworkMode, string> = { single: 'single', legacy_duplicate: 'auto-duplicate', independent: 'independent' };

export const PLAYBOOK_TONE: Record<PlaybookStatus, Tone> = {
  draft: 'neutral', pending_owner: 'warning', active: 'success', superseded: 'neutral', rejected: 'danger',
};

export const IDEA_TONE: Record<IdeaStatus, Tone> = {
  new: 'warning', accepted: 'success', needs_revision: 'warning', rejected: 'danger', planned: 'accent', used: 'neutral', expired: 'neutral',
};

export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  new: 'new', accepted: 'accepted', needs_revision: 'needs revision', rejected: 'rejected', planned: 'planned', used: 'used', expired: 'expired',
};

export const ORIGIN_LABEL: Record<IdeaOrigin, string> = {
  orchestrator: 'orchestrator', series: 'series', directive: 'directive', owner: 'owner', trend: 'trend',
};

/** A platform glyph in its tint (the per-destination colour is the `.amg-plat.is-<platform>` class). */
export function PlatformIcon({ platform, size = 14, style }: { platform: Platform | null; size?: number; style?: CSSProperties }) {
  return (
    <span aria-label={platform ? PLATFORM_LABEL[platform] : 'resource'} title={platform ? PLATFORM_LABEL[platform] : undefined}
      className={`amg-plat${platform ? ` is-${platform}` : ''}`} style={style}>
      <Icon name={platform ? PLATFORM_ICON[platform] : 'globe'} size={size} />
    </span>
  );
}

/** Platform icon + readable resource label (Meta/TikTok uuids resolved to @username). */
export function ResourceLabel({ refId, strong = false, extra }: { refId: string; strong?: boolean; extra?: ReactNode }) {
  const label = useResourceLabels();
  const l = label(refId);
  return (
    <span title={l.title} className="amg-res">
      <PlatformIcon platform={l.platform} />
      <span className={`amg-res-name${strong ? ' is-strong' : ''}`}>{l.label}</span>
      {extra}
    </span>
  );
}

/** A neutral chip: platform icon + label (+ optional suffix like a format). */
export function ResourceChip({ refId, suffix, title }: { refId: string; suffix?: ReactNode; title?: string }) {
  const label = useResourceLabels();
  const l = label(refId);
  return (
    <span className="chip amg-reschip" title={title ?? l.title}>
      <PlatformIcon platform={l.platform} size={12} />
      <span className="amg-trunc">{l.label}</span>
      {suffix != null && <span className="amg-reschip-suffix">· {suffix}</span>}
    </span>
  );
}

export const platformOf = (ref: string) => parseRef(ref).platform;

const SCORE_TONE = (n: number) => (n <= 2 ? 'bad' : n === 3 ? 'mid' : 'good');

/** A 1–5 meter: five tiny segments, coloured by the score. */
export function ScoreMeter({ label, value, title }: { label: string; value: number | undefined; title?: string }) {
  const v = typeof value === 'number' ? Math.max(0, Math.min(5, Math.round(value))) : 0;
  return (
    <span title={`${title ?? label}: ${typeof value === 'number' ? `${value}/5` : 'not scored'}`} className="amg-score">
      <span className="amg-score-label">{label}</span>
      <span className="amg-score-bar" aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => <span key={i} className={`amg-score-seg${i <= v ? ` is-${SCORE_TONE(v)}` : ''}`} />)}
      </span>
    </span>
  );
}

/** A horizontal 0–1 weight bar with its value. */
export function WeightBar({ label, value, max = 1 }: { label: string; value: number; max?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="amg-weight">
      <span className="text-micro amg-muted amg-trunc" title={label}>{label}</span>
      <span className="amg-weight-track"><span className="amg-weight-fill" style={{ width: `${pct}%` }} /></span>
      <span className="text-micro mono tabular-nums amg-muted amg-weight-val">{value.toFixed(2)}</span>
    </div>
  );
}

/** Error of a network endpoint as an empty state (no channel card) or a callout. */
export function NetworkError({ error }: { error: unknown }) {
  const code = errorBody(error)?.error;
  if (code === 'no_channel_card') {
    return <EmptyState icon="agents" title="No Telegram channel"
      note="Playbooks, ideas and network plans belong to an orchestrator anchored on a Telegram channel card." />;
  }
  if (code === 'agent_not_found') return <EmptyState icon="agents" title="Agent not found" />;
  return <div className="callout-danger">{describeError(error)}</div>;
}

/** The server error code + details of a failed request, for toasts. */
export function errorText(err: unknown): string {
  const b = errorBody(err);
  if (b?.details && typeof b.details === 'string') return b.details;
  if (b?.error) return b.error.replace(/_/g, ' ');
  return describeError(err);
}

// ── dates (owner's local day) ──

export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Calendar arithmetic on "YYYY-MM-DD" (UTC-based, so no browser zone or DST can shift it). */
export function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return DAY_FMT.format(new Date(Date.UTC(y, m - 1, d)));
}

/** "in 3h" / "in 2d" / "expired 5h ago". */
export function fmtExpires(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const h = Math.round(abs / 3_600_000);
  const span = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))}m` : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
  return ms >= 0 ? `expires in ${span}` : `expired ${span} ago`;
}

export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

const DAY = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' } as Record<string, string>;
/** daily@09:00 → "daily 09:00"; weekly:sun@10:00 → "Sun 10:00"; series v2 (023): weekly:mon,thu@09:00,19:30 → "Mon, Thu 09:00, 19:30". */
export function fmtCadence(c: string): string {
  const m = /^(daily|weekly:([a-z]{3}(?:,[a-z]{3})*))@(\d{2}:\d{2}(?:,\d{2}:\d{2})*)$/.exec(c);
  if (!m) return c;
  const times = m[3].split(',').join(', ');
  return m[1] === 'daily' ? `daily ${times}` : `${m[2].split(',').map((d) => DAY[d] ?? d).join(', ')} ${times}`;
}

