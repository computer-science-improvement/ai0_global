// Spec 026 FR-015: the "Networks" card on /app/landing. The owner writes the one-line
// blurb each network shows on the public page and sets the order of the networks.
// Ordering renumbers every network to its index (like the resource list below it), so
// the default state where every network has order 0 still moves.
// Spec 078 (C6): a flush panel with one .panel-row per network (identity, order, blurb editor).
import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { TableAction } from '../ui/table';
import { toast, describeError } from '../ui/Toast';
import { SkeletonRows } from '../SkeletonRows';
import {
  landingApi, type LandingAdminNetwork, type LandingAdminNetworks,
} from '../../api/landing';
import { agentChip } from '../../lib/landing-view';
import './landing-admin.css';

export const NETWORK_BLURB_MAX = 280;

function BlurbEditor({ n, disabled, onSave }: { n: LandingAdminNetwork; disabled: boolean; onSave: (blurb: string | null) => void }): JSX.Element {
  const [value, setValue] = useState(n.blurb ?? '');
  useEffect(() => { setValue(n.blurb ?? ''); }, [n.blurb]);
  const dirty = value.trim() !== (n.blurb ?? '').trim();
  const len = Array.from(value.trim()).length;
  const tooLong = len > NETWORK_BLURB_MAX;
  return (
    <div className="nc-blurb">
      <textarea
        className="input-field"
        rows={2}
        value={value}
        placeholder="One line about this network for the public page (optional)"
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Public description of ${n.name}`}
        aria-invalid={tooLong}
      />
      <div className="nc-row">
        <span className={`nc-len${tooLong ? ' is-over' : ''}`}>
          {len}/{NETWORK_BLURB_MAX}
        </span>
        {dirty && (
          <span className="nc-row-btns">
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setValue(n.blurb ?? '')}>Discard</Button>
            <Button variant="primary" size="sm" disabled={disabled || tooLong} onClick={() => onSave(value.trim() ? value.trim() : null)}>Save</Button>
          </span>
        )}
      </div>
    </div>
  );
}

export function NetworksCard({ data, isLoading, error }: { data: LandingAdminNetworks | undefined; isLoading: boolean; error: unknown }): JSX.Element {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: async (updates: Array<{ id: string; blurb?: string | null; order?: number }>) => {
      for (const u of updates) await landingApi.patchNetwork(u.id, { blurb: u.blurb, order: u.order });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landing', 'admin', 'networks'] });
      qc.invalidateQueries({ queryKey: ['landing', 'networks'] });
    },
    onError: (e) => toast.error(`Couldn’t save the network: ${describeError(e)}`),
  });

  if (isLoading) {
    return (
      <SectionCard title="Networks" flush delay={0}>
        <SkeletonRows flush rows={2} height={96} label="Loading networks" />
      </SectionCard>
    );
  }
  if (error || !data) {
    return (
      <SectionCard title="Networks">
        <div className="callout-danger" role="alert">
          Couldn’t load the networks{error ? `: ${describeError(error)}` : ''}
        </div>
      </SectionCard>
    );
  }

  const list = data.networks;
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[idx], next[j]] = [next[j], next[idx]];
    const updates = next.map((n, i) => ({ id: n.id, order: i, stored: n.order }))
      .filter((u) => u.stored !== u.order)
      .map(({ id, order }) => ({ id, order }));
    if (updates.length) save.mutate(updates);
  };

  return (
    <SectionCard
      title="Networks"
      flush
      delay={0}
      action={<span className="la-count">{list.length} {list.length === 1 ? 'network' : 'networks'}</span>}
    >
      <p className="la-note is-flush">
        The public page groups featured resources by network, in this order. A network shows only when at least one of its resources is featured.
      </p>
      {list.length === 0 && (
        <p className="nc-empty">No networks yet. Group resources into networks under Connections → Groups.</p>
      )}
      {list.map((n, i) => {
        const chip = agentChip(n.agent);
        return (
          <div key={n.id} className="panel-row nc-item">
            <div className="nc-item-head">
              <div className="nc-item-main">
                <span className="text-body-sm nc-item-name">{n.name}</span>
                <span className="nc-item-meta mono">{n.featured}/{n.resources} featured</span>
                {chip
                  ? <Badge tone={n.agent?.mode === 'live' ? 'success' : 'warning'}>{chip}</Badge>
                  : <Badge>No agent</Badge>}
              </div>
              <div className="nc-item-actions">
                <Badge tone="neutral">#{i + 1}</Badge>
                <TableAction icon="chevron-up" title="Move up" disabled={i === 0 || save.isPending} onClick={() => move(i, -1)} />
                <TableAction icon="chevron-down" title="Move down" disabled={i === list.length - 1 || save.isPending} onClick={() => move(i, 1)} />
              </div>
            </div>
            <BlurbEditor
              n={n}
              disabled={save.isPending}
              onSave={(blurb) => save.mutate([{ id: n.id, blurb }], { onSuccess: () => toast.success('Network description saved') })}
            />
          </div>
        );
      })}
    </SectionCard>
  );
}
