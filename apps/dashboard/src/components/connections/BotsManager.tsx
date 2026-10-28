// Telegram bots manager — the bot list + add/verify/pause/delete actions.
// Extracted from the old /bots route so it can render both standalone and
// inside the unified Connections page's Telegram tab.

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AddBotModal } from '../AddBotModal';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { useConfirm } from '../ui/ConfirmDialog';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import { ConnAdd, ConnError, ConnPanel, ConnRow, ConnState } from './ConnUi';
import { useBots, useDeleteBot, useSetDefaultBot, useToggleBotActive, useVerifyBot } from '../../api/bots';
import { trackingApi } from '../../api/tracking';
import { BOT_STATUS_HELP } from '../../lib/labels';
import { fmtDate } from '../../lib/format';

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
    <>
      <ConnPanel
        title="Bots"
        note="Telegram bots that publish on your behalf. Tokens are stored encrypted in the database."
        add={<ConnAdd onClick={() => setAddOpen(true)}>Add bot</ConnAdd>}
      >
        <ConnState loading={isLoading} error={error} />
        <ConnError error={setDefault.error} />

        {data && data.length === 0 && (
          <EmptyState
            icon="bots"
            title="No bots configured yet"
            note="Add one to start publishing on your behalf."
          />
        )}

        {data?.map((b) => (
          <ConnRow
            key={b.id}
            lead={<Icon name="bots" size={16} />}
            onOpen={() => viewChannels(b.id)}
            title="View channels assigned to this bot"
            actions={
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
                            <p className="text-micro conn-dialog-note">
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
            }
          >
            <div className="conn-title">
              <button type="button" className="conn-name conn-name-btn mono">{b.bot_id}</button>
              {b.username && <span className="conn-handle">@{b.username}</span>}
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
            <div className="conn-sub">
              {b.token_env && <><span className="mono">env: {b.token_env}</span><span aria-hidden>·</span></>}
              <span>verified {b.last_verified_at ? <span className="mono">{fmtDate(b.last_verified_at)}</span> : 'never'}</span>
            </div>
          </ConnRow>
        ))}
      </ConnPanel>

      <AddBotModal open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
