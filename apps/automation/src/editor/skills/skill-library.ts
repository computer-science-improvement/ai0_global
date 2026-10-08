import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EditorRole } from '../llm/llm.types';

export interface SkillMeta {
  name:        string;
  description: string;
  appliesTo:   EditorRole[];
}

export interface Skill extends SkillMeta {
  body:    string;
  /** `safety: true` in the frontmatter: agents can never override or edit it (spec 017 FR-005). */
  safety?: boolean;
}

/**
 * What prompts and the skill tools read: the file library (tests, MCP) or an
 * agent's resolved DB view (spec 017 FR-006). `inlineNames` are skills the
 * agent keeps always in context in addition to the role workflow.
 */
export interface SkillSource {
  list(role?: EditorRole): SkillMeta[];
  get(name: string): Skill | undefined;
  inlineNames?(): string[];
}

/**
 * Spec 034 FR-014: the voice skills no agent may override or edit — the safety lock by name, so it holds even
 * before a file sets `safety: true` (and for `voice-core`, which arrives with T1). The owner can still override
 * them with an explicit force on the agent page.
 */
export const PROTECTED_SKILLS: ReadonlySet<string> = new Set(['anti-slop', 'human-voice', 'voice-core']);
export const isProtectedSkill = (name: string): boolean => PROTECTED_SKILLS.has(name);

/**
 * Spec 034 FR-014: resource tone skills (`tone-<resource>`, the legacy channel-* tone skills) are opt-in: off and
 * unlisted for every agent until attached to its resource (strategy migration, `attach_skill`, the skills tab).
 */
export const OPTIONAL_SKILL_PREFIX = 'tone-';
export const isOptionalSkill = (name: string): boolean => name.startsWith(OPTIONAL_SKILL_PREFIX);

/** apps/automation/editor-skills — same relative depth from src/ and dist/. */
export const DEFAULT_SKILLS_DIR = join(__dirname, '..', '..', '..', 'editor-skills');

/** Minimal frontmatter parser: `key: value` and `key: [a, b]` lines between `---` fences. */
export function parseSkill(fileName: string, text: string): Skill {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`skill ${fileName}: missing frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.name || !meta.description) throw new Error(`skill ${fileName}: name and description are required`);
  const appliesTo = (meta.applies_to ?? '[planner, executor, reviewer]')
    .replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean) as EditorRole[];
  const safety = meta.safety === 'true' || isProtectedSkill(meta.name);
  return { name: meta.name, description: meta.description, appliesTo, body: m[2].trim(), ...(safety ? { safety: true } : {}) };
}

/**
 * Markdown skills the editor agents load on demand (progressive disclosure:
 * the prompt lists names + descriptions, the body costs tokens only when a
 * skill is actually loaded). Read once at construction; files are static.
 */
export class SkillLibrary implements SkillSource {
  private readonly skills = new Map<string, Skill>();

  constructor(dir: string = DEFAULT_SKILLS_DIR) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const s = parseSkill(f, readFileSync(join(dir, f), 'utf8'));
      if (this.skills.has(s.name)) throw new Error(`duplicate skill name ${s.name}`);
      this.skills.set(s.name, s);
    }
  }

  /** With a role: what a prompt lists for it — optional tone skills stay out (they are inlined only when attached). */
  list(role?: EditorRole): SkillMeta[] {
    return [...this.skills.values()]
      .filter((s) => !role || (s.appliesTo.includes(role) && !isOptionalSkill(s.name)))
      .map(({ name, description, appliesTo }) => ({ name, description, appliesTo }));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  all(): Skill[] {
    return [...this.skills.values()];
  }
}

/** An agent's effective skill set, resolved from the DB before a run (synchronous afterwards). */
export class SkillView implements SkillSource {
  private readonly byName: Map<string, Skill>;

  constructor(skills: Skill[], private readonly inline: string[] = []) {
    this.byName = new Map(skills.map((s) => [s.name, s]));
  }

  list(role?: EditorRole): SkillMeta[] {
    return [...this.byName.values()]
      .filter((s) => !role || s.appliesTo.includes(role))
      .map(({ name, description, appliesTo }) => ({ name, description, appliesTo }));
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  inlineNames(): string[] {
    return this.inline.filter((n) => this.byName.has(n));
  }
}
