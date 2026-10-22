import type { Pool } from 'pg';
import { dismissHealth } from '../platform/resource-health.service';
import type { ResourceProfilesRepository } from '../agents/resource-profile';
import { parseNoteAction } from './note-actions';
import type { SeriesPause, SeriesPausesRepository } from './series-pauses.repository';
import { SERIES_PAUSE_REF, SERIES_PAUSED_KIND } from './series-breaker';

/**
 * Spec 060 FR-001, FR-004: what the owner does with a pause — from the dashboard (Resume) and from an owner-bot card
 * (Відновити, Залишити на паузі, Пауза серії, Заглушити на 7 днів). One place, so both surfaces do the same and both leave
 * the same trace: the card's outcome line, and a line on the Inbox note's body (the note is marked read).
 */
export interface PauseActionsDeps {
  pool:     Pick<Pool, 'query'>;
  repo:     Pick<SeriesPausesRepository, 'get' | 'list' | 'open' | 'resume' | 'insertOpen' | 'skipPlanned'>;
  profiles?: Pick<ResourceProfilesRepository, 'get' | 'setHealth'>;
  now?:     () => Date;
}

export type PauseVia = 'dashboard' | 'telegram';

export interface PauseResult { outcome: string; changed: boolean }

const when = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
const what = (p: Pick<SeriesPause, 'label' | 'channelKey'>) => `"${p.label}" on ${p.channelKey}`;

export class SeriesPauseActions {
  constructor(private readonly d: PauseActionsDeps) {}

  private now(): Date { return this.d.now?.() ?? new Date(); }

  list(channelKey: string, limit = 20): Promise<SeriesPause[]> { return this.d.repo.list(channelKey, limit); }

  /** A line on the note's body and the note read ("the action is logged in the Inbox row"). `noteId` null → the notes of that pause. */
  private async log(line: string, o: { noteId?: number | null; pauseId?: string }): Promise<void> {
    const text = `\n\nOwner action: ${line} (${when(this.now())} UTC)`;
    if (o.noteId != null) {
      await this.d.pool.query(`UPDATE agent_inbox SET read_at = COALESCE(read_at, now()), body = COALESCE(body, '') || $2 WHERE id = $1`, [o.noteId, text]);
    } else if (o.pauseId) {
      await this.d.pool.query(
        `UPDATE agent_inbox SET read_at = COALESCE(read_at, now()), body = COALESCE(body, '') || $2 WHERE kind = $3 AND ref_type = $4 AND ref_id = $1`,
        [o.pauseId, text, SERIES_PAUSED_KIND, SERIES_PAUSE_REF]);
    }
  }

  /** Resumes an open pause (`resumed_by = 'owner'`). Already resumed → says so, nothing changes. */
  async resume(id: string, via: PauseVia, noteId?: number | null): Promise<PauseResult & { pause: SeriesPause | null }> {
    const p = await this.d.repo.resume(id, 'owner');
    if (!p) {
      const was = await this.d.repo.get(id);
      return { outcome: was ? 'Вже відновлено' : 'Паузу не знайдено', changed: false, pause: was };
    }
    await this.log(`resumed ${what(p)} from ${via === 'telegram' ? 'a Telegram card' : 'the dashboard'}`, { noteId, pauseId: id });
    return { outcome: `✅ Відновлено: ${p.label}`, changed: true, pause: p };
  }

  /** «Залишити на паузі»: the note is read and says so; the pause stays. */
  async keep(id: string, noteId?: number | null): Promise<PauseResult> {
    const p = await this.d.repo.get(id);
    if (!p) return { outcome: 'Паузу не знайдено', changed: false };
    await this.log(`kept ${what(p)} paused (Telegram card)`, { noteId, pauseId: id });
    return { outcome: p.resumedAt ? 'Вже відновлено' : `⏸ Залишено на паузі: ${p.label}`, changed: false };
  }

  /** «Пауза серії»: an owner pause (`cause = 'owner'`) — the planner stops planning the series, its planned slots are skipped. */
  async pause(t: { channelKey: string; seriesKey: string; label: string }, noteId?: number | null): Promise<PauseResult> {
    const p = await this.d.repo.insertOpen({ channelKey: t.channelKey, key: t.seriesKey, label: t.label, cause: 'owner', reason: 'Paused by the owner from a Telegram card', streak: 0 });
    if (!p) return { outcome: 'Вже на паузі', changed: false };
    const n = await this.d.repo.skipPlanned(p).catch(() => 0);
    await this.log(`paused ${what(p)} from a Telegram card${n ? `; ${n} planned slot(s) skipped` : ''}`, { noteId });
    return { outcome: `⏸ Призупинено: ${p.label}${n ? ` (слотів пропущено: ${n})` : ''}`, changed: true };
  }

  /** «Заглушити на 7 днів»: the existing health dismiss (spec 049), which expires after 7 days. */
  async mute(ref: string, noteId?: number | null): Promise<PauseResult> {
    if (!this.d.profiles) return { outcome: 'Недоступно', changed: false };
    const ok = await dismissHealth(this.d.profiles, ref, this.now());
    if (!ok) return { outcome: 'Ресурс уже в порядку', changed: false };
    await this.log(`muted the daily connection reminders for ${ref} for 7 days (Telegram card)`, { noteId });
    return { outcome: `🔕 Заглушено на 7 днів: ${ref}`, changed: true };
  }

  /** A card button (`oc:` → the inbox source): runs the action its key names. Throws for a key that is not ours. */
  async run(noteId: number, key: string): Promise<string> {
    const a = parseNoteAction(key);
    if (!a) throw new Error(`unknown button ${key}`);
    const r = a.type === 'resume' ? await this.resume(a.id, 'telegram', noteId)
      : a.type === 'keep' ? await this.keep(a.id, noteId)
      : a.type === 'pause' ? await this.pause({ channelKey: a.channelKey, seriesKey: a.seriesKey, label: a.label }, noteId)
      : await this.mute(a.ref, noteId);
    // A refused or repeated action still answers the note: it is read, so the card does not wait again.
    if (!r.changed) await this.d.pool.query(`UPDATE agent_inbox SET read_at = COALESCE(read_at, now()) WHERE id = $1`, [noteId]);
    return r.outcome;
  }
}
