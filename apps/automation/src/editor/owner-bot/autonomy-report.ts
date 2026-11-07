import type { AutonomyDecision, AutonomyDecisionsRepository, DecisionAction } from '../autonomy/autonomy-decisions.repository';
import { esc, plural } from './owner-text';

/**
 * Spec 090 FR-011: the owner's digest of what the system decided because the owner stayed silent («Зроблено без вас»),
 * and the short list of decisions that stay human (FR-009, «Чекає саме на вас»). Pure formatting plus two reads; the
 * report schedule (`owner-reports.ts`) places the sections.
 */

export type DecisionsReader = Pick<AutonomyDecisionsRepository, 'list' | 'counts'>;

/** Short Ukrainian label per gate family (the closed set the writers use). */
export const GATE_FAMILY_UK: Record<string, string> = {
  directive: 'директиви', pending_action: 'картки агентів', playbook: 'плейбуки', audit_fix: 'виправлення з аудиту',
  readiness_fix: 'виправлення готовності', series_pause: 'серії відновлено', setup_proposal: 'налаштування каналів',
  launch_graduation: 'перехід у Live',
};
export const familyUk = (f: string): string => GATE_FAMILY_UK[f] ?? f;

/** Order of the families in a report (the registry order, then anything unknown). */
const FAMILY_ORDER = Object.keys(GATE_FAMILY_UK);

export type FamilyCount = { family: string; done: number; failed: number; undone: number };

/** Folds `counts()` rows into one entry per family: done = applied + dropped + resumed. */
export function foldCounts(rows: Array<{ family: string; action: DecisionAction; n: number }>): FamilyCount[] {
  const by = new Map<string, FamilyCount>();
  for (const r of rows) {
    const c = by.get(r.family) ?? { family: r.family, done: 0, failed: 0, undone: 0 };
    if (r.action === 'failed') c.failed += r.n;
    else if (r.action === 'undone') c.undone += r.n;
    else c.done += r.n;
    by.set(r.family, c);
  }
  const rank = (f: string) => { const i = FAMILY_ORDER.indexOf(f); return i < 0 ? FAMILY_ORDER.length : i; };
  return [...by.values()].filter((c) => c.done || c.failed || c.undone).sort((a, b) => rank(a.family) - rank(b.family) || a.family.localeCompare(b.family));
}

function familyLine(c: FamilyCount): string {
  const bits = [`${c.done}`];
  if (c.failed) bits.push(`❌ помилок: ${c.failed}`);
  if (c.undone) bits.push(`↩ скасовано вами: ${c.undone}`);
  return `${familyUk(c.family)}: ${bits.join(' · ')}`;
}

/** At most this many decision lines in the daily report. */
export const MAX_DECISION_LINES = 5;

const lineOf = (d: AutonomyDecision): string => {
  const mark = d.action === 'failed' ? '❌' : d.action === 'dropped' ? '⏭' : '✅';
  return `${mark} ${d.channelKey ? `<b>${esc(d.channelKey)}</b>: ` : ''}${esc(d.summary.slice(0, 160))}`;
};

/** Failed first, then the newest. */
export function pickDecisionLines(list: AutonomyDecision[], max = MAX_DECISION_LINES): AutonomyDecision[] {
  const real = list.filter((d) => d.action !== 'undone');
  return [...real.filter((d) => d.action === 'failed'), ...real.filter((d) => d.action !== 'failed')].slice(0, max);
}

/** The daily section «Зроблено без вас»; empty (so the report leaves it out) when nothing was decided in [from, to). */
export async function silentDecisionsDaily(repo: DecisionsReader | undefined, from: Date, to: Date): Promise<string[]> {
  if (!repo) return [];
  const [counts, list] = await Promise.all([repo.counts(from, to), repo.list({ since: from, limit: 50 })]);
  const fam = foldCounts(counts);
  if (!fam.length) return [];
  const lines = pickDecisionLines(list.filter((d) => d.decidedAt < to));
  const out = ['<b>Зроблено без вас</b>', ...fam.map(familyLine)];
  out.push(...lines.map(lineOf));
  const total = fam.reduce((n, c) => n + c.done + c.failed, 0);
  if (total > lines.length) out.push(`… всього ${total} (дашборд → Health → Decided without you)`);
  return out;
}

/** The weekly lines: one per family. Empty when the week had none. */
export async function silentDecisionsWeekly(repo: DecisionsReader | undefined, from: Date, to: Date): Promise<string[]> {
  if (!repo) return [];
  const fam = foldCounts(await repo.counts(from, to));
  return fam.length ? ['<b>Зроблено без вас</b>', ...fam.map(familyLine)] : [];
}

// ── «Чекає саме на вас» (FR-009) ─────────────────────────────────────────────

export interface HumanOnlyItem { label: string; n: number; oldest: Date }

/** "3 дні", "5 год", "20 хв" – the age of the oldest open item. */
export function ageUk(from: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (min < 60) return `${min} хв`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} год`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, 'день', 'дні', 'днів')}`;
}

export function humanOnlyLines(items: HumanOnlyItem[], now: Date): string[] {
  const open = items.filter((i) => i.n > 0);
  if (!open.length) return [];
  return ['<b>Чекає саме на вас</b>', ...open.map((i) => `• ${esc(i.label)}: ${i.n} (найстаріше — ${ageUk(i.oldest, now)})`)];
}

type Q = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

/**
 * The open FR-009 items the code can find today. Each probe is its own query and a failed one is skipped (an older database
 * may lack a table), so a report never fails for this section. Not mapped (no open-item store to read): bot admin rights
 * on their own (shown through the launch Start card and `connection_broken` notes), mode switches (a setting, nothing waits).
 */
export async function humanOnlyItems(pool: Q): Promise<HumanOnlyItem[]> {
  const probes: Array<[string, string]> = [
    ['Підключення й токени', `SELECT count(*)::int AS n, min(created_at) AS oldest FROM agent_inbox
        WHERE read_at IS NULL AND (kind = 'connection_broken'
           OR (kind = 'resource_health' AND parts && ARRAY['state:token_invalid', 'state:no_access']::text[]))`],
    ['Бюджет зупинив роботу', `SELECT count(*)::int AS n, min(created_at) AS oldest FROM agent_inbox WHERE read_at IS NULL AND kind = 'budget_blocked'`],
    ['Пости на схвалення', `SELECT count(*)::int AS n, min(updated_at) AS oldest FROM editor_slots WHERE status = 'awaiting_approval'`],
    ['Старт запуску каналу', `SELECT count(*)::int AS n, min(updated_at) AS oldest FROM channel_launches WHERE status = 'ready'`],
    ['Директиви: крос-промо, стратегія, пауза каналу', `SELECT count(*)::int AS n, min(created_at) AS oldest FROM agent_directives
        WHERE status = 'awaiting_owner' AND NOT shadow AND kind IN ('cross_promo', 'strategy', 'pause_resource')`],
    ['Стиль за референсом (steering)', `SELECT count(*)::int AS n, min(updated_at) AS oldest FROM steering_sets WHERE status = 'ready' AND created_by IS DISTINCT FROM 'launch'`],
    ['Пропозиції для мережі', `SELECT count(*)::int AS n, min(COALESCE(reoffered_at, created_at)) AS oldest FROM network_offers WHERE status = 'open'`],
  ];
  const out: HumanOnlyItem[] = [];
  for (const [label, sql] of probes) {
    try {
      const { rows } = await pool.query(sql);
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0 && rows[0]?.oldest) out.push({ label, n, oldest: new Date(rows[0].oldest) });
    } catch { /* the table or column is not there; skip this probe */ }
  }
  return out;
}
