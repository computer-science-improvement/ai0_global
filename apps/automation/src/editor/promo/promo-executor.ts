import type { EditorCard } from '../card';
import type { AgentLoopResult } from '../harness/agent-loop';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import type { ResourceCatalog } from '../agents/resource-catalog';
import { renderProfile, ResourceProfilesRepository } from '../agents/resource-profile';

export interface PromoExecutorDeps {
  plans:    Pick<EditorPlansRepository, 'updateSlot' | 'getSlot'>;
  card:     (channelKey: string) => Promise<EditorCard | null>;
  catalog:  Pick<ResourceCatalog, 'list'>;
  profiles: Pick<ResourceProfilesRepository, 'get'>;
  /** The executor run (EditorRunnerService.runExecutor with a note). */
  runExecutor: (slot: EditorSlot, card: EditorCard, note: string) => Promise<AgentLoopResult>;
  /** Bot API forwardMessage into `toKey` from `fromKey` (keeps attribution); returns the new message id. */
  forward?: (toKey: string, fromKey: string, messageId: number) => Promise<number>;
  log?:     (msg: string) => void;
}

/** Executes due promo slots (spec 022): a native forward for Telegram reposts, an agent-written post for cross-promo. */
export class PromoExecutor {
  constructor(private readonly d: PromoExecutorDeps) {}

  async publishPromo(slot: EditorSlot, _now: Date): Promise<boolean> {
    const p = (slot.promo ?? {}) as Record<string, any>;
    const card = await this.d.card(slot.channelKey);
    if (!card) { await this.d.plans.updateSlot(slot.id, { status: 'failed', error: 'no channel card' }); return false; }

    if (p.kind === 'repost') {
      const m = String(p.post_ref ?? '').match(/^telegram:(.+)\/(\d+)$/);
      if (!m) { await this.d.plans.updateSlot(slot.id, { status: 'failed', error: 'invalid post_ref' }); return false; }
      if (card.mode !== 'live' || !this.d.forward) {
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
    return after?.status === 'published' || after?.status === 'shadowed';
  }
}
