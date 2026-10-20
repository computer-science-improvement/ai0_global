// Where loadout suggestions surface besides the Loadout tab (spec 054 FR-005): one block in the manager's KPI digest
// and one weekly note in the owner's inbox. Both are advice for the owner: no directive kind, no LLM.

import type { Agent } from '../agents/agent.types';
import { roleOfKind } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { InboxItemInput, OwnerInbox } from '../agents/owner-inbox';
import type { LoadoutAdminService } from './loadout.admin.service';
import { LOADOUT_ROLES } from './loadout-profiles';
import type { LoadoutSuggestion } from './loadout-suggestions';

export interface ScanRow {
  agent:       Pick<Agent, 'id' | 'handle'>;
  suggestions: LoadoutSuggestion[];
}

/** The digest block is at most this many lines across the whole network. */
export const DIGEST_MAX_LINES = 5;

const join = (xs: string[]) => xs.join(', ');

/** "@handle: add a, b · remove c · skills off d", the findings of one agent on one line. */
export function agentLine(r: ScanRow): string {
  const tools = (action: 'add' | 'remove') => r.suggestions.filter((s) => s.action === action && s.tool).map((s) => s.tool!);
  const parts = [
    tools('add').length ? `add ${join(tools('add'))}` : '',
    tools('remove').length ? `remove ${join(tools('remove'))}` : '',
    r.suggestions.some((s) => s.skill) ? `skills off ${join(r.suggestions.filter((s) => s.skill).map((s) => s.skill!))}` : '',
  ].filter(Boolean);
  const line = `@${r.agent.handle}: ${parts.join(' · ')}`;
  return line.length > 220 ? `${line.slice(0, 219)}…` : line;
}

/** The `loadout` block of the KPI digest: the agents with most findings first, at most 5 lines in all. */
export function digestLines(rows: ScanRow[], max = DIGEST_MAX_LINES): string[] {
  const with_ = rows.filter((r) => r.suggestions.length).sort((a, b) => b.suggestions.length - a.suggestions.length || a.agent.handle.localeCompare(b.agent.handle));
  if (with_.length <= max) return with_.map(agentLine);
  const shown = with_.slice(0, max - 1).map(agentLine);
  return [...shown, `…and ${with_.length - shown.length} more agents with loadout suggestions`];
}

/** ISO 8601 week of a date in UTC: "2026-W43". */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const proposals = (n: number) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'пропозиція';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'пропозиції';
  return 'пропозицій';
};

/** The weekly owner note (Ukrainian: it reaches the owner bot), or null when nothing is suggested. */
export function weeklyNote(rows: ScanRow[], week: string): (InboxItemInput & { refType: string; refId: string }) | null {
  const withAny = rows.filter((r) => r.suggestions.length).sort((a, b) => a.agent.handle.localeCompare(b.agent.handle));
  const total = withAny.reduce((n, r) => n + r.suggestions.length, 0);
  if (!total) return null;
  const first = withAny[0];
  const lines = withAny.slice(0, 5).map(agentLine);
  const more = withAny.length > 5 ? [`…і ще ${withAny.length - 5} агентів`] : [];
  const title = `Інструменти агентів: ${total} ${proposals(total)}`;
  return {
    kind: 'loadout_suggestions', severity: 'info', agentId: first.agent.id, refType: 'loadout', refId: week,
    title,
    body: [`${withAny.length} агентів мають що змінити в наборі інструментів. Відкрийте вкладку Loadout агента @${first.agent.handle}: /app/agents/${first.agent.handle}?tab=loadout`, ...lines, ...more].join('\n'),
  };
}

export interface LoadoutScanDeps {
  agents: Pick<AgentsRepository, 'list'>;
  admin:  Pick<LoadoutAdminService, 'viewOf'>;
  /** How long a scan is reused (the digest is built often, the findings change over days). */
  ttlMs?: number;
  now?:   () => number;
}

/** Suggestions of every agent that has a loadout. One agent that cannot be read is skipped, never fails the scan. */
export class LoadoutScan {
  private cache: { at: number; rows: ScanRow[] } | null = null;
  constructor(private readonly d: LoadoutScanDeps) {}

  async run(fresh = false): Promise<ScanRow[]> {
    const now = (this.d.now ?? Date.now)();
    if (!fresh && this.cache && now - this.cache.at < (this.d.ttlMs ?? 600_000)) return this.cache.rows;
    const rows: ScanRow[] = [];
    for (const a of await this.d.agents.list()) {
      if (!LOADOUT_ROLES.includes(roleOfKind(a.kind))) continue;
      try {
        const v = await this.d.admin.viewOf(a);
        if (v.suggestions.length) rows.push({ agent: { id: a.id, handle: a.handle }, suggestions: v.suggestions });
      } catch { /* this agent is skipped */ }
    }
    this.cache = { at: now, rows };
    return rows;
  }

  async digestLines(): Promise<string[]> {
    return digestLines(await this.run());
  }
}

export interface LoadoutNotesDeps {
  scan:  Pick<LoadoutScan, 'run'>;
  inbox: Pick<OwnerInbox, 'postOnce'>;
}

/** Posts the weekly note once per ISO week (`postOnce` keeps a repeat out). Returns whether a note went out. */
export async function postWeeklyLoadoutNote(d: LoadoutNotesDeps, now = new Date()): Promise<boolean> {
  const note = weeklyNote(await d.scan.run(true), isoWeek(now));
  if (!note) return false;
  return (await d.inbox.postOnce(note)) != null;
}
