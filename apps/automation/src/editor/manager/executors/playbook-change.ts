import { resourceRef, type Platform } from '../../agents/agent.types';
import type { EditorCard } from '../../card';
import { classifyPlaybookChange, type PlatformSection, type Playbook, validatePlaybook } from '../../network/playbook';
import type { Change, ExecContext, PlanError } from './types';

/**
 * Pure helpers shared by the playbook executors (spec 025 FR-009…FR-012) and `directive_lock`:
 * patch a body with a change, check that a body holds it (idempotency) or reverts it (the lock),
 * and resolve where a change lands (the playbook section, or the single-channel card).
 */

export const notExecutable = (details: string): PlanError => ({ error: 'not_executable', details });

const EPS = 1e-9;
export const round2 = (x: number) => Math.round(x * 100) / 100;

/** The orchestrator's Telegram anchor as a resource ref. */
export function anchorRef(ctx: ExecContext): string | null {
  if (ctx.net) return resourceRef('telegram', ctx.net.anchorKey);
  return ctx.card ? resourceRef('telegram', ctx.card.channelKey) : null;
}

export type Target =
  | { target: 'playbook'; ref: string; platform: Platform; section: PlatformSection }
  | { target: 'card'; ref: string; platform: 'telegram'; card: EditorCard };

/**
 * Where a change on `ref` lands. With an active playbook: its section for the resource (the resource must be
 * in the network). Without one: only the Telegram anchor, whose card is edited (FR-009 single-channel fallback).
 */
export function resolveTarget(ctx: ExecContext, refIn: unknown): Target | PlanError {
  const anchor = anchorRef(ctx);
  if (!ctx.card || !ctx.net || !anchor) return notExecutable('в оркестратора немає картки каналу — виконати нічого');
  const ref = typeof refIn === 'string' && refIn.trim() ? refIn.trim() : anchor;
  const res = ctx.net.resources.find((r) => r.ref === ref);
  if (!res) return notExecutable(`ресурс ${ref} не в мережі @${ctx.orch.handle} (є: ${ctx.net.resources.map((r) => r.ref).join(', ')})`);
  if (ctx.playbook) {
    const section = ctx.playbook.platforms.find((s) => s.resource_ref === ref);
    if (!section) return notExecutable(`у плейбуку @${ctx.orch.handle} немає секції ${ref}`);
    return { target: 'playbook', ref, platform: res.platform, section };
  }
  if (ref !== anchor) return notExecutable(`плейбука ще немає — без нього змінюється лише картка ${anchor}`);
  return { target: 'card', ref, platform: 'telegram', card: ctx.card };
}

/** The card as a one-section playbook, so card changes are classified by the same rules. */
export function cardAsPlaybook(card: Pick<EditorCard, 'formats' | 'postsPerDayMin' | 'postsPerDayMax'>, ref: string): Playbook {
  return {
    platforms: [{ resource_ref: ref, role: 'core', formats: { ...card.formats }, per_day: { min: card.postsPerDayMin, max: card.postsPerDayMax }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } }],
    series: [], pillars: [], rules: [],
  };
}

const mapSection = (body: Playbook, ref: string, f: (s: PlatformSection) => PlatformSection): Playbook => {
  if (!body.platforms.some((s) => s.resource_ref === ref)) throw new Error(`section ${ref} is gone from the active playbook`);
  return { ...body, platforms: body.platforms.map((s) => (s.resource_ref === ref ? f(s) : s)) };
};

/** The body with the change applied (throws when its section or series is gone). */
export function patchPlaybook(body: Playbook, c: Change): Playbook {
  switch (c.op) {
    case 'per_day': return mapSection(body, c.resource_ref, (s) => ({ ...s, per_day: { ...c.after } }));
    case 'format_weight': return mapSection(body, c.resource_ref, (s) => ({ ...s, formats: { ...s.formats, [c.format]: c.after } }));
    case 'series_active': {
      if (!body.series.some((s) => s.name === c.series)) throw new Error(`series "${c.series}" is gone from the active playbook`);
      return { ...body, series: body.series.map((s) => (s.name === c.series ? { ...s, active: c.after } : s)) };
    }
    case 'pause_resource': throw new Error('pause_resource does not change the playbook');
  }
}

