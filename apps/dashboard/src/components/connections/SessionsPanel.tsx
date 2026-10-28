// MTProto sessions — the user accounts the tracker/stats clients log in as to
// read per-post views/reactions (the Bot API cannot).
//
// A single managed list, like the Bots and Telegraph tabs. Each session is
// stored ENCRYPTED: the session string AND the app api_hash are entered on Add,
// encrypted server-side, and NEVER returned or rendered — only the verified
// account identity and the (non-secret) api_id are shown. The first ACTIVE
// session is the one the tracker/stats actually use; with none active, the
// service falls back silently to .env so existing setups keep working.

import { useState } from 'react';
import {
  useMtprotoSessions, useVerifyMtprotoSession, useToggleMtprotoSession, useDeleteMtprotoSession,
} from '../../api/mtproto-sessions';
import { AddMtprotoSessionModal } from './AddMtprotoSessionModal';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import { ConnAdd, ConnError, ConnPanel, ConnRow, ConnState } from './ConnUi';
import { useConfirm } from '../ui/ConfirmDialog';
import type { MtprotoSession } from '../../api/types';
import { fmtDate } from '../../lib/format';

export function SessionsPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const { data, isLoading, error } = useMtprotoSessions();
  const verify = useVerifyMtprotoSession();
  const toggle = useToggleMtprotoSession();
  const remove = useDeleteMtprotoSession();
  const confirm = useConfirm();

  // The first active session is the one actually used by tracker/stats.
  const firstActiveId = data?.find(s => s.active)?.id ?? null;

  return (
    <>
      <ConnPanel
        title="MTProto sessions"
        note={<>
          User accounts the tracker and stats collectors log in as. The session string and app credentials are stored
          encrypted and never shown. The first <b>active</b> session is used; with none active, the service falls back to{' '}
          <code className="conn-code">.env</code>.
        </>}
        add={<ConnAdd onClick={() => setAddOpen(true)}>Add session</ConnAdd>}
      >
        <ConnState loading={isLoading} error={error} />
        <ConnError error={verify.error} />

        {data && data.length === 0 && (
          <EmptyState
            icon="discovery"
            title="No sessions yet"
            note="Add one to manage tracking from the dashboard, or rely on the .env fallback."
          />
        )}

        {data?.map(s => (
          <SessionRow
            key={s.id}
            s={s}
            inUse={s.id === firstActiveId}
            busy={verify.isPending || toggle.isPending || remove.isPending}
            onVerify={() => verify.mutate(s.id)}
            onToggle={() => toggle.mutate({ id: s.id, active: !s.active })}
            onDelete={async () => {
              if (await confirm(`delete session "${s.label}"`)) remove.mutate(s.id);
            }}
          />
        ))}
      </ConnPanel>

      <AddMtprotoSessionModal open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}

function SessionRow({
  s, inUse, busy, onVerify, onToggle, onDelete,
}: {
  s: MtprotoSession;
  inUse: boolean;
  busy: boolean;
  onVerify: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const verified = !!s.last_verified_at && !s.verify_error;

  return (
    <ConnRow
      lead={<Icon name="discovery" size={16} />}
      actions={
        <RowActions>
          <TableAction action="verify" onClick={onVerify} disabled={busy} title="Connect and run getMe" />
          <TableAction action={s.active ? 'pause' : 'enable'} onClick={onToggle} disabled={busy} />
          <span className="row-actions-sep" aria-hidden />
          <TableAction action="delete" onClick={onDelete} disabled={busy} />
        </RowActions>
      }
    >
      <div className="conn-title">
        <span className="conn-name">{s.label}</span>
        {s.verify_error
          ? <Badge tone="danger" title={s.verify_error}>
              <Icon name="warning" size={11} /> {s.verify_error.slice(0, 48)}
            </Badge>
          : verified
            ? <Badge tone="success" title="Verified via getMe">
                <Icon name="check" size={11} /> verified
              </Badge>
            : <Badge tone="neutral" title="Not verified yet — click Verify">unverified</Badge>}
        {!s.active && <Badge tone="neutral">inactive</Badge>}
        <Badge tone={s.role === 'agent' ? 'accent' : 'neutral'} title={s.role === 'agent' ? 'Agent — read-only DM triage (SP1)' : 'Tracker — stats/competitor tracking'}>
          {s.role ?? 'tracker'}
        </Badge>
        {inUse && (
          <Badge tone="success" title="This active session is the one the tracker/stats use.">in use</Badge>
        )}
      </div>

      <div className="conn-facts">
        <Fact label="Account">
          {s.username ? <span className="mono">@{s.username}</span> : <span className="conn-fact-v is-dim">—</span>}
        </Fact>
        {s.phone && <Fact label="Phone"><span className="mono">{s.phone}</span></Fact>}
        {s.tg_user_id && <Fact label="User id"><span className="mono conn-fact-v is-muted">{s.tg_user_id}</span></Fact>}
        <Fact label="App credentials">
          {s.has_api_creds
            ? <span className="mono">api_id {s.api_id}</span>
            : <span className="conn-fact-v is-dim" title="No per-session app credentials — using the .env TELEGRAM_API_ID / TELEGRAM_API_HASH">
                .env fallback
              </span>}
        </Fact>
        <Fact label="Last verified">
          <span className="conn-fact-v is-muted">{s.last_verified_at ? fmtDate(s.last_verified_at) : '—'}</span>
        </Fact>
      </div>
    </ConnRow>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="conn-fact">
      <div className="text-overline">{label}</div>
      <div className="conn-fact-v">{children}</div>
    </div>
  );
}
