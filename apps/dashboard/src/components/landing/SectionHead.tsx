// Spec 078 B5.2: the head every landing section opens with — a mono eyebrow, a big two-tone title and a lead.
import type { JSX, ReactNode } from 'react';

export function SectionHead({ eyebrow, tone, id, title, lead, className }: {
  eyebrow: string;
  /** The eyebrow is green; "Human in the loop" is amber, the colour of the human. */
  tone?: 'warning';
  /** Id of the h2, for aria-labelledby. */
  id?: string;
  title: ReactNode;
  lead?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={className ? `lp-head ${className}` : 'lp-head'}>
      <div className={`text-overline lp-eyebrow${tone === 'warning' ? ' is-warning' : ''}`}>{eyebrow}</div>
      <h2 id={id} className="lp-h2">{title}</h2>
      {lead && <p className="lp-lead">{lead}</p>}
    </div>
  );
}

/** The muted second line of a section title. */
export function Muted({ children }: { children: ReactNode }): JSX.Element {
  return <span className="lp-muted">{children}</span>;
}
