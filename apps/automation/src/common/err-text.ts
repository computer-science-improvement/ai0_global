/**
 * The reason an error should print in a log line or an owner message (spec 064
 * FR-002). `err.message ?? err` prints nothing for an empty message, and the
 * warnings it fed ended in «: » with no reason. Falls through message, code,
 * the cause's code, name, and finally the value itself.
 */
export function errText(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err.trim() || 'unknown error';
  const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown }; name?: unknown };
  const pick = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  return pick(e.message) || pick(e.code) || pick(e.cause?.code) || pick(e.cause?.message) || pick(e.name) || (String(err).trim() || 'unknown error');
}
