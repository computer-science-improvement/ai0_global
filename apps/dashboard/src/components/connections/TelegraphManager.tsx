// Telegraph accounts manager — list + add/verify/pause/delete. Extracted from
// the old /telegraph route so it can render both standalone and inside the
// unified Connections page's Telegraph tab.

import { useState } from 'react';
import { AddTelegraphAccountModal } from '../AddTelegraphAccountModal';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { useConfirm } from '../ui/ConfirmDialog';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import { ConnAdd, ConnPanel, ConnRow, ConnState } from './ConnUi';
import { fmtDate } from '../../lib/format';
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
    <>
      <ConnPanel
        title="Telegraph"
        note={<>telegra.ph accounts for long posts (recipes) with Instant View. Tokens in <code className="conn-code">.env</code>.</>}
        add={<ConnAdd onClick={() => setAddOpen(true)}>Add account</ConnAdd>}
      >
        <ConnState loading={isLoading} error={error} />

        {data && data.length === 0 && (
          <EmptyState
            icon="telegraph"
            title="No Telegraph accounts yet"
            note="Add one to publish recipe articles with Instant View."
          />
        )}

        {data?.map((a) => (
          <ConnRow
            key={a.id}
            lead={<Icon name="telegraph" size={16} />}
            actions={
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
            }
          >
            <div className="conn-title">
              <span className="conn-name mono">{a.account_id}</span>
              {a.short_name && <span className="conn-handle">{a.short_name}</span>}
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
            <div className="conn-sub">
              {a.token_env && <><span className="mono">env: {a.token_env}</span><span aria-hidden>·</span></>}
              <span>verified {a.last_verified_at ? <span className="mono">{fmtDate(a.last_verified_at)}</span> : 'never'}</span>
            </div>
          </ConnRow>
        ))}
      </ConnPanel>

      <AddTelegraphAccountModal open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
