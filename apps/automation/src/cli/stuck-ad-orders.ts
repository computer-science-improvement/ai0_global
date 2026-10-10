/**
 * Paid-but-unpublished ad orders (spec 036), the one-off check.
 *
 *   cd apps/automation && npm run ads:stuck-orders [-- --json]
 *   in the prod container: node dist/cli/stuck-ad-orders.js [--json]
 *
 * Lists every paid / scheduled ad order that was not published and has no path to publication any more
 * (a digest sponsor whose day passed or that has no date, a failed reserved slot, a paid order never scheduled,
 * a schedule_post action never approved). Read-only: the connection is opened read-only, nothing is flagged,
 * refunded or published. The running service flags the same orders and posts them to the Inbox (at startup
 * and daily, unless AD_STUCK_CHECK=off).
 */
import { Pool } from 'pg';
import { SponsorOrdersRepository } from '../payments/sponsor-orders.repository';
import { findStuckOrders, formatStuck } from '../payments/stuck-ad-orders';

function args(argv: string[]): { json: boolean } {
  const out = { json: false };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: ads:stuck-orders [--json]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function makePool(): Pool {
  const options = '-c default_transaction_read_only=on';
  if (process.env.DATABASE_URL) return new Pool({ connectionString: process.env.DATABASE_URL, options, max: 1 });
  return new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost', port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'ai0global', user: process.env.POSTGRES_USER ?? 'ai0', password: process.env.POSTGRES_PASSWORD ?? 'changeme',
    options, max: 1,
  });
}

async function main() {
  const a = args(process.argv.slice(2));
  const pool = makePool();
  try {
    const stuck = await findStuckOrders(new SponsorOrdersRepository(pool), new Date());
    console.log(a.json ? JSON.stringify(stuck, null, 2) : formatStuck(stuck));
    process.exitCode = stuck.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(2);
});
