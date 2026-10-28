import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import { errorText } from '../agents/NetworkUi';
import { useSetNetworkMode } from '../../api/network';
import { useCreateMetaAccountGroup, useMetaAccountGroups } from '../../api/meta-accounts';
import { useQueryClient } from '@tanstack/react-query';
import { MAP_KEY, useSetLinks, useSetResourceNetwork, type MapResource, type MapRoad, type MapSnapshot } from '../../api/map';
import { PLATFORM_META, resourceTitle } from '../../lib/map-state';
import { PLATFORM_SECTION_NAME } from '../../lib/map-layout';
import { UNLINK_HELP, plannedPromos } from '../../lib/map-links';

// Spec 056 follow-up and 058: what the owner changes from the map — a resource's network, a promo link, a network's mode.
// Each change asks first and says what follows from it.

/** How many planned copies a break skipped, for a toast. */
const copiesSkipped = (n: number): string => (n > 0 ? ` · ${n} planned ${n === 1 ? 'copy' : 'copies'} skipped` : '');

const NEW = '__new__';
const NONE = '__none__';

/** Which network a resource belongs to: pick another, take it out, or start a new network with it. */
export function NetworkPicker({ snap, res }: { snap: MapSnapshot; res: MapResource }) {
  const confirm = useConfirm();
  const groups = useMetaAccountGroups();
  const setNetwork = useSetResourceNetwork();
  const create = useCreateMetaAccountGroup();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const busy = setNetwork.isPending || create.isPending;
  const title = resourceTitle(res);
  const platform = PLATFORM_META[res.platform].label;
  const list = [...(groups.data ?? snap.networks.map((n) => ({ id: n.id, name: n.name })))].sort((a, b) => a.name.localeCompare(b.name));
  const current = list.find((g) => g.id === res.groupId) ?? snap.networks.find((n) => n.id === res.groupId) ?? null;
  const isAnchor = !!current && snap.networks.find((n) => n.id === current.id)?.anchorRef === res.ref;
  /** A network that already has a resource of this platform (the server refuses a second one). */
  const taken = (id: string) => snap.resources.find((r) => r.groupId === id && r.platform === res.platform && r.ref !== res.ref);

  const move = async (groupId: string | null, groupName: string | null) => {
    const ok = groupId
      ? await confirm(`move «${title}» into «${groupName}»`, {
        danger: false, confirmLabel: 'Move',
        details: (
          <p className="text-micro map-note">
            {current ? `It leaves «${current.name}». ` : ''}The network's mode then applies to it: with Auto-duplicate the network's Telegram posts are
            copied to it, with Independent the network's agent decides per post. You can move it back any time.
          </p>
        ),
      })
      : await confirm(`take «${title}» out of «${current?.name ?? 'the network'}»`, {
        danger: isAnchor, confirmLabel: 'Take out',
        details: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {isAnchor && <div className="callout-warning"><strong>This is the network's Telegram channel: the network's agent and its playbook are anchored on it.</strong></div>}
            <p className="text-micro map-note">
              The line disappears: the network's posts are no longer copied or adapted to it, copies already planned for it are skipped, and it moves to the {PLATFORM_SECTION_NAME[res.platform]} section. You can put it back any time.
            </p>
          </div>
        ),
      });
    if (!ok) return false;
    try {
      const r = await setNetwork.mutateAsync({ ref: res.ref, groupId });
      toast.success(`${r.groupName ? `${title} → ${r.groupName}` : `${title} is in no network now`}${copiesSkipped(r.canceled ?? 0)}`);
      return true;
    } catch (e) {
      toast.error(errorText(e));
      return false;
    }
  };

  const onPick = (v: string) => {
    if (v === NEW) { setNaming(true); return; }
    if (v === NONE) { void move(null, null); return; }
    const g = list.find((x) => x.id === v);
    if (g) void move(g.id, g.name);
  };

  const createAndMove = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const g = await create.mutateAsync(n);
      if (await move(g.id, g.name)) { setNaming(false); setName(''); }
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <select className="input-field" aria-label="Network" value={naming ? NEW : res.groupId ?? NONE} disabled={busy} onChange={(e) => onPick(e.target.value)}>
        <option value={NONE}>No network ({PLATFORM_SECTION_NAME[res.platform]})</option>
        {list.map((g) => {
          const clash = g.id !== res.groupId ? taken(g.id) : undefined;
          return (
            <option key={g.id} value={g.id} disabled={!!clash}>
              {g.name}{clash ? ` — has ${platform} ${resourceTitle(clash)}` : ''}
            </option>
          );
        })}
        <option value={NEW}>New network…</option>
      </select>
      {naming && (
        <div className="map-field-row">
          <input className="input-field" style={{ flex: 1 }} autoFocus placeholder="Network name" value={name} maxLength={80}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createAndMove(); if (e.key === 'Escape') setNaming(false); }} />
          <button type="button" className="btn-primary btn-sm" disabled={!name.trim() || busy} onClick={() => void createAndMove()}>Create</button>
          <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => { setNaming(false); setName(''); }}>Cancel</button>
        </div>
      )}
      <p className="text-micro map-note">
        One account per platform in a network. Networks are also managed on <Link to="/app/connections/groups" className="link-accent">Connections → Groups</Link>.
      </p>
    </div>
  );
}

/**
 * The changes a road offers (spec 058): one "break link" that matches the road — a copy road takes the target out of the
 * network, a promo road unlinks the pair — and, on a past road, linking again. For copies, the network's mode.
 */
