// describe-error.ts — turn an unknown thrown value into one well-formed,
// operator-readable line. Pulls the useful bits out of axios/Meta-Graph errors
// (the Graph `error` object carries message + code + subcode + type) so a log
// row says *what* Meta rejected, not just "Request failed with status code 400".
// Never emits tokens.

export function describeError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;

  const e = err as any;

  // Meta Graph / axios error body: { error: { message, code, error_subcode, type } }
  const graph = e?.response?.data?.error;
  if (graph && typeof graph === 'object') {
    const bits = [graph.message ?? 'Graph error'];
    const codes: string[] = [];
    if (graph.code != null) codes.push(`#${graph.code}`);
    if (graph.error_subcode != null) codes.push(`sub ${graph.error_subcode}`);
    if (graph.type) codes.push(String(graph.type));
    return codes.length ? `${bits[0]} (${codes.join(', ')})` : String(bits[0]);
  }

  // Plain HTTP failure with a status but no Graph body.
  const status = e?.response?.status;
  const base = e?.message ? String(e.message) : String(e);
  const name = e?.name && e.name !== 'Error' ? `${e.name}: ` : '';
  const code = e?.code ? ` [${e.code}]` : '';
  const httpStatus = status != null && !base.includes(String(status)) ? ` (HTTP ${status})` : '';
  return `${name}${base}${code}${httpStatus}`.slice(0, 1000);
}
