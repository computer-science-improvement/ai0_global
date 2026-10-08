import { CAPABILITIES, implementedFormats } from '../../platform/capabilities';
import type { EditorChannelsRepository } from '../../repo/editor-channels.repository';
import type { NetworkRepository } from '../../network/network.repository';
import type { Playbook } from '../../network/playbook';
import { localDate } from '../../roles/time';
import type { Directive } from '../directives.repository';
import type { PlanObserver } from './plan-observer';
import {
  anchorRef, cardAsPlaybook, cardHolds, cardPatch, dryRunCheck, holdsIn, notExecutable, patchPlaybook, resolveTarget, round2,
} from './playbook-change';
import type { AnyChange, Applied, Change, ChangeOp, DirectiveExecutor, ExecContext, PlanResult, VerifyResult } from './types';

/**
 * The playbook executors (spec 025 FR-010 frequency, FR-011 format_shift, FR-012 pause_series).
 * A playbook change becomes a new active version written by the directive; a single-channel orchestrator
 * without a playbook gets its card edited instead.
 */

export interface PlaybookExecutorDeps {
  network:  Pick<NetworkRepository, 'applyDirectivePatch' | 'activePlaybook'>;
  channels: Pick<EditorChannelsRepository, 'get' | 'patchPlanning'>;
  observer: PlanObserver;
}

export const FREQUENCY_PCT = { min: -60, max: 100 };
export const FORMAT_DELTA_MAX = 0.3;
export const PAUSE_SERIES_DAYS = { default: 14, max: 28 };
export const FORMAT_VERIFY_PLAN_DAYS = 3;
const KYIV = 'Europe/Kyiv';

/** Build the change for an op: the next body, the dry-run checks, the classification. */
function finish(ctx: ExecContext, kind: Change['kind'], target: 'playbook' | 'card', op: ChangeOp): PlanResult<Change> {
  const ref = op.op === 'series_active' ? null : op.resource_ref;
  const channelKey = ctx.net?.anchorKey ?? ctx.card?.channelKey;
  const prev: Playbook = target === 'playbook' ? ctx.playbook! : cardAsPlaybook(ctx.card!, ref!);
  const draft = { kind, target, channel_key: channelKey, structural: false, reasons: [], ...op } as Change;
  const next = patchPlaybook(prev, draft);
  // A card target is checked against every implemented Telegram format (the card defines them), not only the active ones.
  const check = dryRunCheck(target === 'card' && ctx.net ? { ...ctx, net: { ...ctx.net, telegramFormats: implementedFormats('telegram') } } : ctx, prev, next);
  if ('error' in check) return check;
  return { ...draft, structural: check.structural, reasons: check.reasons };
}

/** Write a change (idempotent) and re-read it. */
async function applyChange(d: PlaybookExecutorDeps, change: Change, dir: Pick<Directive, 'id' | 'toAgentId' | 'kind'>): Promise<Applied> {
  if (change.target === 'card') {
    const key = change.channel_key;
    if (!key) throw new Error('card change without channel_key');
    const card = await d.channels.get(key);
    if (!card) throw new Error(`card ${key} is gone`);
    if (cardHolds(card, change)) return { noop: true };
    await d.channels.patchPlanning(key, cardPatch(card, change));
    if (!cardHolds(await d.channels.get(key), change)) throw new Error('the card does not hold the change after the update');
    return { noop: false };
  }
  const r = await d.network.applyDirectivePatch(dir.toAgentId, dir.id,
    (active) => (holdsIn(active, change) ? null : patchPlaybook(active, change)),
    `Directive ${dir.kind} (${dir.id.slice(0, 8)}): ${change.reasons.join('; ') || describe(change)}`);
  if ('error' in r) throw new Error('no active playbook');
  // Applied = the version is active and re-read (FR-010).
  const now = await d.network.activePlaybook(dir.toAgentId);
  if (!now || !holdsIn(now.body, change)) throw new Error('the active playbook does not hold the change after the write');
  return { noop: r.noop, playbookId: now.id, version: now.version };
}

export function describe(c: AnyChange): string {
  switch (c.op) {
    case 'per_day': return `${c.resource_ref}: posts per day ${c.before.min}–${c.before.max} → ${c.after.min}–${c.after.max}`;
    case 'format_weight': return `${c.resource_ref}: weight of ${c.format} ${c.before} → ${c.after}`;
    case 'series_active': return `series "${c.series}" ${c.after ? 'resumed' : `paused until ${c.resume_on ?? '—'}`}`;
    case 'pause_resource': return `${c.resource_ref}: paused for ${c.days} day(s) until ${c.until}`;
    case 'experiment': return `${c.resource_ref}: experiment "${c.angle.slice(0, 80)}"${c.format ? ` (${c.format})` : ''} — ${c.slots} slot(s) within ${c.within_days} day(s)`;
    case 'playbook_build': return `playbook rebuild from the directive's brief (the owner activates the new version)`;
  }
}

