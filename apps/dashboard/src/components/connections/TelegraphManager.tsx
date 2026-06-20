// Telegraph accounts manager — list + add/verify/pause/delete. Extracted from
// the old /telegraph route so it can render both standalone and inside the
// unified Connections page's Telegraph tab.

import { useState } from 'react';
import { AddTelegraphAccountModal } from '../AddTelegraphAccountModal';
import { Icon } from '../Icon';
import { Badge } from '../ui/Badge';
import { useConfirm } from '../ui/ConfirmDialog';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import {
  useTelegraphAccounts, useDeleteTelegraphAccount,
  useToggleTelegraphActive, useVerifyTelegraphAccount,
} from '../../api/telegraph';

export function TelegraphManager() {
  const { data, isLoading, error } = useTelegraphAccounts();
  const verify = useVerifyTelegraphAccount();
  const toggle = useToggleTelegraphActive();
  const remove = useDeleteTelegraphAccount();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 className="text-eyebrow" style={{ margin: 0 }}>Telegraph</h2>
          <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
            telegra.ph accounts for long posts (recipes) with Instant View. Tokens in <code style={{ color: 'var(--color-ink-muted)' }}>.env</code>.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add account
        </button>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon="telegraph"
          title="No Telegraph accounts yet"
          note="Add one to publish recipe articles with Instant View."
        />
      )}

      {data && data.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((a, i) => (
            <div
              key={a.id}
              className="card row-lift compose-rise"
              style={{
                display: 'flex', alignItems: 'center', gap: 16,
                padding: '13px 18px',
                animationDelay: `${Math.min(i, 12) * 34}ms`,
              }}
            >
              {/* Avatar */}
              <span style={{
                width: 34, height: 34, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-surface-3)', border: '1px solid var(--color-hairline)',
                color: 'var(--color-ink-muted)',
              }}>
                <Icon name="telegraph" size={16} />
              </span>

              {/* Identity + status */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                    {a.account_id}
                  </span>
                  {a.short_name && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{a.short_name}</span>}
                  {a.verify_error
                    ? <Badge tone="danger" title={a.verify_error}>
                        <Icon name="warning" size={11} /> {a.verify_error.slice(0, 40)}
                      </Badge>
                    : a.short_name
                      ? <Badge tone="success" title="getAccountInfo succeeded — token works.">
                          <Icon name="check" size={11} /> verified
                        </Badge>
                      : <Badge tone="neutral" title="Never verified. Click Verify to confirm the token.">unverified</Badge>}
                  {!a.active && <Badge tone="neutral" title="Account is paused — not used for publishing.">inactive</Badge>}
                </div>
                <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {a.token_env && (
                    <>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>env: {a.token_env}</span>
                      <span style={{ color: 'var(--color-ink-dim)' }}>·</span>
                    </>
                  )}
                  <span>verified {a.last_verified_at ? new Date(a.last_verified_at).toLocaleString() : 'never'}</span>
                </div>
              </div>

              {/* Actions */}
              <div style={{ flexShrink: 0 }}>
                <RowActions>
                  <TableAction action="verify" onClick={() => verify.mutate(a.id)} title="Re-run getAccountInfo" />
                  <TableAction
                    action={a.active ? 'pause' : 'enable'}
                    onClick={() => toggle.mutate({ id: a.id, active: !a.active })}
                  />
                  <span className="row-actions-sep" aria-hidden />
                  <TableAction
                    action="delete"
                    onClick={async () => {
                      if (await confirm(`delete Telegraph account ${a.account_id}`)) remove.mutate(a.id);
                    }}
                  />
                </RowActions>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddTelegraphAccountModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
