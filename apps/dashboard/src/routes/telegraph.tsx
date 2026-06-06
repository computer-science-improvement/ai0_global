import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AddTelegraphAccountModal } from '../components/AddTelegraphAccountModal';
import { Icon } from '../components/Icon';
import { useConfirm } from '../components/ui/ConfirmDialog';
import {
  useTelegraphAccounts, useDeleteTelegraphAccount,
  useToggleTelegraphActive, useVerifyTelegraphAccount,
} from '../api/telegraph';

export const Route = createFileRoute('/telegraph')({ component: TelegraphPage });

function TelegraphPage() {
  const { data, isLoading, error } = useTelegraphAccounts();
  const verify = useVerifyTelegraphAccount();
  const toggle = useToggleTelegraphActive();
  const remove = useDeleteTelegraphAccount();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 className="text-display-md" style={{ margin: 0 }}>Telegraph</h1>
          <p className="text-caption" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)' }}>
            telegra.ph accounts used to publish long content (recipes) with Instant View. Token values stay in <code style={{ color: 'var(--color-ink)' }}>.env</code>.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add account
        </button>
      </header>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && data.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 48 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            No Telegraph accounts yet — add one to publish recipe articles.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Account id</th>
                <th>Short name</th>
                <th>Token env</th>
                <th>Status</th>
                <th>Last verified</th>
                <th style={{ width: 260, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map(a => (
                <tr key={a.id}>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{a.account_id}</td>
                  <td>{a.short_name ?? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink-muted)' }}>{a.token_env}</td>
                  <td>
                    {a.verify_error
                      ? <span className="chip chip-danger" title={a.verify_error}>
                          <Icon name="warning" size={12} style={{ marginRight: 4 }} />
                          {a.verify_error.slice(0, 40)}
                        </span>
                      : a.short_name
                        ? <span className="chip chip-success" title="getAccountInfo succeeded — token works.">
                            <Icon name="check" size={12} style={{ marginRight: 4 }} />
                            verified
                          </span>
                        : <span className="chip" title="Never verified. Click Verify to confirm the token.">unverified</span>}
                    {!a.active && <span className="chip" title="Account is paused — not used for publishing." style={{ marginLeft: 6 }}>inactive</span>}
                  </td>
                  <td className="meta">
                    {a.last_verified_at ? new Date(a.last_verified_at).toLocaleString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <button onClick={() => verify.mutate(a.id)} className="btn-tiny" title="Re-run getAccountInfo">
                        <Icon name="refresh" size={12} style={{ marginRight: 4 }} />
                        Verify
                      </button>
                      <button
                        onClick={() => toggle.mutate({ id: a.id, active: !a.active })}
                        className="btn-tiny"
                      >
                        {a.active
                          ? <><Icon name="pause" size={12} style={{ marginRight: 4 }} />Pause</>
                          : <><Icon name="play"  size={12} style={{ marginRight: 4 }} />Activate</>}
                      </button>
                      <button
                        onClick={async () => {
                          if (await confirm(`delete Telegraph account ${a.account_id}`)) remove.mutate(a.id);
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

      <AddTelegraphAccountModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
