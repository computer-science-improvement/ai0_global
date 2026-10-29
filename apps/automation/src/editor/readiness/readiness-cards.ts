import type { Pool } from 'pg';
import type { Finding, Fix } from '../sysadmin/audit.types';
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
 * (`notified_blockers`, at most one stamp a day) has one card; the card names the blockers, lists what one tap does about them
 * (each fix in its own words: what will be switched off, allowed or routed) and offers «Виправити все», «Перевірити» and
 * «Відкрити». The text is the owner's Telegram text (Ukrainian, formal address).
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
const BLOCKER_LINE_MAX = 140;
const LABEL_MAX = 40;
const FIX_LINE_MAX = 90;
const KEEP_FIX_LINES = 3;

/**
 * The blocker's line: the reason in Ukrainian, then what it is about. The label is what tells two blockers of one code apart
 * (which skill, which series), so it is kept (up to 40 characters) and the reason gives way when the line is too long.
 */
export function blockerLineUk(f: Pick<Finding, 'check' | 'title' | 'subject'>): string {
  const reason = (doctorReason(f.check)?.uk ?? f.title).trim().replace(/\.+$/, '');
  const raw = (f.subject?.label ?? '').trim();
  const label = raw ? clip(raw, LABEL_MAX) : '';
  const room = BLOCKER_LINE_MAX - 2 - (label ? label.length + 3 : 0);
  return `• ${clip(reason, room)}${label ? ` — ${label}` : ''}`;
}

/**
 * What one tap does for a fix, in the bot's own words (W1 integration review): not the catalogue's advice to the owner, but the
 * change «Виправити все» makes. Null for a kind this code does not know (a later spec's): the line is left out.
 */
export function fixActionUk(fix: Fix): string | null {
  switch (fix.kind) {
    case 'skill_disable':          return `Вимкну скіл «${fix.skill}»`;
    case 'skill_inline_off':       return `Перестану вантажити скіл «${fix.skill}» у кожен запуск`;
    case 'memory_retire':          return `Приберу рядок пам’яті №${fix.id}`;
    case 'conflicts_resolve':      return 'Узгоджу налаштування з вашими правилами';
    case 'tools_allow_add':        return `Додам ${fix.tools.join(', ')} у дозволені інструменти картки`;
    case 'hashtag_min_zero':       return 'Поставлю мінімум хештегів 0';
    case 'series_resume':          return 'Відновлю призупинену серію';
    case 'series_source_require':  return `Зроблю джерело серії «${fix.series}» обов’язковим (серія стане вашою)`;
    case 'source_drop':            return `Приберу джерело «${fix.sourceId}» з картки`;
    case 'host_proxy_add':         return `Пущу ${fix.host} через проксі й прочитаю джерело ще раз`;
    default:                       return null;
  }
}

const fixLineUk = (f: Pick<Finding, 'fix'>): string | null => {
  const action = f.fix ? fixActionUk(f.fix) : null;
  return action ? clip(`• ${action}`, FIX_LINE_MAX) : null;
};

/** Why «Виправити все» changed nothing, for the owner: the refusal's code in a Ukrainian sentence, never the code itself. */
const FIX_ERROR_UK: Record<string, string> = {
  proxy_not_configured: 'проксі не налаштовано в Settings',
  source_still_failing: 'сайт уже йде через проксі, але джерело досі не читається',
  invalid_host: 'адреса сайту некоректна',
  fix_unavailable: 'це виправлення зараз недоступне',
  nothing_to_apply: 'виправляти вже нічого',
  nothing_to_retire: 'цей рядок пам’яті вже неактивний',
  channel_not_found: 'канал не знайдено',
  agent_not_found: 'агента не знайдено',
  source_not_found: 'цього джерела вже немає в картці',
  pause_not_found: 'цієї паузи вже немає',
  owner_pause: 'серію призупинили ви, тож відновлюєте її лише ви',
  already_resumed: 'серію вже відновлено',
  series_invalid: 'план серій не пройшов перевірку',
  finding_gone: 'проблема вже зникла',
};

/** «Не вдалося виправити: <why>. Деталі — у панелі Readiness.» from a fix error text (`<code>: <details>`). */
export function fixFailureUk(error: string): string {
  const code = /^([a-z][a-z0-9_]*)(?=:|$)/.exec((error ?? '').trim())?.[1];
  const why = code ? FIX_ERROR_UK[code] : undefined;
  return `Не вдалося виправити${why ? `: ${why}` : ''}. Деталі — у панелі Readiness.`;
}

const summaryUk = (k: number) => `Виправлень в один дотик: ${k}. Решта — у панелі Readiness.`;

/**
 * The card body. It must fit `BODY_MAX` by construction (the sender clips, and a clipped summary line would lose the count):
 * blocker lines (at most 5, the rest as «…і ще N») and one-tap fix lines (at most 5); at least three fix lines are kept when the
 * blocker lines would crowd them out. A fix line is the action one tap takes for a blocker the card names (W1 integration
 * review); the summary counts every fix the tap applies, the warnings' and the ones another note covers too.
 */
export function readinessBodyUk(blockers: readonly Finding[], fixable: readonly Finding[]): string {
  const lines = blockers.map(blockerLineUk);
  const named = new Set(blockers.map((f) => f.key));
  const seen = new Set<string>();
  const fixLines: string[] = [];
  for (const f of fixable.filter((x) => named.has(x.key))) {
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
        if (!out.applied.length) throw new Error(fixFailureUk(out.failed[0].error));
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
