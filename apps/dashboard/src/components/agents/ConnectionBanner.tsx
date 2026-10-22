import { Link } from '@tanstack/react-router';
import { useDismissHealth, useResourceProfile, type HealthState } from '../../api/agents';
import { Icon } from '../ui/Icon';
import { fmtDate } from '../../lib/format';

const BLOCKING: HealthState[] = ['no_access', 'token_invalid'];
const SHOWN: HealthState[] = ['no_access', 'token_invalid', 'token_expiring', 'rate_limited'];
const STATE_LABEL: Record<HealthState, string> = {
  ok: 'ok', unknown: 'unknown', no_access: 'no access', token_invalid: 'token invalid', token_expiring: 'token expiring', rate_limited: 'rate limited',
};
const DAY = 86_400_000;

/** Where the owner fixes the connection of a resource ref (`threads:<id>` → that Meta account). */
export function fixLink(ref: string): { to: string; params?: Record<string, string>; search?: Record<string, string> } {
  const [platform, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  if (platform === 'instagram' || platform === 'facebook' || platform === 'threads') return { to: '/app/connections/meta/$accountId', params: { accountId: id } };
  if (platform === 'tiktok') return { to: '/app/connections', search: { section: 'tiktok' } };
  return { to: '/app/connections', search: { section: 'telegram' } };
}

/**
 * Spec 049 FR-002: the agent's resource cannot publish (or soon will not) — since when, why, where to fix it, and
 * a way to mute the daily reminders. Nothing when the connection is fine.
 */
export function ConnectionBanner({ handle }: { handle: string }) {
  const q = useResourceProfile(handle);
  const dismiss = useDismissHealth(handle);
  const h = q.data?.health;
  const ref = q.data?.ref;
  if (!h || !ref || !SHOWN.includes(h.state)) return null;

  const blocking = BLOCKING.includes(h.state);
  const days = h.since ? Math.floor((Date.now() - Date.parse(h.since)) / DAY) : null;
  const since = h.since ? ` since ${fmtDate(h.since)}${days ? ` (${days} d)` : ''}` : '';
  const fix = fixLink(ref);
  return (
    <div className={blocking ? 'callout-danger' : 'callout-warning'} role="alert" style={{ marginBottom: 14, alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
      <Icon name="warning" size={16} />
      <span style={{ flex: '1 1 260px', minWidth: 0 }}>
        <strong>{blocking ? 'Connection broken' : `Connection: ${STATE_LABEL[h.state]}`}{since}</strong>
        {' · '}<code>{ref}</code>
        {h.detail && <span style={{ display: 'block', marginTop: 2 }}>{h.detail}</span>}
        <span style={{ display: 'block', marginTop: 2, opacity: 0.85 }}>
          {blocking ? 'No posts are planned here and planned slots are skipped until it is fixed.'
            : h.state === 'token_expiring' ? 'Reconnect before it expires, or posts here stop.' : 'Publishing may be delayed.'}
          {h.dismissedAt && ' Daily reminders are muted.'}
        </span>
      </span>
      <Link to={fix.to as any} params={fix.params as any} search={fix.search as any} className="btn-tiny" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name="connections" size={13} /> Fix the connection
      </Link>
      {!h.dismissedAt && (
        <button type="button" className="btn-tiny" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}
          title="No more daily Telegram reminders for 7 days, or until the state changes">
          Mute reminders
        </button>
      )}
    </div>
  );
}
