import { z } from 'zod';
import { clip, findingKey } from './audit-text';
import {
  AUDIT_AREAS, AUDIT_SEVERITIES, type AuditArea, type AuditFacts, type AuditSeverity, type Finding, type FindingSubject,
} from './audit.types';

/**
 * Spec 055 FR-002: what the audit pass is given and what it may answer. The model sees the findings (compact) and the texts
 * of the flagged items and of the largest skills and rules; code decides which keys and ids it may name, and drops the rest.
 */

export const ITEM_CHARS = 600;
export const INPUT_CHARS = 24_000;
export const LARGEST_ITEMS = 10;
export const MAX_EXTRA = 8;
export const SUMMARY_CHARS = 600;
const COMMENT_CHARS = 400;
const TITLE_CHARS = 120;
const DETAIL_CHARS = 600;
const MAX_FINDING_LINES = 80;

/** What the model may name: finding keys, and subject ids (of findings and of the texts it was shown). */
export interface AuditAllowed {
  keys:     Set<string>;
  subjects: Map<string, FindingSubject>;
}

export interface AuditInput { text: string; allowed: AuditAllowed }

const findingLine = (f: Finding): string =>
  `- [${f.key}] ${f.severity} ${f.area}/${f.check} · ${clip(f.title, 140)} — ${f.subject.label}${f.subject.agent ? ` (@${f.subject.agent})` : ''}${f.fix ? ` · виправлення: ${f.fix.kind}` : ''}`;

/**
 * The model's input. Findings first (the work), then the texts: flagged items before the largest ones, each clipped to 600
 * characters, the whole input to 24 000. Everything the model is shown by id can be the subject of one of its own findings.
 */
export function buildAuditInput(findings: Finding[], facts: AuditFacts): AuditInput {
  const allowed: AuditAllowed = { keys: new Set(), subjects: new Map() };
  const lines: string[] = [];
  let used = 0;
  const push = (s: string): boolean => {
    if (used + s.length + 1 > INPUT_CHARS) return false;
    lines.push(s);
    used += s.length + 1;
    return true;
  };

  push(`## Знахідки коду (${findings.length}${findings.length > MAX_FINDING_LINES ? `, показано ${MAX_FINDING_LINES}` : ''})`);
  if (!findings.length) push('- немає');
  for (const f of findings.slice(0, MAX_FINDING_LINES)) {
    if (!push(findingLine(f))) break;
    allowed.keys.add(f.key);
    allowed.subjects.set(f.subject.id, f.subject);
  }

  const flagged = (type: FindingSubject['type']) => new Set(findings.filter((f) => f.subject.type === type).map((f) => f.subject.id));
  const bySize = <T extends { text: string }>(xs: T[]) => [...xs].sort((a, b) => b.text.length - a.text.length).slice(0, LARGEST_ITEMS);

  // Skills: flagged ones first, then the largest (one text per skill id).
  const skillFlag = flagged('skill');
  const skills = facts.skills.map((s) => ({ ...s, text: s.body }));
  const pickedSkills = [...skills.filter((s) => skillFlag.has(s.id)), ...bySize(skills.filter((s) => !skillFlag.has(s.id)))];
  push('', );
  push('## Скіли (id · назва · звідки): початок тексту');
  for (const s of pickedSkills) {
    const subject: FindingSubject = { type: 'skill', id: s.id, label: s.name, ...(s.agent ? { agent: s.agent } : {}) };
    if (!push(`- ${s.id} · ${s.name} · ${s.scope}${s.agent ? ` @${s.agent}` : ''}${skillFlag.has(s.id) ? ' · позначено' : ''}: ${clip(s.body, ITEM_CHARS)}`)) break;
    if (!allowed.subjects.has(s.id)) allowed.subjects.set(s.id, subject);
  }

  // Owner rules: flagged first, then the largest.
  const ruleFlag = flagged('rule');
  const rules = facts.rules.map((r) => ({ ...r, key: `${r.channel}#${r.id}` }));
  const ruleText = rules.map((r) => ({ ...r }));
  const pickedRules = [...ruleText.filter((r) => ruleFlag.has(r.key)), ...bySize(ruleText.filter((r) => !ruleFlag.has(r.key)))];
  push('');
  push('## Правила власника (id · канал): текст');
  for (const r of pickedRules) {
    const subject: FindingSubject = { type: 'rule', id: r.key, label: clip(r.text, 80), channel: r.channel, ...(r.agent ? { agent: r.agent } : {}) };
    if (!push(`- ${r.key} · ${r.channel}${ruleFlag.has(r.key) ? ' · позначено' : ''}: ${clip(r.text, ITEM_CHARS)}`)) break;
    if (!allowed.subjects.has(r.key)) allowed.subjects.set(r.key, subject);
  }

  // Memory rows the findings point at.
  const memFlag = flagged('memory');
  const mem = facts.memory.filter((m) => memFlag.has(`${m.channel}#${m.id}`));
  if (mem.length) {
    push('');
    push('## Рядки памʼяті (id · канал · хто записав): текст');
    for (const m of mem) {
      const id = `${m.channel}#${m.id}`;
      if (!push(`- ${id} · ${m.channel} · ${m.createdBy}: ${clip(m.text, ITEM_CHARS)}`)) break;
      if (!allowed.subjects.has(id)) allowed.subjects.set(id, { type: 'memory', id, label: clip(m.text, 80), channel: m.channel });
    }
  }
  return { text: lines.join('\n'), allowed };
}

