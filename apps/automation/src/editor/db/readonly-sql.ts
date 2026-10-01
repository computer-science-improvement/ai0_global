/**
 * Static gate for agent-written SQL. This is the FIRST line of defence; the
 * query additionally runs in a READ ONLY transaction under the `editor_ro`
 * role (no grants on secret tables) with a statement timeout — so a bypass of
 * this classifier still can't write or read secrets.
 */

export const MAX_SQL_LENGTH = 4_000;

const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'upsert', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke',
  'copy', 'set', 'reset', 'lock', 'vacuum', 'analyze', 'cluster', 'reindex', 'call', 'do', 'execute', 'prepare',
  'deallocate', 'listen', 'notify', 'unlisten', 'comment', 'security', 'refresh', 'import', 'load', 'discard',
  'begin', 'commit', 'rollback', 'savepoint', 'release', 'into',
];
const FORBIDDEN_FUNCS = /\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_get|dblink\w*|set_config|current_setting|pg_terminate_backend|pg_cancel_backend|query_to_xml|xpath)\s*\(/i;

export type SqlVerdict = { ok: true; sql: string } | { ok: false; reason: string };

/** Remove comments and string literal contents so keyword scanning can't be fooled by text inside quotes. */
function stripForScan(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function classifySql(input: string): SqlVerdict {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty query' };
  if (raw.length > MAX_SQL_LENGTH) return { ok: false, reason: `query longer than ${MAX_SQL_LENGTH} chars` };
  if (raw.includes('$$') || /\$[a-z_]*\$/i.test(raw)) return { ok: false, reason: 'dollar-quoted strings are not allowed' };

  // Allow trailing semicolons only; strip them for wrapping.
  const sql = raw.replace(/;\s*$/g, '').replace(/;\s*$/g, '').trim();
  const scan = stripForScan(sql);
  if (scan.includes(';')) return { ok: false, reason: 'only a single statement is allowed' };

  const first = scan.trim().match(/^\(*\s*([a-z]+)/i)?.[1]?.toLowerCase();
  if (first !== 'select' && first !== 'with') return { ok: false, reason: 'only SELECT / WITH queries are allowed' };

  const words = new Set((scan.toLowerCase().match(/[a-z_]+/g) ?? []));
  const hit = FORBIDDEN.find((w) => words.has(w));
  if (hit) return { ok: false, reason: `keyword "${hit.toUpperCase()}" is not allowed` };
  if (FORBIDDEN_FUNCS.test(scan)) return { ok: false, reason: 'function not allowed' };

  return { ok: true, sql };
}

export function wrapWithLimit(sql: string, limit: number): string {
  return `SELECT * FROM (${sql}) AS _q LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`;
}
