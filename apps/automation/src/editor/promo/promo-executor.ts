import type { ChannelMode, EditorCard } from '../card';
import { writeAt } from '../approval/approval-timing';
import type { AgentLoopResult } from '../harness/agent-loop';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import type { ResourceCatalog } from '../agents/resource-catalog';
import { renderProfile, ResourceProfilesRepository } from '../agents/resource-profile';

export interface PromoExecutorDeps {
  plans:    Pick<EditorPlansRepository, 'updateSlot' | 'getSlot'> & Partial<Pick<EditorPlansRepository, 'plannedPromoBefore' | 'claimPromoSlot'>>;
  card:     (channelKey: string) => Promise<EditorCard | null>;
  catalog:  Pick<ResourceCatalog, 'list'>;
  profiles: Pick<ResourceProfilesRepository, 'get'>;
  /** The executor run (EditorRunnerService.runExecutor with a note). */
  runExecutor: (slot: EditorSlot, card: EditorCard, note: string) => Promise<AgentLoopResult>;
  /** Bot API forwardMessage into `toKey` from `fromKey` (keeps attribution); returns the new message id. */
  forward?: (toKey: string, fromKey: string, messageId: number) => Promise<number>;
  /**
   * Spec 031: the channel's effective mode (orchestrator ∧ card). Without it the
   * card's mode decides. In `approve` a repost waits for the owner (the forward
   * is sent by the approval publisher) and a cross-promo is written like any
   * waiting post.
   */
  mode?:    (card: EditorCard) => Promise<ChannelMode>;
  /** Spec 031: active cards, for writing promo slots of approval channels ahead of time. */
  cards?:   () => Promise<EditorCard[]>;
  log?:     (msg: string) => void;
}

/** How far ahead promo slots of approval channels are looked at (the evening batch covers the next day). */
export const PROMO_WRITE_AHEAD_WINDOW_MS = 36 * 3600_000;

/** Executes due promo slots (spec 022): a native forward for Telegram reposts, an agent-written post for cross-promo. */
export class PromoExecutor {
  constructor(private readonly d: PromoExecutorDeps) {}

  async publishPromo(slot: EditorSlot, _now: Date): Promise<boolean> {
    const p = (slot.promo ?? {}) as Record<string, any>;
    const card = await this.d.card(slot.channelKey);
    if (!card) { await this.d.plans.updateSlot(slot.id, { status: 'failed', error: 'no channel card' }); return false; }
    const mode = this.d.mode ? await this.d.mode(card) : card.mode;

    if (p.kind === 'repost') {
      const m = String(p.post_ref ?? '').match(/^telegram:(.+)\/(\d+)$/);
      if (!m) { await this.d.plans.updateSlot(slot.id, { status: 'failed', error: 'invalid post_ref' }); return false; }
      if (mode === 'approve') {
        // Spec 031 FR-009: the repost waits for the owner; the approval publisher forwards it at its time.
        await this.d.plans.updateSlot(slot.id, {
          status: 'awaiting_approval', renderedPreview: `↪️ Репост ${m[1]}/${m[2]} у ${slot.channelKey}`,
          renderMessages: { kind: 'forward', fromKey: m[1], messageId: Number(m[2]) }, lintWarnings: [], error: null,
        });
        return true;
      }
      if (mode !== 'live' || !this.d.forward) {
        await this.d.plans.updateSlot(slot.id, { status: 'shadowed', renderedPreview: `↪️ Репост ${m[1]}/${m[2]} у ${slot.channelKey} (shadow)`, error: null });
        return true;
      }
      try {
        const id = await this.d.forward(slot.channelKey, m[1], Number(m[2]));
        await this.d.plans.updateSlot(slot.id, { status: 'published', renderedPreview: `↪️ Переслано ${m[1]}/${m[2]} → ${id}`, error: null });
        return true;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        await this.d.plans.updateSlot(slot.id, { status: /not found|message to forward/i.test(msg) ? 'skipped' : 'failed', error: /not found|message to forward/i.test(msg) ? `source_missing: ${msg}` : msg });
        return false;
      }
    }

    // cross_promo: the source's executor writes a native post about the target with the tracked link.
    const target = (await this.d.catalog.list()).find((r) => r.ref === p.target_ref);
    const profile = p.target_ref ? (await this.d.profiles.get(String(p.target_ref)))?.profile ?? null : null;
    const note = [
      '## Це промо-слот нашого іншого ресурсу (взаємопіар у мережі)',
      `Ціль: ${target?.title ?? p.target_ref} (${p.target_ref}).`,
      profile ? `Про ціль:\n${renderProfile(profile)}` : '',
      p.link_url ? `Обовʼязково дай посилання ${p.link_url} (у тексті або як cta) — воно трекінгове, не змінюй його.` : 'Посилання немає — згадай ресурс назвою.',
      'Пиши чесно: це наш ресурс, рекомендуємо його за конкретну користь для читача. Без гіпербол і «найкращий канал». Без хештегів реклами — це не реклама третьої сторони.',
    ].filter(Boolean).join('\n');
    const res = await this.d.runExecutor(slot, card, note);
    const after = await this.d.plans.getSlot(slot.id);
    if (after?.status === 'running') {
      await this.d.plans.updateSlot(slot.id, { status: 'failed', error: `${res.status}${res.error ? `: ${res.error}` : ''}` });
      return false;
    }
    return after?.status === 'published' || after?.status === 'shadowed' || after?.status === 'awaiting_approval';
  }

  /**
   * Spec 031 FR-009: promo slots of approval-mode channels are written ahead
   * (same write times as content slots), so they wait for the owner before
   * they are due instead of turning up late. Returns how many were written.
   */
  async writeAhead(now: Date): Promise<number> {
    if (!this.d.cards || !this.d.plans.plannedPromoBefore || !this.d.plans.claimPromoSlot) return 0;
    const byKey = new Map<string, EditorCard>();
    for (const c of await this.d.cards()) {
      if ((this.d.mode ? await this.d.mode(c) : c.mode) === 'approve') byKey.set(c.channelKey, c);
    }
    if (!byKey.size) return 0;
    let written = 0;
    for (const s of await this.d.plans.plannedPromoBefore([...byKey.keys()], new Date(now.getTime() + PROMO_WRITE_AHEAD_WINDOW_MS))) {
      const card = byKey.get(s.channelKey)!;
      if (writeAt(s, card).getTime() > now.getTime()) continue;
      const claimed = await this.d.plans.claimPromoSlot(s.id);
      if (!claimed) continue;
      try {
        if (await this.publishPromo(claimed, now)) written++;
      } catch (err: any) {
        this.d.log?.(`promo slot ${s.id} (write-ahead) failed: ${err?.message ?? err}`);
      }
    }
    return written;
  }
}
