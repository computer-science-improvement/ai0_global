import { excerptOf, type AuditCard, type IntegrityCheck } from '../types';

/** Spec 037 T6: a bold lead is one hook sentence — over 140 chars is a warning, over 220 an error. */
export const LEAD_WARN_CHARS = 140;
export const LEAD_ERROR_CHARS = 220;

/** The resource style's `headline.max_chars` (T8) when it is a positive number; read defensively until T8 lands. */
function styleMax(card: AuditCard | undefined): number | null {
  const headline = card?.style?.headline as { max_chars?: unknown } | undefined;
  const v = headline && typeof headline === 'object' ? headline.max_chars : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/** Warning and error thresholds: the style's limit (or 140) warns; 220, or 1.5× a larger style limit, blocks. */
export function leadLimits(card: AuditCard | undefined): { warn: number; error: number } {
  const warn = styleMax(card) ?? LEAD_WARN_CHARS;
  return { warn, error: Math.max(LEAD_ERROR_CHARS, Math.round(warn * 1.5)) };
}

export const leadTooLongCheck: IntegrityCheck = {
  id: 'lead-too-long',
  codes: ['lead_too_long'],
  run: (post, ctx) => {
    const lead = post.lead?.trim();
    if (!lead) return [];
    const n = [...lead].length;
    const { warn, error } = leadLimits(ctx.card);
    if (n <= warn) return [];
    const level = n > error ? 'error' as const : 'warning' as const;
    return [{
      code: 'lead_too_long', level,
      message: `лід ${n} символів (${level === 'error' ? `максимум ${error}` : `краще до ${warn}`}) — лід це одне речення-гачок, решту перенеси в абзац`,
      excerpt: excerptOf(lead, 80),
    }];
  },
};
