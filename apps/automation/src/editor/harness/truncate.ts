/**
 * Make a value safe to persist / feed back to the model: strings longer than
 * `maxChars` are cut with a marker, and the whole JSON form is capped so one
 * huge tool result can't blow up a JSONB row or the context window.
 */
export function truncateString(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars]`;
}

export function truncateJson(value: unknown, maxChars = 8_192): unknown {
  if (value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { unserializable: String(value).slice(0, 200) };
  }
  if (json === undefined) return null;
  if (json.length <= maxChars) return value;
  return { truncated: true, preview: truncateString(json, maxChars) };
}

/** Serialize for a tool message, capped. */
export function toToolContent(value: unknown, maxChars = 16_384): string {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    json = JSON.stringify({ error: 'unserializable_result' });
  }
  return truncateString(json, maxChars);
}
