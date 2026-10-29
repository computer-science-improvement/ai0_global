import type { Pool } from 'pg';
import type { Finding } from '../sysadmin/audit.types';
import type { CardSource, WaitingItem } from '../owner-bot/card-sources';
import type { CardButton } from '../owner-bot/owner-cards.repository';
import { BODY_MAX, clip, kyivTime, plural } from '../owner-bot/owner-text';
import { doctorReason, resolveLink } from './codes';
import { channelOfRefId, notifiable, readinessRefId } from './notify';
import { IN_SWEEP } from './readiness.repository';
import type { FixOutcome, ReadinessService } from './readiness.service';
import { isFixAllTarget } from './view';

/**
 * Spec 072 FR-009: the readiness card in the owner bot (kind `readiness`). A channel whose blockers the service stamped
 * (`notified_blockers`, at most one stamp a day) has one card; the card names the blockers, lists what one tap fixes and offers
 * «Виправити все», «Перевірити» and «Відкрити». The text is the owner's Telegram text (Ukrainian).
 *
 * `refId` is `<channelKey>|<sha1 of the stamped set, 8 hex>|<yyyymmdd of the stamp>` (A9): `owner_cards` never reinserts a
 * `(kind, ref_id)`, so a new set and a new day are a new card, and the same set on the same stamp is the same card. A card
 * stops waiting (and the sweep closes it) when none of the stamped blockers is open any more.
 */

export interface ReadinessCardDeps {
  pool:      Pick<Pool, 'query'>;
  readiness: Pick<ReadinessService, 'fix' | 'recheck'>;
  /** The handle of the channel's orchestrator, for the «Відкрити» path; null = no agent. */
  agentOf(channelKey: string): Promise<string | null>;
}

const at = (outcome: string) => `${outcome} · ${kyivTime(new Date())}`;

export const NOTHING_TO_FIX_UK = 'Тут немає виправлень в один дотик — відкрийте панель';
const FIX_HEADER = 'Виправлю в один дотик:';
const MAX_LINES = 5;
const BLOCKER_LINE_MAX = 100;
const FIX_LINE_MAX = 80;
const KEEP_FIX_LINES = 3;

/** The blocker's line: the reason in Ukrainian and what it is about. */
export function blockerLineUk(f: Pick<Finding, 'check' | 'title' | 'subject'>): string {
  const uk = doctorReason(f.check)?.uk ?? f.title;
  const label = (f.subject?.label ?? '').trim();
  return clip(`• ${uk}${label ? ` — ${clip(label, 40)}` : ''}`, BLOCKER_LINE_MAX);
}

/** The one-sentence fix in Ukrainian, or null when the catalogue has none. */
const fixLineUk = (f: Pick<Finding, 'check'>): string | null => {
  const uk = doctorReason(f.check)?.fix?.uk;
  return uk ? clip(`• ${uk}`, FIX_LINE_MAX) : null;
};

const summaryUk = (k: number) => `Виправлень в один дотик: ${k}. Решта — у панелі Readiness.`;

/**
 * The card body. It must fit `BODY_MAX` by construction (the sender clips, and a clipped summary line would lose the count):
 * blocker lines (at most 5, the rest as «…і ще N») and one-tap fix lines (at most 5); at least three fix lines are kept when the
 * blocker lines would crowd them out.
 */
