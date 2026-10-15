// Spec 037 FR-014 (T14): the post audit as the dashboard shows it — the findings
// of the deterministic checks over a resource's published posts (Network health →
// "Notes and sample posts") and over a waiting post (the approval card). Mirrors
// ResourceAuditView / ApprovalFinding (apps/automation/src/editor/audit/). The
// server sends the English rule title, explanation and fix with every code; the
// check's own message is in the agents' language and is not shown.
// Pure helpers, no React and no runtime imports (the node:test suite loads this).

export type FindingLevel = 'error' | 'warning';
export type FindingSection = 'stories' | 'facts' | 'dates' | 'lint';

export interface AuditIssueItem {
  postKind:    'slot' | 'platform';
  postId:      string;
  slotId:      string | null;
  publishedAt: string;
  url:         string | null;
  postExcerpt: string;
  format:      string | null;
  level:       FindingLevel;
  message:     string;
  excerpt:     string | null;
  extra:       Record<string, unknown> | null;
}

export interface AuditCodeGroup {
  code:    string;
  title:   string;
  explain: string;
  fix:     string;
  group:   string | null;
  section: FindingSection;
  level:   FindingLevel;
  count:   number;
  posts:   number;
  items:   AuditIssueItem[];
}

export interface ResourceAuditView {
  resource:  string;
  days:      number;
  auditedAt: string | null;
  rulesHash: string | null;
  current:   boolean;
  posts:     number;
  findings:  number;
  error:     string | null;
  groups:    AuditCodeGroup[];
}

/** The digest's audit block (counts only). */
export interface AuditSummary {
  audited_at: string | null;
  posts:      number;
  findings:   number;
  groups:     Record<string, number>;
  codes:      Array<{ code: string; level: FindingLevel; n: number; means?: string }>;
}

/** A finding on a waiting post (approval card). */
export interface ApprovalFinding {
  code:    string;
  level:   FindingLevel;
  message: string;
  excerpt: string | null;
  title:   string;
  explain: string;
  fix:     string;
  section: FindingSection;
  group:   string | null;
  extra:   Record<string, unknown> | null;
}

export const SECTION_LABEL: Record<FindingSection, string> = {
  stories: 'Story matches',
  facts:   'Numbers and sources',
  dates:   'Date checks',
  lint:    'Lint warnings',
};
export const SECTION_ORDER: FindingSection[] = ['stories', 'facts', 'dates', 'lint'];

export interface FindingLink { label: string; url: string }

const URL_RE = /^https?:\/\/\S+$/i;
const ID_KEY = /(?:^|_)(?:id|ids)$|Ids?$/;

/**
 * The links and ids a check attached to a finding (story matches, earlier posts, …), whatever the field names:
 * every http(s) URL in `extra` (nested one level: arrays of objects) becomes a link, labelled by a sibling
 * title / text / label / date when there is one; values of `*_id(s)` / `*Id(s)` keys become ids.
 */
export function findingLinks(extra: Record<string, unknown> | null | undefined): { links: FindingLink[]; ids: string[] } {
  const links: FindingLink[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const addLink = (url: string, label?: unknown) => {
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ url, label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : shortUrl(url) });
  };
  const addId = (v: unknown) => {
    for (const x of Array.isArray(v) ? v : [v]) {
      if ((typeof x === 'string' || typeof x === 'number') && String(x).trim() && !ids.includes(String(x))) ids.push(String(x));
    }
  };
  const visit = (o: Record<string, unknown>, depth: number) => {
    const label = o.title ?? o.text ?? o.label ?? o.date ?? o.at;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && URL_RE.test(v)) addLink(v, label);
      else if (ID_KEY.test(k)) addId(v);
      else if (depth < 2 && Array.isArray(v)) {
        for (const x of v) {
          if (typeof x === 'string' && URL_RE.test(x)) addLink(x);
          else if (x && typeof x === 'object') visit(x as Record<string, unknown>, depth + 1);
        }
      } else if (depth < 2 && v && typeof v === 'object') visit(v as Record<string, unknown>, depth + 1);
    }
  };
  if (extra) visit(extra, 0);
  return { links, ids };
}

/** `https://www.example.com/a/b?c` → `example.com/a/b`, at most 48 chars. */
export function shortUrl(url: string): string {
  const s = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '');
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

/** Findings of a waiting post by card section, sections in order, empty ones left out. */
export function findingsBySection(findings: ReadonlyArray<ApprovalFinding> | null | undefined): Array<{ section: FindingSection; label: string; items: ApprovalFinding[] }> {
  const list = findings ?? [];
  return SECTION_ORDER
    .map((section) => ({ section, label: SECTION_LABEL[section], items: list.filter((f) => f.section === section) }))
    .filter((s) => s.items.length > 0);
}

/** "3 findings on 2 posts" for a code group. */
export function groupCountLabel(g: Pick<AuditCodeGroup, 'count' | 'posts'>): string {
  return `${g.count} finding${g.count === 1 ? '' : 's'}${g.posts !== g.count ? ` on ${g.posts} post${g.posts === 1 ? '' : 's'}` : ''}`;
}

/** Has the audit view anything to list? */
export const auditHasFindings = (v: ResourceAuditView | null | undefined): v is ResourceAuditView => !!v && v.groups.length > 0;

export const FEED_SUGGESTION_LABEL: Record<'replace' | 'limit', string> = {
  replace: 'Replace this feed',
  limit:   'Use this feed less',
};
