// Meta accounts manager — one platform (Facebook / Instagram / Threads). Lists
// connected accounts as preview cards (mirrors the Telegram connection cards)
// with verify / pause / delete actions. Tokens live in .env; only the env-var
// NAME is ever shown.

import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { fmtDate } from '../../lib/format';
import { useConfirm } from '../ui/ConfirmDialog';
import { AddMetaAccountModal } from './AddMetaAccountModal';
import {
  useMetaAccounts, useVerifyMetaAccount, useToggleMetaAccount, useDeleteMetaAccount,
} from '../../api/meta-accounts';
import type { MetaAccount, MetaPlatform } from '../../api/types';

const PLATFORM_ICON: Record<MetaPlatform, 'facebook' | 'instagram' | 'threads'> = {
  facebook: 'facebook', instagram: 'instagram', threads: 'threads',
};

const PLATFORM_LABEL: Record<MetaPlatform, string> = {
  facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads',
};

export function MetaAccountsManager({ platform }: { platform: MetaPlatform }) {
  const { data, isLoading, error } = useMetaAccounts();
  const verify = useVerifyMetaAccount();
  const toggle = useToggleMetaAccount();
  const remove = useDeleteMetaAccount();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  const accounts = (data ?? []).filter(a => a.platform === platform);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 className="text-eyebrow" style={{ margin: 0 }}>{PLATFORM_LABEL[platform]}</h2>
          <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
            {PLATFORM_LABEL[platform]} accounts. Tokens are stored in <code style={{ color: 'var(--color-ink-muted)' }}>.env</code>.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add account
        </button>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {!isLoading && accounts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            No {PLATFORM_LABEL[platform]} accounts yet — add one to connect.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {accounts.map(a => (
          <AccountCard
            key={a.id}
            account={a}
            onVerify={() => verify.mutate(a.id)}
            onToggle={async () => {
              const action = a.active ? 'pause' : 'activate';
              if (await confirm(`${action} account ${a.account_id}`, { danger: false, confirmLabel: a.active ? 'Pause' : 'Activate' }))
                toggle.mutate({ id: a.id, active: !a.active });
            }}
            onDelete={async () => {
              if (await confirm(`delete account ${a.username ? `@${a.username}` : a.account_id}`))
                remove.mutate(a.id);
            }}
          />
        ))}
      </div>

      <AddMetaAccountModal open={addOpen} platform={platform} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function AccountCard({ account: a, onVerify, onToggle, onDelete }: {
  account: MetaAccount;
  onVerify: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const verified = !a.verify_error && !!a.username;
  return (
    <div className="card" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <Avatar url={a.picture_url} platform={a.platform} />

      <Link
        to={'/app/connections/meta/$accountId' as any}
        params={{ accountId: a.id } as any}
        style={{ flex: 1, minWidth: 200, textDecoration: 'none', color: 'inherit' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
            {a.display_name ?? a.account_id}
          </span>
          {a.username && <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>@{a.username}</span>}
          {!a.active && <Badge tone="neutral">inactive</Badge>}
        </div>
        <div className="text-caption" style={{ color: 'var(--color-ink-dim)', marginTop: 4 }}>
          {a.followers != null && <>{a.followers.toLocaleString()} followers · </>}
          <code>{a.token_env}</code> · id <code>{a.target_id}</code>
          {a.last_verified_at && <> · verified {new Date(a.last_verified_at).toLocaleString()}</>}
        </div>
        <div style={{ marginTop: 8 }}>
          {a.verify_error
            ? <Badge tone="danger"><span title={a.verify_error}>{a.verify_error.slice(0, 48)}</span></Badge>
            : verified
              ? <Badge tone="success">connected</Badge>
              : <Badge tone="neutral">unverified</Badge>}
        </div>
        <TokenInfo account={a} />
      </Link>

      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button onClick={onVerify} className="btn-tiny" title="Verify token"><Icon name="refresh" size={12} /> Verify</button>
        <button onClick={onToggle} className="btn-tiny">{a.active ? 'Pause' : 'Activate'}</button>
        <button onClick={onDelete} className="btn-tiny-danger"><Icon name="trash" size={12} /> Delete</button>
      </div>
    </div>
  );
}

// Token type → Badge tone. PAGE tokens are preferred for posting (success);
// USER tokens work but are shorter-lived / less appropriate (warning).
const TOKEN_TYPE_TONE: Record<string, 'success' | 'warning' | 'neutral' | 'accent'> = {
  PAGE: 'success', SYSTEM_USER: 'neutral', USER: 'warning',
};

/** Whole days from now until `iso` (negative = already past). */
function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

// Derived access-token metadata from Graph debug_token (never the token itself).
// Threads accounts are skipped server-side, so token_checked_at stays null there.
function TokenInfo({ account: a }: { account: MetaAccount }) {
  const dot = (color: string) => (
    <span style={{ width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block', flexShrink: 0 }} />
  );

  let expiry: ReactNode;
  if (!a.token_checked_at) {
    expiry = <span style={{ color: 'var(--color-ink-dim)' }}>Token: not checked — Verify to read</span>;
  } else if (!a.token_expires_at) {
    expiry = <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-success)' }}>{dot('var(--color-success)')} Token: never expires</span>;
  } else {
    const days = daysUntil(a.token_expires_at);
    const color = days <= 0 ? 'var(--color-danger)' : days <= 30 ? 'var(--color-warning)' : 'var(--color-success)';
    const tail = days <= 0 ? 'expired' : `in ${days} day${days === 1 ? '' : 's'}`;
    expiry = (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color }} title={fmtDate(a.token_expires_at)}>
        {dot(color)} Token expires {fmtDate(a.token_expires_at)} · {tail}
      </span>
    );
  }

  const scopes = a.token_scopes ?? [];
  const scopeText = scopes.length
    ? scopes.length <= 3 ? scopes.join(', ') : `${scopes.slice(0, 3).join(', ')} +${scopes.length - 3} more`
    : null;

  return (
    <div className="text-micro" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, rowGap: 4 }}>
      <Badge tone={a.token_type ? TOKEN_TYPE_TONE[a.token_type] ?? 'neutral' : 'neutral'}>
        {a.token_type ?? 'unknown'}
      </Badge>
      {expiry}
      {scopeText && (
        <span style={{ color: 'var(--color-ink-dim)' }} title={scopes.join(', ')}>· {scopeText}</span>
      )}
    </div>
  );
}

function Avatar({ url, platform }: { url: string | null; platform: MetaPlatform }) {
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
      <Icon name={PLATFORM_ICON[platform]} size={22} />
    </div>
  );
}
