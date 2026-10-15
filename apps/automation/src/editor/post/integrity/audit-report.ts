import { runIntegrityChecks, timelineContexts } from './registry';
import type { AuditCard, AuditPost, Finding } from './types';

/**
 * Spec 037 FR-001: the markdown report of `audit:tg-export`. Each post is checked with its channel's earlier posts
 * as `previous` and the other channels as `network` (one network group), then the findings are listed per channel
 * (local date in the post's zone, post id, code, level, excerpt) with counts per code. Pure.
 */

export interface AuditRow { post: AuditPost; findings: Finding[] }

/** Runs every registered check over a timeline of posts (any channels, any order). */
export function auditPosts(posts: readonly AuditPost[], cardOf: (post: AuditPost) => AuditCard | undefined = () => undefined): AuditRow[] {
  return timelineContexts(posts, (p) => ({ card: cardOf(p) })).map(({ post, ctx }) => ({ post, findings: runIntegrityChecks(post, ctx) }));
}

/** `2026-10-08T14:13:57+02:00` in Europe/Kyiv → `08.10 15:13` (local wall time of the resource). */
export function localStamp(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')} ${get('hour')}:${get('minute')}`;
}

const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function counts(findings: Finding[]): Array<[string, { error: number; warning: number }]> {
  const m = new Map<string, { error: number; warning: number }>();
  for (const f of findings) {
    const c = m.get(f.code) ?? { error: 0, warning: 0 };
    c[f.level] += 1;
    m.set(f.code, c);
  }
  return [...m.entries()].sort((a, b) => (b[1].error + b[1].warning) - (a[1].error + a[1].warning) || a[0].localeCompare(b[0]));
}

export function renderAuditMarkdown(rows: readonly AuditRow[], opts: { title?: string; codes?: readonly string[] } = {}): string {
  const out: string[] = [`# ${opts.title ?? 'Content integrity audit'}`, ''];
  if (opts.codes) out.push(`Checks: ${opts.codes.length} codes (${[...opts.codes].sort().join(', ')}).`, '');
  const channels = [...new Set(rows.map((r) => r.post.channel))];
  const all = rows.flatMap((r) => r.findings);
  for (const ch of channels) {
    const mine = rows.filter((r) => r.post.channel === ch);
    const found = mine.flatMap((r) => r.findings);
    const flagged = mine.filter((r) => r.findings.length).length;
    out.push(`## ${ch}`, '', `${mine.length} posts, ${flagged} with findings: ${found.filter((f) => f.level === 'error').length} errors, ${found.filter((f) => f.level === 'warning').length} warnings.`, '');
    if (!found.length) { out.push('No findings.', ''); continue; }
    out.push('| Date | Post | Code | Level | Excerpt |', '|---|---|---|---|---|');
    for (const r of mine) {
      for (const f of r.findings) {
        out.push(`| ${localStamp(r.post.publishedAt, r.post.timezone)} | ${cell(r.post.id)} | ${f.code} | ${f.level} | ${cell(f.excerpt ?? f.message).slice(0, 140)} |`);
      }
    }
    out.push('');
  }
  out.push('## Summary', '', `${rows.length} posts in ${channels.length} channel(s), ${rows.filter((r) => r.findings.length).length} with findings.`, '');
  if (all.length) {
    out.push('| Code | Errors | Warnings |', '|---|---|---|');
    for (const [code, c] of counts(all)) out.push(`| ${code} | ${c.error} | ${c.warning} |`);
    out.push('');
  }
  return out.join('\n');
}
