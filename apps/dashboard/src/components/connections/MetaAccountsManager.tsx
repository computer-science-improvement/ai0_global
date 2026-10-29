// Meta accounts manager — one platform (Facebook / Instagram / Threads). Lists
// connected accounts as rows of a flush panel (identity, token line, followers and the
// 24 h change, verify / pause / delete actions). Tokens are stored encrypted in the
// database; only the env-var NAME of a legacy token is ever shown.

import { useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import { fmtDate } from '../../lib/format';
import { useConfirm } from '../ui/ConfirmDialog';
import { AddMetaAccountModal } from './AddMetaAccountModal';
import { ConnAdd, ConnError, ConnPanel, ConnRow, ConnState, ConnStat } from './ConnUi';
import {
  useMetaAccounts, useVerifyMetaAccount, useToggleMetaAccount, useDeleteMetaAccount,
  useRefreshThreadsToken, useMetaAccountGroups, useRefreshMetaStats,
} from '../../api/meta-accounts';
import { useStrategies } from '../../api/strategies';
import type { MetaAccount, MetaPlatform, Strategy } from '../../api/types';
import { describeError } from '../ui/Toast';

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
  const refreshStats = useRefreshMetaStats();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  const accounts = (data ?? []).filter(a => a.platform === platform);

  return (
    <>
      <ConnPanel
        title={PLATFORM_LABEL[platform]}
        note={`${PLATFORM_LABEL[platform]} accounts. Tokens are stored encrypted in the database.`}
        add={
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {accounts.length > 0 && (
              <button type="button" className="btn-secondary btn-sm" onClick={() => refreshStats.mutate()} disabled={refreshStats.isPending}
                title="Fetch the latest followers and insights now">
                <Icon name="refresh" size={14} /> {refreshStats.isPending ? 'Refreshing…' : 'Refresh stats'}
              </button>
            )}
            <ConnAdd onClick={() => setAddOpen(true)}>Add account</ConnAdd>
          </span>
        }
      >
        <ConnState loading={isLoading} error={error} />
        <ConnError error={remove.error} />
        <ConnError error={refreshStats.error} />

        {!isLoading && accounts.length === 0 && (
          <EmptyState
            icon={PLATFORM_ICON[platform]}
            title={`No ${PLATFORM_LABEL[platform]} accounts yet`}
            note="Add one to connect and start publishing."
          />
        )}

        {accounts.map(a => (
          <AccountRow
            key={a.id}
            account={a}
            groupName={a.group_id ? groupName.get(a.group_id) ?? null : null}
            onVerify={() => verify.mutate(a.id)}
            onRefreshToken={() => refreshToken.mutate(a.id)}
            refreshing={refreshToken.isPending && refreshToken.variables === a.id}
            refreshError={refreshToken.variables === a.id && refreshToken.isError ? describeError(refreshToken.error) : null}
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
      </ConnPanel>

      <AddMetaAccountModal open={addOpen} platform={platform} onClose={() => setAddOpen(false)} />
    </>
  );
}

// Rendered inside the delete-confirm dialog when an account has bound strategies.
// Cascade-deleting the account also drops every binding listed here.
function AttachedStrategiesList({ strategies }: { strategies: Strategy[] }) {
  return (
    <div>
      <p className="text-micro conn-dialog-note">
        These strategies are attached and will be deleted too:
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {strategies.map(s => (
          <span key={s.id} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="conn-dialog-strong">{s.ext_id}</span>
            <span className="text-micro conn-dialog-dim">{s.type}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function AccountRow({ account: a, groupName, onVerify, onToggle, onDelete, onRefreshToken, refreshing, refreshError }: {
  account: MetaAccount;
  groupName: string | null;
  onVerify: () => void; onToggle: () => void; onDelete: () => void;
  onRefreshToken: () => void; refreshing: boolean; refreshError: string | null;
}) {
  // A Facebook Page or system user has no @username: a successful verify is enough.
  const verified = !a.verify_error && (!!a.username || !!a.last_verified_at);
  const d = a.followers_delta_24h;
  return (
    <ConnRow
      link={{ to: '/app/connections/meta/$accountId', params: { accountId: a.id } }}
      lead={a.picture_url ? <img src={a.picture_url} alt="" width={36} height={36} /> : <Icon name={PLATFORM_ICON[a.platform]} size={16} />}
      stat={a.followers != null ? (
        <ConnStat
          value={a.followers.toLocaleString()} label="followers"
          delta={d != null ? `${d > 0 ? '+' : ''}${d.toLocaleString()} 24h` : undefined}
          tone={d == null || d === 0 ? undefined : d > 0 ? 'up' : 'down'}
        />
      ) : undefined}
      actions={
        <>
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
          {refreshError && <span className="conn-actions-err">{refreshError}</span>}
        </>
      }
    >
      <div className="conn-title">
        <span className="conn-name">{a.display_name ?? a.account_id}</span>
        {a.username && <span className="conn-handle">@{a.username}</span>}
        {a.verify_error
          ? <Badge tone="danger"><span title={a.verify_error}>{a.verify_error.slice(0, 48)}</span></Badge>
          : verified
            ? <Badge tone="success">connected</Badge>
            : <Badge tone="neutral">unverified</Badge>}
        {!a.active && <Badge tone="neutral">inactive</Badge>}
        {groupName && (
          <span title="Meta group — manage on the Groups tab" style={{ display: 'inline-flex' }}>
            <Badge tone="accent"><Icon name="connections" size={11} /> {groupName}</Badge>
          </span>
        )}
      </div>
      <div className="conn-sub">
        {a.token_env && <><span className="mono">{a.token_env}</span><span aria-hidden>·</span></>}
        <span>id <span className="mono">{a.target_id}</span></span>
        {a.last_verified_at && <><span aria-hidden>·</span><span>verified <span className="mono">{fmtDate(a.last_verified_at)}</span></span></>}
      </div>
      <TokenInfo account={a} />
    </ConnRow>
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

  const dot = <span className="conn-dot" aria-hidden />;

  // The token itself was checked (debug_token ran) but reported is_valid=false —
  // independent of verify, so show this even when the connection looks fine.
  const tokenInvalid = !!a.token_checked_at && a.token_valid === false;

  let expiry: ReactNode;
  if (!a.token_checked_at) {
    expiry = <span>Token: not checked — Verify to read</span>;
  } else if (tokenInvalid) {
    // An invalid token's expiry is meaningless — surface the validity instead.
    expiry = <span className="conn-token-expiry is-bad">{dot} Invalid token</span>;
  } else if (!a.token_expires_at) {
    expiry = <span className="conn-token-expiry is-ok">{dot} Token: never expires</span>;
  } else {
    const days = daysUntil(a.token_expires_at);
    const tone = days <= 0 ? 'is-bad' : days <= 30 ? 'is-warn' : 'is-ok';
    const tail = days <= 0 ? 'expired' : `in ${days} day${days === 1 ? '' : 's'}`;
    expiry = (
      <span className={`conn-token-expiry ${tone}`} title={fmtDate(a.token_expires_at)}>
        {dot} Token expires {fmtDate(a.token_expires_at)} · {tail}
      </span>
    );
  }

  return (
    <div className="conn-token">
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
// The identity block is a Link, so the toggle stops the click from navigating.
function ScopeList({ scopes }: { scopes: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!scopes.length) return null;

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded(v => !v);
  };

  if (!expanded) {
    const head = scopes.slice(0, 3);
    const rest = scopes.length - head.length;
    return (
      <span className="conn-scopes">
        · <span className="mono">{head.join(', ')}</span>
        {rest > 0 && (
          <button type="button" onClick={toggle} className="conn-link-btn" aria-expanded={false}>
            +{rest} more
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="conn-scopes">
      {scopes.map(s => <span key={s} className="conn-scope">{s}</span>)}
      <button type="button" onClick={toggle} className="conn-link-btn" aria-expanded={true}>
        show less
      </button>
    </span>
  );
}
