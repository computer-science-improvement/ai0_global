import { useMemo, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { toast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import { Modal } from '../Modal';
import { errorText } from '../agents/NetworkUi';
import { useSetLinks, useSetNetworkMembers, type MapNetwork, type MapResource, type MapSnapshot } from '../../api/map';
import {
  LINK_LIMIT, UNLINK_HELP, diffLine, linkDiff, linkSections, memberOutcome, memberSections, networkMates, networkMembers, plannedPromos, promoPartners,
} from '../../lib/map-links';
import { PLATFORM_META, resourceTitle } from '../../lib/map-state';
import { NetworkPicker } from './MapActions';

// Spec 058: the "Links" section of a building's drawer — the network line with its copy partners, the promo partners
// (a × unlinks, after a confirm) and the "Link resources…" picker. Every change is a real change: a break makes the line
// disappear at once.


function Chip({ res, onPick, onRemove }: { res: MapResource; onPick: (ref: string) => void; onRemove?: () => void }) {
  const meta = PLATFORM_META[res.platform];
  const title = resourceTitle(res);
  return (
    <span className="map-chip">
      <button type="button" className="map-chip-main" onClick={() => onPick(res.ref)} title={`Show ${title}`}>
        <span style={{ color: meta.tint, display: 'inline-flex' }}><Icon name={meta.icon} size={13} /></span>
        <span className="map-chip-text">{title}</span>
      </button>
      {onRemove && <button type="button" className="map-chip-x" aria-label={`Unlink ${title}`} title={`Unlink ${title}`} onClick={onRemove}><Icon name="x" size={12} /></button>}
    </span>
  );
}

export function LinksSection({ snap, res, onPick }: { snap: MapSnapshot; res: MapResource; onPick: (ref: string) => void }) {
  const confirm = useConfirm();
  const setLinks = useSetLinks();
  const [picking, setPicking] = useState(false);
  const mates = networkMates(snap, res);
  const partners = promoPartners(snap, res.ref);
  const title = resourceTitle(res);

  const unlink = async (other: MapResource) => {
    const ok = await confirm(`unlink «${title}» and «${resourceTitle(other)}»`, {
      confirmLabel: 'Unlink',
      details: <p className="text-micro map-note">{UNLINK_HELP}</p>,
    });
    if (!ok) return;
    try {
      const r = await setLinks.mutateAsync({ ref: res.ref, add: [], remove: [other.ref] });
      toast.success(`Unlinked ${resourceTitle(other)}${plannedPromos(r.canceled)}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h4 className="map-subhead">Copies</h4>
        <NetworkPicker snap={snap} res={res} />
        {res.groupId && (
          mates.length
            ? <div className="map-chips" aria-label="Other members of the network">{mates.map((m) => <Chip key={m.ref} res={m} onPick={onPick} />)}</div>
            : <p className="text-micro map-note">It is the only member of its network.</p>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h4 className="map-subhead">Promo partners</h4>
        {partners.length
          ? <div className="map-chips" aria-label="Promo partners">{partners.map((p) => <Chip key={p.ref} res={p} onPick={onPick} onRemove={() => void unlink(p)} />)}</div>
          : <p className="text-micro map-note">No promo partners yet. Link resources to let them promote each other; the manager then proposes promos, each one still needs your approval.</p>}
        <div>
          <button type="button" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => setPicking(true)}>
            <Icon name="link" size={14} />Link resources…
          </button>
        </div>
      </div>
      {picking && <LinkResourcesModal snap={snap} res={res} onClose={() => setPicking(false)} />}
    </div>
  );
}

/** A searchable multi-select of every other resource: checked = linked; checking links, unchecking unlinks. */
function LinkResourcesModal({ snap, res, onClose }: { snap: MapSnapshot; res: MapResource; onClose: () => void }) {
  const confirm = useConfirm();
  const setLinks = useSetLinks();
  const [initial] = useState<ReadonlySet<string>>(() => new Set(promoPartners(snap, res.ref).map((r) => r.ref)));
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initial));
  const [query, setQuery] = useState('');
  const sections = useMemo(() => linkSections(snap, res.ref, query), [snap, res.ref, query]);
  const { add, remove } = linkDiff(initial, checked);
  const title = resourceTitle(res);
  const tooMany = add.length + remove.length > LINK_LIMIT;
  const toggle = (ref: string) => setChecked((cur) => { const n = new Set(cur); if (n.has(ref)) n.delete(ref); else n.add(ref); return n; });

  const apply = async () => {
    if (remove.length) {
      const ok = await confirm(`unlink «${title}» from ${remove.length} ${remove.length === 1 ? 'resource' : 'resources'}`, {
        confirmLabel: 'Apply', danger: true,
        details: <p className="text-micro map-note">{UNLINK_HELP}</p>,
      });
      if (!ok) return;
    }
    try {
      const r = await setLinks.mutateAsync({ ref: res.ref, add, remove });
      const parts = [r.linked.length ? `Linked ${r.linked.length}` : '', r.unlinked.length ? `Unlinked ${r.unlinked.length}` : ''].filter(Boolean);
      toast.success(`${parts.join(' · ') || 'Nothing changed'}${plannedPromos(r.canceled)}`);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <Modal open onClose={onClose} title="Link resources" subtitle={`${title} — checked resources may promote each other`} icon="link" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input className="input-field" type="search" autoFocus placeholder="Search by name, handle or network" aria-label="Search resources" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="map-pick-list" role="group" aria-label="Resources">
          {sections.length === 0 && <p className="text-caption map-note">{query ? 'No resource matches.' : 'There are no other resources yet.'}</p>}
          {sections.map((s) => (
            <section key={s.id}>
              <h4 className="map-subhead" style={{ margin: '8px 0 4px' }}>{s.title}</h4>
              {s.items.map(({ res: r, networkName, linked, stopped }) => {
                const meta = PLATFORM_META[r.platform];
                return (
                  <label key={r.ref} className={`map-pick-row${checked.has(r.ref) ? ' is-checked' : ''}`}>
                    <input type="checkbox" checked={checked.has(r.ref)} onChange={() => toggle(r.ref)} />
                    <span style={{ color: meta.tint, display: 'inline-flex', flex: 'none' }}><Icon name={meta.icon} size={15} /></span>
                    <span className="map-pick-title">{resourceTitle(r)}</span>
                    <span className="map-pick-meta">
                      {networkName && !s.id.startsWith('network:') && <span className="text-micro ink-dim">{networkName}</span>}
                      {linked && <Badge tone="success">linked</Badge>}
                      {stopped && <Badge tone="warning" title="You unlinked this pair; the manager does not propose it">stopped</Badge>}
                    </span>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
        {tooMany && <p className="text-micro ink-warning" style={{ margin: 0 }}>At most {LINK_LIMIT} changes at a time. Apply these, then open the list again.</p>}
      </div>
      <div className="modal-foot" style={{ alignItems: 'center' }}>
        <span className="text-caption ink-muted" style={{ marginRight: 'auto' }} aria-live="polite">{diffLine(add.length, remove.length)}</span>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={(!add.length && !remove.length) || tooMany || setLinks.isPending} onClick={() => void apply()}>Apply</button>
      </div>
    </Modal>
  );
}

/** The title of a resource by ref, for the lists of refused changes. */
const nameOfRef = (snap: MapSnapshot, ref: string): string => {
  const r = snap.resources.find((x) => x.ref === ref);
  return r ? resourceTitle(r) : ref;
};

/**
 * Spec 058: the members of a network in bulk. Checked = in the network; checking adds (one per platform: a row whose platform
 * is taken is disabled and says who holds the place), unchecking takes out. A partial success keeps the dialog open with the
 * refused ones listed, and what went through is already the new starting point.
 */
export function MembersModal({ snap, network, onClose }: { snap: MapSnapshot; network: MapNetwork; onClose: () => void }) {
  const confirm = useConfirm();
  const setMembers = useSetNetworkMembers();
  const [initial, setInitial] = useState<ReadonlySet<string>>(() => new Set(networkMembers(snap, network.id).map((r) => r.ref)));
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initial));
  const [query, setQuery] = useState('');
  const [failed, setFailed] = useState<Array<{ ref: string; error: string }>>([]);
  const sections = useMemo(() => memberSections(snap, network.id, checked, query), [snap, network.id, checked, query]);
  const { add, remove } = linkDiff(initial, checked);
  const tooMany = add.length > LINK_LIMIT || remove.length > LINK_LIMIT;
  const toggle = (ref: string) => setChecked((cur) => { const n = new Set(cur); if (n.has(ref)) n.delete(ref); else n.add(ref); return n; });

  const apply = async () => {
    if (remove.length) {
      const ok = await confirm(`take ${remove.length} ${remove.length === 1 ? 'resource' : 'resources'} out of «${network.name}»`, {
        confirmLabel: 'Apply', danger: true,
        details: (
          <p className="text-micro map-note">
            The line to each disappears: the network's posts are no longer copied or adapted to them, copies already planned for them are skipped, and they move
            to their platform section. You can put them back any time.
          </p>
        ),
      });
      if (!ok) return;
    }
    try {
      const r = await setMembers.mutateAsync({ groupId: network.id, add, remove });
      const out = memberOutcome(r.results, add, remove);
      const parts = [out.added.length ? `Added ${out.added.length}` : '', out.removed.length ? `Took out ${out.removed.length}` : ''].filter(Boolean);
      const skipped = r.canceled > 0 ? ` · ${r.canceled} planned ${r.canceled === 1 ? 'copy' : 'copies'} skipped` : '';
      if (!out.failed.length) {
        toast.success(`${network.name}: ${parts.join(' · ') || 'nothing changed'}${skipped}`);
        onClose();
        return;
      }
      // What went through is the new starting point; the refused ones stay checked / unchecked and are listed.
      setInitial((cur) => { const n = new Set(cur); out.added.forEach((x) => n.add(x)); out.removed.forEach((x) => n.delete(x)); return n; });
      setFailed(out.failed);
      toast.error(`${network.name}: ${parts.join(' · ') || 'nothing changed'}, ${out.failed.length} refused${skipped}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <Modal open onClose={onClose} title="Network members" subtitle={`${network.name} — one account per platform`} icon="layers" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input className="input-field" type="search" autoFocus placeholder="Search by name or handle" aria-label="Search resources" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="map-pick-list" role="group" aria-label="Resources">
          {sections.length === 0 && <p className="text-caption map-note">{query ? 'No resource matches.' : 'No resource can be added: every other one is in a network.'}</p>}
          {sections.map((s) => (
            <section key={s.id}>
              <h4 className="map-subhead" style={{ margin: '8px 0 4px' }}>{s.title}</h4>
              {s.items.map(({ res: r, member, blockedBy }) => {
                const meta = PLATFORM_META[r.platform];
                return (
                  <label key={r.ref} className={`map-pick-row${checked.has(r.ref) ? ' is-checked' : ''}${blockedBy ? ' is-disabled' : ''}`}>
                    <input type="checkbox" checked={checked.has(r.ref)} disabled={!!blockedBy} onChange={() => toggle(r.ref)} />
                    <span style={{ color: meta.tint, display: 'inline-flex', flex: 'none' }}><Icon name={meta.icon} size={15} /></span>
                    <span className="map-pick-title">{resourceTitle(r)}</span>
                    <span className="map-pick-meta">
                      {member && <Badge tone="success">member</Badge>}
                      {r.ref === network.anchorRef && <Badge tone="accent" title="The network's Telegram channel: its agent and playbook are anchored on it">anchor</Badge>}
                      {blockedBy && <span className="text-micro ink-dim">network already has {resourceTitle(blockedBy)}</span>}
                    </span>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
        {failed.length > 0 && (
          <div className="callout-warning" role="alert">
            <strong>{failed.length} {failed.length === 1 ? 'change was' : 'changes were'} refused:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {failed.map((f) => <li key={f.ref}>{nameOfRef(snap, f.ref)}: {f.error}</li>)}
            </ul>
          </div>
        )}
        {tooMany && <p className="text-micro ink-warning" style={{ margin: 0 }}>At most {LINK_LIMIT} additions and {LINK_LIMIT} removals at a time. Apply these, then open the list again.</p>}
      </div>
      <div className="modal-foot" style={{ alignItems: 'center' }}>
        <span className="text-caption ink-muted" style={{ marginRight: 'auto' }} aria-live="polite">
          {!add.length && !remove.length ? 'No changes' : [add.length ? `${add.length} to add` : '', remove.length ? `${remove.length} to take out` : ''].filter(Boolean).join(', ')}
        </span>
        <button type="button" className="btn-secondary" onClick={onClose}>{failed.length ? 'Close' : 'Cancel'}</button>
        <button type="button" className="btn-primary" disabled={(!add.length && !remove.length) || tooMany || setMembers.isPending} onClick={() => void apply()}>Apply</button>
      </div>
    </Modal>
  );
}
