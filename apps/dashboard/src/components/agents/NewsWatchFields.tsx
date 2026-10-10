// Spec 034 FR-011: the news watch of a Telegram news resource — a code-only feed check on a cadence
// that adds a live slot for a fresh, unposted, on-topic item when the day has room. Owner-editable in
// the resource profile (`news_watch`); the defaults are every 2 h, 08:00–22:00, 3 added slots a day.

import { Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import type { NewsWatchSettings } from '../../api/agents';
import { hourRange, newsWatchForm, newsWatchWhen, pad2, type NewsWatchForm } from '../../lib/news-watch';

export { newsWatchBody, newsWatchError, newsWatchForm } from '../../lib/news-watch';

export function NewsWatchView({ w }: { w: NewsWatchSettings | null | undefined }) {
  const f = newsWatchForm(w);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <Badge tone={f.mode === 'off' ? 'neutral' : f.mode === 'on' ? 'success' : 'accent'}>{f.mode === 'auto' ? 'auto (news resources)' : f.mode}</Badge>
      {f.mode !== 'off' && <span className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>{newsWatchWhen(w)}</span>}
    </span>
  );
}

export function NewsWatchEditor({ f, onChange, error }: { f: NewsWatchForm; onChange: (f: NewsWatchForm) => void; error: string | null }) {
  const set = <K extends keyof NewsWatchForm>(k: K, v: NewsWatchForm[K]) => onChange({ ...f, [k]: v });
  const sel = { flex: 1, minWidth: 0 } as const;
  const dim = { color: 'var(--color-ink-dim)' } as const;
  return (
    <Field label="News watch" hint="RSS check, no AI · adds a slot for fresh news">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <select className="input-field" aria-label="News watch" value={f.mode} onChange={(e) => set('mode', e.target.value as NewsWatchForm['mode'])}>
          <option value="auto">Auto — on for news resources</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        {f.mode !== 'off' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="text-micro" style={dim}>every</span>
            <select className="input-field tabular-nums" aria-label="Check every (hours)" value={f.every} onChange={(e) => set('every', e.target.value)} style={sel}>
              {hourRange(1, 12).map((h) => <option key={h} value={String(h)}>{h} h</option>)}
            </select>
            <span className="text-micro" style={dim}>from</span>
            <select className="input-field tabular-nums" aria-label="Active from" value={f.from} onChange={(e) => set('from', e.target.value)} style={sel}>
              {hourRange(0, 23).map((h) => <option key={h} value={String(h)}>{pad2(h)}:00</option>)}
            </select>
            <span className="text-micro" style={dim}>to</span>
            <select className="input-field tabular-nums" aria-label="Active until" value={f.to} onChange={(e) => set('to', e.target.value)} style={sel}>
              {hourRange(1, 24).map((h) => <option key={h} value={String(h)}>{pad2(h)}:00</option>)}
            </select>
            <span className="text-micro" style={dim}>max</span>
            <select className="input-field tabular-nums" aria-label="Most added slots a day" value={f.max} onChange={(e) => set('max', e.target.value)} style={sel}>
              {hourRange(0, 6).map((h) => <option key={h} value={String(h)}>{h} a day</option>)}
            </select>
          </div>
        )}
        {error && <div className="text-micro" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
      </div>
    </Field>
  );
}