const slotsOn = <T extends { ref: string }>(plan: { slots: T[] }, ref: string): T[] => plan.slots.filter((s) => s.ref === ref);

// ── frequency (FR-010) ──────────────────────────────────────────────────────

export function frequencyExecutor(d: PlaybookExecutorDeps): DirectiveExecutor {
  return {
    kind: 'frequency',
    plan(dir, ctx) {
      const pct = Number((dir.params as any)?.change_pct);
      if (!Number.isFinite(pct) || pct < FREQUENCY_PCT.min || pct > FREQUENCY_PCT.max || pct === 0) {
        return notExecutable(`change_pct має бути в межах ${FREQUENCY_PCT.min}…${FREQUENCY_PCT.max} і не 0`);
      }
      const t = resolveTarget(ctx, (dir.params as any)?.resource_ref);
      if ('error' in t) return t;
      const before = t.target === 'playbook' ? { ...t.section.per_day } : { min: t.card.postsPerDayMin, max: t.card.postsPerDayMax };
      const f = 1 + pct / 100;
      const clamp = (x: number) => Math.min(24, Math.max(0, Math.round(x)));
      const cap = t.platform === 'telegram' ? 24 : CAPABILITIES[t.platform].dailyApiCap;
      const max = Math.min(Math.max(clamp(before.max * f), 1), cap);
      const min = Math.min(clamp(before.min * f), max);
      if (min === before.min && max === before.max) {
        return notExecutable(`частота ${t.ref} ${before.min}–${before.max} після ${pct > 0 ? '+' : ''}${pct}% не змінюється (округлення, межі 0–24, ліміт API ${cap}) — візьми більшу зміну`);
      }
      return finish(ctx, 'frequency', t.target, { op: 'per_day', resource_ref: t.ref, before, after: { min, max } });
    },
    apply: (change, dir) => applyChange(d, change, dir),
    /** Verified: the first plan after applied_at puts the resource within the new range; otherwise violated. */
    async verify(dir): Promise<VerifyResult> {
      const c = dir.change as Change | null;
      if (!c || c.op !== 'per_day' || !c.channel_key || !dir.appliedAt) return { verified: false, adherence: 'not_followed', detail: { reason: 'no change recorded' } };
      const [plan] = await d.observer.plans(c.channel_key, { after: dir.appliedAt, limit: 1 });
      if (!plan) return { pending: true };
      const n = slotsOn(plan, c.resource_ref).length;
      const ok = n >= c.after.min && n <= c.after.max;
      return { verified: ok, adherence: ok ? 'followed' : 'violated', detail: { plan_date: plan.planDate, slots: n, range: c.after } };
    },
  };
}

// ── format_shift (FR-011) ───────────────────────────────────────────────────

