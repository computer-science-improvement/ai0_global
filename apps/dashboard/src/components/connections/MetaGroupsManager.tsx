// Groups — the dedicated brand-group management page (Connections → Groups).
//
// A group is a brand "patch-bay": it links one Telegram channel + one Facebook,
// Instagram and Threads account. Any member can be the fan-out SOURCE — publishing
// to it mirrors the same post to every other member. A group holds at most one
// destination per platform (enforced server-side). This page is the ONLY place to
// create/delete groups and wire destinations into them.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, type IconName } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import {
  useMetaAccounts, useMetaAccountGroups, useCreateMetaAccountGroup,
  useDeleteMetaAccountGroup, useSetMetaAccountGroup, useSetMetaAccountGroupSource,
  type GroupSourcePlatform,
} from '../../api/meta-accounts';
import { trackingApi } from '../../api/tracking';
import type { MetaAccount, MetaPlatform, TrackedChannel } from '../../api/types';

const CHANNELS_KEY = ['groups-channels'];
const chLabel = (c: TrackedChannel) =>
  c.channelKey ?? (c.username ? `@${c.username}` : c.title ?? c.id);
const acctLabel = (a: MetaAccount) => (a.username ? `@${a.username}` : a.display_name ?? a.account_id);

const PLATFORMS: MetaPlatform[] = ['facebook', 'instagram', 'threads'];

// Per-destination tint dot — the only added colour, purely for scannability.
const TINT: Record<string, string> = {
  telegram:  '#229ED9',
  facebook:  '#4a7dff',
  instagram: '#e1497f',
  threads:   '#c7c7c7',
};
const LABEL: Record<string, string> = {
  telegram: 'Telegram', facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads',
};

interface PortData {
  key: string;
  icon: IconName;
  source: boolean;
  assigned: { id: string; label: string } | null;
  options: { id: string; label: string }[];
  onAssign: (id: string) => void;
  onRemove: (id: string) => void;
  /** Call to make this port the group's source; undefined when already source or unassigned. */
  onMakeSource?: () => void;
  /** Show no-bot warning on this port (Telegram only, when channel has no bot). */
  noBotWarning?: boolean;
}

