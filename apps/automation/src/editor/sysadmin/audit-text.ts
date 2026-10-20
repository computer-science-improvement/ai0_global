import { createHash } from 'crypto';
import type { AuditArea, FindingSubject } from './audit.types';

/** Words of a text, lower-cased, punctuation dropped (letters and digits of any script stay). */
export function tokens(text: string): string[] {
  return (text.toLowerCase().replace(/[ʼ’`']/g, '').match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokens(text));
}

/** Jaccard similarity of two token sets (1 = the same words, 0 = nothing shared). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The share of `a`'s words that `b` also has (containment) — "how much of a does b say again". */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / a.size;
}

export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** A stable key: the same problem about the same subject gets the same key every week. */
export function findingKey(area: AuditArea | string, check: string, s: Pick<FindingSubject, 'type' | 'id' | 'agent' | 'channel'>): string {
  const raw = [area, check, s.type, s.id, s.agent ?? '', s.channel ?? ''].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}
