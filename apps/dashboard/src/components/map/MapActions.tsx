import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import { errorText } from '../agents/NetworkUi';
import { useSetNetworkMode } from '../../api/network';
import { useCreateMetaAccountGroup, useMetaAccountGroups } from '../../api/meta-accounts';
import { useSetPromoBlock, useSetResourceNetwork, type MapResource, type MapRoad, type MapSnapshot } from '../../api/map';
import { PLATFORM_META, resourceTitle } from '../../lib/map-state';
import { PLATFORM_SECTION_NAME } from '../../lib/map-layout';

// Spec 056 follow-up: what the owner changes from the map — a resource's network, a promo pair, a network's mode.
// Each change asks first and says what follows from it.

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
          <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
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
            <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
              The network's posts are no longer copied or adapted to it and it moves to the {PLATFORM_SECTION_NAME[res.platform]} section. You can put it back any time.
            </p>
          </div>
        ),
      });
    if (!ok) return false;
    try {
      const r = await setNetwork.mutateAsync({ ref: res.ref, groupId });
      toast.success(r.groupName ? `${title} → ${r.groupName}` : `${title} is in no network now`);
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
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input-field" style={{ flex: 1 }} autoFocus placeholder="Network name" value={name} maxLength={80}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createAndMove(); if (e.key === 'Escape') setNaming(false); }} />
          <button type="button" className="btn-primary" disabled={!name.trim() || busy} onClick={() => void createAndMove()}>Create</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setNaming(false); setName(''); }}>Cancel</button>
        </div>
      )}
      <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
        One account per platform in a network. Networks are also managed on <Link to="/app/connections/groups" className="link-accent">Connections → Groups</Link>.
      </p>
    </div>
  );
}

/** The changes a road offers: block or allow promos between the pair; for copies, the network's mode or taking the copy target out. */
export function RoadActions({ snap, road }: { snap: MapSnapshot; road: MapRoad }) {
  const confirm = useConfirm();
  const block = useSetPromoBlock();
  const setNetwork = useSetResourceNetwork();
  const a = snap.resources.find((r) => r.ref === road.from);
  const b = snap.resources.find((r) => r.ref === road.to);
  const shared = a?.groupId && a.groupId === b?.groupId ? snap.networks.find((n) => n.id === a.groupId) ?? null : null;
  const anchorAgent = shared?.anchorRef ? snap.resources.find((r) => r.ref === shared.anchorRef)?.agent ?? null : null;
  const nameA = a ? resourceTitle(a) : road.from;
  const nameB = b ? resourceTitle(b) : road.to;

  const toggleBlock = async () => {
    const blocked = !road.blocked;
    const ok = await confirm(blocked ? `stop promos between «${nameA}» and «${nameB}»` : `allow promos between «${nameA}» and «${nameB}» again`, {
      danger: blocked, confirmLabel: blocked ? 'Stop promos' : 'Allow promos',
      details: (
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          {blocked
            ? 'Both ways. Promo posts of this pair that have not gone out yet are skipped, and a cross-promo or repost directive for the pair is refused until you allow it again. Published promos stay; the line fades out within 30 days.'
            : 'The manager may propose promos between them again; each one still needs your approval.'}
        </p>
      ),
    });
    if (!ok) return;
    try {
      const r = await block.mutateAsync({ a: road.from, b: road.to, blocked });
      toast.success(blocked ? `Promos stopped${r.canceled ? ` · ${r.canceled} planned ${r.canceled === 1 ? 'promo' : 'promos'} skipped` : ''}` : 'Promos allowed again');
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const takeOut = async () => {
    if (!b || !shared) return;
    const ok = await confirm(`take «${nameB}» out of «${shared.name}»`, {
      danger: false, confirmLabel: 'Take out',
      details: <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>The network's posts are no longer copied or adapted to it; it moves to the {PLATFORM_SECTION_NAME[b.platform]} section. You can put it back from its drawer.</p>,
    });
    if (!ok) return;
    try { await setNetwork.mutateAsync({ ref: b.ref, groupId: null }); toast.success(`${nameB} is in no network now`); } catch (e) { toast.error(errorText(e)); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {road.kind !== 'duplicate' && (
        <button type="button" className="btn-secondary" disabled={block.isPending} onClick={() => void toggleBlock()}
          style={{ justifyContent: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8, color: road.blocked ? undefined : 'var(--color-danger)' }}>
          <Icon name={road.blocked ? 'play' : 'ban'} size={14} />{road.blocked ? 'Allow promos between them again' : 'Stop promos between them'}
        </button>
      )}
      {road.kind !== 'promo' && shared && anchorAgent && shared.mode === 'legacy_duplicate' && <IndependentButton handle={anchorAgent} network={shared.name} />}
      {road.kind !== 'promo' && shared && (
        <button type="button" className="btn-secondary" disabled={setNetwork.isPending} onClick={() => void takeOut()}
          style={{ justifyContent: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="x" size={14} />Take {nameB} out of {shared.name}
        </button>
      )}
      {road.kind !== 'promo' && shared && shared.mode === 'independent' && (
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          «{shared.name}» is Independent: @{anchorAgent ?? 'the network agent'} decides per post whether to copy, adapt or write a unique one (its playbook).
        </p>
      )}
    </div>
  );
}

function IndependentButton({ handle, network }: { handle: string; network: string }) {
  const confirm = useConfirm();
  const set = useSetNetworkMode(handle);
  const go = async () => {
    const ok = await confirm(`switch «${network}» to independent`, {
      danger: false, confirmLabel: 'Switch to independent',
      details: <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>Each member becomes its own resource; @{handle} decides per post: duplicate, adapt, unique or skip. Auto-duplication stops from the next plan day once the agent is live with an active playbook.</p>,
    });
    if (!ok) return;
    set.mutate('independent', { onSuccess: (r) => toast.success(`«${r.group}» → ${r.mode}`), onError: (e) => toast.error(errorText(e)) });
  };
  return (
    <button type="button" className="btn-secondary" disabled={set.isPending} onClick={() => void go()}
      style={{ justifyContent: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Icon name="agents" size={14} />Switch {network} to Independent (stop auto-copies)
    </button>
  );
}
