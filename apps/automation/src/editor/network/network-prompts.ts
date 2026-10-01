import type { EditorCard } from '../card';
import { cardSummary } from '../card';
import type { MemoryEntry } from '../repo/editor-memory.repository';
import type { SkillSource } from '../skills/skill-library';
import type { EditorRole } from '../llm/llm.types';
import { localDate, localTimeLabel, localWeekday } from '../roles/time';
import { capabilitiesSummary, implementedFormats } from '../platform/capabilities';
import type { NetworkCtx } from './network-context';
import type { IdeaRow } from './network.repository';
import { renderPlaybook, seriesDue } from './playbook';

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
  return memory.length ? memory.map((m) => `- [${m.kind}${m.createdBy === 'owner' ? ', власник' : ''}] ${m.text}`).join('\n') : '- (порожня)';
}

export function resourcesBlock(net: NetworkCtx): string {
  return net.resources.map((r) => `- ${r.ref} (${r.platform}): формати ${r.platform === 'telegram' ? net.telegramFormats.join(', ') : implementedFormats(r.platform).join(', ') || 'поки немає'}`).join('\n');
}

/** System prompt of an orchestrator run (playbook upkeep, idea pool) — spec 020. */
export function orchestratorSystemPrompt(o: { net: NetworkCtx; card: EditorCard; profile: string | null; memory: MemoryEntry[]; skills: SkillSource; directives?: string | null }): string {
  const { net } = o;
  const platforms = [...new Set(net.resources.map((r) => r.platform))];
  return [
    `Ти — @${net.orchestrator.handle} «${net.orchestrator.name}», оркестратор ${net.mode === 'orchestrated' ? `мережі «${net.groupName}»` : `каналу ${net.anchorKey}`} у медіамережі ai0.`,
    'Ти відповідаєш за стратегію: плейбук (що, куди, як часто) і пул ідей, з яких планувальник складає день. Публікують виконавці; ти не публікуєш.',
    'Правило власника важливіше за директиву менеджера, директива — важливіша за твоє власне рішення. Факти — лише з джерел, які ти прочитав; нічого не вигадуєш.',
    'Код перевіряє всі правила (формати, частоти, дублікати). Якщо інструмент повернув error — виправ і спробуй ще раз.',
    '',
    '## Ресурси',
    resourcesBlock(net),
    '',
    '## Можливості платформ',
    capabilitiesSummary(platforms) || '- лише Telegram',
    ...(o.profile ? ['', '## Профіль', o.profile] : []),
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
    `Сьогодні ${WEEKDAYS[localWeekday(o.now, tz)]}, ${localDate(o.now, tz)} ${localTimeLabel(o.now, tz)}.`,
    o.hasDirectives ? '1. Спершу розбери директиви менеджера: accept_directive з планом або reject_directive з причиною (кожну).' : '',
    `${o.hasDirectives ? '2' : '1'}. Пул: прийнятих ${accepted}, на рецензії ${fresh}${revise.length ? `, на доопрацюванні ${revise.length} (revise_idea: ${revise.map((i) => i.id).join(', ')})` : ''}. Ціль — ${o.target} ідей на 2 дні вперед для всіх ресурсів.`,
    'Подивись статистику (get_network_posts, get_platform_stats, get_format_performance), нещодавні пости й джерела (fetch_feed, fetch_api, search_library), і додай ідеї через add_idea — кожна з варіантами під ресурси й форматами плейбука.',
    'Якщо даних достатньо і бачиш, що плейбук варто підкоригувати (ваги, години, хештеги) — зроби це наприкінці через submit_playbook; інакше заверши finish_orchestration з коротким підсумком.',
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

/** Extra block for the planner of an orchestrated network (spec 020 FR-007). */
export function networkPlannerBlock(o: { net: NetworkCtx; accepted: IdeaRow[]; now: Date; tz: string }): string {
  const due = o.net.playbook ? seriesDue(o.net.playbook, localWeekday(o.now, o.tz)) : [];
  return [
    `## Мережа «${o.net.groupName}» — плануєш день для ВСІХ ресурсів`,
    resourcesBlock(o.net),
    '',
    '## Плейбук',
    o.net.playbook ? renderPlaybook(o.net.playbook) : '- немає',
    '',
    '## Серії за розкладом сьогодні',
    due.length ? due.map((d) => `- «${d.series.name}» о ${d.time} → ${d.series.resource_ref} (${d.series.format}): ${d.series.brief}`).join('\n') : '- немає',
    '',
    '## Прийняті ідеї',
    o.accepted.length
      ? o.accepted.map((i) => `- ${i.id}: «${i.title}»${i.angle ? ` — ${i.angle}` : ''}; варіанти: ${i.variants.map((v) => `${v.resource_ref} ${v.format}`).join(', ')}`).join('\n')
      : '- немає (плануй серії; якщо й їх немає — мінімум постів з бібліотеки через series не можна, тож краще менше постів)',
    '',
    'Одна ідея → нативні варіанти на різних ресурсах з інтервалом ≥ 90 хв; Telegram (core) — першим. Заверши submit_network_plan.',
  ].join('\n');
}
