// Promo tab of /app/agents/$handle (spec 022 FR-007): cross-promo pairs inside
// the network (relevance, last promo, 30-day count), recent promo slots
// (kind, source → target, status, tracked link, outcome) and the tracked
// links with their join counts. Only counts are shown — never who joined.
//
// Spec 078 D1.3: the look is agent-plan.css (prefix apl-). Pairs are a table (rows on a phone), the promo slots and the
// tracked links are rows in flush panels; a slot's status is the Badge of lib/status-tone.ts.

import { useMemo, useState } from 'react';
import { EmptyState, SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Modal } from '../Modal';
import { slotLabel, slotTone } from '../../lib/status-tone';
import { fmtDate, fmtRelative } from '../../lib/format';
import { sanitizeTelegramHtml } from '../../lib/tg-html';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { usePromo, type PromoSlot, type TrackedLink } from '../../api/promo';
import { NetworkError, ResourceLabel } from './NetworkUi';
import { OUTCOME_LABEL, OUTCOME_TONE } from './Directives';

const KIND_LABEL = { cross_promo: 'cross-promo', repost: 'repost' } as const;
const LINK_KIND = { tg_invite: 'invite link', utm: 'UTM link' } as const;

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const s = `${x.hostname.replace(/^www\./, '')}${x.pathname === '/' ? '' : x.pathname}`;
    return s.length > 42 ? `${s.slice(0, 41)}…` : s;
  } catch { return u; }
}