export function RoadActions({ snap, road }: { snap: MapSnapshot; road: MapRoad }) {
  const confirm = useConfirm();
  const links = useSetLinks();
  const setNetwork = useSetResourceNetwork();
  const a = snap.resources.find((r) => r.ref === road.from);
  const b = snap.resources.find((r) => r.ref === road.to);
  const copy = (road.relation ?? (road.kind === 'duplicate' || road.kind === 'adapt' ? 'network' : 'promo')) === 'network';
  const shared = !road.past && a?.groupId && a.groupId === b?.groupId ? snap.networks.find((n) => n.id === a.groupId) ?? null : null;
  const anchorAgent = shared?.anchorRef ? snap.resources.find((r) => r.ref === shared.anchorRef)?.agent ?? null : null;
  const nameA = a ? resourceTitle(a) : road.from;
  const nameB = b ? resourceTitle(b) : road.to;
  // a past copy road can be made again when the source is in a network and the target's platform has a free place there
  const homeNetwork = copy && road.past && a?.groupId && b && !b.groupId ? snap.networks.find((n) => n.id === a.groupId) ?? null : null;
  const placeTaken = homeNetwork && b ? snap.resources.find((r) => r.groupId === homeNetwork.id && r.platform === b.platform) : undefined;

  const setLinked = async (linked: boolean) => {
    const ok = linked
      ? true
      : await confirm(`unlink «${nameA}» and «${nameB}»`, { confirmLabel: 'Unlink', details: <p className="text-micro map-note">{UNLINK_HELP}</p> });
    if (!ok) return;
    try {
      const r = await links.mutateAsync({ ref: road.from, add: linked ? [road.to] : [], remove: linked ? [] : [road.to] });
      toast.success(linked ? `${nameA} ↔ ${nameB} linked` : `Unlinked${plannedPromos(r.canceled)}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const takeOut = async () => {
    if (!b || !shared) return;
    const ok = await confirm(`take «${nameB}» out of «${shared.name}»`, {
      danger: true, confirmLabel: 'Take out',
      details: <p className="text-micro map-note">The line disappears: the network's posts are no longer copied or adapted to it, copies already planned for it are skipped, and it moves to the {PLATFORM_SECTION_NAME[b.platform]} section. You can put it back from its drawer.</p>,
    });
    if (!ok) return;
    try {
      const r = await setNetwork.mutateAsync({ ref: b.ref, groupId: null });
      toast.success(`${nameB} is in no network now${copiesSkipped(r.canceled ?? 0)}`);
    } catch (e) { toast.error(errorText(e)); }
  };

  const putBack = async () => {
    if (!b || !homeNetwork) return;
    try {
      await setNetwork.mutateAsync({ ref: b.ref, groupId: homeNetwork.id });
      toast.success(`${nameB} → ${homeNetwork.name}`);
    } catch (e) { toast.error(errorText(e)); }
  };

  if (road.past) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!copy && (
          <button type="button" className="btn-secondary map-btn-start" disabled={links.isPending} onClick={() => void setLinked(true)}>
            <Icon name="link" size={14} />Link again
          </button>
        )}
        {homeNetwork && b && (
          <button type="button" className="btn-secondary map-btn-start" disabled={setNetwork.isPending || !!placeTaken} onClick={() => void putBack()}>
            <Icon name="link" size={14} />Put {nameB} back in {homeNetwork.name}
          </button>
        )}
        {placeTaken && <p className="text-micro map-note">«{homeNetwork!.name}» already has {resourceTitle(placeTaken)} on this platform.</p>}
        {copy && !homeNetwork && <p className="text-micro map-note">To copy posts again, put the resource back in a network from its drawer.</p>}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!copy && (
        <button type="button" className="btn-secondary map-btn-start map-btn-danger" disabled={links.isPending} onClick={() => void setLinked(false)}>
          <Icon name="x" size={14} />Unlink {nameA} and {nameB}
        </button>
      )}
      {copy && shared && (
        <button type="button" className="btn-secondary map-btn-start map-btn-danger" disabled={setNetwork.isPending} onClick={() => void takeOut()}>
          <Icon name="x" size={14} />Take {nameB} out of {shared.name}
        </button>
      )}
      {copy && shared && anchorAgent && shared.mode === 'legacy_duplicate' && <IndependentButton handle={anchorAgent} network={shared.name} />}
      {copy && shared && shared.mode === 'independent' && (
        <p className="text-micro map-note">
          «{shared.name}» is Independent: @{anchorAgent ?? 'the network agent'} decides per post whether to copy, adapt or write a unique one (its playbook).
        </p>
      )}
    </div>
  );
}

export function IndependentButton({ handle, network }: { handle: string; network: string }) {
  const confirm = useConfirm();
  const set = useSetNetworkMode(handle);
  const qc = useQueryClient();
  const go = async () => {
    const ok = await confirm(`switch «${network}» to independent`, {
      danger: false, confirmLabel: 'Switch to independent',
      details: <p className="text-micro map-note">Each member becomes its own resource; @{handle} decides per post: duplicate, adapt, unique or skip. Auto-duplication stops from the next plan day once the agent is live with an active playbook.</p>,
    });
    if (!ok) return;
    set.mutate('independent', {
      onSuccess: (r) => { toast.success(`«${r.group}» → ${r.mode}`); void qc.invalidateQueries({ queryKey: MAP_KEY }); },
      onError: (e) => toast.error(errorText(e)),
    });
  };
  return (
    <button type="button" className="btn-secondary map-btn-start" disabled={set.isPending} onClick={() => void go()}>
      <Icon name="agents" size={14} />Switch {network} to Independent (stop auto-copies)
    </button>
  );
}