/** Does `body` already contain `c.after`? (idempotent re-apply, FR-009 "restart between apply and status update"). */
export function holdsIn(body: Playbook | null, c: Change): boolean {
  if (!body) return false;
  switch (c.op) {
    case 'per_day': {
      const s = body.platforms.find((x) => x.resource_ref === c.resource_ref);
      return !!s && s.per_day.min === c.after.min && s.per_day.max === c.after.max;
    }
    case 'format_weight': {
      const s = body.platforms.find((x) => x.resource_ref === c.resource_ref);
      return !!s && Math.abs((s.formats[c.format] ?? 0) - c.after) < EPS;
    }
    case 'series_active': {
      const s = body.series.find((x) => x.name === c.series);
      return !!s && (s.active !== false) === c.after;
    }
    case 'pause_resource': return false;
  }
}

/**
 * Does `body` undo the change (the `directive_lock` check)? Moving further in the directive's direction is
 * not a revert; going back toward `before` is. A removed section/format counts as a revert; a removed series
 * does not (a paused series that is dropped stays not planned).
 */
export function revertsIn(body: Playbook, c: Change): boolean {
  switch (c.op) {
    case 'per_day': {
      const s = body.platforms.find((x) => x.resource_ref === c.resource_ref);
      if (!s) return true;
      const up = c.after.max !== c.before.max ? c.after.max > c.before.max : c.after.min > c.before.min;
      return up ? s.per_day.max < c.after.max || s.per_day.min < c.after.min : s.per_day.max > c.after.max || s.per_day.min > c.after.min;
    }
    case 'format_weight': {
      const s = body.platforms.find((x) => x.resource_ref === c.resource_ref);
      if (!s) return true;
      const w = s.formats[c.format] ?? 0;
      return c.after > c.before ? w < c.after - EPS : w > c.after + EPS;
    }
    case 'series_active': {
      const s = body.series.find((x) => x.name === c.series);
      return !!s && (s.active !== false) !== c.after;
    }
    case 'pause_resource': return false;
  }
}

/** The card edit for a card-target change. */
export function cardPatch(card: Pick<EditorCard, 'formats'>, c: Change): { postsPerDayMin?: number; postsPerDayMax?: number; formats?: Record<string, number> } {
  if (c.op === 'per_day') return { postsPerDayMin: c.after.min, postsPerDayMax: c.after.max };
  if (c.op === 'format_weight') return { formats: { ...card.formats, [c.format]: c.after } };
  throw new Error(`${c.op} has no card fallback`);
}

export function cardHolds(card: Pick<EditorCard, 'formats' | 'postsPerDayMin' | 'postsPerDayMax'> | null, c: Change): boolean {
  return !!card && holdsIn(cardAsPlaybook(card, c.op === 'series_active' ? '' : c.resource_ref), c);
}

/**
 * Classify a dry-run (FR-004): the structural rules of a playbook change (a format added, per_day ≥ ±30 %,
 * a schedule change in approval mode) plus deterministic validation — errors the change introduces make it
 * not executable (pre-existing errors of the playbook are not the directive's fault).
 */
export function dryRunCheck(ctx: ExecContext, prev: Playbook, next: Playbook): { structural: boolean; reasons: string[] } | PlanError {
  if (ctx.net) {
    const tg = ctx.net.telegramFormats;
    const before = new Set(validatePlaybook(prev, ctx.net.resources, tg));
    const fresh = validatePlaybook(next, ctx.net.resources, tg).filter((e) => !before.has(e));
    if (fresh.length) return notExecutable(fresh.join('; '));
  }
  return classifyPlaybookChange(prev, next, { mode: ctx.mode });
}
