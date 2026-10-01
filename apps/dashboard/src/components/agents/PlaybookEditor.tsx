// Owner editor of the active playbook (spec 020): per resource — role, format
// weights, posts per day, best hours, tone, hashtags, link policy, CTA; series
// on/off; the rules list. Saving PUTs the whole document; it becomes active at
// once (owner precedence). Server validation (`playbook_invalid` details /
// `invalid_body` issues) is listed inline; the modal stays open.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { Modal } from '../Modal';
import { Toggle } from './AgentsUi';
import { errorBody } from '../../api/agents';
import { usePutPlaybook, type NetworkResource, type Playbook, type PlaybookPlatform, type PlaybookRow } from '../../api/network';
import { ResourceChip, ResourceLabel, errorText, fmtCadence } from './NetworkUi';

const input: CSSProperties = { width: '100%', boxSizing: 'border-box' };
const small: CSSProperties = { padding: '6px 10px', fontSize: 13 };
const eyebrow: CSSProperties = { color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10, marginBottom: 6, display: 'block' };
const ROLES = ['core', 'discovery', 'community', 'archive'];

const clone = (p: Playbook): Playbook => JSON.parse(JSON.stringify(p));

/** Client checks that the form can't express otherwise; the server has the full validation. */
function localErrors(s: PlaybookPlatform): string[] {
  const e: string[] = [];
  if (s.per_day.min > s.per_day.max) e.push('per day: min is above max');
  if (!Object.values(s.formats).some((w) => w > 0)) e.push('at least one format needs a weight above 0');
  if (s.hashtag_policy.min > s.hashtag_policy.max) e.push('hashtags: min is above max');
  return e;
}

