import { clip, containment, findingKey, jaccard, tokenSet } from '../audit-text';
import { AUDIT_LIMITS, type AuditFacts, type Finding, type MemoryFact } from '../audit.types';

/** Spec 055 FR-001, memory (`editor_channel_memory`, active rows): rows no prompt shows, duplicates, stale insights. */

const DAY_MS = 86_400_000;

/** Owner rows first, then newest — the order `listActive` fills the prompt in. */
const promptOrder = (a: MemoryFact, b: MemoryFact) =>
  Number(b.createdBy === 'owner') - Number(a.createdBy === 'owner') || b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;

const byChannel = (rows: MemoryFact[]): Map<string, MemoryFact[]> => {
  const m = new Map<string, MemoryFact[]>();
  for (const r of rows) m.set(r.channel, [...(m.get(r.channel) ?? []), r]);
  return m;
};

const subjectOf = (r: MemoryFact) => ({ type: 'memory' as const, id: `${r.channel}#${r.id}`, label: clip(r.text, 80), channel: r.channel });

/** More active rows than the prompt shows (30; the writer sees 15). Owner preferences learnt on approval have their own section. */
export function memoryOverflowFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  for (const [channel, all] of byChannel(f.memory)) {
    const rows = all.filter((r) => r.source !== 'approval');
    const n = rows.length;
    if (n <= AUDIT_LIMITS.memoryWriterCap) continue;
    const hiddenAll = Math.max(0, n - AUDIT_LIMITS.memoryPromptCap);
    const hiddenWriter = n - AUDIT_LIMITS.memoryWriterCap;
    const subject = { type: 'channel' as const, id: channel, label: channel, channel };
    out.push({
      key: findingKey('memory', 'memory_overflow', subject), area: 'memory', check: 'memory_overflow',
      severity: hiddenAll > 0 ? 'warn' : 'info', subject,
      title: hiddenAll > 0 ? `${channel}: ${hiddenAll} memory rows never reach any prompt` : `${channel}: ${hiddenWriter} memory rows are not shown to the writer`,
      detail: `${n} active rows. Prompts load the newest ${AUDIT_LIMITS.memoryPromptCap} (owner rows first) and the writer shows ${AUDIT_LIMITS.memoryWriterCap}, so ${hiddenAll} rows are never read and ${hiddenWriter} are not seen by the writer. Retire the outdated ones.`,
      evidence: { active: n, hiddenFromPrompt: hiddenAll, hiddenFromWriter: hiddenWriter, owner: rows.filter((r) => r.createdBy === 'owner').length },
    });
  }
  return out;
}

/** Near-identical rows of one channel. The row that repeats an earlier-ranked one is the duplicate; an owner row is never retired. */
export function memoryDuplicateFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  for (const [channel, all] of byChannel(f.memory)) {
    const rows = all.filter((r) => r.source !== 'approval').sort(promptOrder);
    const kept: Array<{ row: MemoryFact; set: Set<string> }> = [];
    for (const r of rows) {
      const set = tokenSet(r.text);
      const twin = kept.find((k) => jaccard(k.set, set) >= AUDIT_LIMITS.memoryDuplicateSim);
      if (!twin) { kept.push({ row: r, set }); continue; }
      const sim = jaccard(twin.set, set);
      const subject = subjectOf(r);
      out.push({
        key: findingKey('memory', 'memory_duplicate', subject), area: 'memory', check: 'memory_duplicate', severity: 'info', subject,
        title: r.createdBy === 'owner' ? `${channel}: two of your rules say the same` : `${channel}: a memory row repeats another`,
        detail: `«${clip(r.text, 160)}» is ${Math.round(sim * 100)}% the same as row #${twin.row.id}${twin.row.createdBy === 'owner' ? ' (your rule)' : ''}: «${clip(twin.row.text, 160)}».${r.createdBy === 'owner' ? ' Your own rows are never retired by a fix.' : ''}`,
        evidence: { similarity: Math.round(sim * 100) / 100, duplicateOf: twin.row.id, createdBy: r.createdBy },
        ...(r.createdBy === 'owner' ? {} : { fix: { kind: 'memory_retire' as const, channel, id: r.id } }),
      });
    }
  }
  return out;
}

/** Reviewer insights older than 90 days that no later row of the channel confirms. */
export function memoryStaleFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  const cutoff = f.now.getTime() - AUDIT_LIMITS.staleInsightDays * DAY_MS;
  for (const [channel, rows] of byChannel(f.memory)) {
    const sets = new Map(rows.map((r) => [r.id, tokenSet(r.text)] as const));
    for (const r of rows) {
      if (r.kind !== 'insight' || r.createdBy !== 'reviewer' || r.source === 'approval' || r.createdAt.getTime() > cutoff) continue;
      const mine = sets.get(r.id)!;
      const confirmed = rows.some((o) => o.id !== r.id && o.createdAt.getTime() > r.createdAt.getTime() && containment(mine, sets.get(o.id)!) >= AUDIT_LIMITS.confirmSim);
      if (confirmed) continue;
      const subject = subjectOf(r);
      const age = Math.floor((f.now.getTime() - r.createdAt.getTime()) / DAY_MS);
      out.push({
        key: findingKey('memory', 'memory_stale', subject), area: 'memory', check: 'memory_stale', severity: 'info', subject,
        title: `${channel}: an old insight nothing confirmed`,
        detail: `«${clip(r.text, 200)}» was learnt ${age} days ago and no later row repeats it. It may be outdated.`,
        evidence: { ageDays: age },
        fix: { kind: 'memory_retire', channel, id: r.id },
      });
    }
  }
  return out;
}

export const MEMORY_CHECKS = [memoryOverflowFindings, memoryDuplicateFindings, memoryStaleFindings];
