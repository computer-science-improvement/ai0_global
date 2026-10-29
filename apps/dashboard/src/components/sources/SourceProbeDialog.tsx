// Spec 076 FR-009: the details of what the SERVER saw when it read a source: the result, the numbers, how it got there, a
// few sample titles of a fresh read, and the block on its host. "Test again" reads the address once more and shows the answer
// here. Styles: agents/agent-settings.css (ast-). The caller keys the dialog by the source so a new source starts clean.

import { Modal } from '../Modal';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { fmtDate } from '../../lib/format';
import type { SourceHealth } from '../../api/agents';
import { useProbeSource } from '../../api/sources';
import { blockLine, isReadFromServer, probeFacts, probeResult, sourceName } from '../../lib/source-probe';

export function SourceProbeDialog({ source, onClose }: { source: SourceHealth; onClose: () => void }) {
  const probe = useProbeSource();
  const fresh = probe.data;
  // A fresh answer is the newer one; until then the row's own latest read is shown.
  const view = fresh ?? source.probe ?? null;
  const kind = source.kind === 'rss' || source.kind === 'url' ? source.kind : undefined;
  const result = view ? probeResult(view) : null;
  const block = blockLine(source.blocked, source.blocked ? fmtDate(source.blocked.until) : '');
  const titles = fresh?.sample_titles ?? [];

  return (
    <Modal open onClose={onClose} title="Read from the server" subtitle={sourceName(source)} icon="radar" size="md">
      {view && result ? (
        <>
          <div className="ast-probe-head">
            <Badge tone={result.tone}>{result.label}</Badge>
            {view.via_proxy && <Badge tone="neutral">Via proxy</Badge>}
            {fresh?.cached && <Badge tone="neutral">Kept answer</Badge>}
          </div>
          <div className="inset ast-facts is-roomy">
            {probeFacts(source.ref, view, fresh ?? {}).map((f) => (
              <div key={f.key} className={`ast-fact${f.wide ? ' is-wide' : ''}`}>
                <span className="text-overline">{f.label}</span>
                <div className={`ast-fact-value${f.mono ? ' mono' : ''}`}>{f.value}</div>
              </div>
            ))}
            {titles.length > 0 && (
              <div className="ast-fact is-wide">
                <span className="text-overline">Sample titles</span>
                <ul className="ast-fact-value ast-titles">
                  {titles.slice(0, 5).map((t, i) => <li key={`${i}-${t}`}>{t}</li>)}
                </ul>
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="text-body-sm ink-muted" style={{ margin: 0 }}>
          The server has not read this address yet. Test it to see what the server sees.
        </p>
      )}
      {block && (
        <div className={`${source.blocked?.reason === 'unreachable' ? 'callout-danger' : 'callout-warning'} ast-probe-note`} role="status">{block}</div>
      )}
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
        {isReadFromServer(source) && kind && (
          <button type="button" className="btn-secondary" disabled={probe.isPending} onClick={() => probe.mutate({ url: source.ref, kind })}>
            <Icon name="refresh" size={14} /> {probe.isPending ? 'Testing…' : 'Test again'}
          </button>
        )}
      </div>
    </Modal>
  );
}