function Relevance({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="apl-dim">—</span>;
  const level = value >= 4 ? 'high' : value >= 3 ? 'mid' : 'low';
  return (
    <span className={`tabular-nums apl-rel is-${level}`} title={value >= 3 ? 'Relevant enough to promote (≥ 3)' : 'Below the relevance threshold (3)'}>
      {Number(value.toFixed(1))}<span className="apl-rel-of">/5</span>
    </span>
  );
}

function Pair({ source, target }: { source: string; target: string }) {
  return (
    <span className="apl-route">
      <ResourceLabel refId={source} strong />
      <span aria-label="to" className="apl-dim">→</span>
      <ResourceLabel refId={target} strong />
    </span>
  );
}

export function AgentPromo({ handle }: { handle: string }) {
  const q = usePromo(handle);
  const phone = useMediaQuery('(max-width: 600px)');
  const totals = useMemo(() => {
    const t = { joins: 0, clicks: 0 };
    for (const l of q.data?.links ?? []) t[l.kind === 'utm' ? 'clicks' : 'joins'] += l.joins ?? 0;
    return t;
  }, [q.data]);

  if (q.error) return <NetworkError error={q.error} />;
  if (!q.data) return <div className="panel apl-skeleton compose-rise" style={{ height: 160 }} aria-hidden />;
  const { pairs, slots, links } = q.data;
  if (!pairs.length && !slots.length && !links.length) {
    return <EmptyState icon="megaphone" title="No promo yet"
      note="Cross-promo and reposts start from an accepted @manager directive: the planner reserves a slot (pair cooldown 14 days, ≤ 1 per resource and ≤ 3 per network a day) and posts it with a tracked link." />;
  }

  return (
    <div className="apl-stack">
      <SectionCard delay={0} icon="graph" title={`Pairs · ${pairs.length}`} flush={phone || pairs.length === 0}>
        {pairs.length === 0
          ? <div className="panel-row"><span className="text-body-sm apl-muted">No promo pairs inside this network yet.</span></div>
          : phone ? (
            pairs.map((p) => (
              <div key={`${p.sourceRef}>${p.targetRef}`} className="panel-row apl-pairrow">
                <Pair source={p.sourceRef} target={p.targetRef} />
                <div className="text-micro apl-pairrow-meta">
                  <span>relevance <Relevance value={p.relevance} /></span>
                  <span title={p.lastPromoAt ? fmtDate(p.lastPromoAt) : undefined}>last {p.lastPromoAt ? fmtRelative(p.lastPromoAt) : 'never'}</span>
                  <span className="tabular-nums">{p.count30d} in 30 days</span>
                </div>
              </div>
            ))
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th>Source → target</th>
                  <th className="num">Relevance</th>
                  <th>Last promo</th>
                  <th className="num">30 days</th>
                </tr></thead>
                <tbody>
                  {pairs.map((p) => (
                    <tr key={`${p.sourceRef}>${p.targetRef}`}>
                      <td className="apl-td-pair"><Pair source={p.sourceRef} target={p.targetRef} /></td>
                      <td className="num"><Relevance value={p.relevance} /></td>
                      <td className="apl-td-when" title={p.lastPromoAt ? fmtDate(p.lastPromoAt) : undefined}>
                        {p.lastPromoAt ? fmtRelative(p.lastPromoAt) : 'never'}
                      </td>
                      <td className="num">{p.count30d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </SectionCard>

      <SectionCard delay={60} icon="megaphone" title={`Recent promos · ${slots.length}`} flush>
        {slots.length === 0
          ? <div className="panel-row"><span className="text-body-sm apl-muted">No promo slots yet.</span></div>
          : slots.map((s) => <PromoSlotRow key={s.id} slot={s} />)}
      </SectionCard>

      <SectionCard delay={120} icon="users" title={`Tracked links · ${links.length}`} flush
        action={links.length ? <span className="text-micro mono apl-muted">{[totals.joins ? `${totals.joins.toLocaleString('en-US')} joins` : null, totals.clicks ? `${totals.clicks.toLocaleString('en-US')} clicks` : null].filter(Boolean).join(' · ') || '0 joins'}</span> : undefined}>
        {links.length === 0
          ? <div className="panel-row"><span className="text-body-sm apl-muted">No tracked links yet — they are created only for live promos.</span></div>
          : links.map((l) => <LinkRow key={l.id} link={l} />)}
      </SectionCard>
    </div>
  );
}

function PromoSlotRow({ slot }: { slot: PromoSlot }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (slot.preview ? sanitizeTelegramHtml(slot.preview) : null), [slot.preview]);
  const p = slot.promo;
  const tracked = p.tracked ?? false;
  return (
    <div className="panel-row apl-promo">
      <div className="apl-promo-top">
        <span className="mono apl-promo-date" title={fmtDate(slot.at)}>
          {fmtDate(slot.at).replace(/ \d{4},/, ',')}
        </span>
        <span className="chip">{KIND_LABEL[p.kind] ?? p.kind}</span>
        <Badge tone={slotTone(slot.status)}>{slotLabel(slot.status)}</Badge>
        {p.link_url !== undefined || p.tracked !== undefined
          ? <span className="chip" title={tracked ? 'Joins through this link are counted' : 'Fallback public link — joins unknown'}>{tracked ? 'tracked' : 'untracked'}</span>
          : null}
        {slot.outcome && <Badge tone={OUTCOME_TONE[slot.outcome]} title="Outcome of the directive behind this promo">{OUTCOME_LABEL[slot.outcome]}</Badge>}
        {p.relevance != null && <span className="text-micro apl-promo-rel">relevance <Relevance value={p.relevance} /></span>}
      </div>
      <Pair source={p.source_ref} target={p.target_ref} />
      <div className="apl-promo-foot">
        {p.link_url && (
          <a href={p.link_url} target="_blank" rel="noreferrer noopener" className="link-accent text-micro apl-url" title={p.link_url}>
            <Icon name="globe" size={11} />{shortUrl(p.link_url)}
          </a>
        )}
        {p.post_ref && <span className="text-micro apl-promo-post">post {p.post_ref}</span>}
        {html && (
          <button type="button" className="btn-tiny apl-promo-preview" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <Icon name="eye" size={12} /> Preview
          </button>
        )}
      </div>
      {slot.error && <div className="text-micro apl-promo-error">{slot.error.replace(/_/g, ' ')}</div>}
      {html && (
        <Modal open={open} onClose={() => setOpen(false)} icon="eye" title="Promo post preview"
          subtitle={`${KIND_LABEL[p.kind] ?? p.kind} · ${fmtDate(slot.at)} · ${slotLabel(slot.status).toLowerCase()}`}>
          <div className="inset text-body-sm apl-preview" dangerouslySetInnerHTML={{ __html: html }} />
        </Modal>
      )}
    </div>
  );
}

function LinkRow({ link }: { link: TrackedLink }) {
  return (
    <div className="panel-row apl-linkrow">
      <div className="apl-linkrow-main">
        <div className="apl-linkrow-top">
          <span className="chip">{LINK_KIND[link.kind as keyof typeof LINK_KIND] ?? link.kind}</span>
          <Badge tone={link.status === 'active' ? 'success' : 'neutral'}>{link.status}</Badge>
          <span className="text-micro mono apl-dim" title={fmtDate(link.createdAt)}>{fmtRelative(link.createdAt)}</span>
        </div>
        <Pair source={link.sourceRef} target={link.targetRef} />
        <a href={link.url} target="_blank" rel="noreferrer noopener" className="link-accent text-micro apl-url" title={link.url}>{shortUrl(link.url)}</a>
      </div>
      <div className="apl-linkrow-count">
        <div className="tabular-nums apl-count">{link.joins.toLocaleString('en-US')}</div>
        <div className="text-micro apl-dim">{link.kind === 'utm' ? 'clicks' : 'joins'}</div>
      </div>
    </div>
  );
}
