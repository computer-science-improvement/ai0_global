// The entity header of the channel page (spec 078 C1): a 64px glyph, the name with its badges, the about text, one mono
// meta line (id, subscribers, poll tier, date added) and the channel's actions. Presentational: the page owns the
// mutations and the confirmations and passes handlers in.

import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { ChannelGlyph } from './ChannelsUi';
import { fmtDate, fmtNumber } from '../../lib/format';
import { CHANNEL_FLAG_HELP, CHANNEL_KIND_HELP, POLL_TIER_HELP, channelTgId } from '../../lib/labels';
import type { TrackedChannel } from '../../api/types';

export function ChannelHeader({
  channel: c, name, themesCount, busy, onPoll, onPause, onThemes, onEdit, onTier,
}: {
  channel: TrackedChannel;
  /** The page title: the channel's name. */
  name: string;
  themesCount: number;
  busy: { poll: boolean; pause: boolean; tier: boolean };
  /** Queue an immediate stats fetch. */
  onPoll: () => void;
  /** Pause publishing (the page confirms first). Resuming lives in the page's "paused" callout. */
  onPause: () => void;
  onThemes: () => void;
  onEdit: () => void;
  /** The poll tier select changed; the page confirms and saves, or snaps the select back. */
  onTier: (next: 'hot' | 'warm' | 'cold') => void;
}) {
  const tg = channelTgId(c);
  return (
    <header className="ent-head compose-rise">
      <ChannelGlyph name={c.title ?? c.username ?? c.channelKey} size="xl" title={name} />
      <div className="ent-main">
        <div className="ent-title">
          <h1 className="page-title">{name}</h1>
          {c.kind && (
            <span className="chip mono" title={CHANNEL_KIND_HELP[c.kind as 'public' | 'private'] ?? c.kind}>{c.kind}</span>
          )}
          {c.isMine && <span title={CHANNEL_FLAG_HELP.mine}><Badge tone="success">mine</Badge></span>}
          {c.publishPaused && (
            <span title={CHANNEL_FLAG_HELP.publishPaused}>
              <Badge tone="warning"><Icon name="pause" size={11} /> paused</Badge>
            </span>
          )}
          {c.trackingStatus === 'not_subscribed' && (
            <span title="The publishing bot is not subscribed to this channel.">
              <Badge tone="danger">not subscribed</Badge>
            </span>
          )}
        </div>

        {c.about && <p className="ent-about">{c.about}</p>}

        <div className="ent-meta mono">
          {tg && <span>{tg}</span>}
          {tg && <span className="ent-sep" aria-hidden>·</span>}
          <span><span className="is-strong">{fmtNumber(c.subsCount)}</span> subscribers</span>
          <span className="ent-sep" aria-hidden>·</span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            poll
            <select
              value={c.pollTier}
              onChange={(e) => onTier(e.target.value as 'hot' | 'warm' | 'cold')}
              disabled={busy.tier}
              title={POLL_TIER_HELP[c.pollTier]}
              aria-label="Poll tier"
              className="input-field mono ent-tier"
            >
              <option value="hot">hot</option>
              <option value="warm">warm</option>
              <option value="cold">cold</option>
            </select>
          </label>
          <span className="ent-sep" aria-hidden>·</span>
          <span>added {fmtDate(c.addedAt)}</span>
        </div>

        <div className="ent-actions">
          <button
            type="button"
            onClick={onPoll}
            disabled={busy.poll}
            className="btn-secondary btn-sm"
            title="Queue an immediate stats fetch (meta + posts). Also checks the subscription."
          >
            <Icon name="refresh" size={14} />
            {busy.poll ? 'Fetching…' : 'Fetch stats'}
          </button>
          <button type="button" onClick={onThemes} className="btn-secondary btn-sm">
            <Icon name="pencil" size={14} />
            Themes ({themesCount})
          </button>
          {c.isMine && (
            <button type="button" onClick={onEdit} className="btn-secondary btn-sm">
              <Icon name="pencil" size={14} />
              Config
            </button>
          )}
          {c.isMine && !c.publishPaused && (
            <button
              type="button"
              onClick={onPause}
              disabled={busy.pause}
              className="btn-secondary btn-sm"
              title={CHANNEL_FLAG_HELP.publishPaused}
            >
              <Icon name="pause" size={14} />
              Pause publishing
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
