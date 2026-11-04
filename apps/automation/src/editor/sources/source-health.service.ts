import type { Pool } from 'pg';
import type { CardSource, EditorCard } from '../card';
import { SourceHealthRepository } from './source-health.repository';
import { hostOf, STRIKES_FOR_OWNER } from '../net/host-failures';
import { playbookSources, PLAYBOOK_SOURCE_PREFIX } from './playbook-feeds';
import { blockKeys, needsReplacement, sourceHealthReport, SOURCE_HEALTH_DAYS, type SourceHealth, type SourceHealthReport } from './source-health';
import { SOURCE_CHANGE_KIND } from './source-change';
import type { OwnerInbox } from '../agents/owner-inbox';

export interface SourceHealthDeps {
  repo:     Pick<SourceHealthRepository, 'steps' | 'blocks'> & Partial<Pick<SourceHealthRepository, 'struck' | 'claimNote' | 'playbookOf'>>;
  channels: { get(key: string): Promise<EditorCard | null> };
  /** Pending / recently discarded source-change cards and the weekly notes (the agent is not asked twice a week). */
  pool?:    Pick<Pool, 'query'>;
  inbox?:   Pick<OwnerInbox, 'post'>;
  now?:     () => Date;
}

/** Days a discarded replacement for a source keeps the agent from proposing again; also how often one source is asked about. */
export const DECLINED_DAYS = 7;
export const SOURCE_FAILING_KIND = 'source_failing';
export const HOST_STRUCK_KIND = 'host_struck';

