// Spec 052 FR-005: the launch in the artifact panel — what waits for the owner, the live checklist, progress after
// Start (graduation, subscribers, promos) and the plan in a dialog. The actions (Start, Go live…) are the artifact's own.
// Spec 078 D3: sections titled by an overline, the checklist as rows in a flush panel, the progress numbers as a StatStrip,
// the plan in a dialog of insets and rows (amg-* classes in agent-manager.css).

import { useState, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { StatStrip, StatTile, StatusDot } from '../ui/primitives';
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
      {headline && <div className="text-body-sm amg-muted">{headline}</div>}

      <section className="amg-section" aria-label="Checklist">
        <div className="amg-sechead">
          <h3 className="text-overline amg-h">Checklist</h3>
          <span className="text-micro amg-dim">What only you can do, and what runs by itself.</span>
        </div>
        <div className="panel is-flush">
          {v.checklist.map((s) => <StepRow key={s.key} s={s} />)}
        </div>
      </section>

      {started && <Progress v={v} />}

      {v.plan && (
        <section className="amg-section" aria-label="Plan">
          <div className="amg-sechead"><h3 className="text-overline amg-h">Plan</h3></div>
          <div className="inset amg-plan">
            <div className="text-body-sm amg-pre amg-wrap">{v.plan.summary}</div>
            <div className="amg-chips">
              {mixRows(v.plan.format_mix.formats).map((r) => <span key={r.format} className="chip mono">{r.format} {r.pct}%</span>)}
            </div>
            <div className="text-micro mono amg-dim amg-wrap">
              {scheduleLine(v.plan.schedule)} · {v.plan.first_week.ideas.length} first-week ideas · {v.plan.series_pillars.series.length} series
            </div>
            <button type="button" className="btn-secondary btn-sm amg-start" onClick={() => setPlanOpen(true)}>
              <Icon name="book" size={13} /> Open the plan
            </button>
          </div>
        </section>
      )}

      <div className="text-micro mono amg-dim amg-wrap">
        Created {fmtRelative(v.createdAt)}{v.startedAt ? ` · started ${fmtDate(v.startedAt)}` : ''} · analysis ${v.costUsd.toFixed(3)}
      </div>
      {planOpen && v.plan && <PlanDialog v={v} plan={v.plan} onClose={() => setPlanOpen(false)} />}
    </>
  );
}

