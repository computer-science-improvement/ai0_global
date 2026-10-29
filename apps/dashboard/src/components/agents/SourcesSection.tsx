// Spec 049 FR-003: how the channel card's sources behaved over 14 days — one row per source (state, reads that
// worked, the last error, the slots it cost), worst first, plus the blocked sites the agent's runs hit outside them.
// The agent proposes a replacement for a source that keeps failing (FR-004); its card waits in "Waiting for you".
// Spec 076 FR-009: each feed and page also shows what the SERVER's own read of it said ("Server read: …"), the row has the
// owner's tools (test from the server, route the site through the proxy, upload the page, remove the source), a dataset
// shows how much material is left, and a channel with no sources says it writes from its brief only.
// Spec 078 D4: a flush panel of rows (the shape of the Health page's Sources section). Styles: agent-settings.css (ast-).

import { useState } from 'react';
import { SectionCard, type Tone } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { fmtRelative } from '../../lib/format';
import { useAgentSources, type SourceHealth, type SourceState } from '../../api/agents';
import { useAddProxyHost, useDropSource, useProbeSource } from '../../api/sources';
import { SourceProbeDialog } from '../sources/SourceProbeDialog';
import { UploadPageDialog } from '../sources/UploadPageDialog';
import { hostOfRef, INK_OF_TONE, isReadFromServer, probeLine, probeTone, rowFixes, runwayLine, sourceBadge, sourceName } from '../../lib/source-probe';

const STATE: Record<SourceState, { label: string; tone: Tone }> = {
  blocked:   { label: 'Blocked', tone: 'danger' },
  failing:   { label: 'Failing', tone: 'danger' },
  exhausted: { label: 'Nothing new', tone: 'warning' },
  ok:        { label: 'Working', tone: 'success' },
  unused:    { label: 'Not read', tone: 'neutral' },
};

const KIND_ICON: Record<SourceHealth['kind'], IconName> = { rss: 'radar', url: 'globe', library: 'database', api: 'link' };

interface RowProps {
  s: SourceHealth;
  channel: string | null;
  proxyConfigured: boolean;
  /** The two tools that open a dialog; a row shows the button only when its dialog is wired. */
  onDetails?: (s: SourceHealth) => void;
  onUpload?: (s: SourceHealth) => void;
}

function SourceRow({ s, channel, proxyConfigured, onDetails, onUpload }: RowProps) {
  const confirm = useConfirm();
  const probe = useProbeSource();
  const proxy = useAddProxyHost();
  const drop = useDropSource();
  const badge = sourceBadge(s) ?? STATE[s.state];
  const fixes = rowFixes(s, { proxyConfigured });
  const host = hostOfRef(s.ref);
  const kind = s.kind === 'rss' || s.kind === 'url' ? s.kind : undefined;
  const runway = runwayLine(s.runway);
  const busy = probe.isPending || proxy.isPending || drop.isPending;

  const remove = async () => {
    if (!channel) return;
    if (await confirm(`remove source “${sourceName(s)}” from ${channel}`, { confirmLabel: 'Remove' })) drop.mutate({ channel, sourceId: s.id });
  };

  return (
    <div className="panel-row ast-src">
      <span className="ast-lead" aria-hidden><Icon name={KIND_ICON[s.kind]} size={16} /></span>
      <div className="ast-src-main">
        <div className="ast-src-title">
          <span className="ast-src-name">{sourceName(s)}</span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {s.origin === 'playbook' && <Badge tone="neutral" title="Not on the card: the channel's playbook reads it">Playbook</Badge>}
          {runway && <Badge tone={runway.tone}>{runway.text}</Badge>}
          {s.slotsLost > 0 && <Badge tone="warning">{s.slotsLost} slot{s.slotsLost === 1 ? '' : 's'} lost</Badge>}
        </div>
        <div className="text-micro mono truncate ast-dim" title={s.ref}>{s.kind} · {s.ref}</div>
        {isReadFromServer(s) && s.probe !== undefined && (
          <div className={`text-micro mono ast-wrap ${INK_OF_TONE[probeTone(s.probe)]}`}>{probeLine(s.probe)}</div>
        )}
        {s.detail && <div className="text-caption clamp ast-muted ast-src-detail" title={s.detail}>{s.detail}</div>}
        {fixes.length > 0 && (
          <div className="ast-src-actions">
            <RowActions danger={fixes.includes('remove') && channel
              ? <TableAction action="delete" title="Remove" disabled={busy} onClick={() => void remove()} />
              : undefined}>
              {fixes.includes('test') && (
                <TableAction action="verify" title="Test from server" disabled={busy} onClick={() => kind && probe.mutate({ url: s.ref, kind })} />
              )}
              {isReadFromServer(s) && onDetails && <TableAction icon="info" title="Details" onClick={() => onDetails(s)} />}
              {fixes.includes('proxy') && (
                <TableAction icon="graph" title="Route via proxy" disabled={busy || !host} onClick={() => host && kind && proxy.mutate({ host, url: s.ref, kind })} />
              )}
              {fixes.includes('upload') && onUpload && <TableAction icon="arrow-up" title="Upload the page" onClick={() => onUpload(s)} />}
            </RowActions>
          </div>
        )}
      </div>
      <div className="ast-src-stats">
        <div className="ast-src-rate tabular-nums">{s.successRate === null ? '—' : `${Math.round(s.successRate * 100)}%`}</div>
        <div className="text-micro mono ast-dim">{s.calls ? `${s.ok}/${s.calls} reads` : 'no reads'}</div>
        {s.lastOkAt && <div className="text-micro mono ast-dim">ok {fmtRelative(s.lastOkAt)}</div>}
      </div>
    </div>
  );
}

