import type { Pool } from 'pg';
import type { CardSource, EditorCard } from '../card';
import { SourceHealthRepository, type StruckHost } from './source-health.repository';
import { hostOf, STRIKES_FOR_OWNER } from '../net/host-failures';
import { egressProxyConfigured } from '../net/safe-http';
import { playbookSeriesSources, playbookSources, PLAYBOOK_SOURCE_PREFIX } from './playbook-feeds';
import {
  blockKeys, needsReplacement, orderSources, sourceHealthReport, SOURCE_HEALTH_DAYS, withReach,
  type SourceHealth, type SourceHealthReport, type SourceRunway,
} from './source-health';
import { SOURCE_CHANGE_KIND } from './source-change';
import { summaryOf, type ProbeSummary } from './probe';
import type { PgSourceProbes } from './source-probes.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { CatalogOverviewRow } from '../tools/catalog-context';

export interface SourceHealthDeps {
  repo:     Pick<SourceHealthRepository, 'steps' | 'blocks'> & Partial<Pick<SourceHealthRepository, 'struck' | 'claimNote' | 'playbookOf'>>;
  channels: { get(key: string): Promise<EditorCard | null> };
  /** Pending / recently discarded source-change cards and the weekly notes (the agent is not asked twice a week). */
  pool?:    Pick<Pool, 'query'>;
  /** `postOnce` carries the host notes (spec 076 A9: the note gate); `post` the weekly «source is failing» note. */
  inbox?:   Pick<OwnerInbox, 'post'> & Partial<Pick<OwnerInbox, 'postOnce'>>;
  /** Spec 076 A23: the catalog overview of a resource (`catalogOverview`), where the runway of a dataset source comes from. */
  runway?:  (resourceRef: string) => Promise<CatalogOverviewRow[]>;
  /** Spec 076: the latest server-side read of each feed / page address. */
  probes?:  Pick<PgSourceProbes, 'latest'>;
  /** Spec 076: the settings (the egress proxy). */
  env?:     (k: string) => string | undefined;
  now?:     () => Date;
}

/** Days a discarded replacement for a source keeps the agent from proposing again; also how often one source is asked about. */
export const DECLINED_DAYS = 7;
export const SOURCE_FAILING_KIND = 'source_failing';
export const HOST_STRUCK_KIND = 'host_struck';

const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);
const fmtTime = (d: Date): string => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** `YYYYMMDDTHHMM` UTC: the `since:` part of a host note (no colon, so the note gate does not read it as a number). */
export const sinceStamp = (d: Date | null): string => (d ? d.toISOString().slice(0, 16).replace(/[-:]/g, '') : 'never');

/** The reasons a host note speaks about. Any other reason (a one-hour `timeout` block) is not a streak to report. */
const NOTE_REASONS = ['unreachable', 'refused', 'dns', 'tls'] as const;

export interface HostNote {
  title: string;
  body:  string;
  alert: { title: string; body: string };
  /** The note gate's parts: the reason, the strikes, and the start of the streak (the last success), so a recovery and a new streak make a new note. */
  parts: string[];
}

/**
 * Spec 076 A31: what the owner reads about a struck host. English for the dashboard Inbox, Ukrainian for the Telegram alert.
 * Null for a row whose reason is not one of the four (a `timeout` block that sits on top of old refusal strikes).
 */
