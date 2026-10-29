// TikTok accounts manager — connected creator accounts. Connect via OAuth (the
// browser leaves to TikTok and returns to ?tiktok=connected|error). Tokens live in
// the DB and are never shown. Mirrors MetaAccountsManager, minus the verify step.

import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/primitives';
import { TableAction, RowActions } from '../ui/table';
import { ConnAdd, ConnError, ConnPanel, ConnRow, ConnState } from './ConnUi';
import { useConfirm } from '../ui/ConfirmDialog';
import {
  useTikTokAccounts, useToggleTikTokAccount, useDeleteTikTokAccount, startTikTokOAuth,
} from '../../api/tiktok-accounts';
import type { TikTokAccount } from '../../api/tiktok-accounts';
import { fmtDate } from '../../lib/format';
import { describeError } from '../ui/Toast';

export function TikTokAccountsManager({ notice }: { notice?: 'connected' | 'error' }) {
  const { data, isLoading, error } = useTikTokAccounts();
  const toggle = useToggleTikTokAccount();
  const remove = useDeleteTikTokAccount();
  const confirm = useConfirm();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true); setConnectError(null);
    try { await startTikTokOAuth(); }
    catch (e) { setConnectError(describeError(e)); setConnecting(false); }
  };

  const accounts = data ?? [];

  return (
    <>
      {notice === 'connected' && (
        <div className="callout-success" role="status" style={{ marginBottom: 16 }}>
          <Icon name="check" size={14} />
          <span className="text-body-sm">TikTok account connected</span>
        </div>
      )}
      {notice === 'error' && (
        <div className="callout-danger" role="alert" style={{ marginBottom: 16 }}>
          <Icon name="info" size={14} />
          <span className="text-body-sm">TikTok connection failed — try again.</span>
        </div>
      )}

      <ConnPanel
        title="TikTok"
        note="Connected creator accounts. Tokens are stored securely and refreshed automatically."
        add={<ConnAdd icon="tiktok" onClick={connect} disabled={connecting}>{connecting ? 'Redirecting…' : 'Connect TikTok'}</ConnAdd>}
      >
        <ConnError error={connectError} />
        <ConnState loading={isLoading} error={error} />

        {!isLoading && accounts.length === 0 && (
          <EmptyState
            icon="tiktok"
            title="No TikTok accounts yet"
            note="Connect one to publish carousels."
          />
        )}

        {accounts.map(a => (
          <AccountRow
            key={a.id}
            account={a}
            onToggle={async () => {
              if (await confirm(`${a.active ? 'pause' : 'activate'} TikTok account ${a.username ?? a.open_id}`,
                { danger: false, confirmLabel: a.active ? 'Pause' : 'Activate' }))
                toggle.mutate({ id: a.id, active: !a.active });
            }}
            onDelete={async () => {
              if (await confirm(`delete TikTok account ${a.username ? `@${a.username}` : a.open_id}`))
                remove.mutate(a.id);
            }}
          />
        ))}
      </ConnPanel>
    </>
  );
}

function AccountRow({ account: a, onToggle, onDelete }: {
  account: TikTokAccount; onToggle: () => void; onDelete: () => void;
}) {
  return (
    <ConnRow
      lead={a.avatar_url ? <img src={a.avatar_url} alt="" width={36} height={36} /> : <Icon name="tiktok" size={16} />}
      actions={
        <RowActions danger={<TableAction action="delete" onClick={onDelete} />}>
          <TableAction action={a.active ? 'pause' : 'enable'} onClick={onToggle} />
        </RowActions>
      }
    >
      <div className="conn-title">
        <span className="conn-name">{a.display_name ?? a.username ?? a.open_id}</span>
        {a.username && <span className="conn-handle">@{a.username}</span>}
        {a.refresh_error
          ? <Badge tone="danger" title={a.refresh_error}>{a.refresh_error.slice(0, 48)}</Badge>
          : <Badge tone="success">connected</Badge>}
        {!a.active && <Badge tone="neutral">inactive</Badge>}
      </div>
      {a.last_refreshed_at && (
        <div className="conn-sub">token refreshed <span className="mono">{fmtDate(a.last_refreshed_at)}</span></div>
      )}
    </ConnRow>
  );
}