export function SourcesSection({ handle, delay = 60 }: { handle: string; delay?: number }) {
  const q = useAgentSources(handle);
  const r = q.data;
  // The two dialogs are rendered once for the whole panel. The details dialog names its source by id, so it follows the
  // row when the report is read again after a test.
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  if (!r) return null;
  if (!r.sources.length && !r.otherHosts.length) {
    // A server from before spec 076 never says `noSources`, so the panel stays hidden there.
    if (!r.noSources) return null;
    return (
      <SectionCard title="Sources" icon="radar" flush delay={delay} style={{ marginBottom: 16 }}>
        <div className="panel-row ast-nosrc">
          <span className="ast-lead" aria-hidden><Icon name="info" size={16} /></span>
          <div className="ast-src-main">
            <div className="text-body-sm">No sources: the channel writes from its brief only.</div>
            <div className="text-caption ast-muted">Add a feed, a page or a dataset to the channel card if its posts need facts.</div>
          </div>
        </div>
      </SectionCard>
    );
  }
  const detail = detailsId === null ? undefined : r.sources.find((s) => s.id === detailsId);
  const bad = r.sources.filter((s) => s.state === 'blocked' || s.state === 'failing' || s.state === 'exhausted' || sourceBadge(s) !== null).length;
  return (
    <SectionCard title="Sources" icon="radar" flush delay={delay} style={{ marginBottom: 16 }}
      action={<span className={`mono ast-count${bad ? ' is-warn' : ''}`}>
        {bad ? `${bad} not working · ` : ''}{r.days} days
      </span>}>
      {r.sources.map((s) => (
        <SourceRow key={s.id} s={s} channel={r.channelKey} proxyConfigured={!!r.proxyConfigured}
          onDetails={(x) => setDetailsId(x.id)} onUpload={(x) => setUploadFor(x.ref)} />
      ))}
      {bad > 0 && (
        <div className="panel-foot text-caption ast-muted">
          The agent looks for a replacement of a source that keeps failing; its proposal waits in "Waiting for you" with Apply / Discard.
        </div>
      )}
      {r.otherHosts.length > 0 && (
        <div className="panel-foot ast-hosts">
          <span className="text-overline">Blocked sites the agent tried</span>
          <div className="ast-chips">
            {r.otherHosts.map((h) => (
              <span key={h.host} className="chip" title={`${h.reason}${h.statusCode ? ` ${h.statusCode}` : ''} · until ${new Date(h.until).toLocaleString('en-GB')}`}>
                {h.host} · {h.calls}×
              </span>
            ))}
          </div>
        </div>
      )}
      {detail && <SourceProbeDialog key={detail.id} source={detail} onClose={() => setDetailsId(null)} />}
      {uploadFor !== null && <UploadPageDialog open initialUrl={uploadFor} onClose={() => setUploadFor(null)} />}
    </SectionCard>
  );
}