export function readinessBodyUk(blockers: readonly Finding[], fixable: readonly Finding[]): string {
  const lines = blockers.map(blockerLineUk);
  const seen = new Set<string>();
  const fixLines: string[] = [];
  for (const f of fixable) {
    const l = fixLineUk(f);
    if (l && !seen.has(l)) { seen.add(l); fixLines.push(l); }
  }
  const compose = (b: number, fx: number): string => {
    const head = [...lines.slice(0, b), ...(lines.length > b ? [`…і ще ${lines.length - b}`] : [])].join('\n');
    const mid = fx > 0 ? `${FIX_HEADER}\n${fixLines.slice(0, fx).join('\n')}` : null;
    return [head, mid, summaryUk(fixable.length)].filter(Boolean).join('\n\n');
  };
  // The owner confirms «Виправити все» without a list in the dialog, so up to three fix lines are kept before more blocker lines
  // are: the most blocker lines that fit with them, then as many fix lines as still fit.
  const want = Math.min(MAX_LINES, fixLines.length);
  const floor = Math.min(KEEP_FIX_LINES, fixLines.length);
  let b = Math.min(MAX_LINES, lines.length);
  while (b > 1 && compose(b, floor).length > BODY_MAX) b--;
  for (let fx = want; fx >= 0; fx--) {
    const t = compose(b, fx);
    if (t.length <= BODY_MAX) return t;
  }
  return compose(1, 0);
}

export function readinessSource(d: ReadinessCardDeps): CardSource {
  return {
    kind: 'readiness', emoji: '🩺', label: 'Готовність каналу',
    async waiting() {
      const { rows } = await d.pool.query(
        `SELECT r.channel_key, r.findings, r.notified_blockers, r.notified_at,
                EXISTS (SELECT 1 FROM channel_launches l
                         WHERE lower(l.channel_key) = lower(c.channel_key) AND lower(l.status) IN ('ready', 'running')) AS launch_open
           FROM channel_readiness r
           JOIN editor_channels c ON c.channel_key = r.channel_key
          WHERE r.blockers > 0 AND r.notified_at IS NOT NULL AND jsonb_array_length(r.notified_blockers) > 0 AND ${IN_SWEEP}
          ORDER BY r.notified_at`);
      const items: WaitingItem[] = [];
      for (const r of rows) {
        const stamped: string[] = Array.isArray(r.notified_blockers) ? r.notified_blockers.map(String) : [];
        const findings: Finding[] = Array.isArray(r.findings) ? r.findings : [];
        const keep = new Set(stamped);
        // The stamped blockers that are still open (and still the card's to name).
        const open = notifiable(findings, { launchOpen: !!r.launch_open }).filter((f) => keep.has(f.key));
        if (!open.length) continue;
        const fixable = findings.filter(isFixAllTarget);
        const handle = await d.agentOf(r.channel_key);
        const path = handle
          ? resolveLink('/app/agents/:agent?tab=overview&readiness=1', { agent: handle })
          : resolveLink('/app/editor/:channel', { channel: r.channel_key });
        const buttons: CardButton[] = [
          ...(fixable.length ? [{ key: 'fix', label: 'Виправити все', confirm: 'Так, виправити' }] : []),
          { key: 'recheck', label: 'Перевірити' },
          { key: 'open', label: 'Відкрити' },
        ];
        items.push({
          refId: readinessRefId(r.channel_key, stamped, new Date(r.notified_at)),
          title: `${r.channel_key}: ${open.length} ${plural(open.length, 'блокер', 'блокери', 'блокерів')} готовності`,
          body: readinessBodyUk(open, fixable),
          path, critical: false, since: new Date(r.notified_at), buttons,
        });
      }
      return items;
    },
    async act(refId, key) {
      const channel = channelOfRefId(refId);
      if (key === 'fix') {
        const out: FixOutcome = await d.readiness.fix(channel, undefined, 'telegram');
        if (!out.applied.length && !out.failed.length) throw new Error(NOTHING_TO_FIX_UK);
        if (!out.applied.length) throw new Error(`Не вдалося виправити: ${out.failed[0].error}`);
        const tail = out.failed.length ? `; не вдалося: ${out.failed.length}` : '';
        return at(`✅ Виправлено: ${out.applied.length}. Блокерів лишилось: ${out.view.blockers}${tail}`);
      }
      if (key === 'recheck') {
        const v = await d.readiness.recheck(channel, 'owner');
        return at(v.blockers ? `Блокерів: ${v.blockers}` : '✅ Блокерів немає');
      }
      throw new Error(`unknown button ${key}`);
    },
  };
}
