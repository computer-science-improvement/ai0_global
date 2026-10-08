import type { EditorCard } from '../card';
import { cardSummary } from '../card';
import type { MemoryEntry } from '../repo/editor-memory.repository';
import type { SkillSource } from '../skills/skill-library';
import type { EditorRole } from '../llm/llm.types';
import { localDate, localTimeLabel, localWeekday } from '../roles/time';
import { capabilitiesSummary, implementedFormats } from '../platform/capabilities';
import type { NetworkCtx } from './network-context';
import { DEFAULT_TZ, resourceTimeLines } from '../time/resource-time';
import type { IdeaRow } from './network.repository';
import { renderPlaybook, seriesDue } from './playbook';
import type { ResourceProfile } from '../agents/resource-profile';

const WEEKDAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
const BUDGET = 8_000;

function skillsBlock(skills: SkillSource, role: EditorRole, inlineNames: string[]): string {
  let budget = BUDGET;
  const inline: string[] = [];
  const names = [...new Set([...inlineNames, ...(skills.inlineNames?.() ?? [])])];
  for (const n of names) {
    const s = skills.get(n);
    if (!s || s.body.length > budget) continue;
    budget -= s.body.length;
    inline.push(`### skill: ${s.name}\n${s.body}`);
  }
  const listed = skills.list(role).filter((s) => !names.includes(s.name)).map((s) => `- ${s.name}: ${s.description}`).join('\n');
  return ['## Скіли, завантажені одразу', inline.join('\n\n') || '- немає', '', '## Інші скіли (load_skill)', listed || '- немає'].join('\n');
}

function memoryBlock(memory: MemoryEntry[]): string {
  return memory.length ? memory.map((m) => `- #${m.id} [${m.kind}${m.createdBy === 'owner' ? ', власник' : ''}] ${m.text}`).join('\n') : '- (порожня)';
}

export function resourcesBlock(net: NetworkCtx): string {
  return net.resources.map((r) => `- ${r.ref} (${r.platform}): формати ${r.platform === 'telegram' ? net.telegramFormats.join(', ') : implementedFormats(r.platform).join(', ') || 'поки немає'}`).join('\n');
}

/**
 * Spec 024 FR-005: the anchor's "now" is in the prompt already; this adds one
 * line per resource outside Kyiv (`instagram:x — America/New_York, зараз 09:12`).
 */
export function resourceClocksBlock(net: NetworkCtx, now: Date): string[] {
  const lines = resourceTimeLines(net.resources.map((r) => ({ ref: r.ref, tz: r.tz })), now);
  return lines.length
    ? ['', '## Час ресурсів (не Київ)', ...lines.map((l) => `- ${l}`), `Решта ресурсів — ${DEFAULT_TZ}. Час слота, найкращі години, тихі години й серії — у часовому поясі свого ресурсу.`]
    : [];
}

/** System prompt of an orchestrator run (playbook upkeep, idea pool) — spec 020. */
export function orchestratorSystemPrompt(o: { net: NetworkCtx; card: EditorCard; profile: string | null; memory: MemoryEntry[]; skills: SkillSource; directives?: string | null; profiles?: Array<{ ref: string; profile: Parameters<typeof compactProfile>[0] | null }> }): string {
  const { net } = o;
  const platforms = [...new Set(net.resources.map((r) => r.platform))];
  return [
    `Ти — @${net.orchestrator.handle} «${net.orchestrator.name}», оркестратор ${net.mode === 'independent' ? `мережі «${net.groupName}»` : `каналу ${net.anchorKey}`} у медіамережі ai0.`,
    'Ти відповідаєш за план контенту мережі: плейбук (що, куди, як часто), серії і пул ідей, з яких планувальник складає день. Публікують виконавці; ти не публікуєш.',
    'Правило власника важливіше за директиву менеджера, директива — важливіша за твоє власне рішення. Факти — лише з джерел, які ти прочитав; нічого не вигадуєш.',
    'Код перевіряє всі правила (формати, частоти, дублікати). Якщо інструмент повернув error — виправ і спробуй ще раз.',
    '',
    '## Ресурси',
    resourcesBlock(net),
    '',
    '## Можливості платформ',
    capabilitiesSummary(platforms) || '- лише Telegram',
    ...(o.profile ? ['', '## Профіль', o.profile] : []),
    ...resourceProfilesBlock(o.profiles ?? []),
    '',
    '## Картка Telegram-каналу',
    JSON.stringify({ ...cardSummary(o.card), capabilities: undefined }, null, 1),
    '',
    '## Плейбук',
    net.playbook ? `v${net.playbookVersion}\n${renderPlaybook(net.playbook)}` : '- ще немає',
    ...(o.directives ? ['', '## Директиви менеджера (вхідні)', o.directives] : []),
    '',
    '## Памʼять',
    memoryBlock(o.memory),
    '',
    skillsBlock(o.skills, 'orchestrator', ['editor-orchestrator-workflow']),
  ].join('\n');
}

