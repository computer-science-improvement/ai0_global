import type { EditorRole } from '../llm/llm.types';

export const SKILL_NAME_RE = /^[a-z0-9-]{3,48}$/;
export const SKILL_MAX_BODY = 12_000;
export const SKILL_MAX_INLINE_BODY = 4_000;

export const SKILL_ROLES: readonly EditorRole[] = [
  'planner', 'executor', 'reviewer', 'checker', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder',
];

export interface SkillDraft {
  name:        string;
  description: string;
  appliesTo:   string[];
  body:        string;
  inline?:     boolean;
}

export interface SkillLintIssue {
  code:    string;
  message: string;
  /** Hard blocks cannot be forced even by the owner (guard bypass, secrets). */
  hard?:   boolean;
}

export interface SkillLintResult {
  ok:       boolean;
  errors:   SkillLintIssue[];
  warnings: SkillLintIssue[];
}

/**
 * Instructions a skill must never contain (spec 017 FR-007), in uk / ru / en.
 * `hard` patterns cannot be overridden by the owner either: they would disarm
 * the deterministic guards that the constitution (I) puts between a model and a
 * public channel.
 */
const BLOCKED: Array<{ code: string; re: RegExp; hard: boolean; message: string }> = [
  {
    code: 'guard_bypass', hard: true, message: 'скіл не може вимагати обходити перевірки (lint, dedup, бюджет, тихі години)',
    re: /(?:обійд\p{L}*|обход\p{L}*|пропуска\p{L}*|пропусти\p{L}*|ігнору\p{L}*|игнорир\p{L}*|не\s+(?:виклика\p{L}*|роби|делай|запуска\p{L}*)|bypass|skip|disable|ignore|without)\s+(?:\S+\s+){0,3}?(?:lint\p{L}*|перевір\p{L}*|провер\p{L}*|guard\p{L}*|dedup\p{L}*|дедуп\p{L}*|budget|бюджет\p{L}*|тих\p{L}+\s+годин\p{L}*|quiet\s+hours|checks?)/iu,
  },
  {
    code: 'ignore_instructions', hard: true, message: 'скіл не може скасовувати системні чи попередні інструкції',
    re: /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system)\s+instructions|ігноруй\s+(?:\S+\s+){0,2}?(?:попередні|системні|вище)\s+інструкц\p{L}*|игнорируй\s+(?:\S+\s+){0,2}?(?:предыдущие|системные)\s+инструкц\p{L}*/iu,
  },
  {
    code: 'secrets', hard: true, message: 'скіл не може просити розкривати ключі, токени, паролі чи системний промпт',
    re: /(?:розкри\p{L}*|покажи|виведи|надішли|раскрой|покажи|выведи|reveal|print|show|send|leak)\s+(?:\S+\s+){0,3}?(?:ключ\p{L}*|токен\p{L}*|парол\p{L}*|api[\s_-]?key|tokens?|passwords?|secrets?|system\s+prompt|системн\p{L}+\s+промпт\p{L}*)/iu,
  },
  {
    code: 'publish_unchecked', hard: true, message: 'скіл не може вимагати публікувати без lint чи без перевірок',
    re: /(?:публікуй|опублікуй|публикуй|опубликуй|publish|post)\s+(?:\S+\s+){0,3}?(?:без|without)\s+(?:\S+\s+){0,2}?(?:lint|перевір\p{L}*|провер\p{L}*|checks?|review)/iu,
  },
  {
    code: 'impersonation', hard: false, message: 'агенти не видають себе за людину (принцип VIII)',
    re: /(?:видавай\s+себе\s+за\s+людин\p{L}*|кажи,?\s+що\s+ти\s+(?:людина|живий)|выдавай\s+себя\s+за\s+человек\p{L}*|pretend\s+(?:to\s+be|you\s+are)\s+(?:a\s+)?human|claim\s+to\s+be\s+(?:a\s+)?human)/iu,
  },
  {
    code: 'third_party_contact', hard: false, message: 'скіли редакції не пишуть стороннім людям (це спека 011, окремий агент)',
    re: /(?:напиши|пиши|надішли|напиши\s+в\s+лс|write\s+to|dm|message)\s+(?:\S+\s+){0,2}?(?:адмін\p{L}*|власник\p{L}*\s+(?:іншого|чужого)|admins?\s+of|other\s+channel\s+owners?)/iu,
  },
];

function parseFront(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** Validate a skill draft from any author (owner, agent, repo). Errors are data. */
export function lintSkill(s: SkillDraft): SkillLintResult {
  const errors: SkillLintIssue[] = [];
  const warnings: SkillLintIssue[] = [];

  if (!SKILL_NAME_RE.test(s.name)) errors.push({ code: 'name', message: 'name: 3–48 символів a-z, 0-9 і дефіс' });
  const desc = (s.description ?? '').trim();
  if (desc.length < 10 || desc.length > 300) errors.push({ code: 'description', message: 'description: 10–300 символів' });
  const unknown = (s.appliesTo ?? []).filter((r) => !(SKILL_ROLES as readonly string[]).includes(r));
  if (unknown.length) errors.push({ code: 'applies_to', message: `невідомі ролі в applies_to: ${unknown.join(', ')}` });
  if (!(s.appliesTo ?? []).length) errors.push({ code: 'applies_to', message: 'applies_to: хоча б одна роль' });

  const body = s.body ?? '';
  if (!body.trim()) errors.push({ code: 'body_empty', message: 'порожній текст скіла' });
  if (body.length > SKILL_MAX_BODY) errors.push({ code: 'body_too_long', message: `текст скіла до ${SKILL_MAX_BODY} символів (зараз ${body.length})` });
  if (s.inline && body.length > SKILL_MAX_INLINE_BODY) {
    warnings.push({ code: 'inline_too_long', message: `для "завжди в контексті" до ${SKILL_MAX_INLINE_BODY} символів — збережено як "на вимогу"` });
  }
  if (/^---\n/.test(body)) {
    const fm = parseFront(body.split('\n---')[0] ?? '');
    if (fm.name && fm.name !== s.name) warnings.push({ code: 'frontmatter_name', message: 'frontmatter у тексті ігнорується; назва береться з поля name' });
  }

  for (const b of BLOCKED) {
    if (b.re.test(`${desc}\n${body}`)) errors.push({ code: b.code, message: b.message, hard: b.hard });
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Owner may force soft lint errors with an explicit "I understand" flag; hard ones never. */
export function canForce(r: SkillLintResult): boolean {
  return r.errors.length > 0 && r.errors.every((e) => !e.hard && !['name', 'description', 'applies_to', 'body_empty', 'body_too_long'].includes(e.code));
}
