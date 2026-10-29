// Groups — the dedicated brand-group management page (Connections → Groups).
//
// A group is a brand "patch-bay": it links one Telegram channel + one Facebook,
// Instagram and Threads account. Each member is its own resource (spec 024): the
// network's agent decides per post whether to duplicate, adapt, write a unique post
// or skip. While auto-duplication is on (legacy groups, or an agent not yet live),
// posts published to the auto-duplicate SOURCE are duplicated to every other member.
// A group holds at most one destination per platform (enforced server-side). This
// page is the ONLY place to create/delete groups and wire destinations into them.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, type IconName } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError } from '../ui/Toast';
import { EmptyState, HubGlyph } from '../ui/primitives';
import {
  useMetaAccounts, useMetaAccountGroups, useCreateMetaAccountGroup,
  useDeleteMetaAccountGroup, useSetMetaAccountGroup, useSetMetaAccountGroupSource,
  autoDuplicates, type GroupSourcePlatform,
} from '../../api/meta-accounts';
import { trackingApi } from '../../api/tracking';
import type { MetaAccount, MetaPlatform, TrackedChannel } from '../../api/types';
import './connections.css';

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
  const portsFor = (g: { id: string; source_platform: GroupSourcePlatform; mode?: 'independent' | 'legacy_duplicate'; auto_duplicate?: boolean | null }): PortData[] => {
    const groupId = g.id;
    // Spec 024 FR-003: the source and double-post warnings matter only while the group auto-duplicates.
    const dup = autoDuplicates(g);
    const ch  = allChannels.find(c => c.groupId === groupId) ?? null;
    const isTgSource = g.source_platform === 'telegram';

    // Telegram has no bot warning when it is either the source or an assigned target
    // and the linked channel has no bot bound.
    const tgActive = isTgSource || (ch != null);
    const noBotWarning = tgActive && ch != null && !ch.bot;
    const tg: PortData = {
      key: 'telegram', icon: 'telegram', source: isTgSource && dup,
      assigned: ch ? { id: ch.id, label: chLabel(ch) } : null,
      options: allChannels.filter(c => c.groupId == null).map(c => ({ id: c.id, label: chLabel(c) })),
      onAssign: (id) => setChannelGroup.mutate({ id, groupId }),
      onRemove: (id) => setChannelGroup.mutate({ id, groupId: null }),
      noBotWarning,
    };
    const metaPorts = PLATFORMS.map<PortData>(platform => {
      const acc = allAccounts.find(a => a.group_id === groupId && a.platform === platform) ?? null;
      const isSource = g.source_platform === platform;
      return {
        key: platform, icon: platform as IconName, source: isSource && dup,
        assigned: acc ? { id: acc.id, label: acctLabel(acc) } : null,
        options: allAccounts.filter(a => a.platform === platform && a.group_id == null)
          .map(a => ({ id: a.id, label: acctLabel(a) })),
        onAssign: (id) => setGroup.mutate({ id, groupId }),
        onRemove: (id) => setGroup.mutate({ id, groupId: null }),
      };
    });
    return [tg, ...metaPorts];
  };

  return (
    <div>
      <p className="grp-intro">
        A group links a brand's destinations. Each member is its own resource; the network's agent decides per post:
        duplicate, adapt, unique or skip. While a group still <b>auto-duplicates</b> (legacy groups, or an agent that is
        not live yet), posts published to its <b>auto-duplicate source</b> are duplicated to every other member
        (Telegram included) — pick it from the dropdown on each group.
      </p>

      {/* Create composer */}
      <section className="panel is-section grp-compose" aria-label="New group">
        <HubGlyph size={36}><Icon name="plus" size={16} /></HubGlyph>
        <input
          value={name} onChange={e => setName(e.target.value)} placeholder="New group name — e.g. Recipes" aria-label="New group name"
          className="input-field" style={{ flex: 1, minWidth: 180 }}
          onKeyDown={e => { if (e.key === 'Enter') create(); }}
        />
        <button onClick={create} className="btn-primary" disabled={!name.trim() || createGroup.isPending}>
          <Icon name="plus" size={14} /> {createGroup.isPending ? 'Creating…' : 'Create group'}
        </button>
      </section>

      {(la || lg) && <p className="grp-state" role="status">Loading…</p>}
      {err && <div className="callout-danger" role="alert" style={{ marginBottom: 16 }}>{describeError(err)}</div>}

      {groups && groups.length === 0 && (
        <EmptyState
          icon="connections"
          title="No groups yet"
          note="Create one above, then wire its Telegram channel + Facebook / Instagram / Threads accounts."
        />
      )}

      <div className="grp-list">
        {(groups ?? []).map((g, i) => {
          const ports = portsFor(g);
          const linked = ports.filter(p => p.assigned).length;
          // Members actually wired into this group — the only valid sources.
          const wired = ports.filter(p => p.assigned).map(p => ({ key: p.key, label: p.assigned!.label }));
          const sourceWired = wired.some(w => w.key === g.source_platform);
          // If the current source isn't wired (e.g. just unlinked), still show it so the <select> reflects reality.
          const sourceOptions = sourceWired
            ? wired
            : [{ key: g.source_platform, label: `${LABEL[g.source_platform] ?? g.source_platform} (not linked)` }, ...wired];
          return (
            <div key={g.id} className="group-card" style={{ animationDelay: `${Math.min(i, 8) * 55}ms` }}>
              <div className="grp-head">
                <HubGlyph>{g.name.charAt(0).toUpperCase()}</HubGlyph>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2 className="text-heading-md grp-name" style={{ margin: 0 }}>{g.name}</h2>
                  <div className={`grp-linked${linked === 4 ? ' is-full' : ''}`}>{linked} of 4 destinations linked</div>
                </div>

                {/* Auto-duplicate source — shown only while the group still auto-duplicates (spec 024 FR-011). */}
                {autoDuplicates(g) ? (
                <label className="grp-source" title="The member you publish to — its posts are duplicated to every other member of the group while auto-duplication is on">
                  <span className="text-eyebrow">Auto-duplicate source</span>
                  <select
                    className="input-field"
                    value={g.source_platform}
                    disabled={busy || wired.length === 0}
                    onChange={e => setSource.mutate({ id: g.id, sourcePlatform: e.target.value as GroupSourcePlatform })}
                    style={{ padding: '5px 10px', fontSize: 13, minWidth: 130 }}
                  >
                    {sourceOptions.map(o => (
                      <option key={o.key} value={o.key}>{LABEL[o.key] ?? o.key} — {o.label}</option>
                    ))}
                  </select>
                </label>
                ) : (
                  <span className="chip" title="The network's agent decides per post for every member; nothing is auto-duplicated">independent</span>
                )}

                <button
                  type="button" className="btn-act btn-act-danger" title="Delete group" aria-label={`Delete group ${g.name}`}
                  onClick={async () => {
                    if (await confirm(`delete group "${g.name}"`, { details: <p className="text-micro conn-dialog-note is-flush">Members (channel + accounts) are kept — they're just un-grouped (auto-duplication stops).</p> })) {
                      deleteGroup.mutate(g.id);
                      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
                    }
                  }}
                >
                  <Icon name="trash" size={14} />
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
          <span className="grp-source-tag"><Icon name="strategies" size={11} /> Source</span>
        )}
      </div>

      {port.assigned ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto' }}>
          <span className="text-body-sm grp-port-name">{port.assigned.label}</span>
          <button type="button" className="group-x" title="Remove from group" aria-label={`Remove ${port.assigned.label} from the group`} disabled={busy} onClick={() => port.onRemove(port.assigned!.id)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : port.options.length === 0 ? (
        <span className="grp-port-none">None available</span>
      ) : (
        <select
          className="group-assign" value="" disabled={busy} style={{ marginTop: 'auto' }}
          onChange={e => { if (e.target.value) port.onAssign(e.target.value); }}
        >
          <option value="">Assign…</option>
          {port.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      )}

      {port.noBotWarning && (
        <div className="callout-warning grp-warn">
          <Icon name="warning" size={13} />
          <span>No bot — this channel can't send or receive group posts.</span>
        </div>
      )}

    </div>
  );
}
