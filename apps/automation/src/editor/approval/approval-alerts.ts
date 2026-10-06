import type { EditorCard } from '../card';
import { localDate } from '../roles/time';
import { addDays, writeAt } from './approval-timing';
import type { ApprovalsRepository } from './approvals.repository';

export interface ApprovalAlertsDeps {
  repo:   Pick<ApprovalsRepository, 'settledBatches' | 'plannedOfBatch' | 'claimAlert' | 'releaseAlert'>;
  card:   (channelKey: string) => Promise<EditorCard | null>;
  /** The owner's existing alert channel (TelegramNotifier.notifyAlert). */
  notify: (text: string) => Promise<void>;
  dashboardUrl?: string | null;
  log?:   (msg: string) => void;
}

function ukPosts(n: number): string {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return 'пост чекає';
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'пости чекають' : 'постів чекають';
}

/**
 * The owner's Telegram alert for approval mode (spec 031 FR-005, T4): one
 * message per resource per batch (the plan date of the waiting posts), sent
 * once the batch has settled — nothing of that day is being written or due
 * to be written. The (channel, batch date) claim lives in approval_alerts,
 * so a restart never repeats an alert; an empty batch sends nothing. v1 does
 * not approve from Telegram: the message links to «Пости на апрув».
 */
export class ApprovalAlerts {
  constructor(private readonly d: ApprovalAlertsDeps) {}

  async run(now: Date): Promise<number> {
    let sent = 0;
    for (const b of await this.d.repo.settledBatches()) {
      const card = await this.d.card(b.channelKey);
      if (!card) continue;
      // Still writing: a slot of the batch whose write time has come is not written yet.
      const pending = await this.d.repo.plannedOfBatch(b.channelKey, b.batchDate);
      if (pending.some((s) => writeAt(s, card).getTime() <= now.getTime())) continue;
      if (!(await this.d.repo.claimAlert(b.channelKey, b.batchDate, b.waiting))) continue;
      try {
        await this.d.notify(this.message(b, card, now));
        sent++;
      } catch (err: any) {
        // Not delivered: release the claim so the next tick tries again.
        await this.d.repo.releaseAlert(b.channelKey, b.batchDate).catch(() => {});
        this.d.log?.(`approval alert for ${b.channelKey} ${b.batchDate} failed: ${err?.message ?? err}`);
      }
    }
    return sent;
  }

  message(b: { channelKey: string; batchDate: string; waiting: number; title: string | null }, card: EditorCard, now: Date): string {
    const today = localDate(now, card.timezone);
    const day = b.batchDate === addDays(today, 1) ? 'на завтра' : b.batchDate === today ? 'на сьогодні' : `на ${b.batchDate}`;
    const link = this.d.dashboardUrl ? `\n${this.d.dashboardUrl.replace(/\/$/, '')}/app/agents/inbox?tab=approvals` : '';
    return `🗳 ${b.title ? `${b.title} (${b.channelKey})` : b.channelKey}: ${b.waiting} ${ukPosts(b.waiting)} апруву ${day} → «Пости на апрув»${link}`;
  }
}
