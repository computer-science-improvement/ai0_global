import type { Pool } from 'pg';

/** How long hosted slides of a source wait for its derived slots at most (spec 024 FR-007). */
export const MEDIA_HOLD_MS = 24 * 3600_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Spec 024 FR-007 media lifetime: hosted slides (SlideHostingService) of a
 * source slot with pending derived slots are kept, so a duplicate posts the
 * same images, and deleted after the last derived slot finishes or after 24 h.
 */
export class MediaHolds {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly hosting: { delete(paths: string[]): Promise<void> } | null = null,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /**
   * Called instead of deleting hosted slides: keeps them (true) when the slot
   * has derived slots still to run; false → the caller deletes as before.
   */
  async holdIfDerived(slotId: string, paths: string[], urls: string[], now: Date = new Date()): Promise<boolean> {
    if (!UUID_RE.test(slotId) || !paths.length) return false;
    const { rows } = await this.pool.query(
      `INSERT INTO media_holds (slot_id, paths, urls, hold_until)
       SELECT $1::uuid, $2::text[], $3::text[], $4
        WHERE EXISTS (SELECT 1 FROM editor_slots WHERE derived_from_slot_id = $1::uuid AND status IN ('planned','running'))
       ON CONFLICT (slot_id) DO UPDATE SET paths = media_holds.paths || EXCLUDED.paths, urls = EXCLUDED.urls
       RETURNING slot_id`,
      [slotId, paths, urls, new Date(now.getTime() + MEDIA_HOLD_MS)]);
    return rows.length > 0;
  }

  /** Hosted slide URLs of a source while they are held (a derived run reuses them). */
  async urls(slotId: string): Promise<string[]> {
    if (!UUID_RE.test(slotId)) return [];
    const { rows } = await this.pool.query(`SELECT urls FROM media_holds WHERE slot_id = $1`, [slotId]);
    return rows[0]?.urls ?? [];
  }

  /**
   * Delete held media whose derived slots are all finished, or that waited
   * 24 h; `sourceSlotId` limits the pass to one source (after its derived slot ran).
   */
  async sweep(now: Date = new Date(), sourceSlotId: string | null = null): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT h.slot_id, h.paths FROM media_holds h
        WHERE ($2::uuid IS NULL OR h.slot_id = $2)
          AND (h.hold_until < $1 OR NOT EXISTS (
                SELECT 1 FROM editor_slots d WHERE d.derived_from_slot_id = h.slot_id AND d.status IN ('planned','running')))`,
      [now, sourceSlotId && UUID_RE.test(sourceSlotId) ? sourceSlotId : null]);
    let n = 0;
    for (const r of rows) {
      try {
        if (this.hosting && r.paths?.length) await this.hosting.delete(r.paths);
      } catch (err: any) {
        this.log(`media hold ${r.slot_id}: delete failed: ${err?.message ?? err}`);
      }
      await this.pool.query(`DELETE FROM media_holds WHERE slot_id = $1`, [r.slot_id]);
      n++;
    }
    return n;
  }
}
