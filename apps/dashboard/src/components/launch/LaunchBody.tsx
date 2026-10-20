// Spec 052 FR-005: the launch in the artifact panel — what waits for the owner, the live checklist, progress after
// Start (graduation, subscribers, promos) and the plan in a dialog. The actions (Start, Go live…) are the artifact's own.

import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Field, StatTile, StatusDot } from '../ui/primitives';
import { Modal } from '../Modal';
import type { ArtifactDetail } from '../../api/artifacts';
import { fmtDate, fmtRelative } from '../../lib/format';
import {
  isExternal, launchHeadline, mixRows, scheduleLine, stepLabel, stepTone, subsDelta, type LaunchPlan, type LaunchStep, type LaunchView,
} from '../../lib/launch';

export function LaunchBody({ d }: { d: ArtifactDetail }) {
  const v = d.body as LaunchView | null;
  const [planOpen, setPlanOpen] = useState(false);
  if (!v) return null;
  const headline = launchHeadline(v);
  const started = v.status === 'running' || v.status === 'graduated';
  return (
    <>
      {v.status === 'failed' && v.reason && <div className="callout-danger"><Icon name="warning" size={16} /><div>{v.reason}</div></div>}
      {v.status === 'ready' && v.reason && <div className="callout-warning"><Icon name="warning" size={16} /><div>{v.reason}</div></div>}
      {headline && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{headline}</div>}

      <Field label="Checklist" hint="What only you can do, and what runs by itself.">
        <div style={{ display: 'grid', gap: 6 }}>
          {v.checklist.map((s) => <StepRow key={s.key} s={s} />)}
        </div>
      </Field>

      {started && <Progress v={v} />}

      {v.plan && (
        <Field label="Plan">
          <div className="panel" style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
            <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{v.plan.summary}</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {mixRows(v.plan.format_mix.formats).map((r) => <span key={r.format} className="chip">{r.format} {r.pct}%</span>)}
            </div>
            <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
              {scheduleLine(v.plan.schedule)} · {v.plan.first_week.ideas.length} first-week ideas · {v.plan.series_pillars.series.length} series
            </div>
            <button type="button" className="btn-secondary" onClick={() => setPlanOpen(true)}
              style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="book" size={13} /> Open the plan
            </button>
          </div>
        </Field>
      )}

      <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
        Created {fmtRelative(v.createdAt)}{v.startedAt ? ` · started ${fmtDate(v.startedAt)}` : ''} · analysis ${v.costUsd.toFixed(3)}
      </div>
      {planOpen && v.plan && <PlanDialog v={v} plan={v.plan} onClose={() => setPlanOpen(false)} />}
    </>
  );
}

