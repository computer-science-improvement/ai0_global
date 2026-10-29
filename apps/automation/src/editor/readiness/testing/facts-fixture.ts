import type { EditorCard } from '../../card';
import { PlaybookSchema, SeriesSchema, type Playbook, type Series } from '../../network/playbook';
import { makeCard } from '../../post/testing/fixtures';
import { deriveFacts, seriesOn, sourceRefsOf, type RawFacts } from '../facts';
import type { ChannelFacts, DatasetFact, SkillFact } from '../facts.types';

/**
 * Spec 072 test fixtures: small `ChannelFacts` built through the real `deriveFacts`, so the derived fields (series, bindings,
 * effective tools, conflict input) are the ones production code makes. Used by the check, doctor, hash and overlay tests.
 */
export const CH = '@fx072';
export const REF = `telegram:${CH}`;
export const NOW = new Date('2026-10-20T10:00:00.000Z');

export const mkSeries = (over: Record<string, unknown> = {}): Series => SeriesSchema.parse({
  name: 'Daily tip', cadence: 'daily@10:00', resource_ref: REF, format: 'text', brief: 'A short tip for the channel readers', ...over,
});

export const mkPlaybook = (series: Series[] = [], over: Record<string, unknown> = {}): Playbook => PlaybookSchema.parse({
  platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }], series, ...over,
});

export const mkSkill = (over: Partial<SkillFact> = {}): SkillFact => ({
  id: 'sk1', name: 'plain-skill', description: 'A plain skill', body: 'Write short posts.', version: 1, inline: false,
  origin: 'agent', scope: 'agent', safety: false, agentId: 'a1', ...over,
} as SkillFact);

export const mkDataset = (over: Partial<Omit<DatasetFact, 'boundBy' | 'seriesPerDay'>> = {}): Omit<DatasetFact, 'boundBy' | 'seriesPerDay'> => ({
  id: 'ds1', key: 'tips', entity: 'tip', version: 1, roles: { title: 'text' }, reusePolicy: { kind: 'never' }, postRequires: [['text']],
  fillRate: null, rows: 100, notPostable: 0, unusedPostable: 100, used28: 0, ...over,
});

export interface FactsInit {
  card?:          Partial<EditorCard>;
  playbook?:      Playbook | null;
  pendingPlaybook?: ChannelFacts['pendingPlaybook'];
  /** Raw datasets: `boundBy` and `seriesPerDay` are derived. */
  datasets?:      Array<Omit<DatasetFact, 'boundBy' | 'seriesPerDay'>>;
  skills?:        SkillFact[];
  rules?:         ChannelFacts['rules'];
  steering?:      ChannelFacts['steering'];
  pins?:          ChannelFacts['pins'];
  pauses?:        ChannelFacts['pauses'];
  loadoutTools?:  string[] | null;
  profile?:       ChannelFacts['profile'];
  group?:         ChannelFacts['group'];
  launch?:        ChannelFacts['launch'];
  planned?:       ChannelFacts['planned'];
  slots24h?:      ChannelFacts['slots24h'];
  sources?:       RawFacts['sources'];
  conflictBase?:  Partial<ChannelFacts['conflictBase']>;
  now?:           Date;
}

/** A healthy channel: a shadow card, a playbook without series, no sources. Override only what a test is about. */
export function makeFacts(i: FactsInit = {}): ChannelFacts {
  const card = { ...makeCard({ channelKey: CH, toolsAllow: null, ...i.card }), createdAt: new Date('2026-09-01T00:00:00.000Z') };
  const playbook = i.playbook === undefined ? mkPlaybook() : i.playbook;
  const series = seriesOn(playbook, REF);
  const sources = i.sources ?? sourceRefsOf(card, series).map((r) => ({ url: r.url, kind: r.kind, origin: r.origin, host: r.host, hostBlock: null, lastSuccessAt: null }));
  return deriveFacts({
    now: i.now ?? NOW, channelKey: CH, resourceRef: REF, card,
    agent: { id: 'a1', handle: 'fx072', mode: card.mode },
    chain: { orchestratorId: 'a1', executorId: 'a2' },
    profile: i.profile === undefined ? { topic: 'Space', language: 'uk', formatPrefs: {}, full: null } : i.profile,
    group: i.group ?? null,
    resources: [{ ref: REF, platform: 'telegram' }],
    playbook: playbook ? { id: 'pb1', version: 3, body: playbook } : null,
    pendingPlaybook: i.pendingPlaybook ?? null,
    pins: i.pins ?? [],
    skills: i.skills ?? [],
    rules: i.rules ?? [],
    steering: i.steering ?? [],
    datasets: i.datasets ?? [],
    pauses: i.pauses ?? [],
    sources,
    loadoutTools: i.loadoutTools ?? null,
    conflictBase: { rules: [], refs: [REF], others: [], ...i.conflictBase },
    launch: i.launch ?? null,
    planned: i.planned ?? [],
    slots24h: i.slots24h ?? [],
  });
}

/** Freezes a value and everything inside it (dates are left as they are). */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !(v instanceof Date) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}