function StepRow({ s }: { s: LaunchStep }) {
  return (
    <div className="panel-row amg-step">
      <span className="amg-step-dot"><StatusDot tone={stepTone(s.state)} /></span>
      <div className="amg-step-main">
        <div className="text-body-sm amg-wrap">{s.title}</div>
        {s.detail && <div className="text-micro amg-muted amg-wrap">{s.detail}</div>}
        {s.link && (
          <a href={s.link} className="link-accent text-micro amg-ref" {...(isExternal(s.link) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            {isExternal(s.link) ? 'Open in Telegram' : 'Open'} <Icon name="external" size={12} />
          </a>
        )}
      </div>
      <div className="amg-step-side">
        <Badge tone={stepTone(s.state)}>{stepLabel(s.state)}</Badge>
        <span className="text-micro amg-dim">{s.who === 'owner' ? 'you' : 'automatic'}</span>
      </div>
    </div>
  );
}

function Progress({ v }: { v: LaunchView }) {
  const g = v.growth;
  const criteria = v.graduation?.stats?.criteria ?? [];
  const promos = v.promo?.items ?? [];
  return (
    <section className="amg-section" aria-label="Since Start">
      <div className="amg-sechead"><h3 className="text-overline amg-h">Since Start</h3></div>
      {g && (
        <StatStrip label="Growth since Start">
          <StatTile label="Subscribers" value={g.subsNow ?? '—'} delta={subsDelta(g) || undefined} deltaTone={(g.subsNow ?? 0) >= (g.subsAtStart ?? 0) ? 'success' : 'danger'} />
          <StatTile label="Published" value={g.published} />
          <StatTile label="Promo joins" value={g.promoJoins} />
        </StatStrip>
      )}
      {v.status === 'running' && criteria.length > 0 && (
        <div className="inset amg-criteria">
          <span className="text-overline">Going live needs</span>
          {criteria.map((c) => (
            <div key={c.key} className={`text-body-sm amg-criterion${c.ok ? ' is-ok' : ''}`}>
              <span className="amg-icon"><Icon name={c.ok ? 'check' : 'clock'} size={14} /></span>
              {c.label}
            </div>
          ))}
        </div>
      )}
      {promos.length > 0 && (
        <div className="panel is-flush">
          {promos.map((p) => (
            <div key={p.sourceRef} className="panel-row amg-promo">
              <Badge tone={p.slotId ? 'success' : 'warning'}>{p.slotId ? 'scheduled' : 'refused'}</Badge>
              <span className="text-body-sm amg-wrap">Promo in {p.sourceRef.replace(/^telegram:/, '')}</span>
              <span className="text-micro mono amg-dim amg-wrap">{p.at ? fmtDate(p.at) : p.error}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** A titled block of the plan dialog: an overline, then its content. */
function PlanSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="amg-section" aria-label={title}>
      <div className="amg-sechead">
        <h3 className="text-overline amg-h">{title}</h3>
        {hint && <span className="text-micro amg-dim">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function PlanFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="amg-line">
      <span className="text-overline amg-key">{label}</span>
      <div className="text-body-sm amg-val is-ink">{children}</div>
    </div>
  );
}

function PlanDialog({ v, plan, onClose }: { v: LaunchView; plan: LaunchPlan; onClose: () => void }) {
  const p = plan.brief_profile.profile;
  const ideas = [...plan.first_week.ideas].sort((a, b) => a.day - b.day);
  return (
    <Modal open onClose={onClose} title={`Launch plan · ${v.channelKey}`} icon="rocket" size="lg">
      <div className="amg-stack is-roomy">
        <div className="text-body-sm amg-pre amg-wrap">{plan.summary}</div>
        <PlanSection title="Brief for the agent"><div className="text-body-sm amg-pre amg-wrap">{plan.brief_profile.brief}</div></PlanSection>
        <PlanSection title="Profile">
          <div className="inset amg-facts">
            {p.topic && <PlanFact label="Topic">{p.topic}</PlanFact>}
            {p.audience?.who && <PlanFact label="Audience">{p.audience.who}</PlanFact>}
            {p.tone && <PlanFact label="Tone">{p.tone}</PlanFact>}
            {p.language && <PlanFact label="Language">{p.language}</PlanFact>}
            {!!p.taboo?.length && <PlanFact label="Never">{p.taboo.join(', ')}</PlanFact>}
          </div>
        </PlanSection>
        <PlanSection title="Format mix and schedule">
          <div className="amg-chips">
            {mixRows(plan.format_mix.formats).map((r) => <span key={r.format} className="chip mono">{r.format} {r.pct}%</span>)}
          </div>
          <div className="text-body-sm amg-wrap">{scheduleLine(plan.schedule)}</div>
        </PlanSection>
        <PlanSection title="Pillars and series">
          <div className="amg-chips">
            {plan.series_pillars.pillars.map((x) => <span key={x.name} className="chip">{x.name} {x.share}%</span>)}
          </div>
          <div className="inset amg-rows">
            {plan.series_pillars.series.map((s) => (
              <div key={s.name} className="panel-row amg-planrow">
                <div className="amg-planrow-top">
                  <span className="text-body-sm amg-strong amg-wrap">{s.name}</span>
                  <span className="text-micro mono amg-dim">{s.cadence} · {s.format}</span>
                </div>
                <div className="text-micro amg-muted amg-wrap">{s.brief}</div>
              </div>
            ))}
          </div>
        </PlanSection>
        <PlanSection title="Voice">
          <div className="text-body-sm amg-wrap">{plan.voice.description}</div>
          <ul className="text-body-sm amg-list">{plan.voice.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        </PlanSection>
        <PlanSection title={`First week (${ideas.length} ideas)`} hint="They go into the idea pool as accepted at Start; the planner uses them first.">
          <div className="inset amg-rows">
            {ideas.map((i) => (
              <div key={i.title} className="panel-row amg-planrow">
                <div className="amg-planrow-top">
                  <span className="text-micro mono tabular-nums amg-dim">Day {i.day}</span>
                  <span className="text-body-sm amg-strong amg-wrap">{i.title}</span>
                  <span className="chip mono">{i.format}</span>
                  {i.intro && <Badge tone="accent">intro</Badge>}
                </div>
                <div className="text-micro amg-muted amg-wrap">{i.angle}</div>
              </div>
            ))}
          </div>
        </PlanSection>
        {(v.refs.length > 0 || plan.references.length > 0) && (
          <PlanSection title="References">
            <div className="inset amg-rows">
              {v.refs.map((r) => {
                const take = plan.references.find((x) => x.ref === r.ref)?.takeaway;
                return (
                  <div key={r.ref} className="panel-row amg-planrow">
                    <div className="amg-planrow-top">
                      <span className="text-body-sm amg-strong amg-wrap">{r.name}</span>
                      <Badge tone={r.status === 'skipped' ? 'warning' : 'neutral'}>{r.status}</Badge>
                    </div>
                    {(take || r.reason) && <div className="text-micro amg-muted amg-wrap">{take ?? r.reason}</div>}
                  </div>
                );
              })}
            </div>
          </PlanSection>
        )}
      </div>
    </Modal>
  );
}
