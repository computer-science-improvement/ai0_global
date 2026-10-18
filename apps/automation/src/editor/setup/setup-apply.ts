import type { EditorCard } from '../card';
import type { Agent } from '../agents/agent.types';
import type { FormatPrefField, ResourceProfile } from '../agents/resource-profile';
import { MAX_PLAYBOOK_EXAMPLES, PlaybookSchema, type Playbook, type PlaybookExample } from '../network/playbook';
import { SETUP_FORMAT_FIELDS, SETUP_SECTIONS, VOICE_SKILL_NAME, type BoundDataset, type SetupSection, type SubmitSetupInput } from './setup-analysis';
import type { SetupPost } from './setup-posts.types';

/**
 * Spec 042 FR-004 / FR-006: what each section would replace (`baseline`, stored at analysis for the drift check), the
 * playbook the proposal produces, and Apply. Sections are written in order through the existing writers (each atomic in
 * its own repository); a failing section stops the Apply and leaves itself and the rest pending.
 */

export interface ChannelState {
  card:      EditorCard | null;
  agent:     Agent | null;
  profile:   ResourceProfile | null;
  locks:     FormatPrefField[];
  playbook:  Playbook | null;
  voice:     string | null;
  /** Spec 047 FR-007: datasets the channel publishes from (series sources and its content ledger). */
  datasets?: BoundDataset[];
}

const PROFILE_KEYS = ['topic', 'audience', 'language', 'goals', 'tone', 'taboo', 'notes'] as const;

function pick<T extends object>(o: T | null | undefined, keys: readonly string[]): Record<string, unknown> | null {
  if (!o) return null;
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k];
  return out;
}

/** The values each section would replace, as JSON-comparable data. */
export function sectionBaseline(s: ChannelState, ref: string): Record<SetupSection, unknown> {
  const sec = s.playbook?.platforms.find((p) => p.resource_ref === ref) ?? null;
  const prefs = s.profile?.format_prefs ?? null;
  return {
    brief_profile: { brief: s.card?.brief ?? null, profile: pick(s.profile, PROFILE_KEYS) },
    formatting: {
      format_prefs: pick(prefs, SETUP_FORMAT_FIELDS), style: prefs?.style ?? null, locks: [...s.locks].sort(),
      card: s.card ? { hashtags: s.card.hashtags, hashtagMin: s.card.hashtagMin, hashtagMax: s.card.hashtagMax, footer: s.card.footer, emojiPolicy: s.card.emojiPolicy, linkStyle: s.card.linkStyle } : null,
    },
    format_mix: { formats: s.card?.formats ?? null },
    series_pillars: {
      series: (s.playbook?.series ?? []).filter((x) => x.resource_ref === ref).map((x) => ({ name: x.name, cadence: x.cadence, format: x.format, brief: x.brief, locked: !!x.locked })),
      pillars: s.playbook?.pillars ?? [],
    },
    schedule: {
      postsPerDayMin: s.card?.postsPerDayMin ?? null, postsPerDayMax: s.card?.postsPerDayMax ?? null,
      quietStartHour: s.card?.quietStartHour ?? null, quietEndHour: s.card?.quietEndHour ?? null, bestHours: sec?.best_hours ?? [],
    },
    examples_voice: {
      examples: (s.playbook?.examples ?? []).filter((e) => e.verdict === 'good' && (!e.resource_ref || e.resource_ref === ref)).map((e) => e.text),
      voice: s.voice,
    },
  };
}

/** Sections whose current value changed since the analysis (the owner must review them again). */
export function driftedSections(baseline: Record<string, unknown> | null, now: Record<SetupSection, unknown>, sections: SetupSection[]): SetupSection[] {
  if (!baseline) return [];
  return sections.filter((s) => JSON.stringify(baseline[s] ?? null) !== JSON.stringify(now[s] ?? null));
}

/** The format_prefs patch of the proposal without the owner's locked fields; `kept` = the fields it leaves alone. */
export function formatPatch(i: SubmitSetupInput, locks: readonly string[], currentStyle: unknown): { patch: Record<string, unknown>; kept: string[] } {
  const patch: Record<string, unknown> = {};
  const kept: string[] = [];
  for (const [k, v] of Object.entries(i.formatting.format_prefs)) {
    if (v === undefined) continue;
    if (locks.includes(k)) { kept.push(k); continue; }
    patch[k] = v;
  }
  if (i.formatting.style && Object.keys(i.formatting.style).length) {
    if (locks.includes('style')) kept.push('style');
    else patch.style = { ...((currentStyle as Record<string, unknown> | null) ?? {}), ...i.formatting.style };
  }
  return { patch, kept };
}