export function formatShiftExecutor(d: PlaybookExecutorDeps): DirectiveExecutor {
  return {
    kind: 'format_shift',
    plan(dir, ctx) {
      const p = (dir.params ?? {}) as Record<string, unknown>;
      const format = typeof p.format === 'string' ? p.format.trim() : '';
      const delta = Number(p.weight_delta);
      if (!format) return notExecutable('вкажи params.format');
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > FORMAT_DELTA_MAX + 1e-9) return notExecutable(`weight_delta має бути в межах ±${FORMAT_DELTA_MAX} і не 0`);
      const t = resolveTarget(ctx, p.resource_ref);
      if ('error' in t) return t;
      const allowed = implementedFormats(t.platform);
      if (!allowed.includes(format)) return notExecutable(`формат ${format} недоступний для ${t.platform} (є: ${allowed.join(', ')})`);
      const formats = t.target === 'playbook' ? t.section.formats : t.card.formats;
      const before = formats[format] ?? 0;
      const after = round2(Math.min(1, Math.max(0, before + delta)));
      if (Math.abs(after - before) < 1e-9) return notExecutable(`вага ${format} уже ${before} — зміна нічого не дасть`);
      if (!Object.entries({ ...formats, [format]: after }).some(([, w]) => w > 0)) return notExecutable('хоча б один формат має лишитися з вагою > 0');
      return finish(ctx, 'format_shift', t.target, { op: 'format_weight', resource_ref: t.ref, format, before, after });
    },
    apply: (change, dir) => applyChange(d, change, dir),
    /**
     * Verified: over the next 3 plan days the format's share on the resource moved in the delta's direction
     * (a positive delta: at least one slot used it); otherwise not_followed.
     */
    async verify(dir): Promise<VerifyResult> {
      const c = dir.change as Change | null;
      if (!c || c.op !== 'format_weight' || !c.channel_key || !dir.appliedAt) return { verified: false, adherence: 'not_followed', detail: { reason: 'no change recorded' } };
      const after = await d.observer.plans(c.channel_key, { after: dir.appliedAt, limit: FORMAT_VERIFY_PLAN_DAYS });
      const mine = after.flatMap((p) => slotsOn(p, c.resource_ref));
      const used = mine.filter((s) => s.format === c.format).length;
      const share = mine.length ? used / mine.length : 0;
      const detail = { plan_days: after.map((p) => p.planDate), slots: mine.length, used, share: round2(share) };
      if (c.after > c.before) {
        if (used > 0) return { verified: true, adherence: 'followed', detail };
        if (after.length < FORMAT_VERIFY_PLAN_DAYS) return { pending: true, detail };
        return { verified: false, adherence: 'not_followed', detail };
      }
      if (after.length < FORMAT_VERIFY_PLAN_DAYS) return { pending: true, detail };
      const before = (await d.observer.plans(c.channel_key, { before: dir.appliedAt, limit: FORMAT_VERIFY_PLAN_DAYS })).flatMap((p) => slotsOn(p, c.resource_ref));
      const shareBefore = before.length ? before.filter((s) => s.format === c.format).length / before.length : null;
      const ok = share === 0 || (shareBefore != null && share < shareBefore);
      return { verified: ok, adherence: ok ? 'followed' : 'not_followed', detail: { ...detail, share_before: shareBefore == null ? null : round2(shareBefore) } };
    },
  };
}

// ── pause_series (FR-012) ───────────────────────────────────────────────────

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function pauseSeriesExecutor(d: PlaybookExecutorDeps): DirectiveExecutor {
  return {
    kind: 'pause_series',
    plan(dir, ctx) {
      const p = (dir.params ?? {}) as Record<string, unknown>;
      const name = String(p.series ?? p.name ?? '').trim();
      if (!name) return notExecutable('вкажи params.series — назву серії');
      if (!ctx.card || !ctx.net || !anchorRef(ctx)) return notExecutable('в оркестратора немає картки каналу — виконати нічого');
      if (!ctx.playbook) return notExecutable('плейбука немає — серій теж');
      const s = ctx.playbook.series.find((x) => x.name === name);
      if (!s) return notExecutable(`серії «${name}» немає (є: ${ctx.playbook.series.map((x) => x.name).join(', ') || '—'})`);
      if (s.locked) return notExecutable(`серію «${name}» заблокував власник — директива її не змінює`);
      if (s.active === false) return notExecutable(`серія «${name}» уже на паузі`);
      const today = localDate(ctx.now, KYIV);
      const resume = p.resume_on == null ? addDays(today, PAUSE_SERIES_DAYS.default) : String(p.resume_on);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(resume) || Number.isNaN(new Date(`${resume}T12:00:00Z`).getTime())) return notExecutable('resume_on — дата YYYY-MM-DD (Київ)');
      if (resume <= today || resume > addDays(today, PAUSE_SERIES_DAYS.max)) return notExecutable(`resume_on має бути після ${today} і не пізніше ${addDays(today, PAUSE_SERIES_DAYS.max)}`);
      return finish(ctx, 'pause_series', 'playbook', { op: 'series_active', series: name, before: true, after: false, resume_on: resume });
    },
    apply: (change, dir) => applyChange(d, change, dir),
    /** Verified: no `series:<name>` slot in the first plan after applied_at (validateNetworkPlan refuses inactive series). */
    async verify(dir): Promise<VerifyResult> {
      const c = dir.change as Change | null;
      if (!c || c.op !== 'series_active' || !c.channel_key || !dir.appliedAt) return { verified: false, adherence: 'not_followed', detail: { reason: 'no change recorded' } };
      const [plan] = await d.observer.plans(c.channel_key, { after: dir.appliedAt, limit: 1 });
      if (!plan) return { pending: true };
      const hits = plan.slots.filter((s) => s.series === c.series).length;
      return { verified: hits === 0, adherence: hits === 0 ? 'followed' : 'violated', detail: { plan_date: plan.planDate, series_slots: hits } };
    },
  };
}

/** The change that lifts a pause_series on its resume date (written as a version of the same directive). */
export function resumeChange(c: Change): Change | null {
  if (c.op !== 'series_active' || c.after !== false) return null;
  return { ...c, before: false, after: true, reasons: [`series "${c.series}" resumed on ${c.resume_on}`] };
}
