// Spec 034 FR-012 / FR-013: what the plan views say about a slot and a plan —
// a live slot's scheduled tool call ("At 14:00: fetch pravda.com.ua → pick the
// freshest item (≤ 6 h) → write photo"), a fixed slot's planning details, why a
// slot was skipped, "Planned at 06:02 by planner run", when the agent plans,
// and the dry-run Preview's button and result. Pure helpers (node tests import
// them); every time goes through an explicit zone, never the browser's.

import type { CriticVerdict } from './critic';
import { formatIn, zoneLabel } from './zoned-time';

/** A live slot's spec as the API returns it (backend LiveSpec). */
export interface LiveSpecView {
  sources:       string[];
  brief:         string;
  max_age_hours: number;
  origin:        'planner' | 'news_watch' | 'pin';
  item?:         { url: string; title: string; published_at?: string | null } | null;
}

/** The owner's dry-run Preview of a fixed planned slot (backend SlotPreview, editor_slots.preview_draft). */
export interface SlotPreviewView {
  status:     'running' | 'ready' | 'rejected' | 'skipped' | 'failed';
  platform:   string | null;
  preview:    string | null;
  spec:       unknown;
  critic:     CriticVerdict | null;
  reason:     string | null;
  warnings:   string[];
  runId:      string | null;
  costUsd:    number;
  startedAt:  string;
  finishedAt: string | null;
}

/** What every plan view knows about a slot (EditorSlot and the network PlanSlot both fit). */
export interface PlanSlotLike {
  at:            string;
  format:        string;
  topic:         string;
  status:        string;
  kind?:         'content' | 'reserved';
  error?:        string | null;
  topicMode?:    'fixed' | 'live' | null;
  liveSpec?:     LiveSpecView | null;
  treatment?:    'unique' | 'duplicate' | 'adapt' | null;
  previewDraft?: SlotPreviewView | null;
}

const PREVIEW_STALE_MS = 10 * 60_000;