function StepRow({ s }: { s: LaunchStep }) {
  return (
    <div className="panel" style={{ padding: '8px 10px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ paddingTop: 6 }}><StatusDot tone={stepTone(s.state)} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="text-body-sm" style={{ overflowWrap: 'anywhere' }}>{s.title}</div>
        {s.detail && <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>{s.detail}</div>}
        {s.link && (
          <a href={s.link} className="link-accent text-micro" {...(isExternal(s.link) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
            {isExternal(s.link) ? 'Open in Telegram' : 'Open'} <Icon name="external" size={11} />
          </a>
        )}
      </div>
      <div style={{ display: 'grid', justifyItems: 'end', gap: 4, flexShrink: 0 }}>
        <Badge tone={stepTone(s.state)}>{stepLabel(s.state)}</Badge>
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{s.who === 'owner' ? 'you' : 'automatic'}</span>
      </div>
    </div>
  );
}

function Progress({ v }: { v: LaunchView }) {
  const g = v.growth;
  const criteria = v.graduation?.stats?.criteria ?? [];
  const promos = v.promo?.items ?? [];
  return (
    <Field label="Since Start">
      <div style={{ display: 'grid', gap: 10 }}>
        {g && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
            <StatTile label="Subscribers" value={g.subsNow ?? '—'} delta={subsDelta(g) || undefined} deltaTone={(g.subsNow ?? 0) >= (g.subsAtStart ?? 0) ? 'success' : 'danger'} icon="users" />
            <StatTile label="Published" value={g.published} icon="megaphone" />
            <StatTile label="Promo joins" value={g.promoJoins} icon="link" />
          </div>
        )}
        {v.status === 'running' && criteria.length > 0 && (
          <div className="panel" style={{ padding: '8px 10px', display: 'grid', gap: 4 }}>
            <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Going live needs</div>
            {criteria.map((c) => (
              <div key={c.key} className="text-body-sm" style={{ display: 'flex', gap: 6, alignItems: 'center', color: c.ok ? 'var(--color-ink)' : 'var(--color-ink-muted)' }}>
                <span style={{ color: c.ok ? 'var(--color-success)' : 'var(--color-ink-dim)', display: 'inline-flex' }}><Icon name={c.ok ? 'check' : 'clock'} size={13} /></span>
                {c.label}
              </div>
            ))}
          </div>
        )}
        {promos.length > 0 && (
          <div style={{ display: 'grid', gap: 4 }}>
            {promos.map((p) => (
              <div key={p.sourceRef} className="text-body-sm" style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Badge tone={p.slotId ? 'success' : 'warning'}>{p.slotId ? 'scheduled' : 'refused'}</Badge>
                <span>Promo in {p.sourceRef.replace(/^telegram:/, '')}</span>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{p.at ? fmtDate(p.at) : p.error}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

function PlanDialog({ v, plan, onClose }: { v: LaunchView; plan: LaunchPlan; onClose: () => void }) {
  const p = plan.brief_profile.profile;
  const ideas = [...plan.first_week.ideas].sort((a, b) => a.day - b.day);
  return (
    <Modal open onClose={onClose} title={`Launch plan · ${v.channelKey}`} icon="rocket" size="lg">
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{plan.summary}</div>
        <Field label="Brief for the agent"><div className="text-body-sm" style={{ whiteSpace: 'pre-wrap' }}>{plan.brief_profile.brief}</div></Field>
        <Field label="Profile">
          <div className="text-body-sm" style={{ display: 'grid', gap: 2 }}>
            {p.topic && <div>Topic: {p.topic}</div>}
            {p.audience?.who && <div>Audience: {p.audience.who}</div>}
            {p.tone && <div>Tone: {p.tone}</div>}
            {p.language && <div>Language: {p.language}</div>}
            {!!p.taboo?.length && <div>Never: {p.taboo.join(', ')}</div>}
          </div>
        </Field>
        <Field label="Format mix and schedule">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {mixRows(plan.format_mix.formats).map((r) => <span key={r.format} className="chip">{r.format} {r.pct}%</span>)}
          </div>
          <div className="text-body-sm">{scheduleLine(plan.schedule)}</div>
        </Field>
        <Field label="Pillars and series">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {plan.series_pillars.pillars.map((x) => <span key={x.name} className="chip">{x.name} {x.share}%</span>)}
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {plan.series_pillars.series.map((s) => (
              <div key={s.name} className="text-body-sm"><b>{s.name}</b> <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{s.cadence} · {s.format}</span><div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{s.brief}</div></div>
            ))}
          </div>
        </Field>
        <Field label="Voice">
          <div className="text-body-sm" style={{ marginBottom: 4 }}>{plan.voice.description}</div>
          <ul className="text-body-sm" style={{ margin: 0, paddingLeft: 18, listStyle: 'disc' }}>{plan.voice.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        </Field>
        <Field label={`First week (${ideas.length} ideas)`} hint="They go into the idea pool as accepted at Start; the planner uses them first.">
          <div style={{ display: 'grid', gap: 6 }}>
            {ideas.map((i) => (
              <div key={i.title} className="panel" style={{ padding: '8px 10px' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>Day {i.day}</span>
                  <span className="text-body-sm" style={{ fontWeight: 600 }}>{i.title}</span>
                  <span className="chip">{i.format}</span>
                  {i.intro && <Badge tone="accent">intro</Badge>}
                </div>
                <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{i.angle}</div>
              </div>
            ))}
          </div>
        </Field>
        {(v.refs.length > 0 || plan.references.length > 0) && (
          <Field label="References">
            <div style={{ display: 'grid', gap: 4 }}>
              {v.refs.map((r) => {
                const take = plan.references.find((x) => x.ref === r.ref)?.takeaway;
                return (
                  <div key={r.ref} className="text-body-sm">
                    <b>{r.name}</b> <Badge tone={r.status === 'skipped' ? 'warning' : 'neutral'}>{r.status}</Badge>
                    {(take || r.reason) && <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{take ?? r.reason}</div>}
                  </div>
                );
              })}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
