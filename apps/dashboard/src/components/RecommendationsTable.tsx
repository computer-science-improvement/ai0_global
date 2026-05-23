// Dark-canvas rewrite. Uses .table recipe (surface-1 wrapper, hairline-soft
// dividers, surface-2 row hover). Chips use .chip / .chip.is-active instead
// of the previous bg-blue-100/text-blue-900 light-theme pair. External
// links use .link-accent (single chromatic accent), not text-blue-600.
// font-mono dropped — global tabular-nums already aligns numeric cells.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { trackingApi } from '../api/tracking';
import { Icon } from './Icon';
import { ChannelAvatar } from './ChannelAvatar';
import type { RecommendationItem } from '../api/types';

interface Props {
  items:        RecommendationItem[];
  targetThemes: string[];
}

/**
 * Pull the public @username out of a Telegram link. Public channels are
 * `https://t.me/<username>`; private invite links are `https://t.me/+<hash>`
 * and have no username. Returns null for invite links.
 */
function extractUsername(link: string): string | null {
  try {
    const url = new URL(link);
    const path = url.pathname.replace(/^\/+/, '').replace(/\/$/, '');
    if (!path || path.startsWith('+')) return null;
    return path;
  } catch {
    return null;
  }
}

/** Best-effort TeleAds product page URL. */
function teleadsUrl(slug: string): string {
  return `https://teleads.com.ua/promo/products/${slug}`;
}

export function RecommendationsTable({ items, targetThemes }: Props) {
  if (items.length === 0) {
    return (
      <div className="card" style={{
        textAlign: 'center', padding: 32,
        background: 'var(--color-surface-1)',
        border: '1px dashed var(--color-hairline)',
      }}>
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          No matches for this target / budget.
        </p>
      </div>
    );
  }

  const targetSet = new Set(targetThemes);

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>Channel</th>
            <th>Themes</th>
            <th className="num">Score</th>
            <th className="num">Price (UAH)</th>
            <th className="num">Subs/ad</th>
            <th className="num">F/M</th>
            <th style={{ width: 200, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, idx) => (
            <RecommendationRow
              key={r.id}
              item={r}
              idx={idx}
              targetSet={targetSet}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecommendationRow({ item: r, idx, targetSet }: {
  item: RecommendationItem; idx: number; targetSet: Set<string>;
}) {
  const navigate = useNavigate();
  const qc       = useQueryClient();

  const username = extractUsername(r.link);

  // "Track" action — adds the channel to /channels and navigates to its
  // detail page. Only available for public channels (we need the @username
  // for discovery polling). Private channels can be tracked manually via
  // the AddChannelModal full-config flow.
  const track = useMutation({
    mutationFn: () => {
      if (!username) throw new Error('Private channel — track via Add Channel modal (private kind)');
      return trackingApi.addChannel(username);
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      navigate({ to: '/channels/$id' as any, params: { id: res.id } as any });
    },
  });

  return (
    <tr>
      <td className="meta num" style={{ textAlign: 'left', width: 40 }}>{idx + 1}</td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {r.avatarUrl
            ? <img src={r.avatarUrl} alt="" style={{ width: 32, height: 32, borderRadius: 9999, objectFit: 'cover' }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : <ChannelAvatar name={r.title ?? r.slug} src={null} size={32} />}
          <div style={{ minWidth: 0 }}>
            <div className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{r.title}</div>
            <a
              href={r.link}
              target="_blank"
              rel="noopener noreferrer"
              className="link-accent text-micro"
              title="Open the channel in Telegram"
            >
              {username ? `@${username}` : 'invite link'}
            </a>
          </div>
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {r.themes.slice(0, 5).map(t => (
            <span key={t} className={targetSet.has(t) ? 'chip is-active' : 'chip'}>
              {t}
            </span>
          ))}
          {r.themes.length > 5 && (
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
              +{r.themes.length - 5}
            </span>
          )}
        </div>
      </td>
      <td className="num">{(r.score * 100).toFixed(0)}%</td>
      <td className="num">{(r.priceMin / 100).toFixed(0)}</td>
      <td className="num">
        {r.estimatedSubsPerAd == null
          ? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>
          : (r.estimatedSubsPerAd > 0 ? '+' : '') + r.estimatedSubsPerAd}
      </td>
      <td className="num">
        {r.sexRatio == null
          ? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>
          : `${r.sexRatio}/${100 - r.sexRatio}`}
      </td>
      <td style={{ textAlign: 'right' }}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <button
            onClick={() => track.mutate()}
            disabled={!username || track.isPending}
            className="btn-tiny"
            title={username
              ? 'Add this channel to /channels and open its detail page'
              : 'Private invite link — add manually via the Add Channel modal'}
          >
            <Icon name="plus" size={12} style={{ marginRight: 4 }} />
            Track
          </button>
          <a
            href={teleadsUrl(r.slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-tiny"
            title="Open the buyer page on teleads.com.ua"
            style={{ textDecoration: 'none' }}
          >
            TeleAds ↗
          </a>
          <a
            href={r.link}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-tiny"
            title="Open the channel in Telegram"
            style={{ textDecoration: 'none' }}
          >
            <Icon name="channels" size={12} style={{ marginRight: 4 }} />
            TG ↗
          </a>
        </div>
      </td>
    </tr>
  );
}
