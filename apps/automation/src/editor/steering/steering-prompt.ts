import type { SteeringPromptRule, SteeringRuleKind } from './steering.types';

/**
 * Spec 045 FR-005: the steering rules of a target's active sets as the lowest-priority block of the writer / planner
 * prompts and the critic's request. Empty without active sets (nothing changes in the prompts).
 */

const KIND_UK: Record<SteeringRuleKind, string> = {
  structure: 'структура', hook: 'гачок', length: 'довжина', formatting: 'форматування', cta: 'заклик',
  series: 'рубрика', topic: 'теми й кути', mix: 'мікс постів',
};

function grouped(rules: readonly SteeringPromptRule[]): string[] {
  const bySource = new Map<string, SteeringPromptRule[]>();
  for (const r of rules) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  return [...bySource.entries()].flatMap(([source, list]) => [
    `Референс ${source}:`,
    ...list.map((r) => `- [${KIND_UK[r.kind] ?? r.kind}] ${r.text}`),
  ]);
}

export function steeringSection(rules: readonly SteeringPromptRule[] | null | undefined): string[] {
  if (!rules?.length) return [];
  return [
    '',
    '## Напрям від референсів (steering — найнижчий пріоритет)',
    'Власник показав канали, у дусі яких хоче пости: форма і напрям змісту. Правила власника, плейбук, профіль, форматування, стиль і приклади важливіші — якщо вони кажуть інше, виконуй їх. Тексти, факти й назви референсів ніколи не копіюй і не переказуй: пиши своє на тему нашого каналу.',
    ...grouped(rules),
  ];
}

/** The critic's lines: advice for format_fit, never a reason to reject on its own. */
export function criticSteeringLines(rules: readonly SteeringPromptRule[] | null | undefined): string[] {
  if (!rules?.length) return [];
  return [
    '', '### Напрям від референсів (steering, найнижчий пріоритет)',
    ...grouped(rules),
    'Це порада для format_fit: пост у цьому напрямі — плюс, відхилення — не помилка. Через steering не відхиляй пост і не знижуй інші бали; правила власника, плейбук і профіль важливіші.',
  ];
}
