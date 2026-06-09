import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import type { CSSProperties } from 'react';
import { trackingApi } from '../api/tracking';
import { useStrategies } from '../api/strategies';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { Panel } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';

export const Route = createFileRoute('/')({ component: OverviewPage });

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
const STATUS_TONE: Record<string, Tone> = { ok: 'success', error: 'danger', skipped: 'warning', running: 'neutral' };
const STATUS_LABEL: Record<string, string> = { ok: 'ok', error: 'error', skipped: 'skipped', running: 'running' };

function rel(iso: string): string {
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function OverviewPage() {
  const strategiesQ = useStrategies();
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 'overview'],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });

  const strategies = strategiesQ.data ?? [];
  const channels = channelsQ.data?.items ?? [];

  const totalSubs = channels.reduce((sum, c) => sum + (c.subsCount ?? 0), 0);
  const active = strategies.filter(s => s.enabled);
  const errors = strategies.filter(s => s.last_run?.status === 'error');
  const upcoming = active
    .filter(s => s.next_run_at)
    .sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))
    .slice(0, 6);
  const recent = strategies
    .filter(s => s.last_run)
    .sort((a, b) => (b.last_run!.started_at > a.last_run!.started_at ? 1 : -1))
    .slice(0, 6);

  const cell: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid var(--color-hairline)', fontSize: 12.5 };

  return (
    <div>
      <PageHeader title="Overview" subtitle="Telegram · publishing and status" />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
        <StatCard label="My channels" value={channelsQ.isLoading ? '…' : channels.length} />
        <StatCard label="Subscribers (total)" value={channelsQ.isLoading ? '…' : totalSubs.toLocaleString('en-US')} />
        <StatCard label="Active strategies" value={strategiesQ.isLoading ? '…' : active.length} />
        <StatCard label="Errors" value={errors.length} deltaTone={errors.length ? 'down' : 'neutral'} delta={errors.length ? 'needs attention' : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Panel title="Upcoming runs">
          {upcoming.length === 0
            ? <p style={{ color: 'var(--color-ink-muted)', fontSize: 12.5, margin: 0 }}>No scheduled runs.</p>
            : upcoming.map(s => (
              <div key={s.id} style={cell}>
                <span style={{ color: 'var(--color-ink)' }}>{s.ext_id}</span>
                <span style={{ color: 'var(--color-ink-dim)' }}>{s.channel_key ?? ''}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)' }}>{s.next_run_at ? rel(s.next_run_at) : ''}</span>
              </div>
            ))}
        </Panel>

        <Panel title="Strategy status">
          {recent.length === 0
            ? <p style={{ color: 'var(--color-ink-muted)', fontSize: 12.5, margin: 0 }}>No runs yet.</p>
            : recent.map(s => (
              <div key={s.id} style={cell}>
                <Badge tone={STATUS_TONE[s.last_run!.status] ?? 'neutral'}>{STATUS_LABEL[s.last_run!.status] ?? s.last_run!.status}</Badge>
                <span style={{ color: 'var(--color-ink)' }}>{s.ext_id}</span>
                {s.last_run!.error && <span style={{ color: 'var(--color-danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }} title={s.last_run!.error}>{s.last_run!.error}</span>}
                <span style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)' }}>{s.last_run!.finished_at ? rel(s.last_run!.finished_at) : ''}</span>
              </div>
            ))}
        </Panel>
      </div>
    </div>
  );
}
