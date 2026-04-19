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
 */
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