// ── submit_audit ────────────────────────────────────────────────────────────

/** Lenient on purpose: a wrong enum or an over-long text is clipped or dropped by the code, not sent back to the model for a retry. */
export const SubmitAuditInput = z.object({
  summary:  z.string().max(4000).describe('До 600 символів українською: що найважливіше цього тижня.'),
  comments: z.array(z.object({ key: z.string().max(80), comment: z.string().max(2000) })).max(120).default([])
    .describe('Коментар до знахідки за її ключем із списку знахідок.'),
  extra:    z.array(z.object({
    subject:  z.string().max(200).describe('id тексту зі вхідних даних'),
    area:     z.string().max(20).describe('skills | memory | rules | tools | prompt'),
    severity: z.string().max(10).describe('info | warn | error'),
    title:    z.string().max(400),
    detail:   z.string().max(4000),
  })).max(30).default([]).describe('До 8 власних знахідок: тексти, що марні, суперечливі, шкідливі чи застарілі.'),
});
export type SubmitAuditInput = z.infer<typeof SubmitAuditInput>;

export interface AuditSubmission {
  summary:  string;
  comments: Record<string, string>;
  /** Judgement findings: never a fix (FR-002). */
  extra:    Finding[];
  dropped:  { comments: number; extra: number };
}

const isArea = (v: string): v is AuditArea => (AUDIT_AREAS as readonly string[]).includes(v);
const isSeverity = (v: string): v is AuditSeverity => (AUDIT_SEVERITIES as readonly string[]).includes(v);

/** The model's answer, checked in code: unknown keys and ids dropped, texts clipped, at most 8 extras, no fixes. */
export function sanitizeSubmission(input: SubmitAuditInput, allowed: AuditAllowed): AuditSubmission {
  const comments: Record<string, string> = {};
  let droppedComments = 0;
  for (const c of input.comments) {
    const text = clip(c.comment, COMMENT_CHARS);
    if (!allowed.keys.has(c.key) || !text || comments[c.key]) { droppedComments++; continue; }
    comments[c.key] = text;
  }
  const extra: Finding[] = [];
  let droppedExtra = 0;
  for (const x of input.extra) {
    const subject = allowed.subjects.get(x.subject.trim());
    const title = clip(x.title, TITLE_CHARS);
    const detail = clip(x.detail, DETAIL_CHARS);
    const area = x.area.trim().toLowerCase();
    const severity = x.severity.trim().toLowerCase();
    if (!subject || !title || !detail || !isArea(area) || extra.length >= MAX_EXTRA) { droppedExtra++; continue; }
    const key = findingKey(area, 'llm_judgement', { type: subject.type, id: `${subject.id}~${title.toLowerCase().replace(/\s+/g, ' ')}`, agent: subject.agent, channel: subject.channel });
    if (extra.some((e) => e.key === key)) { droppedExtra++; continue; }
    extra.push({
      key, area, check: 'llm_judgement', severity: isSeverity(severity) ? severity : 'info', subject, title, detail,
      evidence: { source: 'llm' },
    });
  }
  return { summary: clip(input.summary, SUMMARY_CHARS), comments, extra, dropped: { comments: droppedComments, extra: droppedExtra } };
}