/** The card fields the proposal sets (camelCase card patch) per section. */
export function cardPatch(i: SubmitSetupInput, section: 'formatting' | 'format_mix' | 'schedule'): Record<string, unknown> {
  if (section === 'format_mix') return { formats: i.format_mix.formats };
  if (section === 'schedule') {
    // Spec 041 FR-008: under 7 days of history the rate and the quiet hours are not proposed.
    if (i.schedule.insufficient_span) return {};
    return {
      postsPerDayMin: i.schedule.posts_per_day_min, postsPerDayMax: i.schedule.posts_per_day_max,
      quietStartHour: i.schedule.quiet_start_hour, quietEndHour: i.schedule.quiet_end_hour,
    };
  }
  const c = i.formatting.card;
  const out: Record<string, unknown> = {};
  if (c.hashtags !== undefined) out.hashtags = c.hashtags;
  if (c.hashtag_min !== undefined) out.hashtagMin = c.hashtag_min;
  if (c.hashtag_max !== undefined) out.hashtagMax = c.hashtag_max;
  if (c.footer !== undefined) out.footer = c.footer;
  if (c.emoji_policy !== undefined) out.emojiPolicy = c.emoji_policy;
  if (c.link_style !== undefined) out.linkStyle = c.link_style;
  return out;
}

/** The proposal's profile laid over the stored one (sources, ads, examples, zone, formatting and news watch are kept). */
export function mergedProfile(current: ResourceProfile | null, i: SubmitSetupInput): Record<string, unknown> {
  const { format_prefs: _fp, format_locks: _fl, ...rest } = (current ?? {}) as Record<string, unknown>;
  return { ...rest, ...i.brief_profile.profile };
}

/** Example texts copied from the stored posts (never from the model). */
export function exampleTexts(i: SubmitSetupInput, posts: SetupPost[]): Array<{ text: string; format: string }> {
  const byKey = new Map(posts.map((p) => [p.key, p]));
  return i.examples_voice.example_ids.map((k) => byKey.get(k)).filter((p): p is SetupPost => !!p && p.text.trim().length >= 10)
    .map((p) => ({ text: p.text.trim().slice(0, 2000), format: p.hasMedia ? (p.mediaType === 'video' ? 'video' : p.mediaType === 'photo' ? 'photo' : 'text') : 'text' }));
}

/**
 * The playbook after the proposal's playbook parts: the channel's section (formats, per day, best hours), its series
 * (the owner's locked ones stay), the pillars and the good examples of this channel. A channel without a playbook gets
 * one `core` section.
 */