export function MetaGroupsManager() {
  const qc = useQueryClient();
  const { data: accounts, isLoading: la, error: ea } = useMetaAccounts();
  const { data: groups, isLoading: lg, error: eg } = useMetaAccountGroups();
  const { data: channelsResp } = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });
  const createGroup = useCreateMetaAccountGroup();
  const deleteGroup = useDeleteMetaAccountGroup();
  const setGroup    = useSetMetaAccountGroup();
  const setSource   = useSetMetaAccountGroupSource();
  const setChannelGroup = useMutation({
    mutationFn: ({ id, groupId }: { id: string; groupId: string | null }) =>
      trackingApi.patchChannel(id, { groupId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
      qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
  const confirm = useConfirm();
  const [name, setName] = useState('');

  const allAccounts = accounts ?? [];
  const allChannels = channelsResp?.items ?? [];
  const busy = setGroup.isPending || setChannelGroup.isPending || setSource.isPending;

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    await createGroup.mutateAsync(n);
    setName('');
  };

  const err = (ea || eg || createGroup.error || setGroup.error || setChannelGroup.error || setSource.error) as Error | null;

  // Build the four ports for a group: Telegram, then Facebook, IG, Threads.
  // The source port is driven by g.source_platform (not hardcoded to Facebook).
  const portsFor = (g: { id: string; source_platform: GroupSourcePlatform }): PortData[] => {
    const groupId = g.id;
    const ch  = allChannels.find(c => c.groupId === groupId) ?? null;
    const isTgSource = g.source_platform === 'telegram';
    // Telegram has no bot warning when it is either the source or an assigned target
    // and the linked channel has no bot bound.
    const tgActive = isTgSource || (ch != null);
    const noBotWarning = tgActive && ch != null && !ch.bot;
    const tg: PortData = {
      key: 'telegram', icon: 'telegram', source: isTgSource,
      assigned: ch ? { id: ch.id, label: chLabel(ch) } : null,
      options: allChannels.filter(c => c.groupId == null).map(c => ({ id: c.id, label: chLabel(c) })),
      onAssign: (id) => setChannelGroup.mutate({ id, groupId }),
      onRemove: (id) => setChannelGroup.mutate({ id, groupId: null }),
      onMakeSource: (!isTgSource && ch != null)
        ? () => setSource.mutate({ id: groupId, sourcePlatform: 'telegram' })
        : undefined,
      noBotWarning,
    };
    const metaPorts = PLATFORMS.map<PortData>(platform => {
      const acc = allAccounts.find(a => a.group_id === groupId && a.platform === platform) ?? null;
      const isSource = g.source_platform === platform;
      return {
        key: platform, icon: platform as IconName, source: isSource,
        assigned: acc ? { id: acc.id, label: acctLabel(acc) } : null,
        options: allAccounts.filter(a => a.platform === platform && a.group_id == null)
          .map(a => ({ id: a.id, label: acctLabel(a) })),
        onAssign: (id) => setGroup.mutate({ id, groupId }),
        onRemove: (id) => setGroup.mutate({ id, groupId: null }),
        onMakeSource: (!isSource && acc != null)
          ? () => setSource.mutate({ id: groupId, sourcePlatform: platform as GroupSourcePlatform })
          : undefined,
      };
    });
    return [tg, ...metaPorts];
  };

  return (
    <div>
      <p className="text-micro" style={{ margin: '0 0 16px', color: 'var(--color-ink-dim)', maxWidth: 760, lineHeight: 1.6 }}>
        A group links a brand's destinations. Each group has a{' '}
        <b style={{ color: 'var(--color-ink-muted)' }}>source</b> — the member you publish to. Publishing to the
        source mirrors the same post to every other member (Telegram included). Click{' '}
        <b style={{ color: 'var(--color-ink-muted)' }}>Set as source</b> on any wired destination to change it.
      </p>

      {/* Create composer */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, padding: 14,
        borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-hairline)',
        background: 'var(--color-surface-2)',
      }}>
        <div className="group-hub" aria-hidden style={{ width: 34, height: 34, fontSize: 15 }}>
          <Icon name="plus" size={16} />
        </div>
        <input
          value={name} onChange={e => setName(e.target.value)} placeholder="New group name — e.g. Recipes"
          className="input-field" style={{ flex: 1, minWidth: 180 }}
          onKeyDown={e => { if (e.key === 'Enter') create(); }}
        />
        <button onClick={create} className="btn-primary" style={{ gap: 6 }} disabled={!name.trim() || createGroup.isPending}>
          <Icon name="plus" size={14} /> {createGroup.isPending ? 'Creating…' : 'Create group'}
        </button>
      </div>

      {(la || lg) && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {err && <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>{err.message}</p>}

      {groups && groups.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '44px 32px', borderStyle: 'dashed' }}>
          <div className="group-hub" style={{ margin: '0 auto 12px', width: 44, height: 44 }} aria-hidden>
            <Icon name="connections" size={20} />
          </div>
          <p className="text-body" style={{ color: 'var(--color-ink)', margin: '0 0 4px', fontWeight: 500 }}>No groups yet</p>
          <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
            Create one above, then wire its Telegram channel + Facebook / Instagram / Threads accounts.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {(groups ?? []).map((g, i) => {
          const ports = portsFor(g);
          const linked = ports.filter(p => p.assigned).length;
          return (
            <div key={g.id} className="group-card" style={{ animationDelay: `${Math.min(i, 8) * 55}ms` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <div className="group-hub" aria-hidden>{g.name.charAt(0).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 600, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.name}
                  </div>
                  <div className="text-micro" style={{ color: linked === 4 ? 'var(--color-success)' : 'var(--color-ink-dim)', marginTop: 2 }}>
                    {linked} of 4 destinations linked
                  </div>
                </div>
                <button
                  className="group-del" title="Delete group"
                  onClick={async () => {
                    if (await confirm(`delete group "${g.name}"`, { details: <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>Members (channel + accounts) are kept — they're just un-grouped (fan-out stops).</p> })) {
                      deleteGroup.mutate(g.id);
                      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
                    }
                  }}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>

              <div className="group-rail">
                {ports.map(p => <Port key={p.key} port={p} busy={busy} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One port (destination slot) on a group's rail. Filled = the wired account /
// channel with a hover Remove; empty = a dashed slot with an assign picker (or
// a hint when nothing's available). The current source is flagged with a SOURCE
// badge; any other assigned port gets a quiet "Set as source" affordance.
function Port({ port, busy }: { port: PortData; busy: boolean }) {
  const tint = TINT[port.key] ?? 'var(--color-ink-muted)';
  return (
    <div className={`group-port${port.assigned ? '' : ' is-empty'}${port.source ? ' is-source' : ''}`}>
      <div className="group-port-head">
        <span className="group-port-dot" style={{ background: tint }} />
        <Icon name={port.icon} size={13} />
        <span>{LABEL[port.key] ?? port.key}</span>
        {port.source && (
          <span style={{
            marginLeft: 'auto', color: 'var(--color-accent)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.04em', display: 'inline-flex', alignItems: 'center', gap: 3,
          }}>
            <Icon name="strategies" size={10} /> SOURCE
          </span>
        )}
      </div>

      {port.assigned ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto' }}>
          <span className="text-body-sm" style={{ flex: 1, color: 'var(--color-ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {port.assigned.label}
          </span>
          <button className="group-x" title="Remove from group" disabled={busy} onClick={() => port.onRemove(port.assigned!.id)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : port.options.length === 0 ? (
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 'auto' }}>None available</span>
      ) : (
        <select
          className="group-assign" value="" disabled={busy} style={{ marginTop: 'auto' }}
          onChange={e => { if (e.target.value) port.onAssign(e.target.value); }}
        >
          <option value="">Assign…</option>
          {port.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      )}

      {port.onMakeSource && (
        <button
          disabled={busy}
          onClick={port.onMakeSource}
          style={{
            marginTop: 6, padding: '2px 0', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 10, fontWeight: 500, letterSpacing: '0.02em',
            color: 'var(--color-ink-dim)', textAlign: 'left',
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-ink-dim)'; }}
        >
          Set as source
        </button>
      )}

      {port.noBotWarning && (
        <div className="callout-warning" style={{ marginTop: 8, padding: '7px 10px', gap: 8, fontSize: 11 }}>
          <Icon name="warning" size={13} />
          <span>No bot — this channel can't send or receive group posts.</span>
        </div>
      )}
    </div>
  );
}
