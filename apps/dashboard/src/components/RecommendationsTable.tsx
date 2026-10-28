// The placements table of the Recommendations page: dense, column-oriented data, so it stays a table (ui/table) and the
// page frames it in a SectionCard. Themes shared with the target are the accented chips. Wide cells keep their width; on a
// phone the table scrolls inside its own frame.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { trackingApi } from '../api/tracking';
import { ChannelGlyph } from './channels/ChannelsUi';
import { Icon } from './ui/Icon';
import { EmptyState } from './ui/primitives';
import { TableAction, RowActions, ActionsTh } from './ui/table';
import type { RecommendationItem } from '../api/types';
import './channels/channels.css';

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
    return <EmptyState icon="recommendations" title="No matches" note="Nothing fits this target and budget." />;
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
            <ActionsTh />
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
      navigate({ to: '/app/channels/$id', params: { id: res.id } });
    },
  });

  return (
    <tr>
      <td className="mono rec-rank" style={{ textAlign: 'left' }}>{idx + 1}</td>
      <td>
        <div className="rec-ch">
          <ChannelGlyph name={r.title ?? r.slug} src={r.avatarUrl} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="text-body-sm rec-ch-name">{r.title}</div>
            <a
              href={r.link}
              target="_blank"
              rel="noopener noreferrer"
              className="link-accent mono rec-ch-handle"
              title="Open the channel in Telegram"
            >
              {username ? `@${username}` : 'invite link'}
            </a>
          </div>
        </div>
      </td>
      <td>
        <div className="rec-chips">
          {r.themes.slice(0, 5).map(t => (
            <span key={t} className={targetSet.has(t) ? 'chip is-active' : 'chip'}>
              {t}
            </span>
          ))}
          {r.themes.length > 5 && (
            <span className="mono rec-more">+{r.themes.length - 5}</span>
          )}
        </div>
      </td>
      <td className="num mono">{(r.score * 100).toFixed(0)}%</td>
      <td className="num mono">{(r.priceMin / 100).toFixed(0)}</td>
      <td className="num mono">
        {r.estimatedSubsPerAd == null
          ? <span className="rec-na">—</span>
          : (r.estimatedSubsPerAd > 0 ? '+' : '') + r.estimatedSubsPerAd}
      </td>
      <td className="num mono">
        {r.sexRatio == null
          ? <span className="rec-na">—</span>
          : `${r.sexRatio}/${100 - r.sexRatio}`}
      </td>
      <td style={{ textAlign: 'right' }}>
        <RowActions>
          <TableAction
            icon="plus"
            label="Track"
            onClick={() => track.mutate()}
            disabled={!username || track.isPending}
            title={username
              ? 'Add this channel to your tracked channels and open its page'
              : 'Private invite link — add manually via the Add Channel modal'}
          />
          <a
            href={teleadsUrl(r.slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-tiny rec-ext"
            title="Open the buyer page on teleads.com.ua"
          >
            TeleAds
            <Icon name="external" size={12} />
          </a>
          <a
            href={r.link}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-tiny rec-ext"
            title="Open the channel in Telegram"
          >
            Telegram
            <Icon name="external" size={12} />
          </a>
        </RowActions>
      </td>
    </tr>
  );
}
