// Media kit (spec 008 T008): channels with active ad prices, live stats from
// GET /api/landing/media-kit. Renders nothing until there is at least one price.
import { Icon } from '../ui/Icon';
import { AD_FORMAT_LABEL, useMediaKit } from '../../api/ads';

const fmt = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-US'));

export function MediaKit() {
  const { data } = useMediaKit();
  const channels = data ?? [];
  if (!channels.length) return null;

  return (
    <div className="lp-kit">
      {channels.map((c) => (
        <div key={c.channelKey} className="lp-kit-card">
          <div className="lp-kit-head">
            <Icon name="telegram" size={15} />
            {c.url
              ? <a href={c.url} target="_blank" rel="noreferrer" className="lp-kit-title">{c.title ?? c.channelKey}</a>
              : <span className="lp-kit-title">{c.title ?? c.channelKey}</span>}
          </div>
          <div className="lp-kit-stats">
            <span><b className="tabular-nums">{fmt(c.subscribers)}</b><span className="text-micro">subscribers</span></span>
            <span><b className="tabular-nums">{fmt(c.avgViews30d)}</b><span className="text-micro">avg views / post, 30d</span></span>
          </div>
          <ul className="lp-kit-prices">
            {c.prices.map((p) => (
              <li key={p.format}>
                <span className="lp-kit-fmt">
                  {AD_FORMAT_LABEL[p.format]}
                  {p.note ? <span className="text-micro">{p.note}</span> : null}
                </span>
                <b className="tabular-nums">{p.priceUah.toLocaleString('en-US')} ₴</b>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <style>{`
        .lp-kit {
          width: 100%;
          /* Few cards must sit centred under the centred heading, not hug the left edge. */
          display: flex; flex-wrap: wrap; justify-content: center;
          gap: var(--space-md); text-align: left;
        }
        .lp-kit-card {
          flex: 1 1 260px; max-width: 340px;
          display: flex; flex-direction: column; gap: var(--space-md);
          padding: var(--space-lg);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline-soft);
          border-radius: var(--radius-lg);
        }
        .lp-kit-head { display: flex; align-items: center; gap: 8px; color: var(--color-ink-muted); min-width: 0; }
        .lp-kit-title {
          color: var(--color-ink); font-weight: 600; text-decoration: none;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .lp-kit-stats { display: flex; gap: var(--space-lg); }
        .lp-kit-stats > span { display: flex; flex-direction: column; gap: 2px; }
        .lp-kit-stats b { font-size: 20px; font-weight: 600; color: var(--color-ink); }
        .lp-kit-stats .text-micro { color: var(--color-ink-dim); }
        .lp-kit-prices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .lp-kit-prices li {
          display: flex; justify-content: space-between; gap: var(--space-sm);
          font-size: 13px; color: var(--color-ink-muted);
          padding-top: 6px; border-top: 1px solid var(--color-hairline-soft);
        }
        .lp-kit-prices b { color: var(--color-ink); white-space: nowrap; }
        .lp-kit-fmt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .lp-kit-fmt .text-micro { color: var(--color-ink-dim); }
      `}</style>
    </div>
  );
}
