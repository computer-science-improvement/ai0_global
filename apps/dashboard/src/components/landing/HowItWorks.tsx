// Spec 026 FR-008: "How it works", rebuilt around the agents. Row 1 is who runs the
// network (MANAGER → orchestrator → planner → executor → reviewer); row 2 is how an
// advertiser orders a post, with the AI disclosure under the first step. The copy is
// truthful about the human in the loop: the owner approves structural changes and,
// during the launch period, every post; DM replies are drafted by an AI assistant
// and checked by the owner before they are sent.
import type { JSX } from 'react';
import { motion } from 'motion/react';
import { Icon, type IconName } from '../ui/Icon';

interface Step { icon: IconName; title: string; body: string; badge?: string }

function agentSteps(managerLive: boolean): Step[] {
  return [
    managerLive
      ? { icon: 'radar', title: 'MANAGER', body: 'Reads the network’s KPI digest and turns it into directives or advice for the agents below.' }
      : { icon: 'radar', title: 'MANAGER', body: 'Will read the network’s KPI digest and turn it into directives or advice for the agents below.', badge: 'Soon' },
    { icon: 'agents', title: 'Orchestrator', body: 'Owns one network or channel: keeps its playbook and a pool of ideas worth writing.' },
    { icon: 'calendar', title: 'Planner', body: 'Plans the day for each resource and platform: what goes out, and when.' },
    { icon: 'pencil', title: 'Executor', body: 'Writes and publishes through code guards: dedup, rate limits, quiet hours, budget and a kill switch.' },
    { icon: 'analytics', title: 'Reviewer', body: 'Measures how every post performed and feeds the lessons back into planning.' },
  ];
}

const AD_STEPS: Step[] = [
  { icon: 'telegram', title: 'Message the AI ad manager', body: 'Write to our ad account in Telegram. The first message is prefilled for you, so just send it.' },
  { icon: 'calendar', title: 'Get prices and a slot', body: 'You get the current price list and agree on a format and a time slot.' },
  { icon: 'spend', title: 'Pay via LiqPay', body: 'Pay online through LiqPay once the slot and the creative are agreed.' },
  { icon: 'megaphone', title: 'Your post goes live', body: 'Published labelled #реклама (the legal ad label), with a stats report at 24 h and 72 h.' },
];

const stagger = {
  initial: 'hidden', whileInView: 'show', viewport: { once: true, margin: '-80px' },
  variants: { hidden: {}, show: { transition: { staggerChildren: 0.08 } } },
} as const;
const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.2, 0.7, 0.2, 1] as const } },
};

function StepCard({ s, i, children }: { s: Step; i: number; children?: JSX.Element }): JSX.Element {
  return (
    <motion.li className="hw-step" variants={item}>
      <span className="hw-index" aria-hidden>0{i + 1}</span>
      <span className="hw-icon" aria-hidden><Icon name={s.icon} size={17} /></span>
      <span className="hw-title">
        {s.title}
        {s.badge && <span className="hw-badge">{s.badge}</span>}
      </span>
      <span className="text-body-sm hw-body">{s.body}</span>
      {children}
    </motion.li>
  );
}

export function HowItWorks({ managerLive, adDmUrl }: { managerLive: boolean; adDmUrl: string | null }): JSX.Element {
  return (
    <div className="hw">
      <h3 className="hw-row-title">Who runs the network</h3>
      <motion.ol className="hw-steps hw-steps-5" {...stagger}>
        {agentSteps(managerLive).map((s, i) => <StepCard key={s.title} s={s} i={i} />)}
      </motion.ol>
      <p className="hw-foot">
        <Icon name="lock" size={13} />
        Structural decisions are approved by the owner. During the launch period the owner also approves each post before it goes out.
      </p>

      <h3 className="hw-row-title" id="order-an-ad">How to order an ad</h3>
      <motion.ol className="hw-steps hw-steps-4" {...stagger}>
        {AD_STEPS.map((s, i) => (
          <StepCard key={s.title} s={s} i={i}>
            {i === 0 ? (
              <span className="hw-disclosure">
                <Icon name="info" size={13} />
                <span>Replies are drafted by an AI assistant on the owner’s behalf, and the owner checks them before they are sent. A human is available on request.</span>
              </span>
            ) : undefined}
          </StepCard>
        ))}
      </motion.ol>
      <div className="hw-cta">
        {adDmUrl
          ? <a href={adDmUrl} target="_blank" rel="noopener" className="lp-hero-cta-primary">Order an ad in Telegram <Icon name="telegram" size={15} /></a>
          : <a href="#advertise" className="lp-hero-cta-secondary">See prices and formats ↓</a>}
      </div>

      <style>{`
        .hw { display: flex; flex-direction: column; }
        .hw-row-title {
          margin: 0 0 var(--space-lg); font-size: 15px; font-weight: 600; letter-spacing: -0.2px;
          color: var(--color-ink-muted);
        }
        .hw-row-title + .hw-steps { margin-top: 0; }
        .hw-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-lg); }
        .hw-steps-5 { grid-template-columns: repeat(5, 1fr); }
        .hw-steps-4 { grid-template-columns: repeat(4, 1fr); }
        @media (max-width: 1080px) { .hw-steps-5 { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 980px) { .hw-steps-4 { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 720px) { .hw-steps-5 { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .hw-steps-5, .hw-steps-4 { grid-template-columns: 1fr; } }
        .hw-step {
          position: relative;
          display: flex; flex-direction: column; gap: var(--space-sm);
          padding: var(--space-xl);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline-soft);
          border-radius: var(--radius-lg);
          min-width: 0;
        }
        .hw-index {
          position: absolute; top: var(--space-lg); right: var(--space-lg);
          font-size: 12px; font-weight: 600; letter-spacing: 0.4px;
          color: var(--color-ink-muted); font-variant-numeric: tabular-nums;
        }
        .hw-icon {
          display: inline-flex; align-items: center; justify-content: center;
          width: 38px; height: 38px; border-radius: var(--radius-md);
          background: var(--color-surface-2); border: 1px solid var(--color-hairline);
          color: var(--color-accent); margin-bottom: var(--space-xs);
        }
        .hw-title { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--color-ink); font-weight: 600; font-size: 15px; }
        .hw-badge {
          padding: 1px 8px; border-radius: var(--radius-pill);
          background: var(--color-warning-soft); color: var(--color-warning);
          font-size: 11px; font-weight: 600;
        }
        .hw-body { color: var(--color-ink-muted); }
        .hw-foot {
          display: flex; align-items: flex-start; gap: 8px;
          margin: var(--space-lg) 0 var(--space-section);
          font-size: 13px; line-height: 1.5; color: var(--color-ink-muted);
        }
        .hw-foot svg, .hw-disclosure svg { flex-shrink: 0; margin-top: 3px; color: var(--color-accent); }
        .hw-disclosure {
          display: flex; gap: 6px; margin-top: var(--space-xs);
          padding: 8px 10px; border-radius: var(--radius-md);
          background: var(--color-surface-2); border: 1px solid var(--color-hairline-soft);
          font-size: 12px; line-height: 1.5; color: var(--color-ink-muted);
        }
        .hw-cta { display: flex; justify-content: center; margin-top: var(--space-xxl); }
        @media (max-width: 600px) { .hw-step { padding: var(--space-lg); } }
      `}</style>
    </div>
  );
}
