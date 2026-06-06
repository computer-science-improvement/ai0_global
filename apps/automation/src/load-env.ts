// Loaded FIRST (before AppModule / ConfigModule) so the repo-root .env is the
// source of truth — it overrides stale/empty shell exports. Real-world case:
// local tooling (e.g. Anthropic CLIs) exports an EMPTY `ANTHROPIC_API_KEY` into
// the shell; @nestjs/config (dotenv) won't override an already-present env var,
// and ConfigService reads process.env first, so the empty value would shadow
// the .env one. We re-apply the file values with override here.
//
// Server-safe: in the prod/dev containers vars are injected via docker
// `env_file` and there is NO .env at this path, so the read throws and this is
// a no-op (the injected env stays authoritative).
//
// Minimal parser (no extra dependency): KEY=VALUE lines, '#'-comment/blank
// lines skipped, surrounding quotes stripped, first '=' splits (values may
// contain '=', e.g. base64 session strings). No multiline/inline-comment
// handling — matches this repo's flat .env format.
import { readFileSync } from 'fs';
import { resolve } from 'path';

try {
  const text = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (key) process.env[key] = val;
  }
} catch {
  /* no .env at this path (containers use docker env_file) — keep injected env */
}