function hostOf(u: string): string | null {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/**
 * A source's site name: a feed URL → its host, a card source id → its feed's host (when `feeds` maps
 * ids to URLs), `api:nasa_apod` → "nasa_apod API", `feed:<id>` → like the id.
 */
export function siteName(src: string, feeds: Record<string, string> = {}): string {
  const s = src.trim();
  const host = hostOf(s);
  if (host) return host;
  if (/^api:/i.test(s)) return `${s.slice(4)} API`;
  const id = s.replace(/^(feed|rss):/i, '');
  const ref = feeds[id];
  return (ref && hostOf(ref)) || ref || id;
}

/** id → URL of a card's feeds, so a live slot's sources read as site names. */
export function feedsOf(c: { sources?: Array<{ id: string; kind: string; ref: string }> } | null | undefined): Record<string, string> {
  return Object.fromEntries((c?.sources ?? []).filter((x) => x.kind === 'rss' || x.kind === 'url').map((x) => [x.id, x.ref]));
}

/** "pravda.com.ua, rbc.ua" (unique, in order). */
export function siteList(sources: string[], feeds: Record<string, string> = {}): string {
  return [...new Set(sources.map((s) => siteName(s, feeds)))].join(', ') || 'its feeds';
}

export function isLive(s: Pick<PlanSlotLike, 'topicMode' | 'liveSpec'>): boolean {
  return s.topicMode === 'live' && !!s.liveSpec;
}

/** "At 14:00: fetch pravda.com.ua → pick the freshest item (≤ 6 h) → write photo" — the slot's scheduled tool call. */
export function liveLine(s: Pick<PlanSlotLike, 'at' | 'format' | 'liveSpec'>, tz: string, feeds: Record<string, string> = {}): string {
  const l = s.liveSpec;
  if (!l) return '';
  return `At ${formatIn(s.at, tz)}: fetch ${siteList(l.sources, feeds)} → pick the freshest item (≤ ${l.max_age_hours} h) → write ${s.format}`;
}

/** Where a live slot came from, for its badge. */
export const LIVE_ORIGIN_LABEL: Record<LiveSpecView['origin'], string> = {
  planner: 'live · planner', news_watch: 'live · news watch', pin: 'live · pinned',
};

/** Why a slot did not produce a post, from its `error` (the system's words stay as the detail). */
export interface SkipReason { code: string; label: string; detail: string }

const AGENT_CAUSE_LABEL: Record<string, string> = {
  no_material: 'no material', source_used: 'source already used', source_unreachable: 'source unreachable', quality: 'weak material', other: 'other reason',
};

export function skipReason(error: string | null | undefined): SkipReason | null {
  if (!error) return null;
  const e = error.trim();
  const rest = (prefix: RegExp) => e.replace(prefix, '').trim();
  if (/^no_fresh_item\b/.test(e)) return { code: 'no_fresh_item', label: 'Nothing fresh in the sources', detail: rest(/^no_fresh_item:?/) };
  if (/^critic_rejected\b/.test(e)) return { code: 'critic_rejected', label: 'Rejected by the critic', detail: rest(/^critic_rejected:?/) };
  if (/^critic_failed\b/.test(e)) return { code: 'critic_failed', label: 'Critic unavailable — held', detail: rest(/^critic_failed:?/) };
  if (/^superseded by a new plan/.test(e)) return { code: 'superseded', label: 'Replaced by a newer plan', detail: '' };
  if (/^skipped by owner/.test(e)) return { code: 'owner', label: 'Skipped by you', detail: rest(/^skipped by owner:?/) };
  // Spec 068: the agent names why (`skipped by agent: <cause>: <reason>`); older rows have the reason only.
  const cause = /^skipped by agent:\s*(no_material|source_used|source_unreachable|quality|other):\s*/.exec(e);
  if (cause) return { code: 'agent', label: `Skipped by the agent — ${AGENT_CAUSE_LABEL[cause[1]]}`, detail: e.slice(cause[0].length).trim() };
  if (/^skipped by agent/.test(e)) return { code: 'agent', label: 'Skipped by the agent', detail: rest(/^skipped by agent:?/) };
  if (/^planner_(no_material|source_unreachable)\b/.test(e)) return { code: 'planner_empty', label: 'Declared empty by the planner', detail: rest(/^planner_(no_material|source_unreachable):?/) };
  if (/^preflight_no_material\b/.test(e)) return { code: 'preflight_no_material', label: 'Nothing to post from the library row', detail: rest(/^preflight_no_material:?/) };
  if (/^resource_paused/.test(e)) return { code: 'paused', label: 'Resource paused', detail: '' };
  if (/^resource_unavailable\b/.test(e)) return { code: 'unavailable', label: 'Connection broken', detail: rest(/^resource_unavailable:?/) };
  return { code: 'other', label: 'Note', detail: e };
}

/** "Planned at 06:02 Kyiv" (the plan's creation time in the channel's zone). */
export function plannedAtLine(plannedAt: string | null | undefined, tz: string): string | null {
  if (!plannedAt) return null;
  return `Planned at ${formatIn(plannedAt, tz)} ${zoneLabel(tz)}`;
}

/** The run that made a plan, as a link label: "planner run", "orchestrator run". */
export function runLabel(role: string | null | undefined): string {
  return `${role ? role.replace(/_/g, ' ') : 'agent'} run`;
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * Spec 034 FR-013: when the agent plans. Live / shadow: daily at the card's plan hour. Approval mode: the next
 * day is planned the evening before at the batch hour (20:00), so the owner approves it that evening.
 */
export function planScheduleNote(s: { planHour: number; timezone: string; approval: boolean; batchHour?: number }): string {
  const zone = zoneLabel(s.timezone);
  if (s.approval) {
    return `In approval: each day is planned the evening before at ${hh(s.batchHour ?? 20)} ${zone} and approved that evening; a day still without a plan is planned at ${hh(s.planHour)}.`;
  }
  return `Planned daily at ${hh(s.planHour)} ${zone}; "Replan the rest of today" re-plans only future planned slots.`;
}

/** Did the evening batch make this plan (a plan made the day before its date in approval mode)? */
export function plannedEveningBefore(plannedAt: string | null | undefined, planDate: string, tz: string): boolean {
  if (!plannedAt) return false;
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(plannedAt));
  return d < planDate;
}

// ── the dry-run Preview ───────────────────────────────────────────────────────

/** A running preview older than this belongs to a crashed process (the server lets a new one start). */
export function previewRunning(p: SlotPreviewView | null | undefined, now: number = Date.now()): boolean {
  return !!p && p.status === 'running' && now - new Date(p.startedAt).getTime() < PREVIEW_STALE_MS;
}

/** Only a fixed planned content slot can be previewed (a live slot picks its item at its time; derived slots follow their source). */
export function canPreview(s: PlanSlotLike): boolean {
  return s.status === 'planned' && (s.kind ?? 'content') === 'content' && !isLive(s) && s.treatment !== 'duplicate' && s.treatment !== 'adapt';
}

const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;

/** The button's cost hint: "≈ $0.004" from the channel's recent runs, else "about one executor run". */
export function previewCostHint(estimateUsd: number | null | undefined): string {
  return estimateUsd != null && estimateUsd > 0 ? `≈ ${money(estimateUsd)}` : 'about one executor run';
}

export const PREVIEW_STATUS_LABEL: Record<SlotPreviewView['status'], string> = {
  running: 'Writing the preview…', ready: 'Preview (dry run)', rejected: 'Preview rejected by the critic', skipped: 'The agent would skip this slot', failed: 'Preview failed',
};

/** "Dry run at 09:14 · $0.006 · nothing was published" — the line under a finished preview. */
export function previewFootnote(p: SlotPreviewView, tz: string): string {
  const when = p.finishedAt ?? p.startedAt;
  return `Dry run at ${formatIn(when, tz)} ${zoneLabel(tz)} · ${money(p.costUsd)} · nothing was published or stored for the slot; the real post is written at the slot time.`;
}
