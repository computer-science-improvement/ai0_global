// Spec 034 FR-011: the news watch of a Telegram news resource — a code-only feed check on a cadence
// that adds a live slot for a fresh, unposted, on-topic item when the day has room. Owner-editable in
// the resource profile (`news_watch`); the defaults are every 2 h, 08:00–22:00, 3 added slots a day.
// Spec 078 D1.4: the look is agent-plan.css (classes apl-nw-*).

import { Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import type { NewsWatchSettings } from '../../api/agents';
import { hourRange, newsWatchForm, newsWatchWhen, pad2, type NewsWatchForm } from '../../lib/news-watch';

export { newsWatchBody, newsWatchError, newsWatchForm } from '../../lib/news-watch';

export function NewsWatchView({ w }: { w: NewsWatchSettings | null | undefined }) {
  const f = newsWatchForm(w);
  return (
    <span className="apl-nw-view">
      <Badge tone={f.mode === 'off' ? 'neutral' : f.mode === 'on' ? 'success' : 'accent'}>{f.mode === 'auto' ? 'auto (news resources)' : f.mode}</Badge>
      {f.mode !== 'off' && <span className="text-body-sm tabular-nums apl-nw-when">{newsWatchWhen(w)}</span>}
    </span>
  );
}

export function NewsWatchEditor({ f, onChange, error }: { f: NewsWatchForm; onChange: (f: NewsWatchForm) => void; error: string | null }) {
  const set = <K extends keyof NewsWatchForm>(k: K, v: NewsWatchForm[K]) => onChange({ ...f, [k]: v });
  return (
    <Field label="News watch" hint="RSS check, no AI · adds a slot for fresh news">
      <div className="apl-nw">
        <select className="input-field" aria-label="News watch" value={f.mode} onChange={(e) => set('mode', e.target.value as NewsWatchForm['mode'])}>
          <option value="auto">Auto — on for news resources</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        {f.mode !== 'off' && (
          <div className="apl-nw-line">
            <span className="text-micro apl-nw-word">every</span>
            <select className="input-field tabular-nums apl-nw-sel" aria-label="Check every (hours)" value={f.every} onChange={(e) => set('every', e.target.value)}>
              {hourRange(1, 12).map((h) => <option key={h} value={String(h)}>{h} h</option>)}
            </select>
            <span className="text-micro apl-nw-word">from</span>
            <select className="input-field tabular-nums apl-nw-sel" aria-label="Active from" value={f.from} onChange={(e) => set('from', e.target.value)}>
              {hourRange(0, 23).map((h) => <option key={h} value={String(h)}>{pad2(h)}:00</option>)}
            </select>
            <span className="text-micro apl-nw-word">to</span>
            <select className="input-field tabular-nums apl-nw-sel" aria-label="Active until" value={f.to} onChange={(e) => set('to', e.target.value)}>
              {hourRange(1, 24).map((h) => <option key={h} value={String(h)}>{pad2(h)}:00</option>)}
            </select>
            <span className="text-micro apl-nw-word">max</span>
            <select className="input-field tabular-nums apl-nw-sel" aria-label="Most added slots a day" value={f.max} onChange={(e) => set('max', e.target.value)}>
              {hourRange(0, 6).map((h) => <option key={h} value={String(h)}>{h} a day</option>)}
            </select>
          </div>
        )}
        {error && <div className="text-micro apl-nw-err" role="alert">{error}</div>}
      </div>
    </Field>
  );
}
