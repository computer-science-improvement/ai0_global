import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';
import { NAV_SETTINGS_KEY, validateNavConfig } from './nav-config.schema';

/** The text form of a timestamptz (`2026-10-06 09:00:00.123456+03`, ISO also accepted). */
const REVISION_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export type NavConfigView = {
  /** The saved menu as stored, or null (no row / unreadable row). */
  config:   Record<string, unknown> | null;
  /** Opaque optimistic-lock token (the row's updated_at); null when nothing is saved. */
  revision: string | null;
  warning?: 'unparseable';
};

/**
 * Spec 027 FR-004/FR-005: the owner's menu in the `app_settings` row `ui.nav`.
 * Writes are optimistic: a PUT carries the revision it was based on and gets a
 * 409 when another tab saved (or reset) in between, so a draft is never lost
 * silently. `SettingsService` skips `ui.*` keys, so `GET /settings` is unchanged.
 */
export class NavConfigService {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async get(): Promise<NavConfigView> {
    const { rows } = await this.pool.query<{ value: string; revision: string }>(
      `SELECT value, updated_at::text AS revision FROM app_settings WHERE key = $1`, [NAV_SETTINGS_KEY]);
    const row = rows[0];
    if (!row) return { config: null, revision: null };
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as any).schemaVersion === 'number') {
        // Returned as stored: an older schema is migrated by the dashboard, a newer one shows the default menu there.
        return { config: parsed as Record<string, unknown>, revision: row.revision };
      }
    } catch { /* fall through */ }
    return { config: null, revision: row.revision, warning: 'unparseable' };
  }

  /** Save the menu if `baseRevision` is still current (null = "nothing saved yet"). */
  async put(body: unknown): Promise<{ revision: string }> {
    const b = (body && typeof body === 'object' ? body : {}) as { config?: unknown; baseRevision?: unknown };
    if (!('baseRevision' in b) || (b.baseRevision !== null && typeof b.baseRevision !== 'string')) {
      throw new BadRequestException({ error: 'invalid_nav_config', issues: [{ path: 'baseRevision', message: 'baseRevision is required (string or null)' }] });
    }
    const v = validateNavConfig(b.config);
    if (!v.ok) throw new BadRequestException({ error: 'invalid_nav_config', issues: v.issues });

    const base = b.baseRevision as string | null;
    let rows: Array<{ revision: string }>;
    if (base === null) {
      ({ rows } = await this.pool.query<{ revision: string }>(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (key) DO NOTHING
         RETURNING updated_at::text AS revision`, [NAV_SETTINGS_KEY, v.json]));
    } else {
      // A revision we never issued can't be current: 409, not a cast error.
      if (!REVISION_RE.test(base)) throw new ConflictException({ error: 'nav_conflict', message: 'Changed in another tab' });
      ({ rows } = await this.pool.query<{ revision: string }>(
        `UPDATE app_settings
            SET value = $2, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
          WHERE key = $1 AND updated_at = $3::timestamptz
          RETURNING updated_at::text AS revision`, [NAV_SETTINGS_KEY, v.json, base]));
    }
    if (!rows[0]) throw new ConflictException({ error: 'nav_conflict', message: 'Changed in another tab' });
    return { revision: rows[0].revision };
  }

  /** Reset to the default menu (the dashboard's FR-003 menu). */
  async reset(): Promise<{ revision: null }> {
    await this.pool.query(`DELETE FROM app_settings WHERE key = $1`, [NAV_SETTINGS_KEY]);
    return { revision: null };
  }
}