export function hostStruckNote(b: StruckHost, o: { inCard: boolean; inPlaybook: boolean }): HostNote | null {
  if (!(NOTE_REASONS as readonly string[]).includes(b.reason)) return null;
  const until = fmtTime(b.until);
  const n = b.timeouts;
  const s = b.strikes;
  const status = b.statusCode ? ` (status ${b.statusCode})` : '';
  const statusUk = b.statusCode ? ` (status ${b.statusCode})` : '';
  const sinceEn = b.timeoutsSince ? ` since ${fmtDate(b.timeoutsSince)}` : '';
  const sinceUk = b.timeoutsSince ? ` (з ${fmtDate(b.timeoutsSince)})` : '';
  const text = {
    unreachable: {
      title: `${b.host} cannot be reached from the server`,
      body: `Timed out ${n} times in a row${sinceEn}; blocked until ${until}. Route it through the proxy, upload the page, or remove the source.`,
      alertTitle: `${b.host} недоступний із сервера`,
      alertBody: `Тайм-аутів поспіль: ${n}${sinceUk}; наступна спроба після ${until}. Відкрийте джерела каналу: там можна пустити сайт через проксі, завантажити сторінку або прибрати джерело.`,
    },
    refused: {
      title: `${b.host} refuses the server`,
      body: `Refused ${s} times in a row${status}; blocked until ${until}. Route it through the proxy or remove the source.`,
      alertTitle: `${b.host} відмовляє серверу`,
      alertBody: `Відмов поспіль: ${s}${statusUk}; заблоковано до ${until}. Відкрийте джерела каналу: там можна пустити сайт через проксі або прибрати джерело.`,
    },
    dns: {
      title: `${b.host} does not resolve`,
      body: `DNS failed ${s} times in a row; blocked until ${until}. Check the address or remove the source.`,
      alertTitle: `Домен ${b.host} не знаходиться (DNS)`,
      alertBody: `Збоїв DNS поспіль: ${s}; заблоковано до ${until}. Перевірте адресу або приберіть джерело.`,
    },
    tls: {
      title: `${b.host} has a TLS error`,
      body: `TLS failed ${s} times in a row; blocked until ${until}. Check the address or remove the source.`,
      alertTitle: `${b.host}: помилка TLS-сертифіката`,
      alertBody: `Збоїв TLS поспіль: ${s}; заблоковано до ${until}. Перевірте адресу або приберіть джерело.`,
    },
  }[b.reason as typeof NOTE_REASONS[number]];
  // Where the host is (the 061 sentences).
  const whereEn = (o.inCard ? ' A card source: the channel agent looks for a replacement and shows an Apply / Discard card.' : '')
    + (o.inPlaybook ? " The address is in the channel's playbook: remove it there (a directive to the manager) or keep it if the site may come back." : '');
  const whereUk = (o.inCard ? ' Джерело картки: агент шукає заміну і покаже картку Apply / Discard.' : '')
    + (o.inPlaybook ? ' Адреса є в плейбуку каналу — приберіть її з плейбука (директива менеджеру) або залиште, якщо сайт ще оживе.' : '');
  return {
    title: text.title, body: `${text.body}${whereEn}`,
    alert: { title: text.alertTitle, body: `${text.alertBody}${whereUk}` },
    parts: [b.reason, `strikes:${s}`, `since:${sinceStamp(b.lastSuccessAt)}`],
  };
}

/** «1 раз», «3 рази», «5 разів», «11 разів», «21 раз» — the owner notes count in Ukrainian. */
export function razy(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} раз`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} рази`;
  return `${n} разів`;
}