export function PlaybookEditor({ handle, row, resources, onClose }: {
  handle: string; row: PlaybookRow; resources: NetworkResource[]; onClose: () => void;
}) {
  const put = usePutPlaybook(handle);
  const [d, setD] = useState<Playbook>(() => {
    const c = clone(row.body);
    for (const s of c.platforms) {
      s.best_hours ??= [];
      s.hashtag_policy ??= { vocab: [], min: 0, max: 5 };
    }
    c.series ??= []; c.pillars ??= []; c.rules ??= [];
    return c;
  });
  const [rationale, setRationale] = useState('');
  const dirty = JSON.stringify(d) !== JSON.stringify(row.body) || rationale.trim() !== '';

  const setPlatform = (i: number, fn: (s: PlaybookPlatform) => void) =>
    setD((cur) => { const n = clone(cur); fn(n.platforms[i]); return n; });

  const local = d.platforms.map(localErrors);
  const hasLocal = local.some((x) => x.length > 0) || d.rules.some((r) => r.trim().length > 0 && r.trim().length < 3);

  const body = errorBody(put.error);
  const serverLines: string[] = body?.error === 'playbook_invalid' && Array.isArray(body.details)
    ? (body.details as unknown[]).map(String)
    : body?.error === 'invalid_body' && body.issues
      ? body.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      : [];

  // Bring the server's verdict into view (the modal is long); lines naming a
  // resource are also repeated under that resource's section.
  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (put.error) errRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [put.error]);

  const save = async () => {
    const out = clone(d);
    out.rules = out.rules.map((r) => r.trim()).filter(Boolean);
    for (const s of out.platforms) {
      for (const k of ['tone', 'link_policy', 'cta'] as const) {
        const v = s[k]?.trim();
        if (v) s[k] = v; else delete s[k];
      }
    }
    try {
      const r = await put.mutateAsync({ body: out, ...(rationale.trim() ? { rationale: rationale.trim() } : {}) });
      toast.success(`Saved — v${r.playbook.version} is active`);
      onClose();
    } catch { /* listed inline */ }
  };

  const otherRefs = (ref: string) => resources.map((r) => r.ref).filter((r) => r !== ref);

  return (
    <Modal open onClose={onClose} size="xl" icon="pencil" title={`Edit playbook v${row.version}`}
      subtitle="Your version becomes active as soon as you save; a pending agent draft is superseded.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {d.platforms.map((s, i) => (
          <PlatformForm key={s.resource_ref} s={s} errors={[...local[i], ...serverLines.filter((l) => l.includes(s.resource_ref))]} funnelTargets={otherRefs(s.resource_ref)}
            onChange={(fn) => setPlatform(i, fn)} />
        ))}

        {d.series.length > 0 && (
          <div className="card" style={{ padding: '12px 14px' }}>
            <span className="text-micro" style={eyebrow}>Series</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {d.series.map((s, i) => (
                <div key={s.name} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Toggle checked={s.active} label={s.active ? 'on' : 'off'} title={s.active ? 'Pause the series' : 'Resume the series'}
                    onChange={(v) => setD((cur) => { const n = clone(cur); n.series[i].active = v; return n; })} />
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500, flex: '1 1 160px', minWidth: 0 }}>{s.name}</span>
                  <span className="chip tabular-nums">{fmtCadence(s.cadence)}</span>
                  <ResourceChip refId={s.resource_ref} suffix={s.format} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card" style={{ padding: '12px 14px' }}>
          <span className="text-micro" style={eyebrow}>Rules</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {d.rules.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)', width: 18, textAlign: 'right', flexShrink: 0 }}>{i + 1}.</span>
                <input className="input-field" style={{ ...input, ...small }} value={r} maxLength={300} aria-label={`Rule ${i + 1}`}
                  onChange={(e) => setD((cur) => { const n = clone(cur); n.rules[i] = e.target.value; return n; })} />
                <button type="button" className="btn-act btn-act-danger" title="Remove rule" aria-label={`Remove rule ${i + 1}`}
                  onClick={() => setD((cur) => { const n = clone(cur); n.rules.splice(i, 1); return n; })}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <div>
              <button type="button" className="btn-tiny" disabled={d.rules.length >= 30}
                onClick={() => setD((cur) => ({ ...cur, rules: [...cur.rules, ''] }))}>
                <Icon name="plus" size={12} />&nbsp;Add rule
              </button>
            </div>
          </div>
        </div>

        <div>
          <label className="text-eyebrow" htmlFor="pb-rationale" style={{ display: 'block', marginBottom: 6 }}>Why this change <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>optional · shown in history</span></label>
          <input id="pb-rationale" className="input-field" style={input} value={rationale} maxLength={2000} placeholder="owner edit"
            onChange={(e) => setRationale(e.target.value)} />
        </div>
      </div>

      {put.error && (
        <div ref={errRef} className="callout-danger" style={{ marginTop: 14, flexDirection: 'column', alignItems: 'stretch', gap: 6 }} role="alert">
          <strong>{serverLines.length ? 'The playbook was not saved:' : errorText(put.error)}</strong>
          {serverLines.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {serverLines.map((l, i) => <li key={i} className="text-micro" style={{ overflowWrap: 'anywhere' }}>{l}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="modal-foot" style={{ flexWrap: 'wrap' }}>
        {dirty && <Badge tone="warning" style={{ marginRight: 'auto', alignSelf: 'center' }}>unsaved</Badge>}
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!dirty || hasLocal || put.isPending} onClick={save}
          title={hasLocal ? 'Fix the highlighted fields first' : undefined}>
          {put.isPending ? 'Saving…' : 'Save & activate'}
        </button>
      </div>
    </Modal>
  );
}

function Sub({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <span className="text-micro" style={eyebrow}>{label}{hint && <span style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>{hint}</span>}</span>
      {children}
    </div>
  );
}

function NumberBox({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <input type="number" className="input-field tabular-nums" aria-label={label} style={{ ...small, width: 64 }} min={min} max={max} value={value}
      onChange={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); }} />
  );
}

function PlatformForm({ s, errors, funnelTargets, onChange }: {
  s: PlaybookPlatform; errors: string[]; funnelTargets: string[]; onChange: (fn: (s: PlaybookPlatform) => void) => void;
}) {
  const [newFormat, setNewFormat] = useState('');
  const [tag, setTag] = useState('');
  const listId = `roles-${s.resource_ref.replace(/[^a-z0-9]/gi, '')}`;
  const addFormat = () => {
    const f = newFormat.trim().toLowerCase();
    if (f.length < 2 || f in s.formats) return;
    onChange((x) => { x.formats[f] = 0.2; });
    setNewFormat('');
  };
  const addTag = () => {
    const t = tag.trim();
    if (!t || s.hashtag_policy.vocab.includes(t) || s.hashtag_policy.vocab.length >= 40) return;
    onChange((x) => { x.hashtag_policy.vocab.push(t); });
    setTag('');
  };
  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 14 };

  return (
    <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14, boxShadow: errors.length ? 'inset 0 0 0 1px var(--color-danger)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 200px', minWidth: 0, display: 'flex' }}><ResourceLabel refId={s.resource_ref} strong /></span>
        <label className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-ink-dim)' }}>
          role
          <input className="input-field" list={listId} style={{ ...small, width: 200, maxWidth: '100%' }} value={s.role} maxLength={120}
            onChange={(e) => onChange((x) => { x.role = e.target.value; })} />
          <datalist id={listId}>
            {ROLES.map((r) => <option key={r} value={r} />)}
            {funnelTargets.map((r) => <option key={r} value={`funnel_to:${r}`} />)}
          </datalist>
        </label>
      </div>

      <div style={grid}>
        <Sub label="Format weights" hint="0 – 1">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(s.formats).map(([f, w]) => (
              <div key={f} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 90px) minmax(0, 1fr) 60px 30px', gap: 8, alignItems: 'center' }}>
                <span className="text-micro" style={{ color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f}>{f}</span>
                <input type="range" min={0} max={1} step={0.05} value={w} aria-label={`${f} weight`} style={{ accentColor: 'var(--color-accent)', minWidth: 0 }}
                  onChange={(e) => onChange((x) => { x.formats[f] = Number(e.target.value); })} />
                <input type="number" className="input-field tabular-nums" min={0} max={1} step={0.05} value={w} aria-label={`${f} weight value`} style={{ ...small, width: 60, padding: '5px 6px' }}
                  onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange((x) => { x.formats[f] = Math.max(0, Math.min(1, n)); }); }} />
                <button type="button" className="btn-act" title={`Remove ${f}`} aria-label={`Remove format ${f}`} style={{ width: 28, height: 28 }}
                  onClick={() => onChange((x) => { delete x.formats[f]; })}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input-field" style={{ ...small, flex: 1, minWidth: 0 }} placeholder="add format (e.g. carousel)" value={newFormat} maxLength={30}
                onChange={(e) => setNewFormat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFormat(); } }} />
              <button type="button" className="btn-tiny" disabled={newFormat.trim().length < 2} onClick={addFormat}><Icon name="plus" size={12} /></button>
            </div>
          </div>
        </Sub>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <Sub label="Posts per day">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <NumberBox label="min per day" value={s.per_day.min} min={0} max={24} onChange={(n) => onChange((x) => { x.per_day.min = n; })} />
              <span style={{ color: 'var(--color-ink-dim)' }}>–</span>
              <NumberBox label="max per day" value={s.per_day.max} min={0} max={24} onChange={(n) => onChange((x) => { x.per_day.max = n; })} />
            </div>
          </Sub>
          <Sub label="Best hours" hint={`${s.best_hours.length} / 12`}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))', gap: 4 }}>
              {Array.from({ length: 24 }, (_, h) => {
                const on = s.best_hours.includes(h);
                return (
                  <button key={h} type="button" aria-pressed={on} className={`chip tabular-nums${on ? ' is-active' : ''}`}
                    disabled={!on && s.best_hours.length >= 12}
                    style={{ justifyContent: 'center', border: 0, cursor: 'pointer', fontSize: 11, padding: '3px 0' }}
                    onClick={() => onChange((x) => { x.best_hours = on ? x.best_hours.filter((y) => y !== h) : [...x.best_hours, h].sort((a, b) => a - b); })}>
                    {String(h).padStart(2, '0')}
                  </button>
                );
              })}
            </div>
          </Sub>
        </div>
      </div>

      <div style={grid}>
        <Sub label="Hashtags">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {s.hashtag_policy.vocab.map((t) => (
              <span key={t} className="chip" style={{ gap: 4, paddingRight: 4 }}>
                {t}
                <button type="button" aria-label={`Remove ${t}`} title="Remove"
                  onClick={() => onChange((x) => { x.hashtag_policy.vocab = x.hashtag_policy.vocab.filter((y) => y !== t); })}
                  style={{ background: 'none', border: 0, color: 'var(--color-ink-dim)', cursor: 'pointer', display: 'inline-flex', padding: 2 }}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input-field" style={{ ...small, flex: '1 1 120px', minWidth: 0 }} placeholder="#космос" value={tag} maxLength={40}
              onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
            <button type="button" className="btn-tiny" disabled={!tag.trim()} onClick={addTag}><Icon name="plus" size={12} /></button>
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              per post
              <NumberBox label="min hashtags" value={s.hashtag_policy.min} min={0} max={30} onChange={(n) => onChange((x) => { x.hashtag_policy.min = n; })} />
              –
              <NumberBox label="max hashtags" value={s.hashtag_policy.max} min={0} max={30} onChange={(n) => onChange((x) => { x.hashtag_policy.max = n; })} />
            </span>
          </div>
        </Sub>
        <Sub label="Tone">
          <textarea className="input-field" style={{ ...input, ...small, minHeight: 64, resize: 'vertical', fontFamily: 'inherit' }} maxLength={300} value={s.tone ?? ''}
            onChange={(e) => onChange((x) => { x.tone = e.target.value; })} />
        </Sub>
      </div>

      <div style={grid}>
        <Sub label="Link policy">
          <input className="input-field" style={{ ...input, ...small }} maxLength={200} value={s.link_policy ?? ''} placeholder="—"
            onChange={(e) => onChange((x) => { x.link_policy = e.target.value; })} />
        </Sub>
        <Sub label="CTA">
          <input className="input-field" style={{ ...input, ...small }} maxLength={200} value={s.cta ?? ''} placeholder="—"
            onChange={(e) => onChange((x) => { x.cta = e.target.value; })} />
        </Sub>
      </div>

      {errors.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc' }}>
          {errors.map((e) => <li key={e} className="text-micro" style={{ color: 'var(--color-danger)' }}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}
