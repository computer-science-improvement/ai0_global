import type { ChannelMode, EditorCard } from '../card';
import type { ApprovalsRepository } from './approvals.repository';

export interface ApprovalUpkeepDeps {
  repo:      Pick<ApprovalsRepository, 'expire' | 'channelsWithWaiting' | 'dropWaiting'>;
  publisher: { publishDue(now: Date): Promise<{ published: number; skipped: number; failed: number }> };
  card:      (channelKey: string) => Promise<EditorCard | null>;
  mode:      (card: EditorCard) => Promise<ChannelMode>;
  /** T4: the owner's batch alert. */
  alerts?:   { run(now: Date): Promise<number> };
  log?:      (msg: string) => void;
}

/**
 * The approval lane of the scheduler tick (spec 031): expire posts nobody
 * approved in time, drop waiting posts of resources that left approval for
 * shadow/off (whichever switch did it), publish approved posts that are due,
 * then alert the owner about settled batches.
 */
export class ApprovalUpkeep {
  constructor(private readonly d: ApprovalUpkeepDeps) {}

  async tick(now: Date): Promise<void> {
    const expired = await this.d.repo.expire(now);
    if (expired.length) this.d.log?.(`approval: ${expired.length} post(s) expired unapproved`);

    for (const key of await this.d.repo.channelsWithWaiting()) {
      const card = await this.d.card(key);
      const mode = card ? await this.d.mode(card) : 'off';
      if (mode === 'off' || mode === 'shadow') {
        const n = await this.d.repo.dropWaiting(key);
        if (n) this.d.log?.(`approval: ${key} is ${mode} now — ${n} waiting post(s) dropped (mode_changed)`);
      }
    }

    const r = await this.d.publisher.publishDue(now);
    if (r.published || r.skipped || r.failed) this.d.log?.(`approval: published ${r.published}, skipped ${r.skipped}, failed ${r.failed}`);

    if (this.d.alerts) {
      try { await this.d.alerts.run(now); } catch (err: any) { this.d.log?.(`approval alerts failed: ${err?.message ?? err}`); }
    }
  }
}
