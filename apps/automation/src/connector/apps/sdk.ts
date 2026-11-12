import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Spec 104: the ext-apps client (`App`, `PostMessageTransport`) inlined into the view, so the view loads no script
 * from anywhere (Claude's guidance for production MCP Apps: bundle the client inline). The SDK ships a self-contained
 * ESM bundle (`@modelcontextprotocol/ext-apps/app-with-deps`, pinned in package.json); its one trailing
 * `export{a as B,...}` becomes a local `McpApps` object the view's script reads.
 */

/** The name the view's script reads the SDK's exports from. */
export const SDK_GLOBAL = 'McpApps';

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const EXPORT_RE = /export\s*\{([^{}]*)\}\s*;?\s*$/;

/** The bundle as a plain script body with `const McpApps = {...}` instead of its export; throws on anything unexpected. */
export function inlineSdk(src: string): string {
  const m = EXPORT_RE.exec(src);
  if (!m) throw new Error('ext-apps bundle: no trailing export');
  const body = src.slice(0, m.index);
  // Inside <script>, these would end the script early or switch the HTML parser into its escaped states.
  if (/<\/script/i.test(body) || body.includes('<!--')) throw new Error('ext-apps bundle: cannot be inlined into <script>');
  // An inline script has no URL: import statements or import.meta would fail at load.
  if (/^\s*import[\s{*'"]/m.test(body) || body.includes('import.meta')) throw new Error('ext-apps bundle: not self-contained');
  const pairs = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
    const parts = spec.split(/\s+as\s+/);
    const local = parts[0];
    const exported = parts[1] ?? parts[0];
    if (parts.length > 2 || !IDENT_RE.test(local) || !IDENT_RE.test(exported)) throw new Error(`ext-apps bundle: odd export ${spec.slice(0, 40)}`);
    return `${exported}:${local}`;
  });
  if (!pairs.some((p) => p.startsWith('App:'))) throw new Error('ext-apps bundle: no App export');
  return `${body}\nconst ${SDK_GLOBAL}={${pairs.join(',')}};\n`;
}

let cached: string | null = null;

/** The pinned SDK bundle, inlined (read once per process). */
export function loadAppSdk(): string {
  if (cached === null) {
    const file = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
    cached = inlineSdk(readFileSync(file, 'utf8'));
  }
  return cached;
}

/** The pinned SDK version (from its package.json, which the package does not export: found next to the bundle). */
export function appSdkVersion(): string | null {
  try {
    const file = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
    const pkg = JSON.parse(readFileSync(join(file, '..', '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}