export function orchestratorDailyPrompt(o: { net: NetworkCtx; card: EditorCard; now: Date; open: IdeaRow[]; target: number; hasDirectives: boolean }): string {
  const tz = o.card.timezone;
  const accepted = o.open.filter((i) => i.status === 'accepted').length;
  const fresh = o.open.filter((i) => i.status === 'new').length;
  const revise = o.open.filter((i) => i.status === 'needs_revision');
  return [
    `Сьогодні ${WEEKDAYS[localWeekday(o.now, tz)]}, ${localDate(o.now, tz)} ${localTimeLabel(o.now, tz)}${tz === DEFAULT_TZ ? '' : ` (${tz})`}.`,
    ...resourceClocksBlock(o.net, o.now).slice(1),
    o.hasDirectives ? '1. Спершу розбери директиви менеджера: accept_directive з планом або reject_directive з причиною (кожну).' : '',
    `${o.hasDirectives ? '2' : '1'}. Пул: прийнятих ${accepted}, на рецензії ${fresh}${revise.length ? `, на доопрацюванні ${revise.length} (revise_idea: ${revise.map((i) => i.id).join(', ')})` : ''}. Ціль — ${o.target} ідей на 2 дні вперед для всіх ресурсів.`,
    'Подивись статистику (get_network_posts, get_platform_stats, get_format_performance), нещодавні пости й джерела (fetch_feed, fetch_api, library_catalog), і додай ідеї через add_idea — кожна з варіантами під ресурси й форматами плейбука.',
    'Пост, що вже добре зайшов на одному ресурсі (get_network_posts), можна продублювати чи адаптувати на інші ресурси мережі через repurpose_post — час і інтервал обираєш ти, оформлення під ресурс теж твоє (як вирішувати — скіл resource-decisions).',
    'Форматування кожного ресурсу (format_prefs: get_resource_format) — твоє: змінюй update_resource_format, коли KPI або правки власника (у режимі апруву його правки постів — у памʼяті) показують, що інша подача працює краще. Поля, закріплені власником, не чіпай; не більше 3 змін на ресурс за день, не туди-сюди.',
    'Серії (рубрики) змінюй точково: list_series, define_series, update_series, set_series_active (так виконується директива pause_series), retire_series — не більше 5 змін за прогін. Серії власника (locked) не чіпай: якщо бачиш, що їх варто змінити, напиши це в підсумку.',
    'Якщо даних достатньо і бачиш, що решту плейбука варто підкоригувати (ваги, години, хештеги) — зроби це наприкінці через submit_playbook; інакше заверши finish_orchestration з коротким підсумком.',
  ].filter(Boolean).join('\n');
}

export function playbookBuildPrompt(o: { net: NetworkCtx; brief: string | null; now: Date; tz: string }): string {
  return [
    `Сьогодні ${localDate(o.now, o.tz)}. ${o.net.playbook ? `Перебудуй плейбук (зараз v${o.net.playbookVersion}).` : 'Склади перший плейбук.'}`,
    o.brief?.trim() ? `Бриф власника:\n«${o.brief.trim()}»` : 'Брифу немає — запропонуй плейбук зі статистики й профілю, поясни в rationale, на яких даних він стоїть.',
    'Секція на КОЖЕН ресурс зі списку: роль (core для Telegram, discovery / funnel_to:<ref> для інших), формати лише з доступних, частота, найкращі години, тон, хештеги, заклик.',
    'Серії — лише ті, що просив власник або явно випливають з даних. Правила з брифу перенеси в rules дослівно-коротко.',
    'Спершу подивись статистику (get_network_posts, get_platform_stats, get_format_performance). Заверши submit_playbook.',
  ].join('\n');
}

export function ideaReviewerSystemPrompt(o: { net: NetworkCtx; profile: string | null; memory: MemoryEntry[]; skills: SkillSource }): string {
  return [
    `Ти — рецензент ідей оркестратора @${o.net.orchestrator.handle}. Ти не пишеш пости: ти оцінюєш ідеї (і чернетки плейбука) суворо і по суті.`,
    'Приймаєш лише ідеї, які можна перевірити за джерелами, що пасують профілю й плейбуку, нові для аудиторії і безпечні. Сумнів — revise з конкретною вимогою або reject.',
    '',
    '## Ресурси',
    resourcesBlock(o.net),
    ...(o.profile ? ['', '## Профіль', o.profile] : []),
    '',
    '## Плейбук',
    o.net.playbook ? renderPlaybook(o.net.playbook) : '- ще немає',
    '',
    '## Памʼять',
    memoryBlock(o.memory),
    '',
    skillsBlock(o.skills, 'idea_reviewer', ['idea-review']),
  ].join('\n');
}

export function ideaReviewerUserPrompt(o: { fresh: number; pendingPlaybook: boolean }): string {
  return [
    o.fresh ? `На рецензії ${o.fresh} нових ідей: list_ideas(status=[new]) і review_idea для кожної.` : 'Нових ідей немає.',
    o.pendingPlaybook ? 'Є чернетка плейбука на затвердження власнику: get_playbook і review_playbook (коротко, по пунктах).' : '',
    'Для перевірки новизни дивись get_network_posts; для перевірки джерел можна web_fetch. Заверши finish_idea_review.',
  ].filter(Boolean).join('\n');
}