export function mergePlaybook(current: Playbook | null, ref: string, card: Pick<EditorCard, 'formats' | 'postsPerDayMin' | 'postsPerDayMax'>, o: {
  formatMix?: Record<string, number>; schedule?: { min?: number; max?: number; bestHours: number[] };
  series?: SubmitSetupInput['series_pillars']; examples?: Array<{ text: string; format: string }>;
}): Playbook {
  const base: Playbook = current ?? PlaybookSchema.parse({ platforms: [{ resource_ref: ref, role: 'core', formats: card.formats, per_day: { min: card.postsPerDayMin, max: card.postsPerDayMax } }] });
  let platforms = base.platforms;
  if (!platforms.some((p) => p.resource_ref === ref)) {
    platforms = [...platforms, PlaybookSchema.shape.platforms.element.parse({ resource_ref: ref, role: 'core', formats: card.formats, per_day: { min: card.postsPerDayMin, max: card.postsPerDayMax } })];
  }
  platforms = platforms.map((p) => {
    if (p.resource_ref !== ref) return p;
    const next = { ...p };
    if (o.formatMix) next.formats = { ...o.formatMix };
    if (o.schedule) {
      if (o.schedule.min != null && o.schedule.max != null) next.per_day = { min: o.schedule.min, max: o.schedule.max };
      next.best_hours = [...o.schedule.bestHours].sort((a, b) => a - b);
    }
    return next;
  });
  let series = base.series;
  let pillars = base.pillars;
  if (o.series) {
    const locked = base.series.filter((s) => s.resource_ref === ref && s.locked);
    const lockedNames = new Set(locked.map((s) => s.name));
    series = [
      ...base.series.filter((s) => s.resource_ref !== ref || s.locked),
      ...o.series.series.filter((s) => !lockedNames.has(s.name)).map((s) => ({
        name: s.name, cadence: s.cadence, resource_ref: ref, format: s.format, brief: s.brief,
        active: true, source_mode: 'suggested' as const, origin: 'owner' as const, locked: true,
      })),
    ];
    pillars = o.series.pillars.map((p) => ({ name: p.name, share: p.share }));
  }
  let examples = base.examples;
  if (o.examples) {
    const fresh: PlaybookExample[] = o.examples.map((e) => ({ format: e.format, text: e.text, verdict: 'good', note: 'From the channel history (setup from history)', resource_ref: ref }));
    const kept = base.examples.filter((e) => e.verdict === 'bad' || (e.resource_ref && e.resource_ref !== ref));
    examples = [...fresh, ...kept].slice(0, MAX_PLAYBOOK_EXAMPLES);
  }
  return { ...base, platforms, series, pillars, examples };
}

/** The voice skill's markdown (rules + verbatim quotes). */
export function voiceSkillBody(i: SubmitSetupInput, channelKey: string): { description: string; body: string } {
  const v = i.examples_voice.voice;
  return {
    description: `How ${channelKey} sounds, learned from its last posts: ${v.description}`.slice(0, 300),
    body: [
      `# Голос каналу ${channelKey}`,
      '',
      v.description,
      '',
      '## Правила',
      ...v.rules.map((r) => `- ${r}`),
      '',
      '## Як це звучить (цитати з постів каналу)',
      ...v.quotes.map((q) => `> ${q}`),
    ].join('\n'),
  };
}

export interface ApplyWriters {
  /** The owner's card upsert (merge + validation); creates the card when missing. */
  upsertCard(key: string, patch: Record<string, unknown>): Promise<unknown>;
  getCard(key: string): Promise<EditorCard | null>;
  /** Registry sync: the card's orchestrator and its children; returns the orchestrator. */
  ensureAgent(key: string): Promise<Agent>;
  setProfile(ref: string, profile: Record<string, unknown>): Promise<void>;
  patchFormat(ref: string, patch: Record<string, unknown>): Promise<{ error?: string; details?: unknown } | unknown>;
  /** The playbook rebuild from a brief (AgentsService.onBrief). */
  onBrief(agent: Agent, brief: string): Promise<void>;
  putPlaybook(handle: string, body: Playbook, rationale: string): Promise<unknown>;
  putVoiceSkill(handle: string, skill: { description: string; body: string }): Promise<unknown>;
}

export interface ApplyInput {
  channelKey: string;
  ref:        string;
  title:      string | null;
  input:      SubmitSetupInput;
  posts:      SetupPost[];
  sections:   SetupSection[];
  state:      ChannelState;
}

export interface ApplyOutcome {
  applied: SetupSection[];
  failed:  { section: SetupSection; error: string } | null;
  kept:    string[];
  agent:   Agent | null;
  rebuilt: boolean;
}

const errText = (err: any): string => {
  const r = err?.response ?? err?.getResponse?.();
  if (r && typeof r === 'object') return [r.error, r.details ? (typeof r.details === 'string' ? r.details : JSON.stringify(r.details)) : null, r.issues ? JSON.stringify(r.issues) : null].filter(Boolean).join(': ');
  return String(err?.message ?? err);
};

