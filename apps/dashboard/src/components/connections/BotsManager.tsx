// Telegram bots manager — the bot list + add/verify/pause/delete actions.
// Extracted from the old /bots route so it can render both standalone and
// inside the unified Connections page's Telegram tab.

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AddBotModal } from '../AddBotModal';
import { Icon } from '../Icon';
import { Badge } from '../ui/Badge';
import { useConfirm } from '../ui/ConfirmDialog';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import { useBots, useDeleteBot, useSetDefaultBot, useToggleBotActive, useVerifyBot } from '../../api/bots';
import { trackingApi } from '../../api/tracking';
import { BOT_STATUS_HELP } from '../../lib/labels';

export function BotsManager() {
  const { data, isLoading, error } = useBots();
  const verify     = useVerifyBot();
  const toggle     = useToggleBotActive();
  const remove     = useDeleteBot();
  const setDefault = useSetDefaultBot();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  /** Click on a non-action cell → open channels page filtered by this bot. */
  const viewChannels = (botId: string) => {
    navigate({ to: '/app/channels' as any, search: { filter: 'mine', page: 1, q: '', bot: botId } as any });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 className="text-eyebrow" style={{ margin: 0 }}>Bots</h2>
          <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
            Telegram bots that publish on your behalf. Tokens are stored in <code style={{ color: 'var(--color-ink-muted)' }}>.env</code>.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add bot
        </button>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {setDefault.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(setDefault.error as Error).message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon="bots"
          title="No bots configured yet"
          note="Add one to start publishing on your behalf."
        />
      )}

      {data && data.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((b, i) => (
            <div
              key={b.id}
              className="card row-lift compose-rise"
              style={{
                display: 'flex', alignItems: 'center', gap: 16,
                padding: '13px 18px', cursor: 'pointer',
                animationDelay: `${Math.min(i, 12) * 34}ms`,
              }}
              onClick={() => viewChannels(b.id)}
              title="View channels assigned to this bot"
            >
              {/* Avatar */}
              <span style={{
                width: 34, height: 34, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-surface-3)', border: '1px solid var(--color-hairline)',
                color: 'var(--color-ink-muted)',
              }}>
                <Icon name="bots" size={16} />
              </span>

              {/* Identity + status */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                    {b.bot_id}
                  </span>
                  {b.username && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>@{b.username}</span>}
                  {b.verify_error
                    ? <Badge tone="danger" title={`${BOT_STATUS_HELP.error}\n\n${b.verify_error}`}>
                        <Icon name="warning" size={11} /> {b.verify_error.slice(0, 40)}
                      </Badge>
                    : b.username
                      ? <Badge tone="success" title={BOT_STATUS_HELP.verified}>
                          <Icon name="check" size={11} /> verified
                        </Badge>
                      : <Badge tone="neutral" title={BOT_STATUS_HELP.unverified}>unverified</Badge>}
                  {!b.active && <Badge tone="neutral" title={BOT_STATUS_HELP.inactive}>inactive</Badge>}
                  {b.is_default && (
                    <Badge tone="accent" title="Default bot — used to publish into channels that have no bot of their own.">
                      <Icon name="check" size={11} /> default
                    </Badge>
                  )}
                </div>
                <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {b.token_env && (
                    <>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>env: {b.token_env}</span>
                      <span style={{ color: 'var(--color-ink-dim)' }}>·</span>
                    </>
                  )}
                  <span>verified {b.last_verified_at ? new Date(b.last_verified_at).toLocaleString() : 'never'}</span>
                </div>
              </div>

              {/* Actions */}
              <div style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <RowActions>
                  <TableAction
                    icon="check"
                    label={b.is_default ? 'Default' : 'Set default'}
                    onClick={() => setDefault.mutate({ id: b.id, default: !b.is_default })}
                    title={b.is_default
                      ? 'This bot is the default fallback publisher. Click to unset.'
                      : 'Make this the default fallback publisher for channels with no bot.'}
                  />
                  <TableAction action="verify" onClick={() => verify.mutate(b.id)} title="Re-run getMe" />
                  <TableAction
                    action={b.active ? 'pause' : 'enable'}
                    onClick={() => toggle.mutate({ id: b.id, active: !b.active })}
                  />
                  <span className="row-actions-sep" aria-hidden />
                  <TableAction
                    action="delete"
                    onClick={async () => {
                      const label = b.username ? `@${b.username}` : b.bot_id;
                      let bound: Array<{ id: string; channelKey?: string | null; title?: string | null; username?: string | null }> = [];
                      try {
                        const res = await trackingApi.listChannels({ filter: 'mine', bot: b.id, pageSize: 200 });
                        bound = (res.items ?? []).filter((c) => c.botId === b.id);
                      } catch { /* listing failed — fall back to a plain confirm */ }
                      if (bound.length === 0) {
                        if (await confirm(`delete bot ${label}`)) remove.mutate({ id: b.id });
                        return;
                      }
                      const n = bound.length;
                      const ok = await confirm(
                        `delete bot ${label} and unbind ${n} channel${n === 1 ? '' : 's'}`,
                        {
                          confirmLabel: 'Delete + unbind',
                          details: (
                            <div>
                              <p className="text-micro" style={{ margin: '0 0 8px', color: 'var(--color-ink-muted)' }}>
                                These channels will fall back to the default bot (or stop publishing if no default is set):
                              </p>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {bound.map((c) => (
                                  <span key={c.id} className="chip">{c.channelKey ?? c.title ?? c.username ?? c.id}</span>
                                ))}
                              </div>
                            </div>
                          ),
                        },
                      );
                      if (ok) remove.mutate({ id: b.id, unbind: true });
                    }}
                  />
                </RowActions>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddBotModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
