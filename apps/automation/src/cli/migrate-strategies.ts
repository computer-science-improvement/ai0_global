/**
 * Strategy bindings → agent series, the dry run (spec 023 FR-011).
 *
 *   cd apps/automation && pnpm migrate:strategies --dry-run [--channel @key] [--json]
 *   in the prod container: node dist/cli/migrate-strategies.js --dry-run
 *
 * Prints, per channel with enabled bindings, how each binding maps (series cadence, format, source), the
 * frequency hints and the unmappable bindings with their reason, plus the share mapped. Writes nothing: the
 * connection is opened read-only. The migration itself is the "Migrate" card on /app/strategies (or @ai0).
 * Resource health is not checked here (every group resource counts as usable).
 */
import { Pool } from 'pg';
import { AgentsRepository } from '../editor/agents/agents.repository';
import { ResourceProfilesRepository } from '../editor/agents/resource-profile';
import { NetworkRepository } from '../editor/network/network.repository';
import { seriesSourceCatalog } from '../editor/network/series-edit';
import { EditorChannelsRepository } from '../editor/repo/editor-channels.repository';
import { ResourceTime } from '../editor/time/resource-time';
import { StrategyMigrationService } from '../editor/migration/strategy-migration.service';
import { dryRun, formatDryRun } from '../editor/migration/dry-run';

function args(argv: string[]): { dryRun: boolean; channel: string | null; json: boolean } {
  const out = { dryRun: false, channel: null as string | null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--channel') out.channel = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: migrate:strategies --dry-run [--channel @key] [--json]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function makePool(): Pool {
  // Read-only session: a dry run cannot write even by mistake.
  const options = '-c default_transaction_read_only=on';
  if (process.env.DATABASE_URL) return new Pool({ connectionString: process.env.DATABASE_URL, options, max: 2 });
  return new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost', port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'ai0global', user: process.env.POSTGRES_USER ?? 'ai0', password: process.env.POSTGRES_PASSWORD ?? 'changeme',
    options, max: 2,
  });
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.dryRun) {
    console.error('Only --dry-run is supported here: migrate a channel with the "Migrate" button on /app/strategies (or ask @ai0).');
    process.exit(2);
  }
  const pool = makePool();
  try {
    const channels = new EditorChannelsRepository(pool);
    const profiles = new ResourceProfilesRepository(pool);
    const svc = new StrategyMigrationService({
      pool, agents: new AgentsRepository(pool), network: new NetworkRepository(pool), card: (k) => channels.get(k),
      inbox: { post: async () => { throw new Error('dry run: no Inbox writes'); } },
      time: new ResourceTime({ card: (k) => channels.get(k), profile: (ref) => profiles.rawProfile(ref) }),
      sourceCatalog: (card) => seriesSourceCatalog(pool, card),
      editorEnabled: () => false,
    });
    const r = await dryRun(svc, pool, { channel: a.channel });
    console.log(a.json ? JSON.stringify(r, null, 2) : formatDryRun(r));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
