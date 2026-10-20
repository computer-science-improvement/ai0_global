import type { LevelStats } from './map.types';

/**
 * Spec 056 FR-005: an agent's level measures how well it writes, never how much — volume-based XP would reward spam.
 * Score over the last 30 days = clean approvals + critic passes − 2 × rejections − failed runs;
 * level = clamp(1, 10, 1 + floor(score / 10)).
 */

export const MAX_LEVEL = 10;
export const LEVEL_WINDOW_DAYS = 30;

export interface LevelInput { clean: number; pass: number; rejected: number; failedRuns: number }

export const levelScore = (i: LevelInput): number => i.clean + i.pass - 2 * i.rejected - i.failedRuns;

export function levelOf(score: number): number {
  return Math.min(MAX_LEVEL, Math.max(1, 1 + Math.floor(score / 10)));
}

export function levelStats(i: LevelInput): LevelStats {
  return { ...i, score: levelScore(i) };
}

const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;

/** "12 clean approvals, 18 critic passes, 1 rejection in 30 days" — the one-line explanation shown in the unit drawer. */
export function levelLine(s: LevelInput): string {
  const parts = [n(s.clean, 'clean approval', 'clean approvals'), n(s.pass, 'critic pass', 'critic passes'), n(s.rejected, 'rejection', 'rejections')];
  if (s.failedRuns > 0) parts.push(n(s.failedRuns, 'failed run', 'failed runs'));
  return `${parts.join(', ')} in ${LEVEL_WINDOW_DAYS} days`;
}
