// Meta accounts manager — one platform (Facebook / Instagram / Threads). Lists
// connected accounts as preview cards (mirrors the Telegram connection cards)
// with verify / pause / delete actions. Tokens live in .env; only the env-var
// NAME is ever shown.

import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import { fmtDate } from '../../lib/format';
import { useConfirm } from '../ui/ConfirmDialog';
import { AddMetaAccountModal } from './AddMetaAccountModal';
import {
  useMetaAccounts, useVerifyMetaAccount, useToggleMetaAccount, useDeleteMetaAccount,
  useRefreshThreadsToken, useMetaAccountGroups,
} from '../../api/meta-accounts';
import { useStrategies } from '../../api/strategies';
import type { MetaAccount, MetaPlatform, Strategy } from '../../api/types';

const PLATFORM_ICON: Record<MetaPlatform, 'facebook' | 'instagram' | 'threads'> = {
  facebook: 'facebook', instagram: 'instagram', threads: 'threads',
};

const PLATFORM_LABEL: Record<MetaPlatform, string> = {
  facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads',
};

export function MetaAccountsManager({ platform }: { platform: MetaPlatform }) {
  const { data, isLoading, error } = useMetaAccounts();
  const { data: strategies } = useStrategies();
  const { data: groups } = useMetaAccountGroups();
  const groupName = new Map((groups ?? []).map(g => [g.id, g.name]));
  const verify = useVerifyMetaAccount();
  const toggle = useToggleMetaAccount();
  const remove = useDeleteMetaAccount();
  const refreshToken = useRefreshThreadsToken();
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
      {remove.error && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>
          {(remove.error as Error).message}
        </p>
      )}

      {!isLoading && accounts.length === 0 && (
        <EmptyState
          icon={PLATFORM_ICON[platform]}
          title={`No ${PLATFORM_LABEL[platform]} accounts yet`}
          note="Add one to connect and start publishing."
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {accounts.map(a => (
          <AccountCard
            key={a.id}
            account={a}
            groupName={a.group_id ? groupName.get(a.group_id) ?? null : null}
            onVerify={() => verify.mutate(a.id)}
            onRefreshToken={() => refreshToken.mutate(a.id)}
            refreshing={refreshToken.isPending && refreshToken.variables === a.id}
            refreshError={refreshToken.variables === a.id && refreshToken.isError ? (refreshToken.error as Error).message : null}
            onToggle={async () => {
              const action = a.active ? 'pause' : 'activate';
              if (await confirm(`${action} account ${a.account_id}`, { danger: false, confirmLabel: a.active ? 'Pause' : 'Activate' }))
                toggle.mutate({ id: a.id, active: !a.active });
            }}
            onDelete={async () => {
              const label = a.username ? `@${a.username}` : a.account_id;
              const attached = (strategies ?? []).filter(s => s.meta_account?.id === a.id);
              if (attached.length === 0) {
                if (await confirm(`delete account ${label}`)) remove.mutate({ id: a.id });
                return;
              }
              const n = attached.length;
              const ok = await confirm(
                `delete account ${label} and its ${n} strateg${n === 1 ? 'y' : 'ies'}`,
                {
                  confirmLabel: 'Delete account + strategies',
                  details: <AttachedStrategiesList strategies={attached} />,
                },
              );
              if (ok) remove.mutate({ id: a.id, cascade: true });
            }}
          />
        ))}
      </div>

      <AddMetaAccountModal open={addOpen} platform={platform} onClose={() => setAddOpen(false)} />
    </div>
  );
}

