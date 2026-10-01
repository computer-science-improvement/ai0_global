import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EditorRole } from '../llm/llm.types';

export interface SkillMeta {
  name:        string;
  description: string;
  appliesTo:   EditorRole[];
}

export interface Skill extends SkillMeta {
  body: string;
}

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
  return { name: meta.name, description: meta.description, appliesTo, body: m[2].trim() };
}

/**
 * Markdown skills the editor agents load on demand (progressive disclosure:
 * the prompt lists names + descriptions, the body costs tokens only when a
 * skill is actually loaded). Read once at construction; files are static.
 */
export class SkillLibrary {
  private readonly skills = new Map<string, Skill>();

  constructor(dir: string = DEFAULT_SKILLS_DIR) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const s = parseSkill(f, readFileSync(join(dir, f), 'utf8'));
      if (this.skills.has(s.name)) throw new Error(`duplicate skill name ${s.name}`);
      this.skills.set(s.name, s);
    }
  }

  list(role?: EditorRole): SkillMeta[] {
    return [...this.skills.values()]
      .filter((s) => !role || s.appliesTo.includes(role))
      .map(({ name, description, appliesTo }) => ({ name, description, appliesTo }));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}
