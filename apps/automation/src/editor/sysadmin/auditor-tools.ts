import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { cardSummary, type EditorCard } from '../card';
import type { MemoryEntry } from '../repo/editor-memory.repository';
import { clip } from './audit-text';
import { sanitizeSubmission, SubmitAuditInput, type AuditAllowed, type AuditSubmission } from './auditor-input';

/**
 * Spec 055 FR-002: the tools of the audit pass. `submit_audit` is the terminal one; `inspect_channel_memory` and
 * `inspect_channel_card` are the read-only counterparts of get_channel_memory / get_channel_card, which need a run
 * channel — the audit has none and looks at any channel by key. `load_skill` / `list_skills` come with the read tools
 * (role `auditor`, over the skills the runner passes in `extras.skills`).
 */

export const AUDITOR_TOOLS = new Set(['submit_audit', 'load_skill', 'list_skills', 'inspect_channel_memory', 'inspect_channel_card']);

export interface AuditorToolDeps {
  memory: { listActive(channelKey: string, limit?: number): Promise<MemoryEntry[]> };
  card:   (channelKey: string) => Promise<EditorCard | null>;
}

/** What the runner puts in `ctx.extras.audit` for the tools. */
export interface AuditRunExtras {
  allowed: AuditAllowed;
  /** Set by submit_audit; the runner reads it back from the tool result too. */
  submission?: AuditSubmission;
}

const MEMORY_ROWS = 40;
const MEMORY_ROW_CHARS = 400;

export function buildAuditorTools(d: AuditorToolDeps): EditorTool[] {
  const submit = defineTool({
    name: 'submit_audit',
    description: [
      'Завершити аудит: summary (до 600 символів, головне цього тижня), comments (коментар до знахідок за ключем) і extra (до 8 власних знахідок з id тексту зі входу).',
      'Невідомі ключі й id код відкидає; до власних знахідок виправлення не додається. Виклич один раз.',
    ].join(' '),
    kind: 'terminal', roles: ['auditor'],
    input: SubmitAuditInput,
    execute: async (i, ctx) => {
      const audit = ctx.extras?.audit as AuditRunExtras | undefined;
      if (!audit) return { error: 'no_audit_context' };
      const s = sanitizeSubmission(i, audit.allowed);
      audit.submission = s;
      return { ok: true, comments: Object.keys(s.comments).length, extra: s.extra.length, dropped: s.dropped };
    },
  });

  const memory = defineTool({
    name: 'inspect_channel_memory',
    description: 'Памʼять каналу за ключем (@name): активні рядки, правила власника першими; кожен з id, видом, автором і текстом (до 400 символів).',
    kind: 'read', roles: ['auditor'],
    input: z.object({ channel: z.string().min(2).max(100) }),
    execute: async ({ channel }) => {
      const rows = await d.memory.listActive(channel, MEMORY_ROWS);
      if (!rows.length) return { error: 'no_memory', details: `no active memory rows for ${channel}` };
      return {
        channel,
        rows: rows.map((r) => ({ id: `${channel}#${r.id}`, kind: r.kind, by: r.createdBy, at: r.createdAt, text: clip(r.text, MEMORY_ROW_CHARS) })),
      };
    },
  });

  const card = defineTool({
    name: 'inspect_channel_card',
    description: 'Редакційна картка каналу за ключем (@name): тематика, формати з вагами, словник, джерела, ліміти.',
    kind: 'read', roles: ['auditor'],
    input: z.object({ channel: z.string().min(2).max(100) }),
    execute: async ({ channel }) => {
      const c = await d.card(channel);
      return c ? cardSummary(c) : { error: 'unknown_channel', details: `no channel ${channel}` };
    },
  });

  return [submit, memory, card];
}
