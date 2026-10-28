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
    <div className="set-stack">
      <SectionCard
        title="Sessions"
        flush
        delay={0}
        action={
          <div className="set-actions">
            <Button variant="secondary" size="sm" disabled={busy || others === 0} onClick={onOthers}>Sign out other sessions</Button>
            <Button variant="secondary" size="sm" className="is-danger" disabled={busy || list.length === 0} onClick={onEverywhere}>Sign out everywhere</Button>
          </div>
        }
      >
        {sessions.isLoading && <div className="set-pad" role="status">Loading…</div>}
        {sessions.error && <div className="set-pad"><div className="callout-danger" role="alert">{(sessions.error as Error).message}</div></div>}
        {sessions.data && list.length === 0 && (
          <EmptyState icon="lock" title="No active sessions" note="Scripts using the access token as a Bearer header don't open sessions." />
        )}
        {list.map((s) => <SessionRow key={s.id} s={s} disabled={busy} onRevoke={() => void onRevoke(s)} />)}
      </SectionCard>

      <SectionCard title="Recent sign-in activity" delay={40}
        action={events.data && events.data.length > 0 ? <span className="set-count mono">last {events.data.length}</span> : undefined}>
        {events.isLoading && <div className="set-loading" role="status">Loading…</div>}
        {events.error && <div className="callout-danger" role="alert">{(events.error as Error).message}</div>}
        {events.data && events.data.length === 0 && <EmptyState icon="history" title="No events yet" note="Sign-ins, sign-outs and failed attempts are listed here." />}
        {events.data && events.data.length > 0 && <EventsTable events={events.data} />}
      </SectionCard>
    </div>
  );
}

function SessionRow({ s, disabled, onRevoke }: { s: AuthSession; disabled: boolean; onRevoke: () => void }) {
  return (
    <div className="panel-row set-sess">
      <div className="set-sess-main">
        <div className="set-sess-title">
          <span className="set-sess-name" title={s.userAgent ?? undefined}>{s.device}</span>
          {s.current && <Badge tone="success">This device</Badge>}
          <Badge tone="neutral">{METHOD_LABEL[s.method] ?? s.method}</Badge>
        </div>
        <div className="set-sess-meta mono">
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
                <td className="mono" title={fmtDate(e.at)}>{fmtRelative(e.at)}</td>
                <td><Badge tone={k.tone}>{k.label}</Badge></td>
                <td>{e.method ? METHOD_LABEL[e.method] ?? e.method : '—'}</td>
                <td>{codeLabel(e.code) || '—'}</td>
                <td className="mono">{e.ip ?? '—'}</td>
                <td>{e.device ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
