import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { fmtNumber, fmtRelative, fmtDate } from '../lib/format';
import { Icon } from './Icon';
import { Badge } from './ui/Badge';
import { RowActions, TableAction } from './ui/table';
import { EditChannelModal } from './EditChannelModal';
import { ChannelGlyph } from './channels/ChannelsUi';
import {
  POLL_TIER_HELP, CHANNEL_FLAG_HELP, STRATEGY_ROLE_HELP,
  STRATEGY_STATUS_HELP, describeStrategy, channelTgId,
} from '../lib/labels';
import { TRACKING_META, channelName } from '../lib/channel-view';
import type { TrackedChannel } from '../api/types';

/**
 * One channel as a row of a flush panel (`<SectionCard flush>`): glyph, name and badges, the tg id, then subscribers,
 * poll tier and last poll. The identity and the numbers link to the channel page; edit and delete are their own buttons.
 */
export function ChannelRow({ c, onDelete, showTracking = false }: {
  c: TrackedChannel;
  /** When provided, renders a danger delete action (used by the Tracked page). */
  onDelete?: () => void;
  /** Also shows the tracking state (Tracking / Unknown) as a badge: for channels the tracker follows (Tracked page). */
  showTracking?: boolean;
}) {
  const strategies = c.strategies ?? [];
  const [editing, setEditing] = useState(false);
  const name = channelName(c);
  const tg = channelTgId(c);
  const tracking = TRACKING_META[c.trackingStatus];
  const del = onDelete ? <TableAction action="delete" title="Delete channel" onClick={onDelete} /> : undefined;

  return (
    <div className="panel-row ch-row">
      <Link to="/app/channels/$id" params={{ id: c.id }} className="ch-row-link">
        <ChannelGlyph name={c.title ?? c.username ?? c.channelKey} />
        <div className="ch-row-id">
          <div className="ch-row-title">
            <span className="text-body ch-row-name">{name}</span>
            {c.kind && (
              <span className="chip" title={`Kind: ${c.kind} channel`}>{c.kind}</span>
            )}
            {c.isMine        && <span title={CHANNEL_FLAG_HELP.mine}><Badge tone="success">mine</Badge></span>}
            {c.isClosed      && <span title={CHANNEL_FLAG_HELP.closed}><Badge tone="neutral">closed</Badge></span>}
            {c.publishPaused && (
              <span title={CHANNEL_FLAG_HELP.publishPaused}>
                <Badge tone="warning"><Icon name="pause" size={11} /> paused</Badge>
              </span>
            )}
            {c.bot && (
              <span
                className={`chip${c.bot.active ? '' : ' ch-dim'}`}
                title={`Bot ${c.bot.bot_id}${c.bot.username ? ` (@${c.bot.username})` : ''}${!c.bot.active ? ' — inactive' : ''} — publishes into this channel`}
              >
                <Icon name="bots" size={11} style={{ marginRight: 4 }} />
                {c.bot.username ?? c.bot.bot_id}
              </span>
            )}
            {c.needsBot && (
              <span title="This channel has no bot bound and no default bot exists — strategies can't publish here.">
                <Badge tone="warning"><Icon name="warning" size={11} /> No bot — add or set a default bot to publish</Badge>
              </span>
            )}
            {c.trackingStatus === 'not_subscribed' && (
              <span title="The tracker account isn't subscribed to this channel">
                <Badge tone="warning"><Icon name="warning" size={11} /> Subscribe to track</Badge>
              </span>
            )}
            {showTracking && c.trackingStatus !== 'not_subscribed' && (
              <span title={tracking.help}><Badge tone={tracking.tone}>{tracking.label}</Badge></span>
            )}
          </div>
          {/* The real Telegram id (chat id for private, @username for public); never the local channelKey alias
              when a real id is there, never the internal UUID. */}
          {tg && (
            <div
              className="mono ch-row-sub"
              title={c.kind === 'private' ? 'Numeric Telegram chat id' : 'Public Telegram @username'}
            >
              {tg}
            </div>
          )}
        </div>
        <div className="ch-row-nums mono">
          <span
            className={`ch-row-subs${c.subsCount == null ? ' is-unknown' : ''}`}
            title={c.subsCount == null
              ? 'Subscriber count unknown. Public channels populate on the next poll; private channels return null from Telegram’s getChat unless the bot is admin.'
              : `${c.subsCount.toLocaleString()} subscribers`}
          >
            {fmtNumber(c.subsCount)}
          </span>
          <PollTierChip tier={c.pollTier} />
          <span
            className="ch-row-age"
            title={c.lastPolledAt
              ? `Last polled: ${fmtDate(c.lastPolledAt)}`
              : 'Never polled — the tracker hasn’t fetched stats for this channel yet.'}
          >
            {fmtRelative(c.lastPolledAt)}
          </span>
        </div>
      </Link>

      {(c.isMine || onDelete) && (
        // The delete button sits after a divider only when an edit button comes before it.
        <RowActions danger={c.isMine ? del : undefined}>
          {c.isMine ? <TableAction action="edit" title="Edit channel config" onClick={() => setEditing(true)} /> : del}
        </RowActions>
      )}

      {strategies.length > 0 && (
        <div className="ch-row-strat">
          <span className="text-micro ch-row-strat-label">strategies:</span>
          {strategies.map(s => {
            const meta = describeStrategy(s.type);
            const tooltip = [
              meta ? `${meta.title} — ${meta.description}` : s.type,
              `Binding: ${s.ext_id}`,
              `Role: ${s.role} (${STRATEGY_ROLE_HELP[s.role]})`,
              `Status: ${s.enabled ? 'enabled' : 'paused'} — ${s.enabled ? STRATEGY_STATUS_HELP.enabled : STRATEGY_STATUS_HELP.paused}`,
            ].join('\n\n');
            return (
              <span
                key={s.id}
                className={`chip${s.enabled ? ' is-active' : ' ch-dim'}`}
                title={tooltip}
              >
                {s.type}
                {s.role === 'forward' && <span className="ch-row-strat-fwd">↩</span>}
              </span>
            );
          })}
        </div>
      )}

      {editing && <EditChannelModal channel={c} open={editing} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** The poll tier is a category, not a state: a neutral badge (amber is reserved for the human). */
function PollTierChip({ tier }: { tier: TrackedChannel['pollTier'] }) {
  return <Badge tone="neutral" title={POLL_TIER_HELP[tier]}>{tier}</Badge>;
}