// Rendered inside the delete-confirm dialog when an account has bound strategies.
// Cascade-deleting the account also drops every binding listed here.
function AttachedStrategiesList({ strategies }: { strategies: Strategy[] }) {
  return (
    <div>
      <p className="text-micro" style={{ margin: '0 0 8px', color: 'var(--color-ink-muted)' }}>
        These strategies are attached and will be deleted too:
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {strategies.map(s => (
          <span key={s.id} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--color-ink)' }}>{s.ext_id}</span>
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{s.type}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function AccountCard({ account: a, groupName, onVerify, onToggle, onDelete, onRefreshToken, refreshing, refreshError }: {
  account: MetaAccount;
  groupName: string | null;
  onVerify: () => void; onToggle: () => void; onDelete: () => void;
  onRefreshToken: () => void; refreshing: boolean; refreshError: string | null;
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
          {groupName && (
            <span title="Meta group — manage on the Groups tab" style={{ display: 'inline-flex' }}>
              <Badge tone="accent"><Icon name="connections" size={11} /> {groupName}</Badge>
            </span>
          )}
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

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <RowActions danger={<TableAction action="delete" onClick={onDelete} />}>
          <TableAction action="verify" onClick={onVerify} title="Verify token" />
          {/* Threads tokens are short-lived (~60d) and refreshable with only the
              current token. Refresh re-encrypts the new token + updates the expiry.
              Kept labelled (vs icon-only) so it isn't confused with Verify. */}
          {a.platform === 'threads' && (
            <TableAction
              icon="refresh"
              label={refreshing ? 'Refreshing…' : 'Refresh token'}
              onClick={onRefreshToken}
              disabled={refreshing}
              title="Refresh the Threads long-lived token"
            />
          )}
          <TableAction action={a.active ? 'pause' : 'enable'} onClick={onToggle} />
        </RowActions>
        {refreshError && (
          <span className="text-micro" style={{ color: 'var(--color-danger)', maxWidth: 240, textAlign: 'right' }}>
            {refreshError}
          </span>
        )}
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
// Threads accounts are skipped server-side (debug_token is a facebook.com
// endpoint), so token info is unobtainable — hide the block entirely rather
// than showing a meaningless "unknown / not checked" until it's ever populated.
function TokenInfo({ account: a }: { account: MetaAccount }) {
  if (a.platform === 'threads' && !a.token_checked_at) return null;

  const dot = (color: string) => (
    <span style={{ width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block', flexShrink: 0 }} />
  );

  // The token itself was checked (debug_token ran) but reported is_valid=false —
  // independent of verify, so show this even when the connection looks fine.
  const tokenInvalid = !!a.token_checked_at && a.token_valid === false;

  let expiry: ReactNode;
  if (!a.token_checked_at) {
    expiry = <span style={{ color: 'var(--color-ink-dim)' }}>Token: not checked — Verify to read</span>;
  } else if (tokenInvalid) {
    // An invalid token's expiry is meaningless — surface the validity instead.
    expiry = (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-danger)', fontWeight: 500 }}>
        {dot('var(--color-danger)')} Invalid token
      </span>
    );
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

  return (
    <div className="text-micro" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, rowGap: 4 }}>
      <Badge tone={a.token_type ? TOKEN_TYPE_TONE[a.token_type] ?? 'neutral' : 'neutral'}>
        {a.token_type ?? 'unknown'}
      </Badge>
      {expiry}
      <ScopeList scopes={a.token_scopes ?? []} />
    </div>
  );
}

// Click-to-expand granted scopes. Collapsed shows the first 3 + a "+N more"
// button; expanded shows every scope as wrapped chips with a "show less" toggle.
// The card itself is a Link, so the toggle stops the click from navigating.
function ScopeList({ scopes }: { scopes: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!scopes.length) return null;

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded(v => !v);
  };

  const toggleStyle: React.CSSProperties = {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    font: 'inherit', color: 'var(--color-accent)', textDecoration: 'underline',
  };

  if (!expanded) {
    const head = scopes.slice(0, 3);
    const rest = scopes.length - head.length;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', color: 'var(--color-ink-dim)' }}>
        · {head.join(', ')}
        {rest > 0 && (
          <button type="button" onClick={toggle} style={toggleStyle} aria-expanded={false}>
            +{rest} more
          </button>
        )}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {scopes.map(s => <span key={s} className="chip" style={{ fontSize: 10 }}>{s}</span>)}
      <button type="button" onClick={toggle} style={toggleStyle} aria-expanded={true}>
        show less
      </button>
    </span>
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
