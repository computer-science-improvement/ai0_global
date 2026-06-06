// Telegraph accounts manager — list + add/verify/pause/delete. Extracted from
// the old /telegraph route so it can render both standalone and inside the
// unified Connections page's Telegraph tab.

import { useState } from 'react';
import { AddTelegraphAccountModal } from '../AddTelegraphAccountModal';
import { Icon } from '../Icon';
import { useConfirm } from '../ui/ConfirmDialog';
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
            telegra.ph акаунти для довгих публікацій (рецепти) з Instant View. Токени у <code style={{ color: 'var(--color-ink-muted)' }}>.env</code>.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add account
        </button>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && data.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
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