/** Apply the chosen sections in order (FR-006). */
export async function applySections(w: ApplyWriters, a: ApplyInput): Promise<ApplyOutcome> {
  const order = SETUP_SECTIONS.filter((s) => a.sections.includes(s));
  const out: ApplyOutcome = { applied: [], failed: null, kept: [], agent: a.state.agent, rebuilt: false };
  let card = a.state.card;
  const i = a.input;
  const step = async (section: SetupSection, fn: () => Promise<void>): Promise<boolean> => {
    try { await fn(); return true; } catch (err) { out.failed = { section, error: errText(err) }; return false; }
  };

  // A new channel: the card in mode off, then its agent (registry sync mirrors the card's mode).
  if (!card || !out.agent) {
    const ok = await step(order[0], async () => {
      if (!card) await w.upsertCard(a.channelKey, { mode: 'off', title: a.title });
      out.agent = await w.ensureAgent(a.channelKey);
      card = await w.getCard(a.channelKey);
      if (!card) throw new Error('card_not_created');
    });
    if (!ok) return out;
  }
  if (!card) return out;
  let cur: EditorCard = card;
  const agent = out.agent!;
  const writesPlaybook = order.some((s) => s === 'series_pillars' || s === 'schedule' || s === 'examples_voice');

  for (const section of order) {
    if (section === 'brief_profile') {
      if (!(await step(section, async () => {
        await w.setProfile(a.ref, mergedProfile(a.state.profile, i));
        await w.upsertCard(a.channelKey, { brief: i.brief_profile.brief });
      }))) return out;
      out.applied.push(section);
    } else if (section === 'formatting') {
      if (!(await step(section, async () => {
        const { patch, kept } = formatPatch(i, a.state.locks, a.state.profile?.format_prefs?.style ?? null);
        out.kept.push(...kept);
        if (Object.keys(patch).length) {
          const r = await w.patchFormat(a.ref, patch) as { error?: string; details?: unknown } | null;
          if (r && typeof r === 'object' && 'error' in r && r.error && r.error !== 'no_change') throw new Error(`${r.error}: ${JSON.stringify(r.details ?? '')}`);
        }
        const cp = cardPatch(i, 'formatting');
        if (Object.keys(cp).length) await w.upsertCard(a.channelKey, cp);
      }))) return out;
      out.applied.push(section);
    } else if (section === 'format_mix') {
      if (!(await step(section, () => w.upsertCard(a.channelKey, cardPatch(i, 'format_mix')).then(() => undefined)))) return out;
      cur = { ...cur, formats: i.format_mix.formats as Record<string, number> };
      out.applied.push(section);
    } else if (section === 'schedule') {
      const cp = cardPatch(i, 'schedule');
      if (Object.keys(cp).length && !(await step(section, () => w.upsertCard(a.channelKey, cp).then(() => undefined)))) return out;
      if (!i.schedule.insufficient_span) cur = { ...cur, postsPerDayMin: i.schedule.posts_per_day_min, postsPerDayMax: i.schedule.posts_per_day_max };
      // Applied once the playbook (best hours) is written below.
    }
  }

  if (writesPlaybook) {
    const pbSections = order.filter((s) => s === 'series_pillars' || s === 'schedule' || s === 'examples_voice');
    const ok = await step(pbSections[0], async () => {
      const body = mergePlaybook(a.state.playbook, a.ref, cur, {
        formatMix: order.includes('format_mix') ? i.format_mix.formats as Record<string, number> : undefined,
        schedule: order.includes('schedule')
          ? { ...(i.schedule.insufficient_span ? {} : { min: i.schedule.posts_per_day_min, max: i.schedule.posts_per_day_max }), bestHours: i.schedule.best_hours }
          : undefined,
        series: order.includes('series_pillars') ? i.series_pillars : undefined,
        examples: order.includes('examples_voice') ? exampleTexts(i, a.posts) : undefined,
      });
      await w.putPlaybook(agent.handle, body, 'Setup from the channel history (spec 042)');
    });
    if (!ok) return out;
    for (const s of pbSections) if (s !== 'examples_voice') out.applied.push(s);
    if (order.includes('examples_voice')) {
      if (!(await step('examples_voice', () => w.putVoiceSkill(agent.handle, voiceSkillBody(i, a.channelKey)).then(() => undefined)))) return out;
      out.applied.push('examples_voice');
    }
  }

  // A brief without a playbook write rebuilds the playbook as before; with one, the proposal's playbook stands.
  if (order.includes('brief_profile') && !writesPlaybook) {
    await w.onBrief(agent, i.brief_profile.brief).catch(() => {});
    out.rebuilt = true;
  }
  out.applied = SETUP_SECTIONS.filter((s) => out.applied.includes(s));
  return out;
}

export { VOICE_SKILL_NAME };
