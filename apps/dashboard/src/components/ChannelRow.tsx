import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { fmtNumber, fmtRelative } from '../lib/format';
import { Icon } from './Icon';
import { Badge } from './ui/Badge';
import { EditChannelModal } from './EditChannelModal';
import { ChannelAvatar } from './ChannelAvatar';
import {
  POLL_TIER_HELP, CHANNEL_FLAG_HELP, STRATEGY_ROLE_HELP,
  STRATEGY_STATUS_HELP, describeStrategy, channelTgId,
} from '../lib/labels';
import type { TrackedChannel } from '../api/types';

export function ChannelRow({ c, lowContentIds }: { c: TrackedChannel; lowContentIds?: Set<string> }) {
  const strategies = c.strategies ?? [];
  const [editing, setEditing] = useState(false);

  return (
    <>
      <Link
        to={'/channels/$id' as any}
        params={{ id: c.id } as any}
        style={{
          display: 'block',
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 18px',
          textDecoration: 'none',
          color: 'inherit',
          transition: 'background 0.12s ease',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-2)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-1)'; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <ChannelAvatar
            name={c.title ?? c.username ?? c.channelKey}
            src={null}
            size={36}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                {c.title ?? c.channelKey ?? (c.username ? `@${c.username}` : '(no title)')}
              </span>
              {c.kind && (
                <span className="chip" title={`Kind: ${c.kind} channel`}>{c.kind}</span>
              )}
              {c.isMine        && <span className="chip chip-success" title={CHANNEL_FLAG_HELP.mine}>mine</span>}
              {c.isClosed      && <span className="chip" title={CHANNEL_FLAG_HELP.closed}>closed</span>}
              {c.publishPaused && (
                <span className="chip chip-warning" title={CHANNEL_FLAG_HELP.publishPaused}>
                  <Icon name="pause" size={11} style={{ marginRight: 4 }} />
                  paused
                </span>
              )}
              {c.bot && (
                <span
                  className="chip"
                  title={`Bot ${c.bot.bot_id}${c.bot.username ? ` (@${c.bot.username})` : ''}${!c.bot.active ? ' — inactive' : ''} — publishes into this channel`}
                  style={{ opacity: c.bot.active ? 1 : 0.6 }}
                >
                  <Icon name="bots" size={11} style={{ marginRight: 4 }} />
                  {c.bot.username ?? c.bot.bot_id}
                </span>
              )}
              {c.trackingStatus === 'not_subscribed' && (
                <span title="The tracker account isn't subscribed to this channel">
                  <Badge tone="warning">
                    <Icon name="warning" size={11} /> Subscribe to track
                  </Badge>
                </span>
              )}
            </div>
            {/* Meta line — the *real* Telegram id (chat-id for private,
                @username for public). Never the local channelKey alias when
                a real id is available, and never the internal UUID. */}
            {(() => {
              const tg = channelTgId(c);
              return tg ? (
                <div
                  className="text-micro"
                  style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}
                  title={c.kind === 'private' ? 'Numeric Telegram chat id' : 'Public Telegram @username'}
                >
                  {tg}
                </div>
              ) : null;
            })()}
          </div>
          <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 14 }}>
            <span
              className="text-body-sm"
              style={{ color: c.subsCount == null ? 'var(--color-ink-dim)' : 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}
              title={c.subsCount == null
                ? 'Subscriber count unknown. Public channels populate on the next poll; private channels return null from Telegram’s getChat unless the bot is admin.'
                : `${c.subsCount.toLocaleString()} subscribers`}
            >
              {fmtNumber(c.subsCount)}
            </span>
            <PollTierChip tier={c.pollTier} />
            <span
              className="text-body-sm"
              style={{ color: 'var(--color-ink-muted)' }}
              title={c.lastPolledAt
                ? `Last polled: ${new Date(c.lastPolledAt).toLocaleString()}`
                : 'Never polled — the tracker hasn’t fetched stats for this channel yet.'}
            >
              {fmtRelative(c.lastPolledAt)}
            </span>
            {c.isMine && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(true); }}
                className="btn-icon"
                style={{ width: 28, height: 28, color: 'var(--color-ink-muted)' }}
                title="Edit channel config"
              >
                <Icon name="pencil" size={12} />
              </button>
            )}
          </div>
        </div>

        {strategies.length > 0 && (
          <div style={{
            marginTop: 10, paddingTop: 10,
            borderTop: '1px solid var(--color-hairline-soft)',
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>strategies:</span>
            {strategies.map(s => {
              const meta = describeStrategy(s.type);
              const tooltip = [
                meta ? `${meta.title} — ${meta.description}` : s.type,
                `Binding: ${s.ext_id}`,
                `Role: ${s.role} (${STRATEGY_ROLE_HELP[s.role]})`,
                `Status: ${s.enabled ? 'enabled' : 'paused'} — ${s.enabled ? STRATEGY_STATUS_HELP.enabled : STRATEGY_STATUS_HELP.paused}`,
                ...(lowContentIds?.has(s.id) ? ['⚠ Low content — running out of posts for this strategy.'] : []),
              ].join('\n\n');
              return (
                <span
                  key={s.id}
                  className={s.enabled ? 'chip is-active' : 'chip'}
                  title={tooltip}
                  style={{ opacity: s.enabled ? 1 : 0.6 }}
                >
                  {s.type}
                  {s.role === 'forward' && <span style={{ marginLeft: 4, color: 'var(--color-ink-dim)' }}>↩</span>}
                  {lowContentIds?.has(s.id) && (
                    <Icon name="warning" size={11} style={{ marginLeft: 4, color: 'var(--color-warning)' }} />
                  )}
                </span>
              );
            })}
          </div>
        )}
      </Link>

      {editing && <EditChannelModal channel={c} open={editing} onClose={() => setEditing(false)} />}
    </>
  );
}

function PollTierChip({ tier }: { tier: TrackedChannel['pollTier'] }) {
  const cls = tier === 'hot' ? 'chip chip-warning' : tier === 'warm' ? 'chip chip-success' : 'chip';
  return <span className={cls} title={POLL_TIER_HELP[tier]}>{tier}</span>;
}
