// Telegram bots manager — the bot list + add/verify/pause/delete actions.
// Extracted from the old /bots route so it can render both standalone and
// inside the unified Connections page's Telegram tab.

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AddBotModal } from '../AddBotModal';
import { Icon } from '../Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { useBots, useDeleteBot, useToggleBotActive, useVerifyBot } from '../../api/bots';
import { BOT_STATUS_HELP } from '../../lib/labels';

export function BotsManager() {
  const { data, isLoading, error } = useBots();
  const verify  = useVerifyBot();
  const toggle  = useToggleBotActive();
  const remove  = useDeleteBot();
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

      {data && data.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            No bots configured yet — add one to start publishing.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Bot id</th>
                <th>Username</th>
                <th>Token env</th>
                <th>Status</th>
                <th>Last verified</th>
                <th style={{ width: 260, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map(b => (
                <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => viewChannels(b.id)} title="View channels assigned to this bot">
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{b.bot_id}</td>
                  <td>{b.username ? `@${b.username}` : <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink-muted)' }}>{b.token_env}</td>
                  <td>
                    {b.verify_error
                      ? <span className="chip chip-danger" title={`${BOT_STATUS_HELP.error}\n\n${b.verify_error}`}>
                          <Icon name="warning" size={12} style={{ marginRight: 4 }} />
                          {b.verify_error.slice(0, 40)}
                        </span>
                      : b.username
                        ? <span className="chip chip-success" title={BOT_STATUS_HELP.verified}>
                            <Icon name="check" size={12} style={{ marginRight: 4 }} />
                            verified
                          </span>
                        : <span className="chip" title={BOT_STATUS_HELP.unverified}>unverified</span>}
                    {!b.active && <span className="chip" title={BOT_STATUS_HELP.inactive} style={{ marginLeft: 6 }}>inactive</span>}
                  </td>
                  <td className="meta">
                    {b.last_verified_at ? new Date(b.last_verified_at).toLocaleString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <button onClick={() => verify.mutate(b.id)} className="btn-tiny" title="Re-run getMe">
                        <Icon name="refresh" size={12} style={{ marginRight: 4 }} />
                        Verify
                      </button>
                      <button
                        onClick={() => toggle.mutate({ id: b.id, active: !b.active })}
                        className="btn-tiny"
                      >
                        {b.active
                          ? <><Icon name="pause" size={12} style={{ marginRight: 4 }} />Pause</>
                          : <><Icon name="play"  size={12} style={{ marginRight: 4 }} />Activate</>}
                      </button>
                      <button
                        onClick={async () => {
                          if (await confirm(`delete bot ${b.username ? `@${b.username}` : b.bot_id}`)) remove.mutate(b.id);
                        }}
                        className="btn-tiny-danger"
                      >
                        <Icon name="trash" size={12} style={{ marginRight: 4 }} />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddBotModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
