import type { MemoryEntry } from '../repo/editor-memory.repository';

/**
 * Spec 040 FR-011: the channel's owner rules as their own prompt block for the writers (executor) and the critic.
 * On 10-16 the rules sat in the memory list next to the reviewer's insights while the playbook said the opposite, so
 * the posts followed the playbook. Approval preferences (edits / rejects learnt on approval) are not rules: they have
 * their own section.
 */
export interface OwnerRuleLine { id: number; text: string }

/** Rules the owner wrote (not the preferences learnt on approval). */
export function ownerRulesOf(memory: readonly MemoryEntry[]): OwnerRuleLine[] {
  return memory
    .filter((m) => m.createdBy === 'owner' && (m.evidence as { source?: string } | null)?.source !== 'approval')
    .map((m) => ({ id: m.id, text: m.text }));
}

/** The memory without the owner rules (they get `ownerRulesSection`). */
export function memoryWithoutRules(memory: readonly MemoryEntry[]): MemoryEntry[] {
  const ids = new Set(ownerRulesOf(memory).map((r) => r.id));
  return memory.filter((m) => !ids.has(m.id));
}

/** The writer's block: every owner rule by id, above the playbook / profile / examples it overrides. */
export function ownerRulesSection(rules: readonly OwnerRuleLine[]): string[] {
  if (!rules.length) return [];
  return [
    '',
    '## Правила власника (обовʼязкові)',
    'Важливіші за плейбук, профіль, format_prefs і приклади: якщо вони кажуть інше — виконуй правило. Критик перевіряє кожне правило.',
    ...rules.map((r) => `- #${r.id} ${r.text.trim().replace(/\n+/g, '\n  ')}`),
  ];
}