/** Extra block for the planner of an independent network (spec 020 FR-007, 024 FR-005). */
/** One line of a member resource's profile — what the per-resource decisions cite (spec 024 FR-012). */
export function compactProfile(p: Pick<ResourceProfile, 'topic' | 'audience' | 'language' | 'goals' | 'taboo'> & { tone?: string }): string {
  const aud = [p.audience?.who, p.audience?.age, p.audience?.region].filter(Boolean).join(', ');
  return [
    `тема: ${p.topic}`, aud ? `аудиторія: ${aud}` : '', `мова: ${p.language}`, p.goals?.length ? `цілі: ${p.goals.join(' > ')}` : '',
    p.taboo?.length ? `табу: ${p.taboo.join(', ')}` : '', p.tone ? `тон: ${p.tone}` : '',
  ].filter(Boolean).join('; ');
}

/** "## Профілі ресурсів": each member's own profile, so a decision can name it (empty when none is described). */
export function resourceProfilesBlock(profiles: Array<{ ref: string; profile: Parameters<typeof compactProfile>[0] | null }>): string[] {
  const lines = profiles.filter((x) => x.profile).map((x) => `- ${x.ref}: ${compactProfile(x.profile!)}`);
  return lines.length ? ['', '## Профілі ресурсів (кожен ресурс — окрема одиниця)', ...lines, 'Ресурс без профілю — за профілем мережі.'] : [];
}

export function networkPlannerBlock(o: { net: NetworkCtx; accepted: IdeaRow[]; now: Date; tz: string; planDate?: string; profiles?: Array<{ ref: string; profile: Parameters<typeof compactProfile>[0] | null }> }): string {
  // The plan date is one calendar date for every resource, so its weekday is the same in every zone.
  const planDate = o.planDate ?? localDate(o.now, o.tz);
  const due = o.net.playbook ? seriesDue(o.net.playbook, new Date(`${planDate}T12:00:00Z`).getUTCDay()) : [];
  const tzOf = new Map(o.net.resources.map((r) => [r.ref, r.tz]));
  return [
    `## Мережа «${o.net.groupName}» — плануєш день ${planDate} для ВСІХ ресурсів`,
    resourcesBlock(o.net),
    ...resourceClocksBlock(o.net, o.now),
    ...resourceProfilesBlock(o.profiles ?? []),
    '',
    '## Плейбук',
    o.net.playbook ? renderPlaybook(o.net.playbook) : '- немає',
    '',
    '## Серії за розкладом сьогодні',
    due.length ? due.map((d) => {
      const tz = tzOf.get(d.series.resource_ref);
      return `- «${d.series.name}» о ${d.time}${tz && tz !== DEFAULT_TZ ? ` (${tz})` : ''} → ${d.series.resource_ref} (${d.series.format}): ${d.series.brief}`;
    }).join('\n') : '- немає',
    '',
    '## Прийняті ідеї',
    o.accepted.length
      ? o.accepted.map((i) => `- ${i.id}: «${i.title}»${i.angle ? ` — ${i.angle}` : ''}; варіанти (підказка): ${i.variants.map((v) => `${v.resource_ref} ${v.format}`).join(', ')}`).join('\n')
      : '- немає (плануй серії; якщо й їх немає — мінімум постів з бібліотеки через series не можна, тож краще менше постів)',
    '',
    '## Рішення по ресурсах (кожен ресурс — окрема одиниця)',
    'Для кожної ідеї, яку береш у план, вирішуй окремо для КОЖНОГО ресурсу з секцією плейбука — рівно одне рішення з reason (сигнал профілю, плейбука чи KPI; як вирішувати — скіл resource-decisions):',
    '- unique — свій пост для цього ресурсу (формат з плейбука);',
    '- duplicate — той самий пост, що на іншому ресурсі (from_slot = його номер); оформлення під ресурс зробиш ти сам за format_prefs, можна додати format_notes;',
    '- adapt — та сама ідея й факти, переписані нативно під платформу (from_slot теж обовʼязковий);',
    '- skip — у skips з причиною: не та тема для профілю, ресурс слабкий у цьому форматі, частота вичерпана.',
    'Варіанти ідеї — підказка, не вимога. Напрям дублювання будь-який (і з Instagram у Telegram). Похідний слот — не раніше за джерело, інтервал обираєш ти (0 — одночасно); ланцюжків немає — джерело завжди unique.',
    'Інтервали між постами одного ресурсу на платформах — на твій розсуд (орієнтир: ≥ 60 хв; між варіантами однієї ідеї — пару годин, якщо аудиторії перетинаються); код стежить лише за частотою, тихими годинами й лімітами API. Інтервал у Telegram задає картка каналу.',
    'Заверши submit_network_plan.',
  ].join('\n');
}
