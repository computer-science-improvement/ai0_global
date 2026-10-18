import { z } from 'zod';
import type { EditorCard } from '../card';
import { makeDefaultCard } from '../chat/default-card';
import { Agent, parseResourceRef, Platform, validateHandle } from './agent.types';
import { implementedFormats } from '../platform/capabilities';
import { MAX_FITTING_FORMATS } from '../network/playbook';
import type { AgentsRepository } from './agents.repository';
import type { AgentRegistrySync } from './agent-registry-sync';
import type { ResourceCatalog } from './resource-catalog';
import { ResourceProfileSchema, ResourceProfilesRepository, renderProfile } from './resource-profile';

/**
 * Spec 031 FR-002: a new resource and its agent start in `approve` — the agent
 * writes real posts and each one waits for the owner. This replaced the 3-day
 * shadow start; `shadow` stays a manual dry-run mode.
 */
export const NEW_RESOURCE_MODE = 'approve' as const;

/** Spec 034 FR-007: a format the builder picked for the resource, with why it fits (one line). */
export const FittingFormatSchema = z.object({
  format: z.string().trim().min(2).max(30),
  reason: z.string().trim().min(3).max(200),
});

export const CreateAgentSchema = z.object({
  resource_ref:     z.string().min(3).max(200).optional(),
  network_id:       z.string().uuid().optional(),
  name:             z.string().trim().min(1).max(60),
  handle:           z.string().trim().toLowerCase().transform((s) => s.replace(/^@/, '')),
  emoji:            z.string().trim().max(8).optional(),
  description:      z.string().trim().max(500).optional(),
  profile:          ResourceProfileSchema,
  brief:            z.string().trim().max(4000).optional(),
  /** Spec 034 FR-007: 1–4 formats that fit the topic and audience, each with a reason (absent = text + photo). */
  formats:          z.array(FittingFormatSchema).min(1).max(MAX_FITTING_FORMATS).optional(),
  /** Spec 034 FR-009: literal words the owner listed to never use (the card's bannedTerms); taboo topics stay in the profile. */
  banned_terms:     z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  schedule:         z.object({ times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(8) }).optional(),
  daily_budget_usd: z.number().min(0).max(50).optional(),
  model:            z.string().trim().min(3).max(100).optional(),
  /** Spec 047 FR-006: the voice the agent uses for itself (absent = masculine). */
  grammatical_gender: z.enum(['masculine', 'feminine']).optional(),
}).refine((v) => !!v.resource_ref !== !!v.network_id, { message: 'exactly one of resource_ref or network_id is required' });
export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;

export interface AgentCreatorDeps {
  agents:   Pick<AgentsRepository, 'findTop' | 'handleTaken' | 'insert'>;
  registry: Pick<AgentRegistrySync, 'ensureChildren'>;
  catalog:  Pick<ResourceCatalog, 'list'>;
  profiles: Pick<ResourceProfilesRepository, 'setProfile'>;
  channels: {
    get(key: string): Promise<EditorCard | null>; insertIfMissing(c: EditorCard): Promise<boolean>;
    /** Spec 034 FR-009: the brief of a resource whose card already exists is written to it. */
    setBrief?(key: string, brief: string): Promise<boolean>;
  };
  /** Spec 020: build the first playbook from the brief in the background. */
  onBrief?: (agent: Agent, brief: string) => Promise<void>;
  now?:     () => Date;
}

/** Brief for a new channel card when the owner gave none: the profile itself. */
export function briefFromProfile(input: CreateAgentInput): string {
  return input.brief?.trim() || renderProfile(input.profile);
}

/** Polls and quizzes at creation only for a quiz / education resource or when the brief asks for them (spec 034 FR-005). */
const POLL_FORMATS = new Set(['poll', 'quiz']);
const ASKS_FOR_POLLS = /опитуван|вікторин|голосуван|\bpolls?\b|\bquiz/iu;

/** Problems of the picked formats (English: the builder reads them as tool errors, the owner on a failed card). */
export function fittingFormatErrors(input: Pick<CreateAgentInput, 'formats' | 'brief' | 'profile'>, platform: Platform): string[] {
  const picked = input.formats ?? [];
  const errors: string[] = [];
  const allowed = implementedFormats(platform);
  const bad = picked.filter((f) => !allowed.includes(f.format)).map((f) => f.format);
  if (bad.length) errors.push(`formats ${bad.join(', ')} are not available on ${platform} (available: ${allowed.join(', ')})`);
  if (new Set(picked.map((f) => f.format)).size !== picked.length) errors.push('a format is listed twice');
  const kind = input.profile.format_prefs?.content_kind;
  const polls = picked.filter((f) => POLL_FORMATS.has(f.format)).map((f) => f.format);
  if (polls.length && kind !== 'quiz' && kind !== 'education' && !ASKS_FOR_POLLS.test(input.brief ?? '')) {
    errors.push(`${polls.join(', ')}: weight 0 by default — only for a quiz / education resource (format_prefs.content_kind) or when the owner's brief asks for polls`);
  }
  return errors;
}

/**
 * What the first playbook build starts from: the owner's brief plus the formats picked in the chat with their
 * reasons (spec 034 FR-007), so the build keeps the same fitting subset.
 */
export function buildBriefText(input: Pick<CreateAgentInput, 'brief' | 'formats'>): string {
  const lines = [input.brief?.trim() ?? ''];
  if (input.formats?.length) {
    lines.push('', `Формати, погоджені з власником (лише вони, з причинами): ${input.formats.map((f) => `${f.format} — ${f.reason}`).join('; ')}.`);
  }
  return lines.join('\n').trim();
}

