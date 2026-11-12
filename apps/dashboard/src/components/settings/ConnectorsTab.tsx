// Settings → Connectors (spec 103 FR-E): the Claude connector. The master switch is the catalog setting MCP_CONNECTOR
// (the same write path as Configuration, with the same confirm), the URL to paste into Claude, who is connected
// (apps and their access), and what they did. Modelled on the Security tab: rows in flush panels.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONNECTOR_ACTIVITY_KEY, CONNECTOR_CLIENTS_KEY, CONNECTOR_GRANTS_KEY, CONNECTOR_STATUS_KEY, connectorsApi,
  type ConnectorActivity, type ConnectorClient, type ConnectorGrant,
} from '../../api/connectors';
import { settingsApi, type SettingState, type SettingsCatalog } from '../../api/settings';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast, describeError } from '../ui/Toast';
import { Toggle } from '../agents/AgentsUi';
import { fmtDate, fmtRelative } from '../../lib/format';
import { isOn } from '../../lib/settings-catalog';
import { activityAlert, activityLabel, claudeCodeCommand, scopeChip, statusWarning } from '../../lib/connector-view';

const CATALOG_KEY = ['settings', 'catalog'] as const;
const SWITCH_KEY = 'MCP_CONNECTOR';

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function ConnectorsTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const status = useQuery({ queryKey: CONNECTOR_STATUS_KEY, queryFn: () => connectorsApi.status() });
  const catalog = useQuery({ queryKey: CATALOG_KEY, queryFn: () => settingsApi.catalog() });
  const clients = useQuery({ queryKey: CONNECTOR_CLIENTS_KEY, queryFn: () => connectorsApi.clients(), refetchInterval: 60_000 });
  const grants = useQuery({ queryKey: CONNECTOR_GRANTS_KEY, queryFn: () => connectorsApi.grants(), refetchInterval: 60_000 });
  const activity = useQuery({ queryKey: CONNECTOR_ACTIVITY_KEY, queryFn: () => connectorsApi.activity(50), refetchInterval: 60_000 });

  const refresh = () => {
    for (const k of [CONNECTOR_STATUS_KEY, CONNECTOR_CLIENTS_KEY, CONNECTOR_GRANTS_KEY, CONNECTOR_ACTIVITY_KEY]) void qc.invalidateQueries({ queryKey: k });
  };

  const sw = catalog.data?.settings.find((s) => s.key === SWITCH_KEY);
  const enabled = sw ? isOn(sw, sw.value ?? sw.default) : !!status.data?.enabled;

  const save = useMutation({
    mutationFn: (value: string) => settingsApi.setValue(SWITCH_KEY, value),
    onSuccess: (fresh: SettingState) => {
      qc.setQueryData<SettingsCatalog>(CATALOG_KEY, (old) => old && { ...old, settings: old.settings.map((x) => (x.key === fresh.key ? fresh : x)) });
      refresh();
    },
  });
  const revokeGrant = useMutation({ mutationFn: (id: string) => connectorsApi.revokeGrant(id), onSuccess: refresh });
  const revokeClient = useMutation({ mutationFn: (id: string) => connectorsApi.revokeClient(id), onSuccess: refresh });
  const revokeAll = useMutation({ mutationFn: () => connectorsApi.revokeAll(), onSuccess: refresh });
  const busy = save.isPending || revokeGrant.isPending || revokeClient.isPending || revokeAll.isPending;

  const flip = async (next: boolean) => {
    if (!sw) return;
    const ok = await confirm(next ? 'turn the Claude connector on' : 'turn the Claude connector off', {
      danger: !next, confirmLabel: next ? 'Turn on' : 'Turn off',
      details: (
        <p className="text-body-sm set-muted" style={{ margin: 0 }}>
          {next
            ? 'Claude can then sign in here and, after you allow it, read your channels and plans, prepare posts and talk to your agents. Nothing can be published from Claude directly.'
            : 'The connector URL and its sign-in pages answer 404. Existing access stays but cannot be used until you turn it back on.'}
        </p>
      ),
    });
    if (ok) save.mutate(next ? sw.bool?.on ?? 'on' : sw.bool?.off ?? 'off');
  };

  const onDisconnect = async (c: ConnectorClient) => {
    if (await confirm(`disconnect ${c.name} (${c.activeGrants} active access)`, { danger: true, confirmLabel: 'Disconnect' })) revokeClient.mutate(c.id);
  };
  const onRevoke = async (g: ConnectorGrant) => {
    if (await confirm(`revoke the access of ${g.clientName}`, { danger: true, confirmLabel: 'Revoke' })) revokeGrant.mutate(g.id);
  };
  const onRevokeAll = async () => {
    if (await confirm('revoke all connector access (every connected app has to sign in again)', { danger: true, confirmLabel: 'Revoke all' })) revokeAll.mutate();
  };

  const st = status.data;
  const warning = st ? statusWarning(st) : null;
  const url = st?.url ?? '';
  const copy = async (text: string, what: string) => {
    if (await copyText(text)) toast.success(`${what} copied`);
    else toast.error('Could not copy. Select the text and copy it by hand.');
  };

  return (
    <div className="set-stack">
      <SectionCard
        title="Claude connector"
        icon="connections"
        delay={0}
        action={<Toggle checked={enabled} label={enabled ? 'On' : 'Off'} disabled={!sw || busy} onChange={(v) => void flip(v)} title={sw ? 'Turn the connector on or off' : 'Loading the setting'} />}
      >
        <p className="set-intro">
          Lets Claude (claude.ai, Claude Desktop, Claude mobile and Claude Code) see your channels, plan posts and talk to your agents.
          Posts it creates or edits are locked: the agents do not overwrite them. Publishing still happens only through the schedule and approvals.
        </p>
        {status.error && <div className="callout-danger" role="alert">{describeError(status.error)}</div>}
        <div className="inset con-url">
          <div className="text-overline">Connector URL</div>
          <div className="con-url-row">
            <code className="mono con-url-text">{url || 'not configured'}</code>
            <Button variant="secondary" size="sm" disabled={!url} onClick={() => void copy(url, 'URL')}><Icon name="copy" size={14} /> Copy</Button>
          </div>
        </div>
        {warning && <div className={warning.tone === 'danger' ? 'callout-danger' : 'callout-warning'} role="alert" style={{ marginTop: 12 }}>{warning.text}</div>}
        {save.error && <div className="callout-danger" role="alert" style={{ marginTop: 12 }}>{describeError(save.error)}</div>}

        <div className="con-steps">
          <div className="text-overline">How to add it in Claude</div>
          <ol className="text-body-sm con-list">
            <li>In Claude open Settings → Connectors → Add custom connector.</li>
            <li>Paste the URL above and choose Connect.</li>
            <li>Sign in here if asked, check what Claude asks for and choose Allow.</li>
          </ol>
          <div className="text-overline">Claude Code</div>
          <div className="con-url-row">
            <code className="mono con-url-text">{claudeCodeCommand(url || '<connector url>')}</code>
            <Button variant="secondary" size="sm" disabled={!url} onClick={() => void copy(claudeCodeCommand(url), 'Command')}><Icon name="copy" size={14} /> Copy</Button>
          </div>
          <p className="text-caption ink-dim" style={{ margin: 0 }}>Then run /mcp in Claude Code and sign in.</p>
        </div>
      </SectionCard>

      <SectionCard title="Connected apps" flush delay={40}>
        {clients.isLoading && <div className="set-pad" role="status">Loading…</div>}
        {clients.error && <div className="set-pad"><div className="callout-danger" role="alert">{describeError(clients.error)}</div></div>}
        {clients.data && clients.data.length === 0 && <EmptyState icon="connections" title="No apps connected" note="Add the connector URL in Claude and an app appears here." />}
        {(clients.data ?? []).map((c) => (
          <div className="panel-row set-sess" key={c.id}>
            <div className="set-sess-main">
              <div className="set-sess-title">
                <span className="set-sess-name">{c.name}</span>
                <Badge tone="neutral">{c.kind}</Badge>
                {c.activeGrants > 0 && <Badge tone="success">{c.activeGrants} active</Badge>}
              </div>
              <div className="set-sess-meta mono">
                {c.redirectHosts.join(', ') || 'no redirect host'} · added {fmtDate(c.createdAt)} · last used {fmtRelative(c.lastUsedAt)}
              </div>
            </div>
            <TableAction icon="ban" danger title="Disconnect" disabled={busy} onClick={() => void onDisconnect(c)} />
          </div>
        ))}
      </SectionCard>

      <SectionCard
        title="Active access"
        flush
        delay={80}
        action={<Button variant="secondary" size="sm" className="is-danger" disabled={busy || !(grants.data?.length)} onClick={() => void onRevokeAll()}>Revoke all</Button>}
      >
        {grants.isLoading && <div className="set-pad" role="status">Loading…</div>}
        {grants.error && <div className="set-pad"><div className="callout-danger" role="alert">{describeError(grants.error)}</div></div>}
        {grants.data && grants.data.length === 0 && <EmptyState icon="lock" title="No active access" note="Nothing is signed in through the connector." />}
        {(grants.data ?? []).map((g) => (
          <div className="panel-row set-sess" key={g.id}>
            <div className="set-sess-main">
              <div className="set-sess-title">
                <span className="set-sess-name">{g.clientName}</span>
                {g.scopes.map((s) => <Badge key={s} tone={s === 'mcp:write' ? 'warning' : 'neutral'} title={s}>{scopeChip(s)}</Badge>)}
              </div>
              <div className="set-sess-meta mono">
                {g.lastIp ?? 'unknown IP'} · signed in {fmtDate(g.createdAt)} · last used {fmtRelative(g.lastUsedAt)}{g.expiresAt ? ` · expires ${fmtDate(g.expiresAt)}` : ''}
              </div>
            </div>
            <TableAction icon="ban" danger title="Revoke" disabled={busy} onClick={() => void onRevoke(g)} />
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Recent activity" delay={120}
        action={activity.data && activity.data.length > 0 ? <span className="set-count mono">last {activity.data.length}</span> : undefined}>
        {activity.isLoading && <div className="set-loading" role="status">Loading…</div>}
        {activity.error && <div className="callout-danger" role="alert">{describeError(activity.error)}</div>}
        {activity.data && activity.data.length === 0 && <EmptyState icon="history" title="No activity yet" note="Tool calls and sign-in events of connected apps are listed here." />}
        {activity.data && activity.data.length > 0 && <ActivityTable items={activity.data} />}
      </SectionCard>
    </div>
  );
}

function ActivityTable({ items }: { items: ConnectorActivity[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th>When</th>
          <th>Event</th>
          <th>App</th>
          <th>Result</th>
          <th className="num">Time</th>
        </tr></thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="mono" title={fmtDate(a.at)}>{fmtRelative(a.at)}</td>
              <td>
                {activityLabel(a.event)}
                {a.tool && <> <span className="mono">{a.tool}</span></>}
                {a.summary && <div className="text-micro ink-dim" style={{ overflowWrap: 'anywhere' }}>{a.summary}</div>}
              </td>
              <td>{a.clientName ?? '—'}</td>
              <td>
                <Badge tone={activityAlert(a) ? 'danger' : 'success'} title={a.error ?? undefined}>{!a.ok ? 'error' : activityAlert(a) ? 'blocked' : 'ok'}</Badge>
                {a.error && <div className="text-micro ink-dim" style={{ overflowWrap: 'anywhere' }}>{a.error}</div>}
              </td>
              <td className="num mono">{a.durationMs != null ? `${a.durationMs} ms` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
