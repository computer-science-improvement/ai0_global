// Promo tab of /app/agents/$handle (spec 022 FR-007): cross-promo pairs inside
// the network (relevance, last promo, 30-day count), recent promo slots
// (kind, source → target, status, tracked link, outcome) and the tracked
// links with their join counts. Only counts are shown — never who joined.

import { useMemo, useState } from 'react';
import { EmptyState, SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { SLOT_TONE } from '../editor/EditorUi';
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
  if (value == null) return <span style={{ color: 'var(--color-ink-dim)' }}>—</span>;
  const tone = value >= 4 ? 'var(--color-success)' : value >= 3 ? 'var(--color-ink)' : 'var(--color-danger)';
  return (
    <span className="tabular-nums" title={value >= 3 ? 'Relevant enough to promote (≥ 3)' : 'Below the relevance threshold (3)'} style={{ color: tone, fontWeight: 500 }}>
      {Number(value.toFixed(1))}<span style={{ color: 'var(--color-ink-dim)', fontWeight: 400 }}>/5</span>
    </span>
  );
}

function Pair({ source, target }: { source: string; target: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%', flexWrap: 'wrap' }}>
      <ResourceLabel refId={source} strong />
      <span aria-label="to" style={{ color: 'var(--color-ink-dim)' }}>→</span>
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
  if (!q.data) return <div className="panel compose-rise" style={{ height: 160, opacity: 0.55 }} />;
  const { pairs, slots, links } = q.data;
  if (!pairs.length && !slots.length && !links.length) {
    return <EmptyState icon="megaphone" title="No promo yet"
      note="Cross-promo and reposts start from an accepted @manager directive: the planner reserves a slot (pair cooldown 14 days, ≤ 1 per resource and ≤ 3 per network a day) and posts it with a tracked link." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionCard delay={0} icon="graph" title={`Pairs · ${pairs.length}`}>
        {pairs.length === 0
          ? <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>No promo pairs inside this network yet.</p>
          : phone ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pairs.map((p) => (
                <div key={`${p.sourceRef}>${p.targetRef}`} style={{ padding: '8px 10px', borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Pair source={p.sourceRef} target={p.targetRef} />
                  <div className="text-micro" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: 'var(--color-ink-muted)' }}>
                    <span>relevance <Relevance value={p.relevance} /></span>
                    <span title={p.lastPromoAt ? fmtDate(p.lastPromoAt) : undefined}>last {p.lastPromoAt ? fmtRelative(p.lastPromoAt) : 'never'}</span>
                    <span className="tabular-nums">{p.count30d} in 30 days</span>
                  </div>
                </div>
              ))}
            </div>
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
                      <td style={{ maxWidth: 360 }}><Pair source={p.sourceRef} target={p.targetRef} /></td>
                      <td className="num"><Relevance value={p.relevance} /></td>
                      <td title={p.lastPromoAt ? fmtDate(p.lastPromoAt) : undefined} style={{ whiteSpace: 'nowrap', color: 'var(--color-ink-muted)' }}>
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

      <SectionCard delay={60} icon="megaphone" title={`Recent promos · ${slots.length}`}>
        {slots.length === 0
          ? <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>No promo slots yet.</p>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{slots.map((s, i) => <PromoSlotRow key={s.id} slot={s} delay={Math.min(i, 10) * 25} />)}</div>}
      </SectionCard>

      <SectionCard delay={120} icon="users" title={`Tracked links · ${links.length}`}
        action={links.length ? <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>{[totals.joins ? `${totals.joins.toLocaleString('en-US')} joins` : null, totals.clicks ? `${totals.clicks.toLocaleString('en-US')} clicks` : null].filter(Boolean).join(' · ') || '0 joins'}</span> : undefined}>
        {links.length === 0
          ? <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>No tracked links yet — they are created only for live promos.</p>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{links.map((l) => <LinkRow key={l.id} link={l} />)}</div>}
      </SectionCard>
    </div>
  );
}

function PromoSlotRow({ slot, delay }: { slot: PromoSlot; delay: number }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (slot.preview ? sanitizeTelegramHtml(slot.preview) : null), [slot.preview]);
  const p = slot.promo;
  const tracked = p.tracked ?? false;
  return (
    <div className="card row-lift compose-rise" style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 7, animationDelay: `${delay}ms` }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink)', fontWeight: 500, whiteSpace: 'nowrap' }} title={fmtDate(slot.at)}>
          {fmtDate(slot.at).replace(/ \d{4},/, ',')}
        </span>
        <span className="chip" style={{ fontSize: 11 }}>{KIND_LABEL[p.kind] ?? p.kind}</span>
        <Badge tone={SLOT_TONE[slot.status] ?? 'neutral'}>{slot.status}</Badge>
        {p.link_url !== undefined || p.tracked !== undefined
          ? <span className="chip" style={{ fontSize: 11 }} title={tracked ? 'Joins through this link are counted' : 'Fallback public link — joins unknown'}>{tracked ? 'tracked' : 'untracked'}</span>
          : null}
        {slot.outcome && <Badge tone={OUTCOME_TONE[slot.outcome]} title="Outcome of the directive behind this promo">{OUTCOME_LABEL[slot.outcome]}</Badge>}
        {p.relevance != null && <span className="text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }}>relevance <Relevance value={p.relevance} /></span>}
      </div>
      <Pair source={p.source_ref} target={p.target_ref} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        {p.link_url && (
          <a href={p.link_url} target="_blank" rel="noreferrer noopener" className="link-accent text-micro" title={p.link_url}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <Icon name="globe" size={11} />{shortUrl(p.link_url)}
          </a>
        )}
        {p.post_ref && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>post {p.post_ref}</span>}
        {html && (
          <button type="button" className="btn-tiny" style={{ gap: 5, marginLeft: 'auto' }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name="eye" size={12} /> {open ? 'Hide preview' : 'Preview'}
          </button>
        )}
      </div>
      {slot.error && <div className="text-micro" style={{ color: 'var(--color-danger)', overflowWrap: 'anywhere' }}>{slot.error.replace(/_/g, ' ')}</div>}
      {open && html && (
        <div className="text-body-sm" style={{ padding: '10px 12px', maxWidth: 520, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, color: 'var(--color-ink)' }}
          dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function LinkRow({ link }: { link: TrackedLink }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline)' }}>
      <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="chip" style={{ fontSize: 11 }}>{LINK_KIND[link.kind as keyof typeof LINK_KIND] ?? link.kind}</span>
          <Badge tone={link.status === 'active' ? 'success' : 'neutral'}>{link.status}</Badge>
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }} title={fmtDate(link.createdAt)}>{fmtRelative(link.createdAt)}</span>
        </div>
        <Pair source={link.sourceRef} target={link.targetRef} />
        <a href={link.url} target="_blank" rel="noreferrer noopener" className="link-accent text-micro" title={link.url}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{shortUrl(link.url)}</a>
      </div>
      <div style={{ textAlign: 'right', marginLeft: 'auto' }}>
        <div className="tabular-nums" style={{ fontSize: 20, fontWeight: 600, color: 'var(--color-ink)', lineHeight: 1.1 }}>{link.joins.toLocaleString('en-US')}</div>
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{link.kind === 'utm' ? 'clicks' : 'joins'}</div>
      </div>
    </div>
  );
}
