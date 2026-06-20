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
import { Icon } from '../Icon';
import { Badge } from '../ui/Badge';
import { TableAction, RowActions } from '../ui/table';
import { EmptyState } from '../ui/primitives';
import { useConfirm } from '../ui/ConfirmDialog';
import type { MtprotoSession } from '../../api/types';

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
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 className="text-eyebrow" style={{ margin: 0 }}>MTProto sessions</h2>
          <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
            User accounts the tracker and stats collectors log in as. The session string
            and app credentials are stored encrypted and never shown. The first{' '}
            <b>active</b> session is used; with none active, the service falls back to
            {' '}<code style={{ color: 'var(--color-ink-muted)' }}>.env</code>.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add session
        </button>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {verify.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(verify.error as Error).message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon="discovery"
          title="No sessions yet"
          note="Add one to manage tracking from the dashboard, or rely on the .env fallback."
        />
      )}

      {data && data.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.map(s => (
            <SessionCard
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
        </div>
      )}

      <AddMtprotoSessionModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function SessionCard({
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
    <div className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
      <div style={{
        display: 'inline-flex', flexShrink: 0, padding: 10, borderRadius: 'var(--radius-pill)',
        background: 'var(--color-surface-3)', color: 'var(--color-ink)',
      }}>
        <Icon name="discovery" size={18} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{s.label}</span>
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
          {inUse && (
            <Badge tone="success" title="This active session is the one the tracker/stats use.">in use</Badge>
          )}
        </div>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
          <Meta label="Account">
            {s.username
              ? <span style={{ color: 'var(--color-ink)' }}>@{s.username}</span>
              : <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
          </Meta>
          {s.phone && (
            <Meta label="Phone">
              <span style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>{s.phone}</span>
            </Meta>
          )}
          {s.tg_user_id && (
            <Meta label="User id">
              <span style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>{s.tg_user_id}</span>
            </Meta>
          )}
          <Meta label="App credentials">
            {s.has_api_creds
              ? <span style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
                  api_id {s.api_id}
                </span>
              : <span style={{ color: 'var(--color-ink-dim)' }} title="No per-session app credentials — using the .env TELEGRAM_API_ID / TELEGRAM_API_HASH">
                  .env fallback
                </span>}
          </Meta>
          <Meta label="Last verified">
            <span style={{ color: 'var(--color-ink-muted)' }}>
              {s.last_verified_at ? new Date(s.last_verified_at).toLocaleString() : '—'}
            </span>
          </Meta>
        </div>
      </div>

      <div style={{ flexShrink: 0 }}>
        <RowActions>
          <TableAction action="verify" onClick={onVerify} disabled={busy} title="Connect and run getMe" />
          <TableAction action={s.active ? 'pause' : 'enable'} onClick={onToggle} disabled={busy} />
          <span className="row-actions-sep" aria-hidden />
          <TableAction action="delete" onClick={onDelete} disabled={busy} />
        </RowActions>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 2 }}>{label}</div>
      <div className="text-body-sm">{children}</div>
    </div>
  );
}
