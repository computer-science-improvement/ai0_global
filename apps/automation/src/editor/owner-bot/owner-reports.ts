import type { Pool } from 'pg';
import type { BudgetStatus } from '../../spend/spend.service';
import type { NetworkHealth, StuckKind } from '../health/network-health';
import { isNotAMiss, isOwnerDecision, skipGroupOf } from '../silent/skip-reasons';
import type { Keyboard } from './bot-api';
import type { OwnerCardsRepository } from './owner-cards.repository';
import { esc, plural } from './owner-text';

/**
 * Spec 012 FR-005 / FR-006: the owner's daily summary and weekly report, in Ukrainian (Telegram). The data is read
 * here; sending and the once-per-period claim (`owner_reports`) are the scheduler's (`tick`).
 */

const TZ = 'Europe/Kyiv';
const DAY = 86_400_000;

// ── Kyiv time ───────────────────────────────────────────────────────────────

function parts(d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "2026-10-19" (the Kyiv date). */
export function kyivDate(d: Date): string { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; }
/** "21:05" (Kyiv). */
export function kyivHM(d: Date): string { const p = parts(d); return `${p.hour}:${p.minute}`; }
/** "Mon" … "Sun" (Kyiv). */
export function kyivWeekday(d: Date): string { return parts(d).weekday; }

/** ISO week of a calendar date: "2026-W43". */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;            // Mon = 0
  d.setUTCDate(d.getUTCDate() - dow + 3);         // the Thursday of this week
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** "21:00" → the period to send today, or null (off, not yet, bad value). */
export function dailyDue(now: Date, at: string | undefined): string | null {
  const v = (at ?? '21:00').trim();
  if (v === 'off' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return null;
  return kyivHM(now) >= v ? kyivDate(now) : null;
}

/** "Mon 09:00" → the ISO week to send now, or null. */
export function weeklyDue(now: Date, at: string | undefined): string | null {
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([01]\d|2[0-3]):([0-5]\d)$/.exec((at ?? 'Mon 09:00').trim());
  if (!m) return null;
  return kyivWeekday(now) === m[1] && kyivHM(now) >= `${m[2]}:${m[3]}` ? isoWeek(kyivDate(now)) : null;
}

// ── data ────────────────────────────────────────────────────────────────────

export interface WaitingCount { label: string; emoji: string; n: number }

export interface ReportDeps {
  pool:     Pick<Pool, 'query'>;
  repo:     Pick<OwnerCardsRepository, 'claimReport' | 'releaseReport' | 'lastReports'>;
  budgets:  () => Promise<{ rows: BudgetStatus[] }>;
  health:   () => Promise<NetworkHealth>;
  waiting:  () => Promise<WaitingCount[]>;
  env:      (key: string) => string | undefined;
  now?:     () => Date;
}

export interface ChannelLine {
  ref:       string;
  title:     string;
  published: number;
  skipped:   number;
  /** The main reason group of the skips (Ukrainian label). */
  skipWhy:   string | null;
  failed:    number;
  awaiting:  number;
  /** Subscriber change over the period, when tracked. */
  subs:      number | null;
}

const SKIP_UK: Record<string, string> = {
  critic: 'критик', lint: 'перевірки тексту', cap: 'ліміти', nothing_fresh: 'нема свіжого матеріалу', budget: 'бюджет',
  other: 'інше', owner: 'ваше рішення',
};

const STUCK_UK: Record<StuckKind, string> = {
  slot_running: 'Пости застрягли в запуску', slot_overdue: 'Прострочені пости', slot_failed: 'Пости з помилкою за добу',
  approval_waiting: 'Пости чекають схвалення понад добу', action_waiting: 'Картки агентів чекають понад 12 год',
  playbook_waiting: 'Плейбуки чекають понад 2 дні', ideas_waiting: 'Ідеї без розгляду понад 48 год',
};

const CONN_UK: Record<string, string> = {
  no_access: 'нема доступу', token_invalid: 'токен недійсний', token_expiring: 'токен спливає', rate_limited: 'ліміт запитів',
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Per channel over [from, to): published, skipped (+ the main reason), failed; waiting for approval now; subscriber change. */
export async function channelLines(pool: ReportDeps['pool'], from: Date, to: Date): Promise<ChannelLine[]> {
  const { rows } = await pool.query(
    `SELECT COALESCE(s.resource_ref, 'telegram:' || s.channel_key) AS ref, s.channel_key, c.title, s.status, s.error, s.critic->>'verdict' AS verdict
       FROM editor_slots s LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
      WHERE s.kind = 'content' AND s.scheduled_at >= $1 AND s.scheduled_at < $2
        AND s.status IN ('published', 'skipped', 'expired', 'failed')`, [from, to]);
  const { rows: waiting } = await pool.query(
    `SELECT COALESCE(s.resource_ref, 'telegram:' || s.channel_key) AS ref, s.channel_key, c.title, count(*)::int AS n
       FROM editor_slots s LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
      WHERE s.status = 'awaiting_approval' GROUP BY 1, 2, 3`);
  const by = new Map<string, ChannelLine & { why: Map<string, number>; key: string }>();
  const line = (ref: string, key: string, title: string | null) => {
    let l = by.get(ref);
    if (!l) {
      const platform = ref.startsWith('telegram:') ? '' : ` · ${ref.split(':')[0]}`;
      l = { ref, key, title: `${title || key}${platform}`, published: 0, skipped: 0, skipWhy: null, failed: 0, awaiting: 0, subs: null, why: new Map() };
      by.set(ref, l);
    }
    return l;
  };
  for (const r of rows) {
    const l = line(r.ref, r.channel_key, r.title);
    if (r.status === 'published') l.published++;
    else if (r.status === 'failed') l.failed++;
    else if (!isNotAMiss(r.error)) {
      l.skipped++;
      const g = isOwnerDecision(r.error) ? 'owner' : skipGroupOf(r.error, r.verdict);
      l.why.set(g, (l.why.get(g) ?? 0) + 1);
    }
  }
  for (const r of waiting) line(r.ref, r.channel_key, r.title).awaiting = Number(r.n);
  const tg = [...by.values()].filter((l) => l.ref.startsWith('telegram:')).map((l) => l.key);
  if (tg.length) {
    const { rows: subs } = await pool.query(
      `SELECT k.key,
              (SELECT subscribers FROM channel_stats_snapshots WHERE channel_id = k.key AND captured_at < $3 ORDER BY captured_at DESC LIMIT 1) AS now_subs,
              (SELECT subscribers FROM channel_stats_snapshots WHERE channel_id = k.key AND captured_at < $2 ORDER BY captured_at DESC LIMIT 1) AS before_subs
         FROM unnest($1::text[]) AS k(key)`, [tg, from, to]);
    for (const r of subs) {
      const l = by.get(`telegram:${r.key}`);
      if (l && r.now_subs != null && r.before_subs != null) l.subs = Number(r.now_subs) - Number(r.before_subs);
    }
  }
  return [...by.values()]
    .filter((l) => l.published || l.skipped || l.failed || l.awaiting)
    .map(({ why, key: _k, ...l }) => {
      const top = [...why.entries()].sort((x, y) => y[1] - x[1])[0];
      return { ...l, skipWhy: top ? SKIP_UK[top[0]] ?? top[0] : null };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function channelText(l: ChannelLine): string {
  const bits = [`✅ ${l.published}`];
  if (l.skipped) bits.push(`⏭ ${l.skipped}${l.skipWhy ? ` (${l.skipWhy})` : ''}`);
  if (l.failed) bits.push(`❌ ${l.failed}`);
  if (l.awaiting) bits.push(`⏳ ${l.awaiting} на схвалення`);
  if (l.subs != null) bits.push(`👥 ${signed(l.subs)}`);
  return `• <b>${esc(l.title)}</b>: ${bits.join(' · ')}`;
}

/** The agents' cap (editor.*) and the whole account (global), today. */
export function spendLines(rows: BudgetStatus[]): string[] {
  const out: string[] = [];
  const show = (label: string, b: BudgetStatus | undefined) => {
    if (!b) return;
    out.push(b.dailyUsd != null
      ? `${label}: ${usd(b.spentTodayUsd)} з ${usd(b.dailyUsd)}${b.pct != null ? ` (${Math.round(b.pct)}%)` : ''}${b.state === 'blocked' ? ' — зупинено' : ''}`
      : `${label}: ${usd(b.spentTodayUsd)}`);
  };
  show('Агенти', rows.find((b) => b.scopeKind === 'feature_prefix' && b.scopeKey === 'editor.'));
  show('Весь акаунт', rows.find((b) => b.scopeKind === 'global'));
  return out;
}

export function healthLines(h: NetworkHealth | null): string[] {
  if (!h) return ['Не вдалося перевірити'];
  const out: string[] = [];
  const conns = h.connections.filter((c) => !c.muted);
  if (conns.length) out.push(`🔌 Підключення: ${conns.slice(0, 5).map((c) => `${esc(c.title || c.ref)} — ${CONN_UK[c.state] ?? c.state}`).join('; ')}${conns.length > 5 ? ` і ще ${conns.length - 5}` : ''}`);
  if (h.sources.length) out.push(`📡 Джерела з проблемами: ${h.sources.length} (${[...new Set(h.sources.map((s) => s.channelKey))].slice(0, 5).map(esc).join(', ')})`);
  if (h.budget.blocking.length) out.push(`💸 Бюджет зупинив: ${h.budget.blocking.length}`);
  for (const g of h.stuck) out.push(`⏱ ${STUCK_UK[g.kind] ?? g.label}: ${g.count}`);
  return out.length ? out : ['Все гаразд ✓'];
}

function keyboard(env: ReportDeps['env']): Keyboard {
  const base = env('DASHBOARD_URL')?.trim();
  return [[{ text: 'Що чекає', data: 'oc:waiting' }], ...(base ? [[{ text: 'Відкрити дашборд', url: `${base.replace(/\/$/, '')}/app` }]] : [])];
}

const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

export class OwnerReports {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly d: ReportDeps) {}

  private now(): Date { return this.d.now?.() ?? new Date(); }

  /** The Kyiv day around `now`: [start, start + 1 day). */
  async dayBounds(now: Date): Promise<{ from: Date; to: Date }> {
    const { rows } = await this.d.pool.query(
      `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}') AS from_at`, [now]);
    const from = new Date(rows[0].from_at);
    return { from, to: new Date(from.getTime() + DAY) };
  }

  /** FR-005: the daily summary. */
  async daily(): Promise<{ text: string; keyboard: Keyboard }> {
    const now = this.now();
    const { from, to } = await this.dayBounds(now);
    const [channels, budgets, health, waiting, last] = await Promise.all([
      channelLines(this.d.pool, from, to),
      this.d.budgets().catch(() => ({ rows: [] as BudgetStatus[] })),
      this.d.health().catch(() => null),
      this.d.waiting().catch(() => [] as WaitingCount[]),
      this.d.repo.lastReports().catch(() => ({ daily: null, weekly: null })),
    ]);
    const since = last.daily && last.daily > from ? last.daily : from;
    const { rows } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM agent_inbox WHERE severity = 'info' AND created_at >= $1`, [since]);
    const info = Number(rows[0]?.n ?? 0);

    const lines = [`📊 <b>Підсумок дня · ${ddmm(kyivDate(now))}</b>`, ''];
    lines.push('<b>Канали</b>', ...(channels.length ? channels.map(channelText) : ['Сьогодні постів не було']), '');
    const spend = spendLines(budgets.rows);
    if (spend.length) lines.push('<b>Витрати сьогодні</b>', ...spend, '');
    lines.push('<b>Чекає на вас</b>');
    lines.push(...(waiting.length ? waiting.map((w) => `${w.emoji} ${esc(w.label)}: ${w.n}`) : ['Нічого ✓']));
    if (info) lines.push(`ℹ️ ${info} ${plural(info, 'нове інфо-сповіщення', 'нові інфо-сповіщення', 'нових інфо-сповіщень')} в Inbox`);
    lines.push('', "<b>Здоров'я</b>", ...healthLines(health));
    return { text: lines.join('\n'), keyboard: keyboard(this.d.env) };
  }

  /** /status extra lines: today's posts, spend and health in short. */
  async statusLines(): Promise<string[]> {
    const now = this.now();
    const { from, to } = await this.dayBounds(now);
    const [channels, budgets, health] = await Promise.all([
      channelLines(this.d.pool, from, to).catch(() => [] as ChannelLine[]),
      this.d.budgets().catch(() => ({ rows: [] as BudgetStatus[] })),
      this.d.health().catch(() => null),
    ]);
    const sum = (k: 'published' | 'skipped' | 'failed') => channels.reduce((n, c) => n + c[k], 0);
    return [
      `Сьогодні: опубліковано ${sum('published')}, пропущено ${sum('skipped')}, помилок ${sum('failed')}`,
      ...spendLines(budgets.rows),
      health ? (health.problems ? `Здоров'я: ${health.problems} ${plural(health.problems, 'проблема', 'проблеми', 'проблем')}` : "Здоров'я: все гаразд ✓") : '',
    ].filter(Boolean);
  }

  /**
   * The schedule, once a minute: claims the period's report and sends it; a failed send releases the claim for the next
   * minute (5 tries a period). Returns what went out.
   */
  async tick(send: (text: string, kb: Keyboard) => Promise<boolean>): Promise<string[]> {
    const now = this.now();
    const out: string[] = [];
    const jobs: Array<['daily' | 'weekly', string | null, () => Promise<{ text: string; keyboard: Keyboard }>]> = [
      ['daily', dailyDue(now, this.d.env('OWNER_DAILY_REPORT_AT')), () => this.daily()],
    ];
    for (const [kind, period, build] of jobs) {
      if (!period) continue;
      const key = `${kind}:${period}`;
      if ((this.attempts.get(key) ?? 0) >= 5) continue;
      if (!(await this.d.repo.claimReport(kind, period))) continue;
      let ok = false;
      try {
        const r = await build();
        ok = await send(r.text, r.keyboard);
      } catch { ok = false; }
      if (ok) { out.push(key); continue; }
      this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
      await this.d.repo.releaseReport(kind, period);
    }
    return out;
  }
}
