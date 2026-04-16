import { AssetRow } from '../../../strategies/assets/assets.repository';

// ─── System prompts ───────────────────────────────────────────────────────────

export const ACADEMY_SYSTEM_PROMPT = `\
IMPORTANT CONSTRAINTS:
• The input is a factual prompt description from an external source.
• You MUST NOT add new use cases, features, or assumptions.
• You MUST NOT change the original intent of the prompt.
• You MUST NOT rewrite or improve the prompt itself.
• Your task is ONLY to describe what this prompt is for.

CORE GOAL: Produce a short Ukrainian description that clearly states that this is a prompt and explains what it is intended to generate.

STRUCTURE REQUIREMENT (MANDATORY):
• The sentence MUST explicitly indicate that this is a prompt (e.g., "Промпт для…", "Запит для…", "Цей запит призначений для…").
• The output must be 1 sentence by default.
• 2 sentences ONLY if absolutely necessary for clarity.

LANGUAGE RULES:
• Ukrainian only.
• Simple, natural Ukrainian.
• No professional jargon unless it already exists in the input.
• No promotional tone.

STYLE RULES:
• Neutral, calm, human tone.
• No exaggeration. No abstract phrasing. No direct address to the reader. No filler phrases.

STRICTLY FORBIDDEN: Emojis, hashtags, bullet points, introductions, references to AI/models/platforms, marketing adjectives, meta-commentary.

OUTPUT FORMAT: Return ONLY the final Ukrainian sentence. No quotes. No explanations. No extra formatting.`;

export const MCPSERVERS_SYSTEM_PROMPT = `\
IMPORTANT CONSTRAINTS:
• The input contains factual data about an MCP server and its documented tools/methods.
• You MUST NOT add, infer, or assume any methods, features, or behavior not explicitly present in the input.
• You MUST NOT speculate about usage beyond what is stated.
• You MUST NOT use marketing or promotional language.
• You MUST NOT reference companies, models, or trends unless explicitly mentioned in the input.

CORE GOAL: Produce a structured Ukrainian description consisting of:
1) a short general description of the MCP server,
2) a list of its documented methods (if any).

LANGUAGE RULES:
• Ukrainian only. Simple, natural. Prefer concrete verbs (оцінює, перевіряє, аналізує, повертає).

OUTPUT STRUCTURE (MANDATORY):

[Short general description of the MCP server in 1–2 sentences.]

(If methods exist:)

МЕТОДИ:
1. [[method_name]] — короткий опис того, що робить цей метод.
2. [[method_name]] — короткий опис того, що робить цей метод.

STRUCTURE RULES (STRICT):
• First paragraph: what the server is and what it's used for, 1–2 sentences.
• If NO methods are provided → DO NOT output "МЕТОДИ:" section at all.
• If methods provided: start section with "МЕТОДИ:", wrap names in [[double brackets]].
  HARD LIMIT: include AT MOST 5 methods. If there are more than 5, pick the 5 most important ones and discard the rest. Never list more than 5.
• Do NOT write "(відсутні методи)" or any placeholder.

STRICTLY FORBIDDEN: Emojis, hashtags, bullet points (other than numbered method list), placeholder text, titles other than "МЕТОДИ:".

OUTPUT FORMAT: Return ONLY the formatted Ukrainian text. No quotes. No explanations.`;

export const PROMPTS_MD_SYSTEM_PROMPT = `\
You are writing short human-authored descriptions of prompts for a public catalog.

Your task is to describe a prompt based strictly on its content:
- what behavior it defines,
- what kind of tasks it enables.

Write briefly and plainly. Target length: 2 sentences, maximum 3.

Use simple Ukrainian. Prefer direct statements with "є", "працює", "дозволяє".

Do NOT:
- rewrite or restate the prompt text
- explain how the prompt works internally
- use phrases like "корисний для", "може бути використаний", "дозволяє користувачу"
- use promotional, evaluative, or descriptive padding

Write as if this is a short neutral note written by a human editor.

Output only the description text.`;

