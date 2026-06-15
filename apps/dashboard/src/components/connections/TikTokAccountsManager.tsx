// TikTok accounts manager — connected creator accounts. Connect via OAuth (the
// browser leaves to TikTok and returns to ?tiktok=connected|error). Tokens live in
// the DB and are never shown. Mirrors MetaAccountsManager, minus the verify step.

import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { useConfirm } from '../ui/ConfirmDialog';
import {
  useTikTokAccounts, useToggleTikTokAccount, useDeleteTikTokAccount, startTikTokOAuth,
} from '../../api/tiktok-accounts';
import type { TikTokAccount } from '../../api/tiktok-accounts';

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
    catch (e) { setConnectError((e as Error).message); setConnecting(false); }
  };

  const accounts = data ?? [];

  return (
    <div>
      {notice === 'connected' && (
        <div className="card" style={{ marginBottom: 16, padding: 12 }}>
          <Badge tone="success">TikTok account connected</Badge>
        </div>
      )}
      {notice === 'error' && (
        <div className="callout-warning" style={{ marginBottom: 16 }}>
          <Icon name="info" size={14} />
          <span className="text-micro">TikTok connection failed — try again.</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 className="text-eyebrow" style={{ margin: 0 }}>TikTok</h2>
          <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
            Connected creator accounts. Tokens are stored securely and refreshed automatically.
          </p>
        </div>
        <button onClick={connect} disabled={connecting} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="tiktok" size={14} /> {connecting ? 'Redirecting…' : 'Connect TikTok'}
        </button>
      </div>

      {connectError && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>{connectError}</p>
      )}
      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {!isLoading && accounts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            No TikTok accounts yet — connect one to publish carousels.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {accounts.map(a => (
          <AccountCard
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
      </div>
    </div>
  );
}

function AccountCard({ account: a, onToggle, onDelete }: {
  account: TikTokAccount; onToggle: () => void; onDelete: () => void;
}) {
  return (
    <div className="card" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <Avatar url={a.avatar_url} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
            {a.display_name ?? a.username ?? a.open_id}
          </span>
          {a.username && <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>@{a.username}</span>}
          {!a.active && <Badge tone="neutral">inactive</Badge>}
        </div>
        <div className="text-caption" style={{ color: 'var(--color-ink-dim)', marginTop: 4 }}>
          {a.last_refreshed_at && <>token refreshed {new Date(a.last_refreshed_at).toLocaleString()}</>}
        </div>
        <div style={{ marginTop: 8 }}>
          {a.refresh_error
            ? <Badge tone="danger"><span title={a.refresh_error}>{a.refresh_error.slice(0, 48)}</span></Badge>
            : <Badge tone="success">connected</Badge>}
        </div>
      </div>
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button onClick={onToggle} className="btn-tiny">{a.active ? 'Pause' : 'Activate'}</button>
        <button onClick={onDelete} className="btn-tiny-danger"><Icon name="trash" size={12} /> Delete</button>
      </div>
    </div>
  );
}

function Avatar({ url }: { url: string | null }) {
  const size = 48;
  if (url) {
    return <img src={url} alt="" width={size} height={size}
      style={{ borderRadius: 999, objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: 999, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--color-surface-3)', color: 'var(--color-ink-muted)',
    }}>
      <Icon name="tiktok" size={22} />
    </div>
  );
}
