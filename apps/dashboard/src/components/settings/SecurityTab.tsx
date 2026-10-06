// Settings → Security (spec 028 FR-010): live dashboard sessions with Revoke,
// "Sign out other sessions", "Sign out everywhere", and the recent auth audit.
// Ending the CURRENT session (revoke it, or sign out everywhere) clears the
// cookie server-side; the client then drops every cached query and goes to /login.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { authApi } from '../../api/auth';
import type { AuthEvent, AuthSession } from '../../api/types';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { fmtDate, fmtRelative } from '../../lib/format';
import { EVENT_LABEL, METHOD_LABEL, codeLabel } from '../../auth/messages';

const SESSIONS_KEY = ['auth', 'sessions'] as const;
const EVENTS_KEY = ['auth', 'events'] as const;

export function SecurityTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => authApi.sessions(), refetchInterval: 60_000 });
  const events = useQuery({ queryKey: EVENTS_KEY, queryFn: () => authApi.events(50) });

  /** After ending our own session: nothing cached may survive, then /login. */
  const leave = async () => {
    qc.clear();
    await navigate({ to: '/login', replace: true });
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    void qc.invalidateQueries({ queryKey: EVENTS_KEY });
  };

  const revoke = useMutation({
    mutationFn: (id: string) => authApi.revoke(id),
    onSuccess: (r) => (r.current ? leave() : refresh()),
  });
  const revokeAll = useMutation({
    mutationFn: (includeCurrent: boolean) => authApi.revokeAll(includeCurrent),
    onSuccess: (r) => (r.current ? leave() : refresh()),
  });

  const list = sessions.data ?? [];
  const others = list.filter((s) => !s.current).length;

  const onRevoke = async (s: AuthSession) => {
    const what = s.current ? 'sign out this device' : `sign out ${s.device}${s.ip ? ` (${s.ip})` : ''}`;
    if (await confirm(what, { danger: true, confirmLabel: 'Sign out' })) revoke.mutate(s.id);
  };
  const onOthers = async () => {
    if (await confirm(`sign out ${others} other session${others === 1 ? '' : 's'}`, { danger: true, confirmLabel: 'Sign out' })) revokeAll.mutate(false);
  };
  const onEverywhere = async () => {
    if (await confirm('sign out everywhere, including this device', { danger: true, confirmLabel: 'Sign out everywhere' })) revokeAll.mutate(true);
  };

  const busy = revoke.isPending || revokeAll.isPending;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionCard
        title="Sessions"
        icon="lock"
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button variant="tiny" disabled={busy || others === 0} onClick={onOthers}>Sign out other sessions</Button>
            <Button variant="tiny-danger" disabled={busy || list.length === 0} onClick={onEverywhere}>Sign out everywhere</Button>
          </div>
        }
      >
        {sessions.isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
        {sessions.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(sessions.error as Error).message}</p>}
        {sessions.data && list.length === 0 && (
          <EmptyState icon="lock" title="No active sessions" note="Scripts using the access token as a Bearer header don't open sessions." />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map((s, i) => <SessionRow key={s.id} s={s} index={i} disabled={busy} onRevoke={() => void onRevoke(s)} />)}
        </div>
      </SectionCard>

      <SectionCard title="Recent sign-in activity" icon="history">
        {events.isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
        {events.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(events.error as Error).message}</p>}
        {events.data && events.data.length === 0 && <EmptyState icon="history" title="No events yet" />}
        {events.data && events.data.length > 0 && <EventsTable events={events.data} />}
      </SectionCard>
    </div>
  );
}

function SessionRow({ s, index, disabled, onRevoke }: { s: AuthSession; index: number; disabled: boolean; onRevoke: () => void }) {
  return (
    <div
      className="card row-lift compose-rise"
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', animationDelay: `${index * 40}ms` }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }} title={s.userAgent ?? undefined}>{s.device}</span>
          {s.current && <Badge tone="success">This device</Badge>}
          <Badge tone="neutral">{METHOD_LABEL[s.method] ?? s.method}</Badge>
        </div>
        <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>
          {s.ip ?? 'unknown IP'} · signed in {fmtDate(s.createdAt)} · last seen {fmtRelative(s.lastSeenAt)} · expires {fmtDate(s.expiresAt)}
        </div>
      </div>
      <TableAction icon="ban" danger title={s.current ? 'Sign out this device' : 'Revoke'} disabled={disabled} onClick={onRevoke} />
    </div>
  );
}

function EventsTable({ events }: { events: AuthEvent[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th>When</th>
          <th>Event</th>
          <th>Method</th>
          <th>Detail</th>
          <th>IP</th>
          <th>Device</th>
        </tr></thead>
        <tbody>
          {events.map((e) => {
            const k = EVENT_LABEL[e.kind] ?? { label: e.kind, tone: 'neutral' as const };
            return (
              <tr key={e.id}>
                <td title={fmtDate(e.at)}>{fmtRelative(e.at)}</td>
                <td><Badge tone={k.tone}>{k.label}</Badge></td>
                <td>{e.method ? METHOD_LABEL[e.method] ?? e.method : '—'}</td>
                <td>{codeLabel(e.code) || '—'}</td>
                <td>{e.ip ?? '—'}</td>
                <td>{e.device ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
