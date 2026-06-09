import type { IconName } from './Icon';
import { Icon } from './Icon';

export function Placeholder({ icon, title, note }: {
  icon: IconName; title: string; note: string;
}) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 56, color: 'var(--color-ink-muted)' }}>
      <div style={{ display: 'inline-flex', padding: 14, borderRadius: 'var(--radius-pill)', background: 'var(--color-surface-3)', marginBottom: 14 }}>
        <Icon name={icon} size={22} />
      </div>
      <h2 className="text-heading-md" style={{ margin: '0 0 6px', color: 'var(--color-ink)', fontWeight: 500 }}>{title}</h2>
      <p className="text-body-sm" style={{ margin: 0 }}>{note}</p>
      <div style={{ marginTop: 12 }}>
        <span className="chip" style={{ fontSize: 10 }}>Soon</span>
      </div>
    </div>
  );
}
