import { z } from 'zod';
import { defineTool, EditorTool } from '../harness/tool';
import type { DocStore } from './doc-store';
import type { StoredDoc } from './doc-types';
import { findIn, findSection, pageOf, READ_MAX_CHARS } from './doc-view';

/**
 * Spec 065 FR-001: read a large page like a file. web_fetch keeps the whole document and hands out a `doc_id`; these two
 * tools read it — one section or a character range at a time, and snippets around a query.
 */
const ROLES = ['planner', 'executor', 'reviewer', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder', 'auditor'] as const;

/** read_doc may return a whole code block past `max_chars` (see `pageOf`), so its result cap is wider than the usual 8k. */
const READ_RESULT_MAX = 20_000;

export function docExpired(docs: DocStore, id: string) {
  const url = docs.urlOf(id);
  return {
    error: 'doc_expired',
    details: url ? `документ ${id} уже не зберігається — виклич web_fetch(${url}) ще раз` : `документа ${id} немає — виклич web_fetch сторінки ще раз`,
    ...(url ? { url } : {}),
  };
}

const imagesOf = (doc: StoredDoc, from: number, to: number) =>
  doc.sections.flatMap((s) => s.images).filter((i) => i.at >= from && i.at < to).map((i) => ({ src: i.src, alt: i.alt }));

export function buildDocTools(d: { docs: DocStore }): EditorTool[] {
  const readDoc = defineTool({
    name: 'read_doc',
    description: 'Прочитати частину великого документа, який повернув web_fetch (doc_id). section — id секції з outline (s7) або її заголовок; або from — зсув у символах (next_from з попередньої відповіді). Віддає до max_chars (≤ 6000) тексту, не обрізає блок коду посередині (він іде цілий або наступною сторінкою), images — зображення цього шматка у порядку документа, next_from — звідки читати далі (null — кінець).',
    kind: 'read', roles: [...ROLES], maxResultChars: READ_RESULT_MAX,
    input: z.object({
      doc_id:    z.string().min(3).max(40),
      section:   z.string().min(1).max(200).optional().describe('id секції (s7) або заголовок'),
      from:      z.number().int().min(0).optional().describe('зсув у символах документа (next_from)'),
      max_chars: z.number().int().min(200).max(READ_MAX_CHARS).default(READ_MAX_CHARS),
    }),
    execute: async ({ doc_id, section, from, max_chars }) => {
      const doc = d.docs.get(doc_id);
      if (!doc) return docExpired(d.docs, doc_id);
      let lo = 0;
      let hi = doc.text.length;
      let sec: { id: string; heading: string; level: number } | null = null;
      if (section) {
        const s = findSection(doc, section);
        if (!s) return { error: 'unknown_section', details: `секції «${section}» немає; id секцій — з outline (s1…s${doc.sections.length})` };
        lo = s.start; hi = s.end;
        sec = { id: s.id, heading: s.heading, level: s.level };
      }
      const page = pageOf(doc, Math.min(Math.max(from ?? lo, lo), hi), hi, max_chars);
      const images = imagesOf(doc, page.from, page.to);
      return {
        doc_id, ...(sec ? { section: sec } : {}), from: page.from, to: page.to, size_chars: doc.text.length,
        text: page.text, ...(images.length ? { images } : {}), next_from: page.next_from,
        ...(page.split_block ? { note: 'блок коду довший за ліміт сторінки і розрізаний по рядку; продовжуй з next_from' } : {}),
      };
    },
  });

  const findInDoc = defineTool({
    name: 'find_in_doc',
    description: 'Знайти місце у великому документі (doc_id з web_fetch): фраза без урахування регістру, а якщо її немає дослівно — місця, де поруч є всі слова запиту. Віддає фрагменти (±300 символів) з id секції й offset (його можна дати в read_doc як from).',
    kind: 'read', roles: [...ROLES],
    input: z.object({
      doc_id: z.string().min(3).max(40),
      query:  z.string().min(2).max(200),
      limit:  z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ doc_id, query, limit }) => {
      const doc = d.docs.get(doc_id);
      if (!doc) return docExpired(d.docs, doc_id);
      const r = findIn(doc, query, limit);
      return {
        doc_id, query, total: r.total, matches: r.matches,
        ...(r.total === 0 ? { note: 'нічого не знайдено; спробуй одне ключове слово або перегляд outline' } : {}),
      };
    },
  });

  return [readDoc, findInDoc];
}
