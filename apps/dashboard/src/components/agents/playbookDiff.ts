// Client-side summary of what changed between two playbook versions (spec 020
// FR-011 "history with diffs", the pending card). Grouped per resource, then
// series, pillars and rules. Each change is one short English line; content
// (format names, series names, rules) stays as written.

import type { Playbook, PlaybookPlatform } from '../../api/network';

export type ChangeKind = 'added' | 'removed' | 'changed';
export interface Change { kind: ChangeKind; text: string }
export interface DiffGroup { key: string; refId?: string; title: string; changes: Change[] }

const w = (n: number) => n.toFixed(2);
const range = (r: { min: number; max: number }) => `${r.min}–${r.max}/day`;
const hours = (h: number[]) => (h.length ? [...h].sort((a, b) => a - b).map((x) => String(x).padStart(2, '0')).join(', ') : 'none');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function platformChanges(a: PlaybookPlatform, b: PlaybookPlatform): Change[] {
  const out: Change[] = [];
  if (a.role !== b.role) out.push({ kind: 'changed', text: `role ${a.role} → ${b.role}` });
  const fa = a.formats ?? {}; const fb = b.formats ?? {};
  for (const f of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (!(f in fa)) out.push({ kind: 'added', text: `format ${f} (${w(fb[f])})` });
    else if (!(f in fb)) out.push({ kind: 'removed', text: `format ${f}` });
    else if (Math.abs(fa[f] - fb[f]) >= 0.005) out.push({ kind: 'changed', text: `${f} ${w(fa[f])} → ${w(fb[f])}` });
  }
  if (!same(a.per_day, b.per_day)) out.push({ kind: 'changed', text: `per day ${range(a.per_day)} → ${range(b.per_day)}` });
  if (!same([...(a.best_hours ?? [])].sort(), [...(b.best_hours ?? [])].sort())) out.push({ kind: 'changed', text: `best hours ${hours(a.best_hours ?? [])} → ${hours(b.best_hours ?? [])}` });
  if ((a.tone ?? '') !== (b.tone ?? '')) out.push({ kind: 'changed', text: 'tone rewritten' });
  if ((a.cta ?? '') !== (b.cta ?? '')) out.push({ kind: 'changed', text: b.cta ? (a.cta ? 'CTA changed' : 'CTA added') : 'CTA removed' });
  if ((a.link_policy ?? '') !== (b.link_policy ?? '')) out.push({ kind: 'changed', text: 'link policy changed' });
  const va = new Set(a.hashtag_policy?.vocab ?? []); const vb = new Set(b.hashtag_policy?.vocab ?? []);
  const plus = [...vb].filter((x) => !va.has(x)); const minus = [...va].filter((x) => !vb.has(x));
  if (plus.length) out.push({ kind: 'added', text: `hashtags ${plus.join(' ')}` });
  if (minus.length) out.push({ kind: 'removed', text: `hashtags ${minus.join(' ')}` });
  if (a.hashtag_policy && b.hashtag_policy && (a.hashtag_policy.min !== b.hashtag_policy.min || a.hashtag_policy.max !== b.hashtag_policy.max)) {
    out.push({ kind: 'changed', text: `hashtags per post ${a.hashtag_policy.min}–${a.hashtag_policy.max} → ${b.hashtag_policy.min}–${b.hashtag_policy.max}` });
  }
  return out;
}

/** What changed from `prev` to `next`. Empty when they are the same. */
export function diffPlaybooks(prev: Playbook | null | undefined, next: Playbook): DiffGroup[] {
  const groups: DiffGroup[] = [];
  const pa = new Map((prev?.platforms ?? []).map((p) => [p.resource_ref, p]));
  const pb = new Map(next.platforms.map((p) => [p.resource_ref, p]));
  for (const ref of new Set([...pa.keys(), ...pb.keys()])) {
    const a = pa.get(ref); const b = pb.get(ref);
    const changes: Change[] = !a ? [{ kind: 'added', text: `new section · ${b!.role} · ${Object.keys(b!.formats).join(', ')}` }]
      : !b ? [{ kind: 'removed', text: 'section dropped' }]
      : platformChanges(a, b);
    if (changes.length) groups.push({ key: `p:${ref}`, refId: ref, title: ref, changes });
  }

  const sa = new Map((prev?.series ?? []).map((s) => [s.name, s]));
  const sb = new Map((next.series ?? []).map((s) => [s.name, s]));
  const series: Change[] = [];
  for (const name of new Set([...sa.keys(), ...sb.keys()])) {
    const a = sa.get(name); const b = sb.get(name);
    if (!a) series.push({ kind: 'added', text: `«${name}» ${b!.cadence} · ${b!.format}` });
    else if (!b) series.push({ kind: 'removed', text: `«${name}»` });
    else {
      const bits: string[] = [];
      if (a.cadence !== b.cadence) bits.push(`${a.cadence} → ${b.cadence}`);
      if (a.format !== b.format) bits.push(`${a.format} → ${b.format}`);
      if (a.resource_ref !== b.resource_ref) bits.push('moved to another resource');
      if (a.active !== b.active) bits.push(b.active ? 'resumed' : 'paused');
      if (a.brief !== b.brief) bits.push('brief rewritten');
      if (bits.length) series.push({ kind: 'changed', text: `«${name}» ${bits.join(', ')}` });
    }
  }
  if (series.length) groups.push({ key: 'series', title: 'Series', changes: series });

  const qa = new Map((prev?.pillars ?? []).map((p) => [p.name, p.share]));
  const qb = new Map((next.pillars ?? []).map((p) => [p.name, p.share]));
  const pillars: Change[] = [];
  for (const name of new Set([...qa.keys(), ...qb.keys()])) {
    const a = qa.get(name); const b = qb.get(name);
    if (a == null) pillars.push({ kind: 'added', text: `${name} ${b}%` });
    else if (b == null) pillars.push({ kind: 'removed', text: name });
    else if (a !== b) pillars.push({ kind: 'changed', text: `${name} ${a}% → ${b}%` });
  }
  if (pillars.length) groups.push({ key: 'pillars', title: 'Topic pillars', changes: pillars });

  const ra = new Set(prev?.rules ?? []); const rb = new Set(next.rules ?? []);
  const rules: Change[] = [
    ...[...rb].filter((r) => !ra.has(r)).map((r) => ({ kind: 'added' as const, text: r })),
    ...[...ra].filter((r) => !rb.has(r)).map((r) => ({ kind: 'removed' as const, text: r })),
  ];
  if (rules.length) groups.push({ key: 'rules', title: 'Rules', changes: rules });
  return groups;
}