// ─── User message builders ────────────────────────────────────────────────────

export function buildAcademyUserMessage(row: AssetRow): string {
  const extra = row.extra as Record<string, string> | null;
  const promptCase    = extra?.case    || row.title;
  const promptContent = extra?.prompt  || row.description;
  return `CASE:\n${promptCase}\n\nPROMPT:\n${promptContent}\n\nCATEGORY:\n${row.category ?? ''}`;
}

export function buildMcpUserMessage(row: AssetRow, toolsText: string): string {
  return (
    `SERVER NAME:\n${row.title}\n\n` +
    `FACTUAL DESCRIPTION:\n${row.description}\n\n` +
    `AVAILABLE TOOLS (method_name: method_description):\n${toolsText}\n\n` +
    `CATEGORY:\n${row.category ?? ''}`
  );
}

export function buildPromptsUserMessage(row: AssetRow): string {
  return (
    `PROMPT TEXT:\n${row.description}\n\n` +
    `TASK:\nWrite a very short Ukrainian description of this prompt.\n` +
    `Explain what behavior it sets and in what situations it is used.\n` +
    `Keep it concise and neutral.`
  );
}

// ─── Telegram message formatters ──────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Convert Markdown inline-code backticks to <code> tags (after HTML-escaping) */
function mdInlineCode(s: string): string {
  return escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Strip Markdown backticks (used inside <code> blocks where nesting isn't supported) */
function stripBackticks(s: string): string {
  return s.replace(/`([^`]+)`/g, '$1');
}

/** academy-openai: description text + blockquote of original + tag + link */
export function buildAcademyMessage(aiText: string, row: AssetRow, tag: string): string {
  const parts: string[] = [];
  if (aiText) parts.push(escapeHtml(aiText));
  if (row.description) {
    parts.push('');
    parts.push(`<blockquote><code>${escapeHtml(row.description)}</code></blockquote>`);
  }
  parts.push('');
  parts.push(tag);
  if (row.link) {
    parts.push('');
    parts.push(`<a href="${escapeHtml(row.link)}">Посилання</a>`);
  }
  return parts.join('\n');
}

/**
 * mcpservers: bold title + AI text (with [[method]] → <b>method</b>) + tag + link.
 * TelegramPublisher handles caption-length split automatically.
 */
export function buildMcpMessage(aiText: string, row: AssetRow, tag: string): string {
  const parts: string[] = [];
  if (row.title) {
    parts.push(`<b>${escapeHtml(row.title)}</b>`);
    parts.push('');
  }
  if (aiText) {
    // [[method_name]] → <b>method_name</b>
    const withBold = escapeHtml(aiText).replace(/\[\[(.+?)\]\]/g, '<b>$1</b>');
    parts.push(withBold);
  }
  parts.push('');
  parts.push(tag);
  if (row.link) {
    parts.push('');
    parts.push(`<a href="${escapeHtml(row.link)}">Посилання</a>`);
  }
  return parts.join('\n');
}

/** prompts-md: bold title + description + blockquote of actual prompt + tag + link */
export function buildPromptsMessage(aiText: string, row: AssetRow, tag: string): string {
  const extra = row.extra as Record<string, string> | null;
  const promptContent = extra?.prompt || row.description;

  const parts: string[] = [];
  if (row.title) {
    // `placeholder` → <code>placeholder</code> inside bold
    parts.push(`<b>${mdInlineCode(row.title)}</b>`);
    parts.push('');
  }
  if (aiText) parts.push(escapeHtml(aiText));
  if (promptContent) {
    parts.push('');
    // Inside <code> nesting isn't supported — strip backtick markers
    parts.push(`<blockquote><code>${escapeHtml(stripBackticks(promptContent))}</code></blockquote>`);
  }
  parts.push('');
  parts.push(tag);
  if (row.link) {
    parts.push('');
    parts.push(`<a href="${escapeHtml(row.link)}">Посилання</a>`);
  }
  return parts.join('\n');
}
