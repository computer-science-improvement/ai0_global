/**
 * Initialize database schema from database/init.sql
 * Idempotent — all statements use IF NOT EXISTS.
 *
 * Usage:
 *   pnpm run init-db
 *   pnpm run init-db --reset   (DROP all tables first, then recreate)
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SQL  = join(__dirname, '..', '..', '..', 'database', 'init.sql');

const isReset = process.argv.includes('--reset');

async function init() {
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
