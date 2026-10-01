import type { CardRole } from '../llm/llm.types';
import { cardSummary, EditorCard } from '../card';
import type { SkillLibrary } from '../skills/skill-library';
import type { MemoryEntry } from '../repo/editor-memory.repository';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { localDate, localTimeLabel, localWeekday } from './time';

const ROLE_TITLE: Record<CardRole, string> = {
  planner:  'редактор-планувальник',
  executor: 'автор і випусковий редактор',
  reviewer: 'аналітик-рецензент',
};

const WEEKDAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
const INLINE_SKILLS_BUDGET = 8_000;

/**
 * System prompt = role + principles + card + memory + the role's workflow
 * skill and the channel's own skills inline; every other skill is only listed
 * (name + description) and loaded on demand via load_skill.
 */
export function buildSystemPrompt(role: CardRole, card: EditorCard, memory: MemoryEntry[], skills: SkillLibrary): string {
  const inlineNames = [`editor-${role}-workflow`, ...card.skills];
  let budget = INLINE_SKILLS_BUDGET;
  const inline: string[] = [];
  for (const name of inlineNames) {
    const s = skills.get(name);
    if (!s || s.body.length > budget) continue;
    budget -= s.body.length;
    inline.push(`### skill: ${s.name}\n${s.body}`);
  }
  const listed = skills.list(role).filter((s) => !inlineNames.includes(s.name));

  return [
    `Ти — ${ROLE_TITLE[role]} Telegram-каналу «${card.title ?? card.channelKey}» (${card.channelKey}) в українській медіамережі ai0.`,
    'Працюєш автономно через інструменти. Усі тексти для читачів — українською, живою мовою, без канцеляриту й AI-штампів.',
    'Принципи: факти перевірені; чужі тексти не копіюєш; один пост — одна думка; краще пропустити, ніж опублікувати слабке.',
    'Код перевіряє всі правила (формат, хештеги, ліміти, тихі години, дублікати). Якщо інструмент повернув error — виправ і спробуй ще раз, не сперечайся з правилами.',
    '',
    '## Картка каналу',
    JSON.stringify(cardSummary(card), null, 1),
    '',
    '## Памʼять каналу (правила власника і висновки минулих тижнів)',
    memory.length
      ? memory.map((m) => `- [${m.kind}${m.createdBy === 'owner' ? ', власник' : ''}] ${m.text}`).join('\n')
      : '- (поки порожня)',
    '',
    '## Скіли, завантажені одразу',
    inline.join('\n\n') || '- немає',
    '',
    '## Інші скіли (завантаж через load_skill, коли потрібні)',
    listed.map((s) => `- ${s.name}: ${s.description}`).join('\n') || '- немає',
  ].join('\n');
}

export function plannerUserPrompt(card: EditorCard, now: Date, reserved: EditorSlot[]): string {
  const tz = card.timezone;
  return [
    `Сьогодні ${WEEKDAYS[localWeekday(now, tz)]}, ${localDate(now, tz)}, зараз ${localTimeLabel(now, tz)} (${tz}).`,
    `Склади план публікацій каналу на сьогодні: ${card.postsPerDayMin}–${card.postsPerDayMax} постів з урахуванням резервних.`,
    reserved.length
      ? `Резервні (рекламні) слоти, їх не чіпай і тримай інтервал: ${reserved.map((r) => localTimeLabel(r.scheduledAt, tz)).join(', ')}.`
      : 'Резервних слотів немає.',
    'Спершу подивись статистику, нещодавні пости й ефективність форматів. Заверши викликом submit_plan.',
  ].join('\n');
}

export function executorUserPrompt(card: EditorCard, slot: EditorSlot, now: Date): string {
  const tz = card.timezone;
  return [
    `Слот на ${localTimeLabel(slot.scheduledAt, tz)} (зараз ${localTimeLabel(now, tz)}).`,
    `Формат: ${slot.format}.`,
    `Тема: ${slot.topic}`,
    slot.angle ? `Кут подачі: ${slot.angle}` : '',
    slot.sourceHints.length ? `Підказки джерел: ${slot.sourceHints.join('; ')}` : 'Підказок джерел немає — обери сам із джерел картки або бібліотеки.',
    slot.isExperiment ? 'Це експеримент: зроби його чисто за задумом планувальника, щоб результат можна було оцінити.' : '',
    'Підготуй пост і опублікуй його через publish_post (після lint_post) або пропусти через skip_slot з причиною.',
  ].filter(Boolean).join('\n');
}

export function reviewerUserPrompt(card: EditorCard, now: Date): string {
  return [
    `Сьогодні ${localDate(now, card.timezone)}. Проаналізуй канал за останні 7 і 28 днів.`,
    'Онови памʼять каналу (add_memory / retire_memory) і за потреби ваги форматів (set_format_weights).',
    'Заверши finish_review з підсумком для власника.',
  ].join('\n');
}
