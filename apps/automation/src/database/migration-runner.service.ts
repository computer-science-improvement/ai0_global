import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join }                      from 'path';
import { Pool }                      from 'pg';
import { DB_POOL }                   from './database.tokens';

/**
 * Applies pending SQL migrations from `database/migrations/*.sql` on boot.
 *
 * - Each file is executed once, in alphabetical order.
 * - Applied migrations are recorded in `schema_migrations`.
 * - Each file runs inside its own transaction.
 * - `init.sql` remains the baseline for fresh DBs; this runner only ever
 *   adds new DDL.
 * - The whole run is serialized with a Postgres advisory lock so a rolling
 *   deploy that briefly boots two instances can't run the same migration twice.
 */
// Arbitrary fixed key for the boot-migration advisory lock — shared by every
// instance so they queue rather than race.
const MIGRATION_LOCK_KEY = 778_899_001;

@Injectable()
export class MigrationRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationRunnerService.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    const dir = this.resolveMigrationsDir();
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    } catch (err: any) {
      this.logger.warn(`Migrations dir not found (${dir}): ${err.message}`);
      return;
    }

    if (!files.length) {
      this.logger.debug('No migration files found');
      return;
    }

    // Hold a session-level advisory lock on a dedicated connection for the whole
    // run. A second instance booting concurrently blocks here until we release,
    // then sees every migration already applied — no double-apply, no race.
    const lock = await this.pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

      await this.ensureRegistry();
      const applied = await this.fetchApplied();

      for (const file of files) {
        const version = file.replace(/\.sql$/i, '');
        if (applied.has(version)) continue;

        const sql = readFileSync(join(dir, file), 'utf-8');
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
            [version],
          );
          await client.query('COMMIT');
          this.logger.log(`Applied migration ${version}`);
        } catch (err: any) {
          await client.query('ROLLBACK');
          this.logger.error(`Migration ${version} failed: ${err.message}`);
          throw err;
        } finally {
          client.release();
        }
      }
    } finally {
      try { await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]); }
      catch { /* connection may already be gone; lock auto-releases on disconnect */ }
      lock.release();
    }
  }

  private async ensureRegistry(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    VARCHAR(64) PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  }

  private async fetchApplied(): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations`,
    );
    return new Set(rows.map((r) => r.version));
  }

  /**
   * The runner is executed both from `dist/` (prod) and `src/` (dev). We walk
   * up until we find a `database/migrations` folder sibling to `apps/`.
   */
  private resolveMigrationsDir(): string {
    return join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  }
}