/** Spec 049 FR-003 / FR-004: the source health of a channel card, and the sources that need a replacement. */
export class SourceHealthService {
  constructor(private readonly d: SourceHealthDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** The card's sources plus the feeds its orchestrator's playbook reads (spec 061 FR-004). */
  private async sourcesOf(card: EditorCard): Promise<{ all: CardSource[]; playbook: CardSource[] }> {
    const body = this.d.repo.playbookOf ? await this.d.repo.playbookOf(`telegram:${card.channelKey}`).catch(() => null) : null;
    const playbook = playbookSources(body ?? null, card.sources);
    return { all: [...card.sources, ...playbook], playbook };
  }

  async forCard(card: EditorCard, days = SOURCE_HEALTH_DAYS): Promise<SourceHealthReport> {
    const now = this.now();
    const since = new Date(now.getTime() - days * 86_400_000);
    const { all, playbook } = await this.sourcesOf(card);
    const steps = await this.d.repo.steps(card.channelKey, since);
    const blocks = await this.d.repo.blocks(blockKeys(all, steps), since);
    const report = sourceHealthReport(card.channelKey, all, steps, blocks, now, days);
    const fromPlaybook = new Set(playbook.map((p) => p.id));
    return { ...report, sources: report.sources.map((h) => ({ ...h, origin: fromPlaybook.has(h.id) ? 'playbook' as const : 'card' as const })) };
  }

  async forChannel(channelKey: string, days = SOURCE_HEALTH_DAYS): Promise<SourceHealthReport | null> {
    const card = await this.d.channels.get(channelKey);
    return card ? this.forCard(card, days) : null;
  }

  /**
   * Spec 049 FR-004: the card's blocked, failing or exhausted sources with no change card waiting for the owner and
   * none the owner discarded in the last week — what the channel agent's daily run is asked to replace.
   */
  async needingReplacement(card: EditorCard, report?: SourceHealthReport): Promise<SourceHealth[]> {
    // Only card sources: a `change_source` card edits the card, a playbook feed is noted to the owner instead (noteStruckHosts).
    const troubled = (report ?? await this.forCard(card)).sources.filter((h) => h.origin !== 'playbook' && needsReplacement(h));
    if (!troubled.length || !this.d.pool) return troubled;
    const { rows } = await this.d.pool.query(
      `SELECT payload->>'sourceId' AS source_id FROM pending_actions
        WHERE kind = $1 AND payload->>'channelKey' = $2
          AND (status = 'pending' OR (status = 'discarded' AND decided_at > now() - make_interval(days => $3)))`,
      [SOURCE_CHANGE_KIND, card.channelKey, DECLINED_DAYS]).catch(() => ({ rows: [] as Array<{ source_id: string | null }> }));
    const handled = new Set(rows.map((r) => r.source_id).filter(Boolean));
    return troubled.filter((h) => !handled.has(h.id));
  }

  /**
   * Spec 061 FR-004: a host of this channel's sources (card or playbook) blocked 3 times in a row (the 7-day cap) gets ONE
   * owner note, in Ukrainian, written once per streak (`noted_at`; a successful fetch starts the next streak). A card
   * source is also in the daily replacement run (`needingReplacement`, the `change_source` card); a playbook feed has no
   * such path, so the note is how the owner hears about it. Spec 086 FR-004: a struck host the channel's runs hit outside its
   * sources (`otherHosts` of the source health report) gets an info note of its own, once per streak too.
   */
  async noteStruckHosts(card: EditorCard, agentId: string | null, report?: SourceHealthReport): Promise<string[]> {
    if (!this.d.repo.struck || !this.d.repo.claimNote || !this.d.inbox) return [];
    const { all, playbook } = await this.sourcesOf(card);
    const hosts = [...new Set(all.map((s) => hostOf(s.ref)).filter(Boolean) as string[])];
    // Spec 086 FR-004: blocked hosts the channel's runs hit outside its sources (one report read; the caller may pass its own).
    const rep = report ?? await this.forCard(card).catch(() => null);
    const others = new Map((rep?.otherHosts ?? []).map((o) => [o.host, o]));
    const struck = await this.d.repo.struck([...new Set([...hosts, ...others.keys()])], STRIKES_FOR_OWNER);
    const noted: string[] = [];
    for (const b of struck) {
      const mine = all.filter((s) => hostOf(s.ref) === b.host);
      const outside = others.get(b.host);
      if (!mine.length && !outside) continue;
      if (!mine.length && outside) {
        // Spec 086 FR-004: the host-wide claim belongs to the source note — an info note must not use it up, or the channel
        // that has the host as a source would never get its action note. Dedupe per channel and streak instead: any earlier note for the pair counts, and a successful fetch of the host (PgHostFailures.succeeded) retires them.
        if (this.d.pool) {
          const { rows } = await this.d.pool.query(
            `SELECT 1 FROM agent_inbox WHERE kind = $1 AND ref_type = 'host' AND ref_id = $2 LIMIT 1`,
            [HOST_STRUCK_KIND, `${card.channelKey}/${b.host}`]).catch(() => ({ rows: [{}] }));
          if (rows.length) continue;
        }
        await this.d.inbox.post({
          agentId, kind: HOST_STRUCK_KIND, refType: 'host', refId: `${card.channelKey}/${b.host}`, severity: 'info',
          title: `${b.host} відмовляє нам ${b.strikes} рази поспіль — агенти ${card.channelKey} ходять туди поза джерелами`,
          body: `Сайт ${b.host} заблоковано до ${b.until.toISOString().slice(0, 10)} (${b.reason}${b.statusCode ? ` ${b.statusCode}` : ''}); блокування 1 → 3 → 7 діб, до його кінця запитів не робимо.`
            + ` Його немає серед джерел каналу: агенти читали його ${outside.calls} раз(и) за ${rep!.days} днів (посилання з новин чи пошуку).`
            + ' Якщо матеріал звідти потрібен — додайте джерело тієї ж теми; якщо ні — нічого робити не треба.',
        }).catch(() => null);
        noted.push(b.host);
        continue;
      }
      if (!(await this.d.repo.claimNote(b.host))) continue;
      const inCard = mine.some((s) => !s.id.startsWith(PLAYBOOK_SOURCE_PREFIX));
      const inPlaybook = playbook.some((s) => hostOf(s.ref) === b.host);
      const where = inCard ? `джерел ${card.channelKey} (картка каналу)` : `плейбука ${card.channelKey}`;
      await this.d.inbox.post({
        agentId, kind: HOST_STRUCK_KIND, refType: 'host', refId: `${card.channelKey}/${b.host}`, severity: 'action',
        title: `${b.host} відмовляє нам ${b.strikes} рази поспіль — прибрати з ${where}?`,
        body: `Сайт ${b.host} заблоковано до ${b.until.toISOString().slice(0, 10)} (${b.reason}${b.statusCode ? ` ${b.statusCode}` : ''}); блокування 1 → 3 → 7 діб, до його кінця запитів не робимо.`
          + (inCard ? ' Джерело картки: агент шукає заміну і покаже картку Apply / Discard.' : '')
          + (inPlaybook ? ' Адреса є в плейбуку каналу — приберіть її з плейбука (директива менеджеру) або залиште, якщо сайт ще оживе.' : ''),
      }).catch(() => null);
      noted.push(b.host);
    }
    return noted;
  }

  /**
   * The sources the agent's daily run is asked to replace today: those needing a replacement that were not asked about
   * this week. Each gets one owner Inbox note ("… is failing; the agent looks for a replacement"), at most weekly.
   */
  async toReplaceToday(card: EditorCard, agentId: string | null): Promise<SourceHealth[]> {
    const report = await this.forCard(card).catch(() => undefined); // one read for the note and the replacement list
    await this.noteStruckHosts(card, agentId, report).catch(() => null);
    const need = await this.needingReplacement(card, report);
    if (!need.length || !this.d.pool) return need;
    const refs = need.map((h) => `${card.channelKey}/${h.id}`);
    const { rows } = await this.d.pool.query(
      `SELECT ref_id FROM agent_inbox WHERE kind = $1 AND ref_type = 'source' AND ref_id = ANY($2) AND created_at > now() - make_interval(days => $3)`,
      [SOURCE_FAILING_KIND, refs, DECLINED_DAYS]).catch(() => ({ rows: [] as Array<{ ref_id: string }> }));
    const asked = new Set(rows.map((r) => r.ref_id));
    const fresh = need.filter((h) => !asked.has(`${card.channelKey}/${h.id}`));
    for (const h of fresh) {
      await this.d.inbox?.post({
        agentId, kind: SOURCE_FAILING_KIND, refType: 'source', refId: `${card.channelKey}/${h.id}`, severity: 'info',
        title: `Source «${h.id}» of ${card.channelKey} ${h.state === 'exhausted' ? 'has nothing new' : h.state === 'blocked' ? 'is blocked' : 'is failing'}`,
        body: `${h.kind} ${h.ref}: ${h.detail}. The channel agent looks for a replacement; a proposal comes as a card with Apply / Discard.`,
      }).catch(() => null);
    }
    return fresh;
  }
}

/** The orchestrator's prompt block for the sources to replace (Ukrainian, like the rest of its prompt); null for none. */
export function sourcesToReplaceBlock(troubled: SourceHealth[]): string | null {
  if (!troubled.length) return null;
  const what: Record<string, string> = { blocked: 'заблоковане', failing: 'не відповідає', exhausted: 'нічого нового' };
  return [
    '## Джерела картки, що не працюють (spec 049)',
    ...troubled.map((h) => `- «${h.id}» (${h.kind} ${h.ref}) — ${what[h.state] ?? h.state}: ${h.detail}`),
    'Для кожного знайди заміну: стрічку чи сторінку того ж змісту (інша стрічка сайту, інший сайт теми, fetch_api, датасет), перевір її (fetch_feed / web_fetch) і виклич propose_source_change (replace; add — якщо старе ще інколи працює). Власник побачить картку і застосує її. Не знайшов робочої заміни — не пропонуй нічого.',
  ].join('\n');
}
