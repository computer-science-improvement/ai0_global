// carousel-text.ts — pure helpers for the recipe carousel renderer (no I/O).

/** pg NUMERIC arrives as a string; parse to a finite number or null. */
export function parseNum(s: string | null): number | null {
  if (s == null || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Split an ingredients blob into clean lines (newlines, bullets, semicolons). */
export function splitIngredients(s: string): string[] {
  return (s ?? '')
    .split(/[\n;•]+/)
    .map(x => x.replace(/^[\s\-–—*]+/, '').trim())
    .filter(Boolean);
}

/** Split an instructions blob into steps, stripping any leading "1." numbering. */
export function splitSteps(s: string): string[] {
  return (s ?? '')
    .split(/\n+|(?=\b\d{1,2}[.)]\s)/)
    .map(x => x.replace(/^\s*\d{1,2}[.)]\s*/, '').trim())
    .filter(Boolean);
}

/** Build a data URL from image bytes, sniffing PNG vs JPEG (default JPEG). */
export function imageDataUrl(buf: Buffer): string {
  const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const mime = isPng ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}
