// MTProto sessions — the user accounts the tracker/stats clients log in as to
// read per-post views/reactions (the Bot API cannot).
//
// Two sources, in priority order:
//   1. DB-managed sessions (this panel) — stored ENCRYPTED, managed here like
//      the other connections. The first ACTIVE session wins.
//   2. The .env fallback (shown read-only below) — used when no active DB
//      session exists, so existing setups keep working with zero config.
//
// The session string is a secret: entered on Add, encrypted server-side, and
// NEVER returned or rendered. Only the verified account identity is shown.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../../api/tracking';
import {
  useMtprotoSessions, useVerifyMtprotoSession, useToggleMtprotoSession, useDeleteMtprotoSession,
} from '../../api/mtproto-sessions';
import { AddMtprotoSessionModal } from './AddMtprotoSessionModal';
import { Icon } from '../Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import type { TrackingSession, MtprotoSession } from '../../api/types';

export function SessionsPanel() {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <DbSessions onAdd={() => setAddOpen(true)} />
      <EnvSessions />
      <AddMtprotoSessionModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

// ── DB-managed (encrypted) sessions ──────────────────────────────────────────

function DbSessions({ onAdd }: { onAdd: () => void }) {
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
            User accounts the tracker and stats collectors log in as. Stored encrypted —
            the session string is never shown. The first <b>active</b> session is used;
            with none active, the <code style={{ color: 'var(--color-ink-muted)' }}>.env</code> fallback below applies.
          </p>
        </div>
        <button onClick={onAdd} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add session
        </button>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {verify.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(verify.error as Error).message}</p>}

      {data && data.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <p className="text-body" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            No DB sessions yet — add one to manage tracking from the dashboard, or rely on the <code>.env</code> fallback below.
          </p>
        </div>
      )}

      {data && data.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.map(s => (
            <DbSessionCard
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
    </div>
  );
}

function DbSessionCard({
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
            ? <span className="chip chip-danger" title={s.verify_error}>
                <Icon name="warning" size={12} style={{ marginRight: 4 }} />
                {s.verify_error.slice(0, 48)}
              </span>
            : verified
              ? <span className="chip chip-success" title="Verified via getMe">
                  <Icon name="check" size={12} style={{ marginRight: 4 }} />verified
                </span>
              : <span className="chip" title="Not verified yet — click Verify">unverified</span>}
          {!s.active && <span className="chip">inactive</span>}
          {inUse && (
            <span className="chip chip-success" title="This active session is the one the tracker/stats use.">in use</span>
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
          <Meta label="Last verified">
            <span style={{ color: 'var(--color-ink-muted)' }}>
              {s.last_verified_at ? new Date(s.last_verified_at).toLocaleString() : '—'}
            </span>
          </Meta>
        </div>
      </div>

      <div style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
        <button onClick={onVerify} disabled={busy} className="btn-tiny" title="Connect and run getMe">
          <Icon name="refresh" size={12} style={{ marginRight: 4 }} />Verify
        </button>
        <button onClick={onToggle} disabled={busy} className="btn-tiny">
          {s.active
            ? <><Icon name="pause" size={12} style={{ marginRight: 4 }} />Pause</>
            : <><Icon name="play"  size={12} style={{ marginRight: 4 }} />Activate</>}
        </button>
        <button onClick={onDelete} disabled={busy} className="btn-tiny-danger">
          <Icon name="trash" size={12} style={{ marginRight: 4 }} />Delete
        </button>
      </div>
    </div>
  );
}

// ── .env fallback (read-only) ─────────────────────────────────────────────────

function EnvSessions() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['tracking-sessions'],
    queryFn:  () => trackingApi.sessionStatus(),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 className="text-eyebrow" style={{ margin: 0 }}>Environment fallback</h2>
        <p className="text-micro" style={{ margin: '4px 0 0', color: 'var(--color-ink-dim)' }}>
          Used only when no DB session above is active. Session strings live in{' '}
          <code style={{ color: 'var(--color-ink-muted)' }}>.env</code> and are never shown.
        </p>
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.sessions.map((s) => <EnvSessionCard key={s.id} s={s} />)}
        </div>
      )}
    </div>
  );
}

function EnvSessionCard({ s }: { s: TrackingSession }) {
  const state: 'ok' | 'configured-not-ready' | 'empty' =
    s.ready ? 'ok' : s.configured ? 'configured-not-ready' : 'empty';

  const tone =
    state === 'ok' ? { chip: 'chip chip-success', label: 'Connected' }
    : state === 'configured-not-ready' ? { chip: 'chip chip-warning', label: 'Configured, not connected' }
    : { chip: 'chip chip-danger', label: 'Empty' };

  const acct = s.account;
  const displayName = [acct?.firstName, acct?.lastName].filter(Boolean).join(' ') || null;

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
          <span className={tone.chip} title="Tracker account state via MTProto">{tone.label}</span>
          {s.shared && (
            <span className="chip" title="Reuses the publisher's shared session (TELEGRAM_SESSION_STRING)">shared</span>
          )}
          {acct?.isPremium && <span className="chip chip-success">premium</span>}
        </div>

        {/* Account behind the session */}
        {acct ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
            <Meta label="Account">
              {acct.username
                ? <span style={{ color: 'var(--color-ink)' }}>@{acct.username}</span>
                : <span style={{ color: 'var(--color-ink-dim)' }}>no username</span>}
            </Meta>
            {displayName && <Meta label="Name"><span style={{ color: 'var(--color-ink)' }}>{displayName}</span></Meta>}
            {acct.phone && (
              <Meta label="Phone">
                <span style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>+{acct.phone}</span>
              </Meta>
            )}
            {acct.id && (
              <Meta label="User id">
                <span style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>{acct.id}</span>
              </Meta>
            )}
          </div>
        ) : (
          <p className="text-body-sm" style={{ margin: '8px 0 0', color: 'var(--color-ink-muted)' }}>
            {state === 'empty'
              ? 'Session not configured.'
              : 'Account data unavailable (session not connected).'}
          </p>
        )}

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
          <Meta label="ENV variable">
            <code style={{ color: 'var(--color-ink)' }}>{s.envVar}</code>
          </Meta>
          <Meta label="API keys">
            {s.hasApiCreds
              ? <span style={{ color: 'var(--color-success)' }}>present</span>
              : <span style={{ color: 'var(--color-danger)' }}>missing</span>}
          </Meta>
        </div>

        {state === 'empty' && (
          <div className="callout-warning" style={{ marginTop: 12 }}>
            <Icon name="warning" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Add a DB session above, or set <code>TELEGRAM_API_ID</code>, <code>TELEGRAM_API_HASH</code> and
              {' '}<code>{s.envVar}</code> in <code>.env</code> — stats and tracking will turn on.
            </span>
          </div>
        )}
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
