/**
 * Initialize database schema from database/init.sql
 * Idempotent — all statements use IF NOT EXISTS.
 *
 * Usage:
 *   pnpm run init-db
 *   pnpm run init-db --reset   (DROP all tables first, then recreate)
 *
 * --reset is destructive and guarded: it refuses to run unless
 * ALLOW_DB_RESET=yes is set AND NODE_ENV is not "production".
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SQL  = join(__dirname, '..', '..', '..', 'database', 'init.sql');

const isReset = process.argv.includes('--reset');

/** Returns a refusal reason, or null when a --reset may proceed. */
function resetRefusal(env = process.env) {
  if (env.NODE_ENV === 'production') return 'NODE_ENV=production — --reset is never allowed here';
  if (env.ALLOW_DB_RESET !== 'yes') return 'set ALLOW_DB_RESET=yes to confirm dropping ALL tables';
  return null;
}

async function init() {
  if (isReset) {
    const refusal = resetRefusal();
    if (refusal) {
      console.error(`Refusing to reset the database: ${refusal}.`);
      process.exitCode = 1;
      await pool.end();
      return;
    }
  }

  const client = await pool.connect();
  try {
    if (isReset) {
      console.log('Resetting database — dropping all tables...\n');
      // Drop all user tables (not system tables)
      const { rows } = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      for (const { tablename } of rows) {
        await client.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
        console.log(`  Dropped: ${tablename}`);
      }
      console.log('');
    }

    const sql = readFileSync(INIT_SQL, 'utf-8');
    console.log('Applying init.sql...');
    await client.query(sql);
    console.log('Schema initialized successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch((err) => {
  console.error(err);
  process.exit(1);
});
