import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { toast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import { errorText } from '../agents/NetworkUi';
import { useSetLinks, useSetResourceNetwork, type MapSnapshot } from '../../api/map';
import { linkChoices, linkHint } from '../../lib/map-links';
import { resourceTitle } from '../../lib/map-state';

// Spec 058: link mode — the HUD's "Link" button; click one building, then another, and the popover at the second one offers what
// to do with the pair. The mode stays on after an action, so several pairs can be linked one after another.

/** The line under the HUD while link mode is on. */
export function LinkHint({ first }: { first: string | null }) {
  return (
    <div className="map-hud map-hint" role="status" aria-live="polite">
      <Icon name="link" size={14} /><span>{linkHint(first)}</span>
    </div>
  );
}

export interface LinkPopoverProps {
  snap: MapSnapshot;
  /** The first building clicked, and the second one (the popover sits at it). */
  a: string;
  b: string;
  /** Where the popover hangs, in the page's own pixels (the second building). */
  x: number;
  y: number;
  /** An action went through (or failed): pick the next pair. */
  onDone: () => void;
  onCancel: () => void;
}

export function LinkPopover({ snap, a, b, x, y, onDone, onCancel }: LinkPopoverProps) {
  const confirm = useConfirm();
  const setLinks = useSetLinks();
  const setNetwork = useSetResourceNetwork();
  const c = linkChoices(snap, a, b);
  if (!c) return null;
  const nameA = resourceTitle(c.a);
  const nameB = resourceTitle(c.b);
  const busy = setLinks.isPending || setNetwork.isPending;

  const link = async () => {
    try {
      await setLinks.mutateAsync({ ref: c.a.ref, add: [c.b.ref], remove: [] });
      toast.success(`${nameA} and ${nameB} are linked`);
      onDone();
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const putIn = async () => {
    if (!c.putIn) return;
    if (c.leaves) {
      const ok = await confirm(`move «${nameB}» from «${c.leaves}» into «${c.putIn.name}»`, {
        danger: false, confirmLabel: 'Move',
        details: <p className="text-micro map-note">It leaves «{c.leaves}»: copies planned for it there are skipped. You can move it back any time.</p>,
      });
      if (!ok) return;
    }
    try {
      const r = await setNetwork.mutateAsync({ ref: c.b.ref, groupId: c.putIn.id });
      toast.success(`${nameB} → ${r.groupName ?? c.putIn.name}`);
      onDone();
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <div className="map-hud map-popover" style={{ left: x, top: y }} role="dialog" aria-label={`${nameA} and ${nameB}`}>
      <p className="map-popover-title">
        <span>{nameA}</span><Icon name="link" size={13} /><span>{nameB}</span>
      </p>
      <div className="map-popover-actions">
        <button type="button" className="btn-secondary" disabled={busy || c.linked} onClick={() => void link()}>
          <Icon name="megaphone" size={14} />{c.linked ? 'Already promo partners' : 'Promo partners'}
        </button>
        {c.putIn && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void putIn()}>
            <Icon name="layers" size={14} />Put {nameB} in {c.putIn.name}
          </button>
        )}
        <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
      {c.stopped && <p className="text-micro map-note"><Badge tone="warning">stopped</Badge> You unlinked this pair earlier; linking brings it back.</p>}
      {c.full && <p className="text-micro map-note">«{c.full.name}» already has {resourceTitle(c.full.holder)} on this platform, so {nameB} cannot join it.</p>}
    </div>
  );
}
