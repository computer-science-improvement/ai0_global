import type { EditorRole } from '../llm/llm.types';
import { SKILL_MAX_INLINE_BODY } from '../agents/skill-lint';
import type { Skill, SkillMeta, SkillSource } from './skill-library';

/** One skill's text for one run only (spec 059: the proposed version of a skill, tried before it is adopted). */
export interface SkillOverride {
  name:        string;
  description: string;
  appliesTo:   EditorRole[];
  body:        string;
}

/**
 * A skill source that answers like `base`, except that one skill has the override's text. Nothing is written anywhere:
 * the probe's "new" run reads the proposal through this, the "old" run reads the live skills as they are. A skill the
 * base does not have is added; a changed `appliesTo` decides which roles list it; an always-in-context skill stays
 * inline only while its new text still fits.
 */
export class SkillOverlay implements SkillSource {
  constructor(private readonly base: SkillSource, private readonly o: SkillOverride) {}

  private meta(): SkillMeta { return { name: this.o.name, description: this.o.description, appliesTo: this.o.appliesTo }; }

  list(role?: EditorRole): SkillMeta[] {
    // The base lists the skills that apply to `role` today; the override may change that either way, so ask without the role.
    const rows = this.base.list().map((m) => (m.name === this.o.name ? this.meta() : m));
    if (!rows.some((m) => m.name === this.o.name)) rows.push(this.meta());
    return role ? rows.filter((m) => m.appliesTo.includes(role)) : rows;
  }

  get(name: string): Skill | undefined {
    if (name !== this.o.name) return this.base.get(name);
    const was = this.base.get(name);
    return { ...this.meta(), body: this.o.body, ...(was?.safety ? { safety: true } : {}) };
  }

  inlineNames(): string[] {
    const names = this.base.inlineNames?.() ?? [];
    return this.o.body.length > SKILL_MAX_INLINE_BODY ? names.filter((n) => n !== this.o.name) : names;
  }
}
