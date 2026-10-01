import { PostSpecSchema } from '../post/post-spec';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import { RESERVED_CLAIM_BATCH, SponsoredOrdersPort } from './sponsored.publisher';

export interface ReservedDispatcherDeps {
  plans:     Pick<EditorPlansRepository, 'claimDueReserved'>;
  orders:    Pick<SponsoredOrdersPort, 'findBySlot'>;
  /** 008 ad path (SponsoredPublisher), unchanged. */
  sponsored: { publishClaimed(slot: EditorSlot, now: Date): Promise<boolean> };
  /** 010 manual path (DraftsService): a scheduled chat post. */
  manual:    { publishScheduled(slot: EditorSlot, now: Date): Promise<boolean> };
  /** 022 promo path: a cross-promo or repost between own resources. */
  promo?:    { publishPromo(slot: EditorSlot, now: Date): Promise<boolean> };
  log?:      (msg: string) => void;
}

/**
 * Publishes due reserved slots deterministically, without an LLM, on every
 * scheduler tick (regardless of EDITOR_ENABLED and channel mode). A slot owned
 * by an ad order goes through the sponsored path (spec 008); a slot without an
 * order whose post_spec is a valid PostSpec is a scheduled chat post (spec 010).
 * Anything else falls to the sponsored path, which fails it as before.
 */
export class ReservedDispatcher {
  constructor(private readonly d: ReservedDispatcherDeps) {}

  async publishDue(now: Date): Promise<number> {
    const slots = await this.d.plans.claimDueReserved(now, RESERVED_CLAIM_BATCH);
    let published = 0;
    for (const slot of slots) {
      if (slot.promo && this.d.promo) {
        try { if (await this.d.promo.publishPromo(slot, now)) published++; } catch (err: any) { this.d.log?.(`promo slot ${slot.id} failed: ${err?.message ?? err}`); }
        continue;
      }
      let manual = false;
      try {
        manual = !(await this.d.orders.findBySlot(slot.id)) && PostSpecSchema.safeParse(slot.postSpec).success;
      } catch (err: any) {
        this.d.log?.(`reserved slot ${slot.id}: order lookup failed: ${err?.message ?? err}`);
      }
      const ok = manual ? await this.d.manual.publishScheduled(slot, now) : await this.d.sponsored.publishClaimed(slot, now);
      if (ok) published++;
    }
    return published;
  }
}
