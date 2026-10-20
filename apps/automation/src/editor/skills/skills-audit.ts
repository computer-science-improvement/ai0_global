/**
 * Spec 034 FR-014: the skills audit — lifted out of its test by spec 055 so the sysadmin (the auditor agent) can run the
 * same rules on the skills of the database. Every skill must name only tools that exist, use current refs (`data://`,
 * spec 032), never say a new agent starts in shadow (spec 031: approve), use known roles and fit the inline budgets of
 * the prompts that inline it.
 */
import { isOptionalSkill, parseSkill } from './skill-library';
import { SKILL_MAX_INLINE_BODY, SKILL_ROLES } from '../agents/skill-lint';

/**
 * Every tool name an agent can be given, read from source text: `defineTool({ name: '…' })` literals, plus the names of
 * a tool factory that passes `name` through (`defineTool({ name, … })` with a `name: 'a' | 'b'` parameter in the same
 * file). Tests use it on the repo; the running service uses its ToolRegistry instead (the sources are not shipped).
 */
export function toolRegistryFromSource(files: Array<{ text: string }>): Set<string> {
  const out = new Set<string>();
  for (const { text } of files) {
    for (const m of text.matchAll(/defineTool\(\{\s*name:\s*['"`]([a-z0-9_]+)['"`]/g)) out.add(m[1]);
    if (/defineTool\(\{\s*name\s*,/.test(text)) {
      for (const u of text.matchAll(/\bname:\s*((?:'[a-z0-9_]+'\s*\|\s*)+'[a-z0-9_]+')/g)) {
        for (const lit of u[1].matchAll(/'([a-z0-9_]+)'/g)) out.add(lit[1]);
      }
    }
  }
  return out;
}

/** Verbs our tool names start with: a backticked `verb_object` in a skill is read as a tool reference. */
export const TOOL_VERBS = [
  'accept', 'add', 'attach', 'cancel', 'check', 'contest', 'create', 'decline', 'define', 'detach', 'edit', 'explain',
  'extract', 'fetch', 'file', 'finish', 'get', 'inspect', 'lint', 'list', 'load', 'pause', 'preview', 'propose',
  'publish', 'query', 'report', 'repurpose', 'retire', 'review', 'revise', 'save', 'schedule', 'search', 'set', 'skip',
  'submit', 'update', 'write',
];

/** Backticked identifiers that look like tools but are not (with why). */
export const NOT_TOOLS: Readonly<Record<string, string>> = {
  pause_resource: 'a MANAGER directive kind (spec 025), executed by code',
  pause_series:   'a MANAGER directive kind (spec 025), executed via set_series_active',
};

const TOOL_LIKE = new RegExp(`\`((?:${TOOL_VERBS.join('|')})_[a-z0-9_]+)(?:\\([^\`]*\\))?\``, 'g');

/** The tool-like names in a skill text that are not registered tools (and not allowlisted non-tools). */
export function unknownToolRefs(text: string, tools: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOOL_LIKE)) {
    const id = m[1];
    if (!tools.has(id) && !NOT_TOOLS[id] && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface AuditIssue { file: string; rule: string; detail: string }

/** A new agent / resource starts in approve (spec 031); text that sends it to shadow by default is stale. */
const SHADOW_DEFAULT = /(?:start\p{L}*\s+in\s+shadow|(?:стартує|починає|почне|працюватиме|працює|запускається)[^.\n]{0,40}\bshadow\b|перш\p{L}*\s+\d+\s+дн\p{L}*[^.\n]{0,40}\bshadow\b|shadow-режим\p{L}*)/iu;

/** Role prompts inline their workflow skill within an 8 000-char budget (`roles/prompts.ts`, `agent-prompts.ts`). */
export const INLINE_BUDGET = 8_000;
export const WORKFLOW_SKILLS = /^(?:editor-[a-z]+-workflow|manager-workflow|auditor-workflow|agent-onboarding|agent-chat-etiquette)$/;
/** Leave ≥ 2 000 chars of the budget to the card's and the agent's own inline skills. */
export const WORKFLOW_MAX = INLINE_BUDGET - 2_000;
/** The executor prompt also carries the voice skills (FR-001); its workflow stays small. */
export const EXECUTOR_WORKFLOW_MAX = 2_600;
/** FR-001: the always-inlined voice block. */
export const VOICE_CORE_MAX = 2_500;

export function auditSkills(files: Array<{ file: string; text: string }>, tools: ReadonlySet<string>): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const add = (file: string, rule: string, detail: string) => issues.push({ file, rule, detail });
  const names = new Map<string, string>();

  for (const { file, text } of files) {
    let skill;
    try {
      skill = parseSkill(file, text);
    } catch (err: any) {
      add(file, 'frontmatter', err?.message ?? String(err));
      continue;
    }
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    if (`${skill.name}.md` !== file) add(file, 'frontmatter', `name ${skill.name} differs from the file name`);
    if (names.has(skill.name)) add(file, 'frontmatter', `duplicate name ${skill.name} (also ${names.get(skill.name)})`);
    names.set(skill.name, file);

    const appliesLine = front.match(/^applies_to:\s*(.*)$/m);
    if (!appliesLine) add(file, 'applies_to_empty', 'applies_to is missing (the parser would default it)');
    else if (!skill.appliesTo.length) add(file, 'applies_to_empty', 'applies_to lists no role');
    const unknown = skill.appliesTo.filter((r) => !(SKILL_ROLES as readonly string[]).includes(r));
    if (unknown.length) add(file, 'applies_to_role', `unknown roles: ${unknown.join(', ')}`);

    const body = `${skill.description}\n${skill.body}`;
    for (const id of unknownToolRefs(body, tools)) add(file, 'unknown_tool', `\`${id}\` is not a registered tool`);
    if (/library:\/\//.test(body)) add(file, 'library_ref', 'library:// refs are legacy aliases; write data://<dataset>/<id> (spec 032)');
    const shadow = body.match(SHADOW_DEFAULT);
    if (shadow) add(file, 'shadow_default', `"${shadow[0]}": new agents start in approve (spec 031); shadow is a manual dry run`);

    const len = skill.body.length;
    if (skill.name === 'editor-executor-workflow' && len > EXECUTOR_WORKFLOW_MAX) add(file, 'inline_size', `${len} > ${EXECUTOR_WORKFLOW_MAX}`);
    else if (WORKFLOW_SKILLS.test(skill.name) && len > WORKFLOW_MAX) add(file, 'inline_size', `${len} > ${WORKFLOW_MAX}`);
    if (isOptionalSkill(skill.name) && len > SKILL_MAX_INLINE_BODY) add(file, 'inline_size', `tone skill ${len} > ${SKILL_MAX_INLINE_BODY} (attached inline)`);
    if (skill.name === 'voice-core' && len > VOICE_CORE_MAX) add(file, 'inline_size', `voice-core ${len} > ${VOICE_CORE_MAX}`);
  }
  return issues;
}