/** Spec 049 FR-003 / FR-004: the source health of a channel card, and the sources that need a replacement. */
export class SourceHealthService {
  constructor(private readonly d: SourceHealthDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /**
   * The card's sources plus the feeds its orchestrator's playbook reads that the card does not list (spec 061 FR-004) and,
   * since spec 076 A23, the datasets and apis its series name. `playbook` holds both kinds of extra row (origin `playbook`).
   */
  private async sourcesOf(card: EditorCard): Promise<{ all: CardSource[]; playbook: CardSource[] }> {
    const body = this.d.repo.playbookOf ? await this.d.repo.playbookOf(`telegram:${card.channelKey}`).catch(() => null) : null;
    const playbook = [...playbookSources(body ?? null, card.sources), ...playbookSeriesSources(body ?? null, card.sources)];
    return { all: [...card.sources, ...playbook], playbook };
  }

  /** Material left per dataset on the channel's resource (A23); empty without the overview, without a dataset source, or when it fails. */
  private async runwayOf(card: EditorCard, all: CardSource[]): Promise<Map<string, SourceRunway>> {
    const out = new Map<string, SourceRunway>();
    if (!this.d.runway || !all.some((s) => s.kind === 'library')) return out;
    const rows = await this.d.runway(`telegram:${card.channelKey}`).catch(() => [] as CatalogOverviewRow[]);
    for (const r of rows) out.set(r.dataset, { unposted: r.unposted_here ?? null, days: r.runway_days ?? null, rounds: !!r.repeat });
    return out;
  }

  /** The server's latest read of each feed / page address (A22). */
  private async probesOf(all: CardSource[]): Promise<Map<string, ProbeSummary>> {
    const out = new Map<string, ProbeSummary>();
    if (!this.d.probes) return out;
    const urls = all.filter((s) => s.kind === 'rss' || s.kind === 'url').map((s) => s.ref);
    for (const [url, r] of await this.d.probes.latest(urls).catch(() => new Map())) out.set(url, summaryOf(r));
    return out;
  }

  async forCard(card: EditorCard, days = SOURCE_HEALTH_DAYS): Promise<SourceHealthReport> {
    const now = this.now();
    const since = new Date(now.getTime() - days * 86_400_000);
    const { all, playbook } = await this.sourcesOf(card);
    const steps = await this.d.repo.steps(card.channelKey, since);
    const blocks = await this.d.repo.blocks(blockKeys(all, steps), since);
    const report = sourceHealthReport(card.channelKey, all, steps, blocks, now, days);
    const fromPlaybook = new Set(playbook.map((p) => p.id));
    const [probes, runways] = await Promise.all([this.probesOf(all), this.runwayOf(card, all)]);
    const sources = orderSources(report.sources.map((h) => withReach(
      { ...h, origin: fromPlaybook.has(h.id) ? 'playbook' as const : 'card' as const },
      { probe: probes.get(h.ref) ?? null, runway: runways.get(h.ref) ?? null })));
    return { ...report, sources, noSources: all.length === 0, proxyConfigured: egressProxyConfigured(this.d.env) };
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
   * A host of this channel's sources (card or playbook) that the server cannot use gets an owner note: three timeouts in a
   * row (`unreachable`, noted at its first strike, spec 076), or a refusal / DNS / TLS failure struck 3 times (the 7-day cap,
   * spec 061 FR-004). A card source is also in the daily replacement run (`needingReplacement`, the `change_source` card);
   * a playbook feed has no such path, so the note is how the owner hears about it.
   *
   * Spec 076 A9: the note goes through the note gate (`postOnce`, subject `host_struck:<channel>/<host>`, parts = the reason, the
   * strikes and the start of the streak). It is sent when the host is new, when its reason or its streak changes, and as «still …»
   * after a few days, and the third unanswered note is posted as info. `struck()` keeps its `noted_at IS NULL` filter, and the new
   * code never sets that column, so a host the 061 code already told the owner about stays quiet until a success clears it.
   *
   * Spec 086 FR-004: a struck host the channel's runs hit OUTSIDE its sources (`otherHosts` of the source health report) gets an
   * info note of its own, gated per channel and streak (subject `host_struck_outside:<channel>/<host>`), so it never uses up the
   * action note of a channel that has the host as a source. A host in both gets the action note only.
   */
  async noteStruckHosts(card: EditorCard, agentId: string | null, report?: SourceHealthReport): Promise<string[]> {
    const inbox = this.d.inbox;
    if (!this.d.repo.struck || !inbox?.postOnce) return [];
    const { all, playbook } = await this.sourcesOf(card);
    const hosts = [...new Set(all.map((s) => hostOf(s.ref)).filter(Boolean) as string[])];
    // Spec 086 FR-004: blocked hosts the channel's runs hit outside its sources (one report read; the caller may pass its own).
    const rep = report ?? await this.forCard(card).catch(() => null);
    const others = new Map((rep?.otherHosts ?? []).map((o) => [o.host, o]));
    const struck = await this.d.repo.struck([...new Set([...hosts, ...others.keys()])], 1);
    const noted: string[] = [];
    for (const b of struck) {
      // The row's LAST reason decides: an `unreachable` streak that turns into a refusal at strike 2 waits for strike 3.
      if (!(b.reason === 'unreachable' || b.strikes >= STRIKES_FOR_OWNER)) continue;
      const mine = all.filter((s) => hostOf(s.ref) === b.host);
      const outside = others.get(b.host);
      if (!mine.length && !outside) continue;
      if (!mine.length && outside) {
        const status = b.statusCode ? ` ${b.statusCode}` : '';
        const id = await inbox.postOnce({
          agentId, kind: HOST_STRUCK_KIND, refType: 'host', refId: `${card.channelKey}/${b.host}`, severity: 'info',
          title: `${b.host} is blocked for the server — ${card.channelKey}'s agents reach it outside the sources`,
          body: `Blocked until ${fmtTime(b.until)} (${b.reason}${status}); blocks last 1 → 3 → 7 days and no request goes out until one ends.`
            + ` It is not one of the channel's sources: its agents read it ${outside.calls} time${outside.calls === 1 ? '' : 's'} in ${rep!.days} days (links from news or search).`
            + ' If material from it is needed, add a source on the same topic; otherwise nothing to do.',
          gate: { subject: `host_struck_outside:${card.channelKey}/${b.host}`, parts: [b.reason, `since:${sinceStamp(b.lastSuccessAt)}`] },
        }).catch(() => null);
        if (id != null) noted.push(b.host);
        continue;
      }
      const inCard = mine.some((s) => !s.id.startsWith(PLAYBOOK_SOURCE_PREFIX));
      const inPlaybook = playbook.some((s) => hostOf(s.ref) === b.host);
      const note = hostStruckNote(b, { inCard, inPlaybook });
      if (!note) continue;
      const id = await inbox.postOnce({
        agentId, kind: HOST_STRUCK_KIND, refType: 'host', refId: `${card.channelKey}/${b.host}`, severity: 'action',
        title: note.title, body: note.body, alert: note.alert,
        gate: { subject: `${HOST_STRUCK_KIND}:${card.channelKey}/${b.host}`, parts: note.parts },
      }).catch(() => null);
      if (id != null) noted.push(b.host);
    }
    return noted;
  }

  /**
   * The sources the agent's daily run is asked to replace today: those needing a replacement that were not asked about
   * this week. Each gets one owner Inbox note ("… is failing; the agent looks for a replacement"), at most weekly.
   * The notes about struck hosts are not written here since spec 076 A26: `SourceProbeWorker` writes them every morning, for every
   * active card, whether or not the agent proposes source changes (SOURCE_PROPOSALS).
   */
  async toReplaceToday(card: EditorCard, agentId: string | null): Promise<SourceHealth[]> {
    const report = await this.forCard(card).catch(() => undefined); // one read for the replacement list
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
