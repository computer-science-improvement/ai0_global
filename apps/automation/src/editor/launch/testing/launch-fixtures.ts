import type { SubmitLaunchInput } from '../launch-analysis';
import type { LaunchPatch } from '../launch.repository';
import { OPEN_LAUNCH_STATUSES, type ChannelLaunch, type LaunchRef, type LaunchStatus } from '../launch.types';

/** Spec 052 test fixtures: a valid launch plan and an in-memory channel_launches. */

export function validLaunch(): SubmitLaunchInput {
  return {
    summary: 'Канал про домашню каву для початківців: прості рецепти, техніка і чесні огляди недорогого обладнання.',
    brief_profile: {
      profile: {
        topic: 'Домашня кава для початківців', audience: { who: 'люди, які варять каву вдома і хочуть смачніше' },
        language: 'uk', goals: ['growth', 'engagement'], tone: 'дружній, практичний, на «ви»', taboo: ['реклама без позначки'],
        notes: 'вік аудиторії бриф не називає',
      },
      brief: 'Канал допомагає людям варити смачну каву вдома без дорогого обладнання. Щодня — один практичний пост: рецепт, прийом техніки '
        + 'або огляд недорогого приладдя. Пояснюємо просто, без снобізму, з конкретними цифрами: грами, секунди, градуси. Тон дружній, звертання на «ви».',
    },
    formatting: {
      format_prefs: { emoji: 'light', length: { target: 400, max: 900 } },
      style: { address: 'vy' },
      card: { hashtags: ['кава'], hashtag_min: 0, hashtag_max: 1, emoji_policy: 'sparse' },
    },
    format_mix: { formats: { text: 0.5, photo: 0.5 } },
    series_pillars: {
      series: [{ name: 'Рецепт тижня', cadence: 'weekly:sat@10:00', format: 'photo', brief: 'Один рецепт з точними пропорціями й фото результату.' }],
      pillars: [{ name: 'Рецепти', share: 40 }, { name: 'Техніка', share: 35 }, { name: 'Обладнання', share: 25 }],
    },
    schedule: { posts_per_day_min: 1, posts_per_day_max: 2, quiet_start_hour: 23, quiet_end_hour: 8, best_hours: [9, 19] },
    voice: {
      description: 'Дружній бариста-сусід: пояснює просто і з цифрами.',
      rules: [
        'Пиши на «ви», дружньо і просто',
        'Давай точні цифри: грами, секунди, градуси',
        'Не зневажай розчинну каву і дешеве приладдя',
        'Один пост — одна думка',
        'Без канцеляризмів і пафосу',
      ],
    },
    first_week: {
      ideas: [
        { day: 1, title: 'Знайомство: що буде в каналі', angle: 'Для кого канал, що тут буде щодня і чому без снобізму.', format: 'text', intro: true },
        { day: 2, title: 'Пропорція 1:16 для фільтру', angle: 'Чому саме стільки кави на воду і як підлаштувати під смак.', format: 'text', intro: false },
        { day: 3, title: 'Турка без пригорілого смаку', angle: 'Три помилки при варінні в турці і як їх уникнути.', format: 'photo', intro: false },
        { day: 5, title: 'Ручна кавомолка до 1000 грн', angle: 'Що дає свіжий помел і на що дивитися при виборі.', format: 'photo', intro: false },
        { day: 6, title: 'Рецепт тижня: лате вдома без машини', angle: 'Молочна пінка френч-пресом, точні пропорції.', format: 'photo', intro: false },
      ],
    },
    references: [{ ref: 'telegram:@coffee_ref', takeaway: 'Короткі пости з цифрами і фото результату' }],
  };
}

export class MemoryLaunchRepo {
  rows: ChannelLaunch[] = [];
  private n = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async insert(l: { channelKey: string; title: string | null; brief: string; refs: LaunchRef[]; createdBy: string }): Promise<ChannelLaunch | null> {
    if (this.rows.some((r) => r.channelKey.toLowerCase() === l.channelKey.toLowerCase() && OPEN_LAUNCH_STATUSES.includes(r.status))) return null;
    const at = this.now();
    const row: ChannelLaunch = {
      id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`, channelKey: l.channelKey, targetRef: `telegram:${l.channelKey}`,
      title: l.title, brief: l.brief, refs: l.refs, status: 'queued', reason: null, retryAt: null, plan: null, checklist: null,
      startRequested: false, startedAt: null, graduation: {}, promo: null, subsAtStart: null, botCheckedAt: null, botState: null,
      agentId: null, runId: null, costUsd: 0, createdBy: l.createdBy, createdAt: at, updatedAt: at, graduatedAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async get(id: string) { const r = this.rows.find((x) => x.id === id); return r ? { ...r } : null; }
  async openFor(key: string) {
    const r = this.rows.filter((x) => x.channelKey.toLowerCase() === key.toLowerCase() && OPEN_LAUNCH_STATUSES.includes(x.status)).at(-1);
    return r ? { ...r } : null;
  }
  async list(f: { channel?: string | null; status?: string | null } = {}) {
    return this.rows.filter((r) => (!f.channel || r.channelKey === f.channel) && (!f.status || r.status === f.status)).map((r) => ({ ...r })).reverse();
  }
  async active(statuses: readonly LaunchStatus[], now: Date) {
    return this.rows.filter((r) => statuses.includes(r.status) && (!r.retryAt || r.retryAt <= now)).map((r) => ({ ...r }));
  }
  async requeueStuck(olderThan: Date) {
    let n = 0;
    for (const r of this.rows) if (r.status === 'analyzing' && r.updatedAt < olderThan) { r.status = 'preparing'; n++; }
    return n;
  }
  async transition(id: string, from: readonly LaunchStatus[], p: Partial<LaunchPatch>) {
    const r = this.rows.find((x) => x.id === id);
    if (!r || !from.includes(r.status)) return null;
    return this.update(id, p);
  }
  async update(id: string, p: Partial<LaunchPatch>) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    for (const [k, v] of Object.entries(p)) if (v !== undefined) (r as any)[k] = v;
    r.updatedAt = this.now();
    return { ...r };
  }
}
