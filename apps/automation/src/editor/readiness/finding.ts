import { findingKey } from '../sysadmin/audit-text';
import type { AuditSeverity, Finding, Fix, SubjectType } from '../sysadmin/audit.types';
import { doctorReason, resolveLink, type LinkValues } from './codes';
import type { ChannelFacts } from './facts.types';

/**
 * Spec 072 FR-001, A8: the one way a doctor check makes a finding. `area` is always `channel`, `check` is the reason code,
 * `title` is the catalogue's English text and `key` hashes the code with a subject that names the agent and the channel, so two
 * subjects of one code never collide. A code that is not in the catalogue throws: a check cannot emit a code nobody can read.
 */
export interface FindingInput {
  code:      string;
  severity:  AuditSeverity;
  subject:   { type: SubjectType; id: string; label: string };
  /** One or two sentences naming the thing (which skill, which dataset, which number). */
  detail:    string;
  evidence?: Record<string, unknown>;
  fix?:      Fix;
  /** Replaces the catalogue's link template (e.g. the Memory tab for a rule instead of the Skills tab). */
  link?:     string;
  /** Values for `:dataset` and `:series` (`:channel` and `:agent` come from the facts). */
  values?:   Pick<LinkValues, 'dataset' | 'series'>;
}

export function mkFinding(f: Pick<ChannelFacts, 'channelKey' | 'agent'>, i: FindingInput): Finding {
  const entry = doctorReason(i.code);
  if (!entry) throw new Error(`doctor code ${i.code} has no catalogue entry`);
  const subject = { ...i.subject, ...(f.agent ? { agent: f.agent.handle } : {}), channel: f.channelKey };
  const link = resolveLink(i.link ?? entry.link, { channel: f.channelKey, agent: f.agent?.handle, ...i.values });
  return {
    key: findingKey('channel', i.code, subject), area: 'channel', check: i.code, severity: i.severity, subject,
    title: entry.en, detail: i.detail, evidence: i.evidence ?? {},
    ...(i.fix ? { fix: i.fix } : {}),
    ...(link ? { link } : {}),
  };
}

/** The agent handle a skill fix is addressed to (the orchestrator, as the weekly audit does), or null when the channel has no agent. */
export const agentHandleOf = (f: Pick<ChannelFacts, 'agent'>): string | null => f.agent?.handle ?? null;
