// Spec 024 FR-010: the buttons of an Inbox `network_independent_offer` item —
// "Switch to independent" (POST …/network-mode, behind a confirmation that
// explains shadow) and "Keep auto-duplicate" (closes the offer for good). An
// answered offer shows its outcome instead.

import { Link } from '@tanstack/react-router';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { useKeepNetworkOffer, useNetworkOffers, useSetNetworkMode } from '../../api/network';
import { errorText } from './NetworkUi';

export const NETWORK_OFFER_KIND = 'network_independent_offer';

/** The confirmation text of the switch (FR-010). */
export const SWITCH_CONFIRM_NOTE = 'In shadow the agent records decisions as previews and auto-duplication continues; it stops when the agent goes live.';

export function NetworkOfferActions({ groupId, handle, onDone }: { groupId: string; handle: string; onDone?: () => void }) {
  const offers = useNetworkOffers();
  const keep = useKeepNetworkOffer();
  const setMode = useSetNetworkMode(handle);
  const confirm = useConfirm();
  const offer = offers.data?.offers.find((o) => o.groupId === groupId);
  const busy = keep.isPending || setMode.isPending;

  const playbookLink = (
    <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'playbook' }} className="link-accent text-micro">
      Open playbook →
    </Link>
  );

  if (offer && offer.status !== 'open') {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        <Badge tone={offer.status === 'switched' ? 'success' : 'neutral'}>
          {offer.status === 'switched' ? 'switched to independent' : 'kept auto-duplicate'}
        </Badge>
        {playbookLink}
      </div>
    );
  }

  const onSwitch = async () => {
    const ok = await confirm('switch this network to independent resources', {
      danger: false, confirmLabel: 'Switch to independent',
      details: (
        <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink-muted)', lineHeight: 1.5 }}>
          Each member becomes its own resource: the agent decides per post whether to duplicate, adapt, write a unique post
          or skip. {SWITCH_CONFIRM_NOTE} The change applies from the next plan day.
        </p>
      ),
    });
    if (!ok) return;
    setMode.mutate('independent', {
      onSuccess: (r) => { toast.success(`"${r.group}" is now independent`); offers.refetch(); onDone?.(); },
      onError: (e) => toast.error(errorText(e)),
    });
  };

  const onKeep = () => keep.mutate(groupId, {
    onSuccess: () => { toast.success('Auto-duplicate kept — you will not be asked again'); onDone?.(); },
    onError: (e) => toast.error(errorText(e)),
  });

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
      <button type="button" className="btn-primary" style={{ gap: 6, fontSize: 12, padding: '5px 10px' }} disabled={busy} onClick={onSwitch}>
        <Icon name="check" size={13} /> Switch to independent
      </button>
      <button type="button" className="btn-secondary" style={{ gap: 6, fontSize: 12, padding: '5px 10px' }} disabled={busy} onClick={onKeep}>
        Keep auto-duplicate
      </button>
      {playbookLink}
    </div>
  );
}
