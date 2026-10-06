import { Link } from '@tanstack/react-router';

/** One breadcrumb: an ancestor page (the current page is the PageHeader title). */
export interface Crumb {
  label:   string;
  to:      string;
  search?: Record<string, unknown>;
  params?: Record<string, string>;
}

/**
 * Spec 027 FR-013: the trail above a page title. Desktop shows the whole trail
 * (`Editor / @channel`); at ≤860px only `‹ Parent` shows (CSS, no JS).
 */
export function Crumbs({ crumbs, style }: { crumbs: Crumb[]; style?: React.CSSProperties }) {
  if (crumbs.length === 0) return null;
  const parent = crumbs[crumbs.length - 1];
  return (
    <nav aria-label="Breadcrumb" className="crumbs" style={style}>
      <ol className="crumbs-full">
        {crumbs.map((c, i) => (
          <li key={`${c.to}:${i}`}>
            <Link to={c.to as any} search={c.search as any} params={c.params as any} className="crumb-link">{c.label}</Link>
            <span aria-hidden className="crumb-sep">/</span>
          </li>
        ))}
      </ol>
      <Link to={parent.to as any} search={parent.search as any} params={parent.params as any} className="crumb-link crumbs-back">
        ‹ {parent.label}
      </Link>
    </nav>
  );
}
