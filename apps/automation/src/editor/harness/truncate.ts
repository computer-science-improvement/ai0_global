/**
 * Make a value safe to persist / feed back to the model: strings longer than
 * `maxChars` are cut with a marker, and the whole JSON form is capped so one
 * huge tool result can't blow up a JSONB row or the context window.
 */
export function truncateString(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars]`;
}

/**
 * Spec 053 FR-003: a tool result the model sees is at most this long. Every later step of the run re-sends it, so a
 * tool that needs more says so itself (`EditorTool.maxResultChars`, e.g. load_skill).
 */
export const TOOL_RESULT_MAX_CHARS = 8_000;

/**
 * The value to persist for a tool step: itself when its JSON fits `maxChars`, else the same JSON shrunk by rows (spec 064
 * FR-007: «[N more items omitted]» in the largest array, long strings cut), else a `{truncated, preview}` wrapper whose
 * own serialised length — escapes and wrapper included — stays within `maxChars`. The old cut counted the preview alone,
 * and the escaped quotes of a JSON string inside JSON pushed stored results to 9 KB.
 */
export function truncateJson(value: unknown, maxChars = TOOL_RESULT_MAX_CHARS): unknown {
  if (value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { unserializable: String(value).slice(0, 200) };
  }
  if (json === undefined) return null;
  if (json.length <= maxChars) return value;
  const fitted = fitJson(value, maxChars);
  if (fitted) return JSON.parse(fitted);
  // Last resort: the largest preview whose wrapped form fits (halving the overshoot, as escapes make it non-linear).
  let keep = Math.max(0, maxChars - 60);
  for (let i = 0; i < 12; i++) {
    const wrapped = { truncated: true, preview: truncateString(json, keep) };
    const over = JSON.stringify(wrapped).length - maxChars;
    if (over <= 0 || keep === 0) return wrapped;
    keep = Math.max(0, keep - Math.max(over, 1));
  }
  return { truncated: true, preview: truncateString(json, 0) };
}

/** A string longer than this is a candidate for cutting when a result must shrink. */
const MIN_CUT_STRING = 400;
const MAX_SHRINK_ROUNDS = 60;

type Holder = Record<string, unknown> | unknown[];
interface Biggest { holder: Holder; key: string | number; kind: 'array' | 'string'; size: number }

/** The largest array (≥ 2 items) or long string inside `node`, by its JSON size. */
function biggest(node: unknown, holder: Holder | null, key: string | number | null, best: Biggest | null): Biggest | null {
  if (typeof node === 'string') {
    if (holder && key !== null && node.length > MIN_CUT_STRING && (!best || node.length > best.size)) {
      return { holder, key, kind: 'string', size: node.length };
    }
    return best;
  }
  if (!node || typeof node !== 'object') return best;
  if (Array.isArray(node)) {
    const items = node.filter((x) => !isOmittedMarker(x));
    if (holder && key !== null && items.length >= 2) {
      const size = JSON.stringify(node).length;
      if (!best || size > best.size) best = { holder, key, kind: 'array', size };
    }
    node.forEach((x, i) => { best = biggest(x, node, i, best); });
    return best;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) best = biggest(v, node as Record<string, unknown>, k, best);
  return best;
}

const OMITTED_RE = /^\[(\d+) more items? omitted\]$/;
function isOmittedMarker(x: unknown): boolean {
  return typeof x === 'string' && OMITTED_RE.test(x);
}

/** Drop items from the end of an array (≥ 1 kept), noting how many went in a trailing marker string. */
function shrinkArray(arr: unknown[]): unknown[] {
  const prev = arr.length && isOmittedMarker(arr[arr.length - 1]) ? Number(OMITTED_RE.exec(arr[arr.length - 1] as string)![1]) : 0;
  const items = prev ? arr.slice(0, -1) : arr;
  const keep = Math.max(1, Math.floor(items.length * 0.6));
  const omitted = prev + items.length - keep;
  return [...items.slice(0, keep), `[${omitted} more item${omitted === 1 ? '' : 's'} omitted]`];
}

/**
 * Spec 053 FR-003: a result over `maxChars` shrinks by rows — the largest array loses items from its end (with an
 * «[N more items omitted]» marker), then the longest strings are cut — so the model still gets valid JSON. null when
 * it cannot get under the cap (the caller falls back to a plain cut).
 */
export function fitJson(value: unknown, maxChars: number): string | null {
  let copy: unknown;
  try { copy = JSON.parse(JSON.stringify(value)); } catch { return null; }
  if (!copy || typeof copy !== 'object') return null;
  const root: Holder = [copy];
  for (let round = 0; round < MAX_SHRINK_ROUNDS; round++) {
    const json = JSON.stringify(root[0]);
    if (json.length <= maxChars) return json;
    const b = biggest(root[0], root, 0, null);
    if (!b) return null;
    const cur = (b.holder as any)[b.key];
    if (b.kind === 'array') (b.holder as any)[b.key] = shrinkArray(cur as unknown[]);
    else {
      const s = cur as string;
      const over = json.length - maxChars;
      const keep = Math.max(MIN_CUT_STRING / 2, Math.min(Math.floor(s.length / 2), s.length - over - 40));
      (b.holder as any)[b.key] = `${s.slice(0, keep)}…[cut ${s.length - keep} chars]`;
    }
  }
  const json = JSON.stringify(root[0]);
  return json.length <= maxChars ? json : null;
}

/** `s` cut so that the result, marker included, is at most `maxChars` (spec 064 FR-007). */
function truncateWithin(s: string, maxChars: number): string {
  let keep = Math.max(0, maxChars - 30);
  let out = truncateString(s, keep);
  while (out.length > maxChars && keep > 0) { keep = Math.max(0, keep - (out.length - maxChars)); out = truncateString(s, keep); }
  return out;
}

/** Serialize for a tool message, capped (spec 053: by rows, so the JSON stays valid; a plain cut only as the last resort). */
export function toToolContent(value: unknown, maxChars = TOOL_RESULT_MAX_CHARS): string {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    json = JSON.stringify({ error: 'unserializable_result' });
  }
  if (json.length <= maxChars) return json;
  return fitJson(value, maxChars) ?? truncateWithin(json, maxChars);
}