/**
 * Creates an orchestrator from a resource profile (spec 018 FR-007). Dry-run
 * `validate` runs when the card is proposed and again when it is applied, so a
 * stale card (handle taken meanwhile) fails with a clear reason.
 */
export class AgentCreator {
  constructor(private readonly d: AgentCreatorDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /**
   * Spec 034 FR-009: late-bound playbook build (the AgentsService that owns the brief hook is built after the
   * creator). A brief at creation then starts the first playbook build in the background.
   */
  setOnBrief(fn: (agent: Agent, brief: string) => Promise<void>): void {
    this.d.onBrief = fn;
  }

  async validate(raw: unknown): Promise<{ ok: true; input: CreateAgentInput; scope: 'resource' | 'network'; scopeId: string } | { error: string; details?: unknown }> {
    const p = CreateAgentSchema.safeParse(raw);
    if (!p.success) return { error: 'invalid_agent', details: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    const input = p.data;
    const herr = validateHandle(input.handle);
    if (herr) return { error: 'invalid_handle', details: herr };
    if (await this.d.agents.handleTaken(input.handle)) return { error: 'handle_taken', details: `@${input.handle} is already taken` };

    const resources = await this.d.catalog.list();
    if (input.resource_ref) {
      const r = resources.find((x) => x.ref === input.resource_ref);
      if (!r) return { error: 'resource_not_connected', details: `${input.resource_ref} is not connected — /app/connections` };
      if (r.agent) return { error: 'resource_has_agent', details: `the resource is already run by @${r.agent}` };
      const parsed = parseResourceRef(input.resource_ref);
      if (!parsed) return { error: 'invalid_ref' };
      const ferr = fittingFormatErrors(input, parsed.platform);
      if (ferr.length) return { error: 'invalid_formats', details: ferr };
      return { ok: true, input, scope: 'resource', scopeId: input.resource_ref };
    }
    const ferr = fittingFormatErrors(input, 'telegram');
    if (ferr.length) return { error: 'invalid_formats', details: ferr };
    // A network is run by the orchestrator of its Telegram channel (spec 020): create that one.
    const members = resources.filter((x) => x.groupId === input.network_id);
    if (!members.length) return { error: 'network_not_found', details: 'the account group is empty or does not exist' };
    const anchor = members.find((x) => x.platform === 'telegram');
    if (!anchor) return { error: 'network_needs_telegram', details: 'a network is run by the agent of its Telegram channel — add the channel to the group' };
    if (anchor.agent) return { error: 'network_has_agent', details: `the network's channel is already run by @${anchor.agent} — turn on network mode on its page` };
    return { ok: true, input: { ...input, resource_ref: anchor.ref, network_id: undefined }, scope: 'resource', scopeId: anchor.ref };
  }

  async create(raw: unknown): Promise<{ agent: Agent; cardCreated: boolean; briefWritten: boolean; buildStarted: boolean } | { error: string; details?: unknown }> {
    const v = await this.validate(raw);
    if ('error' in v) return v;
    const { input, scope, scopeId } = v;

    // The agent first: the hourly registry sync then finds it and never creates a duplicate for the new card.
    const agent = await this.d.agents.insert({
      kind: 'orchestrator', scope, scopeId, name: input.name, handle: input.handle, emoji: input.emoji ?? '📣',
      description: input.description ?? input.profile.topic, mode: NEW_RESOURCE_MODE, shadowUntil: null,
      schedule: input.schedule ?? { times: ['06:30'] }, dailyBudgetUsd: input.daily_budget_usd ?? null, model: input.model ?? null,
      grammaticalGender: input.grammatical_gender ?? null, createdBy: 'builder',
    });
    await this.d.registry.ensureChildren(agent);
    await this.d.profiles.setProfile(scope === 'resource' ? scopeId : `network:${scopeId}`, input.profile, 'builder');

    let cardCreated = false;
    let briefWritten = false;
    const tg = scope === 'resource' ? parseResourceRef(scopeId) : null;
    if (tg?.platform === 'telegram') {
      if (!(await this.d.channels.get(tg.id))) {
        const base = makeDefaultCard(tg.id, input.name);
        cardCreated = await this.d.channels.insertIfMissing({
          ...base, mode: NEW_RESOURCE_MODE, brief: briefFromProfile(input),
          // Spec 034 FR-007: only the formats picked with a reason (else text + photo); polls stay off.
          formats: input.formats?.length ? Object.fromEntries(input.formats.map((f) => [f.format, 1])) : base.formats,
          // Spec 034 FR-009: taboo is a list of topics (prompts and the critic), not lint terms; only words the owner listed.
          bannedTerms: (input.banned_terms ?? []).slice(0, 50),
        });
        briefWritten = cardCreated;
      } else if (input.brief?.trim() && this.d.channels.setBrief) {
        // Spec 034 FR-009: the owner's brief for a resource that already has a card is not lost.
        briefWritten = await this.d.channels.setBrief(tg.id, input.brief.trim());
      }
    }
    // Spec 034 FR-009: a brief at creation starts the first playbook build (in the background, never blocks Apply).
    let buildStarted = false;
    if (input.brief?.trim() && this.d.onBrief) {
      try { await this.d.onBrief(agent, buildBriefText(input)); buildStarted = true; } catch { /* the daily orchestrator run builds it later */ }
    }
    return { agent, cardCreated, briefWritten, buildStarted };
  }
}
