import type { Pool } from 'pg';
import { z } from 'zod';
import type { ChannelSetupRepository, SetupProposal } from '../setup/setup.repository';
import { OPEN_STATUSES } from '../setup/setup.repository';
import { refName, type SteeringRepository } from '../steering/steering.repository';
import type { SteeringSet } from '../steering/steering.types';
import { RulesEdit } from '../steering/steering.service';
import type { EditorMemoryRepository, MemoryRow } from '../repo/editor-memory.repository';
import type { SkillStore } from '../agents/skill-store';
import type { PlaybookRow } from '../network/network.repository';
import type { ArtifactVersionsRepository } from './artifact-versions.repository';
import type {
  ArtifactAction, ArtifactEditor, ArtifactRow, ArtifactType, ArtifactVersionMeta,
} from './artifact.types';

/**
 * Spec 048 FR-001: one adapter per artifact type over its own table. Lists never write; a single read records a body
 * that changed elsewhere as a `system` version (setup, steering, rules), so every change shows in the history.
 */

/** Orchestrators: handle ↔ resource ref ↔ Telegram channel. */
export interface AgentDirectory {
  byHandle: Map<string, { id: string; ref: string | null; channel: string | null }>;
  byId:     Map<string, string>;
  byRef:    Map<string, string>;
}

export async function loadDirectory(pool: Pick<Pool, 'query'>): Promise<AgentDirectory> {
  const { rows } = await pool.query(
    `SELECT id, handle, scope, scope_id FROM agents WHERE parent_id IS NULL AND kind = 'orchestrator'`).catch(() => ({ rows: [] as any[] }));
  const d: AgentDirectory = { byHandle: new Map(), byId: new Map(), byRef: new Map() };
  for (const a of rows) {
    const ref = a.scope === 'resource' ? (a.scope_id as string) : null;
    const channel = ref?.startsWith('telegram:@') ? ref.slice('telegram:'.length) : null;
    d.byHandle.set(a.handle, { id: a.id, ref, channel });
    d.byId.set(a.id, a.handle);
    if (ref) d.byRef.set(ref, a.handle);
  }
  return d;
}

const handleOfChannel = (d: AgentDirectory, channel: string | null) => (channel ? d.byRef.get(`telegram:${channel}`) ?? null : null);

/** A filter with the agent resolved to its channel and resource ref. */
export interface ResolvedFilter {
  channel?: string;
  ref?:     string;
  agentId?: string;
  status?:  string;
  limit:    number;
}

export type AdapterEdit = { ok: true } | { ok: false; error: string; details?: unknown };

export interface ArtifactAdapter {
  type: ArtifactType;
  list(f: ResolvedFilter, dir: AgentDirectory): Promise<ArtifactRow[]>;
  /** The artifact now, its body, and (for own-version types) the version recorded for it. */
  get(id: string, dir: AgentDirectory): Promise<{ row: ArtifactRow; body: unknown } | null>;
  versions(id: string): Promise<ArtifactVersionMeta[]>;
  version(id: string, v: number): Promise<unknown | undefined>;
  actions(row: ArtifactRow, body: unknown): ArtifactAction[];
  /** Hand edit or an agent's change; the type's validation decides. Absent = read only. */
  edit?(id: string, patch: unknown, by: ArtifactEditor, dir: AgentDirectory): Promise<AdapterEdit>;
  /** The edit's validation without writing: an agent's card is refused at once, not at the owner's Apply (FR-002). */
  check?(id: string, patch: unknown): Promise<AdapterEdit>;
}

/** Errors thrown by the existing services (Nest HttpException) as data. */
export function errorOf(err: any): { error: string; details?: unknown } {
  const r = typeof err?.getResponse === 'function' ? err.getResponse() : null;
  if (r && typeof r === 'object') return { error: String((r as any).error ?? 'invalid'), details: (r as any).details ?? (r as any).issues ?? (r as any).message };
  return { error: 'failed', details: String(err?.message ?? err) };
}

async function tryEdit(fn: () => Promise<unknown>): Promise<AdapterEdit> {
  try { await fn(); return { ok: true }; } catch (err) { return { ok: false, ...errorOf(err) }; }
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : new Date(0).toISOString());
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);

// ── setup ──────────────────────────────────────────────────────────────────

const SETUP_LABEL: Record<string, string> = {
  queued: 'queued', collecting: 'reading posts', analyzing: 'analysing', ready: 'ready', applied: 'applied',
  partially_applied: 'partly applied', discarded: 'discarded', superseded: 'superseded', failed: 'failed',
  no_access: 'no access', too_few_posts: 'too few posts', expired: 'expired',
};

function setupBody(p: SetupProposal) {
  return { status: p.status, reason: p.reason, sections: p.sections, sectionStatus: p.sectionStatus, metrics: p.metrics, resourceRef: p.resourceRef };
}

export function setupAdapter(d: { setup: Pick<ChannelSetupRepository, 'get' | 'list'>; versions: ArtifactVersionsRepository }): ArtifactAdapter {
  const row = (p: SetupProposal, dir: AgentDirectory, version: number | null): ArtifactRow => {
    const states = Object.values(p.sectionStatus ?? {});
    const applied = states.filter((s) => s === 'applied').length;
    const sections = p.sections ? Object.keys(p.sections).length : 0;
    return {
      type: 'setup', id: p.id, title: `Setup from history · ${p.channelKey}`,
      agent: (p.agentId ? dir.byId.get(p.agentId) : null) ?? handleOfChannel(dir, p.channelKey), channel: p.channelKey,
      target: p.resourceRef, status: p.status, version, updatedAt: iso(p.updatedAt),
      summary: sections ? `${sections} section${sections === 1 ? '' : 's'} · ${applied} applied` : `${SETUP_LABEL[p.status] ?? p.status}${p.reason ? ` — ${p.reason}` : ''}`,
      live: false,
    };
  };
  return {
    type: 'setup',
    async list(f, dir) {
      const all = await d.setup.list(f.channel ?? null, f.limit);
      const ps = all.filter((p) => !f.status || p.status === f.status);
      const v = await d.versions.latestMany('setup', ps.map((p) => p.id));
      return ps.map((p) => row(p, dir, v.get(p.id) ?? null));
    },
    async get(id, dir) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const p = await d.setup.get(id);
      if (!p) return null;
      const body = setupBody(p);
      const version = await d.versions.record('setup', id, { status: p.status, sections: p.sections, sectionStatus: p.sectionStatus }, 'system');
      return { row: row(p, dir, version), body };
    },
    versions: (id) => d.versions.list('setup', id),
    version: (id, v) => d.versions.body('setup', id, v),
    actions(r) {
      const out: ArtifactAction[] = [];
      if (r.status === 'ready' || r.status === 'partially_applied') out.push({ key: 'apply', label: 'Apply sections', method: 'POST', path: `/api/channel-setup/proposals/${r.id}/apply` });
      if ((OPEN_STATUSES as readonly string[]).includes(r.status) || r.status === 'partially_applied') {
        out.push({ key: 'discard', label: 'Discard', method: 'POST', path: `/api/channel-setup/proposals/${r.id}/discard`, danger: true });
      }
      return out;
    },
  };
}

// ── steering ───────────────────────────────────────────────────────────────

function steeringBody(s: SteeringSet) {
  return { status: s.status, reason: s.reason, summary: s.summary, sourceRef: s.sourceRef, sourceTitle: s.sourceTitle, targetRef: s.targetRef, rules: s.rules };
}

export function steeringAdapter(d: {
  repo: Pick<SteeringRepository, 'get' | 'list'>; editRules(id: string, body: unknown): Promise<unknown>; versions: ArtifactVersionsRepository;
}): ArtifactAdapter {
  const row = (s: SteeringSet, dir: AgentDirectory, version: number | null): ArtifactRow => {
    const on = s.rules.filter((r) => r.enabled && !r.conflict).length;
    const conflicts = s.rules.filter((r) => r.conflict).length;
    return {
      type: 'steering', id: s.id, title: `Steering from ${s.sourceTitle ?? refName(s.sourceRef)}`,
      agent: dir.byRef.get(s.targetRef) ?? null, channel: s.channelKey, target: s.targetRef, status: s.status, version,
      updatedAt: iso(s.updatedAt),
      summary: s.rules.length ? `${on} of ${s.rules.length} rules on${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : ''} · ${refName(s.sourceRef)}` : `${refName(s.sourceRef)}${s.reason ? ` — ${s.reason}` : ''}`,
      live: s.status === 'active',
    };
  };
  const snapshot = (s: SteeringSet) => ({ status: s.status, summary: s.summary, rules: s.rules });
  return {
    type: 'steering',
    async list(f, dir) {
      const sets = await d.repo.list({ targetRef: f.ref ?? (f.channel ? `telegram:${f.channel}` : null), limit: f.limit });
      const ss = sets.filter((s) => !f.status || s.status === f.status);
      const v = await d.versions.latestMany('steering', ss.map((s) => s.id));
      return ss.map((s) => row(s, dir, v.get(s.id) ?? null));
    },
    async get(id, dir) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const s = await d.repo.get(id);
      if (!s) return null;
      const version = await d.versions.record('steering', id, snapshot(s), 'system');
      return { row: row(s, dir, version), body: steeringBody(s) };
    },
    versions: (id) => d.versions.list('steering', id),
    version: (id, v) => d.versions.body('steering', id, v),
    actions(r) {
      const p = (a: string) => `/api/steering/${r.id}/${a}`;
      const editable = ['ready', 'active', 'paused'].includes(r.status);
      const out: ArtifactAction[] = editable ? [{ key: 'edit', label: 'Edit rules', method: 'PATCH' }] : [];
      if (r.status === 'ready') out.push({ key: 'activate', label: 'Activate', method: 'POST', path: p('activate') });
      if (r.status === 'active') out.push({ key: 'pause', label: 'Pause', method: 'POST', path: p('pause') });
      if (r.status === 'paused') out.push({ key: 'resume', label: 'Resume', method: 'POST', path: p('resume') });
      if (['discarded', 'superseded', 'failed', 'no_access', 'too_few_posts', 'active', 'paused'].includes(r.status)) {
        out.push({ key: 'reanalyze', label: 'Read the reference again', method: 'POST', path: p('reanalyze') });
      }
      if (['queued', 'ready', 'active', 'paused', 'failed', 'no_access', 'too_few_posts'].includes(r.status)) {
        out.push({ key: 'discard', label: 'Discard', method: 'POST', path: p('discard'), danger: true });
      }
      return out;
    },
    async check(id, patch) {
      const b = RulesEdit.safeParse(patch ?? {});
      if (!b.success) return { ok: false, error: 'invalid_body', details: issues(b.error) };
      const s = await d.repo.get(id);
      if (!s) return { ok: false, error: 'artifact_not_found' };
      if (!['ready', 'active', 'paused'].includes(s.status)) return { ok: false, error: 'not_editable', details: `a ${s.status} steering set is not edited` };
      const known = new Set(s.rules.map((r) => r.id));
      const unknown = [...(b.data.rules ?? []).map((r) => r.id), ...(b.data.remove ?? [])].filter((x) => !known.has(x));
      return unknown.length ? { ok: false, error: 'rule_not_found', details: unknown } : { ok: true };
    },
    async edit(id, patch, by) {
      const r = await tryEdit(() => d.editRules(id, patch));
      if (!r.ok) return r;
      const s = await d.repo.get(id);
      if (s) await d.versions.record('steering', id, snapshot(s), by.author, { agentId: by.agentId, reason: by.reason });
      return r;
    },
  };
}

// ── rules and memory (editor_channel_memory) ───────────────────────────────

const isOwnerRule = (m: Pick<MemoryRow, 'createdBy' | 'evidence'>) =>
  m.createdBy === 'owner' && (m.evidence as { source?: string } | null)?.source !== 'approval';

const RulesPatch = z.object({
  add:    z.array(z.string().trim().min(3).max(600)).max(20).optional(),
  edit:   z.array(z.object({ id: z.number().int(), text: z.string().trim().min(3).max(600) }).strict()).max(20).optional(),
  retire: z.array(z.number().int()).max(50).optional(),
}).strict().refine((b) => !!(b.add?.length || b.edit?.length || b.retire?.length), { message: 'add, edit or retire' });

/** Channels with active memory rows: owner rules (`rules`) or the rest (`memory`). */
async function memoryChannels(pool: Pick<Pool, 'query'>, rules: boolean, channel?: string) {
  const { rows } = await pool.query(
    `SELECT channel_key, count(*)::int AS n, max(created_at) AS at FROM editor_channel_memory
      WHERE active AND ($1::text IS NULL OR channel_key = $1)
        AND ${rules ? `created_by = 'owner' AND COALESCE(evidence->>'source', '') <> 'approval'` : `NOT (created_by = 'owner' AND COALESCE(evidence->>'source', '') <> 'approval')`}
      GROUP BY channel_key ORDER BY max(created_at) DESC`, [channel ?? null]);
  return rows as Array<{ channel_key: string; n: number; at: Date }>;
}

export function rulesAdapter(d: {
  pool: Pick<Pool, 'query'>; memory: Pick<EditorMemoryRepository, 'listAll' | 'add' | 'retireByOwner'>;
  lint: (text: string, channelKey: string) => Promise<Array<{ code: string; detail: string }>>; versions: ArtifactVersionsRepository;
}): ArtifactAdapter {
  const rulesOf = async (key: string) => (await d.memory.listAll(key)).filter((m) => m.active && isOwnerRule(m));
  const snapshot = (rs: MemoryRow[]) => rs.map((r) => ({ id: r.id, text: r.text }));
  const row = (key: string, n: number, at: Date, dir: AgentDirectory, version: number | null): ArtifactRow => ({
    type: 'rules', id: key, title: `Owner rules · ${key}`, agent: handleOfChannel(dir, key), channel: key, target: key,
    status: 'active', version, updatedAt: iso(at), summary: `${n} rule${n === 1 ? '' : 's'}`, live: n > 0,
  });
  const validate = async (id: string, patch: unknown) => {
    const p = RulesPatch.safeParse(patch ?? {});
    if (!p.success) return { ok: false as const, error: 'invalid_body', details: issues(p.error) as unknown };
    const current = await rulesOf(id);
    const known = new Set(current.map((r) => r.id));
    const unknown = [...(p.data.edit ?? []).map((e) => e.id), ...(p.data.retire ?? [])].filter((x) => !known.has(x));
    if (unknown.length) return { ok: false as const, error: 'rule_not_found', details: unknown as unknown };
    const texts = [...(p.data.add ?? []), ...(p.data.edit ?? []).map((e) => e.text)];
    const problems: string[] = [];
    for (const t of texts) for (const i of await d.lint(t, id)) problems.push(`«${t.slice(0, 60)}»: ${i.detail}`);
    if (problems.length) return { ok: false as const, error: 'rule_invalid', details: problems as unknown };
    return { ok: true as const, p: p.data, current };
  };
  return {
    type: 'rules',
    async list(f, dir) {
      if (f.status && f.status !== 'active') return [];
      const chans = (await memoryChannels(d.pool, true, f.channel)).slice(0, f.limit);
      const v = await d.versions.latestMany('rules', chans.map((c) => c.channel_key));
      return chans.map((c) => row(c.channel_key, c.n, c.at, dir, v.get(c.channel_key) ?? null));
    },
    async get(id, dir) {
      if (!/^@[A-Za-z0-9_]{3,64}$/.test(id)) return null;
      const rs = await rulesOf(id);
      const version = rs.length ? await d.versions.record('rules', id, snapshot(rs), 'system') : await d.versions.latest('rules', id);
      const at = rs.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), new Date(0));
      return {
        row: row(id, rs.length, at, dir, version),
        body: { rules: rs.map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: iso(r.createdAt), source: (r.evidence as { source?: string } | null)?.source ?? 'owner' })) },
      };
    },
    versions: (id) => d.versions.list('rules', id),
    version: (id, v) => d.versions.body('rules', id, v),
    actions: () => [{ key: 'edit', label: 'Edit rules', method: 'PATCH' }],
    check: async (id, patch) => { const v = await validate(id, patch); return v.ok ? { ok: true } : v; },
    async edit(id, patch, by) {
      const v = await validate(id, patch);
      if (!v.ok) return v;
      const { p, current } = v;
      const evidence = { source: by.author === 'owner' ? 'artifact' : 'chat', ...(by.agentId ? { agent: by.agentId } : {}) };
      for (const e of p.edit ?? []) {
        await d.memory.retireByOwner(id, e.id);
        await d.memory.add(id, current.find((r) => r.id === e.id)?.kind ?? 'rule', e.text, { ...evidence, replaces: e.id }, 'owner');
      }
      for (const r of p.retire ?? []) await d.memory.retireByOwner(id, r);
      for (const t of p.add ?? []) await d.memory.add(id, 'rule', t, evidence, 'owner');
      await d.versions.record('rules', id, snapshot(await rulesOf(id)), by.author, { agentId: by.agentId, reason: by.reason });
      return { ok: true };
    },
  };
}

const MemoryPatch = z.object({ retire: z.array(z.number().int()).min(1).max(50) }).strict();

export function memoryAdapter(d: { pool: Pick<Pool, 'query'>; memory: Pick<EditorMemoryRepository, 'listAll' | 'retireByOwner'> }): ArtifactAdapter {
  const linesOf = async (key: string) => (await d.memory.listAll(key)).filter((m) => m.active && !isOwnerRule(m));
  const row = (key: string, n: number, at: Date, dir: AgentDirectory): ArtifactRow => ({
    type: 'memory', id: key, title: `Memory · ${key}`, agent: handleOfChannel(dir, key), channel: key, target: key,
    status: 'active', version: null, updatedAt: iso(at), summary: `${n} line${n === 1 ? '' : 's'} learnt from reviews and approvals`, live: n > 0,
  });
  return {
    type: 'memory',
    async list(f, dir) {
      if (f.status && f.status !== 'active') return [];
      return (await memoryChannels(d.pool, false, f.channel)).slice(0, f.limit).map((c) => row(c.channel_key, c.n, c.at, dir));
    },
    async get(id, dir) {
      if (!/^@[A-Za-z0-9_]{3,64}$/.test(id)) return null;
      const ls = await linesOf(id);
      const at = ls.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), new Date(0));
      return {
        row: row(id, ls.length, at, dir),
        body: { lines: ls.map((r) => ({ id: r.id, kind: r.kind, text: r.text, by: r.createdBy, createdAt: iso(r.createdAt), source: (r.evidence as { source?: string } | null)?.source ?? null })) },
      };
    },
    versions: async () => [],
    version: async () => undefined,
    actions: () => [{ key: 'edit', label: 'Retire lines', method: 'PATCH' }],
    async edit(id, patch) {
      const p = MemoryPatch.safeParse(patch ?? {});
      if (!p.success) return { ok: false, error: 'invalid_body', details: issues(p.error) };
      const known = new Set((await linesOf(id)).map((l) => l.id));
      const unknown = p.data.retire.filter((x) => !known.has(x));
      if (unknown.length) return { ok: false, error: 'line_not_found', details: unknown };
      for (const r of p.data.retire) await d.memory.retireByOwner(id, r);
      return { ok: true };
    },
  };
}

// ── skills ─────────────────────────────────────────────────────────────────

const SkillPatch = z.object({
  body:        z.string().min(1).max(20_000).optional(),
  description: z.string().trim().min(1).max(300).optional(),
  appliesTo:   z.array(z.string().trim().min(1).max(40)).min(1).max(12).optional(),
}).strict().refine((b) => b.body !== undefined || b.description !== undefined || b.appliesTo !== undefined, { message: 'body, description or appliesTo' });

export function skillAdapter(d: { pool: Pick<Pool, 'query'>; skills: Pick<SkillStore, 'get' | 'versions' | 'writeAgentSkill'> }): ArtifactAdapter {
  const toRow = (r: any): ArtifactRow => ({
    type: 'skill', id: r.id, title: r.name, agent: r.owner_handle ?? null, channel: null, target: r.handle ?? 'shared',
    status: r.locked ? 'locked' : 'active', version: Number(r.current_version), updatedAt: iso(r.updated_at),
    summary: r.description ?? '', live: true,
  });
  const SELECT = `SELECT s.id, s.name, s.description, s.locked, s.current_version, s.updated_at, s.scope, a.handle,
                         COALESCE(p.handle, a.handle) AS owner_handle
                    FROM skills s LEFT JOIN agents a ON a.id = s.agent_id LEFT JOIN agents p ON p.id = a.parent_id`;
  return {
    type: 'skill',
    async list(f) {
      const { rows } = await d.pool.query(
        `${SELECT} WHERE s.scope <> 'builtin' AND ($1::uuid IS NULL OR s.agent_id = $1 OR a.parent_id = $1)
           AND ($2::text IS NULL OR ($2 = 'locked') = s.locked)
         ORDER BY s.updated_at DESC LIMIT $3`, [f.agentId ?? null, f.status ?? null, f.limit]);
      return rows.map(toRow);
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { rows } = await d.pool.query(`${SELECT} WHERE s.id = $1`, [id]);
      const s = await d.skills.get(id);
      if (!rows[0] || !s) return null;
      return { row: toRow(rows[0]), body: { name: s.name, scope: s.scope, description: s.description, appliesTo: s.appliesTo, body: s.body, locked: s.locked } };
    },
    async versions(id) {
      return (await d.skills.versions(id)).map((v) => ({ version: v.version, author: v.author, reason: v.reason, createdAt: iso(v.createdAt) }))
        .sort((a, b) => b.version - a.version);
    },
    async version(id, v) {
      const r = (await d.skills.versions(id)).find((x) => x.version === v);
      return r ? { description: r.description, appliesTo: r.appliesTo, body: r.body } : undefined;
    },
    actions: (r) => (r.status === 'locked' ? [] : [{ key: 'edit', label: 'Edit', method: 'PATCH' }]),
    async edit(id, patch, by) {
      const p = SkillPatch.safeParse(patch ?? {});
      if (!p.success) return { ok: false, error: 'invalid_body', details: issues(p.error) };
      const s = await d.skills.get(id);
      if (!s) return { ok: false, error: 'not_found' };
      if (s.scope !== 'agent' || !s.agentId) return { ok: false, error: 'shared_skill', details: 'a shared skill is changed per agent on the agent\'s Skills tab' };
      const r = await d.skills.writeAgentSkill({
        agentId: s.agentId, name: s.name, description: p.data.description ?? s.description, appliesTo: p.data.appliesTo ?? s.appliesTo,
        body: p.data.body ?? s.body, author: by.author === 'owner' ? 'owner' : 'agent', authorAgentId: by.agentId ?? null, reason: by.reason ?? null,
      });
      return 'error' in r ? { ok: false, error: r.error, details: r.details } : { ok: true };
    },
  };
}

// ── playbooks ──────────────────────────────────────────────────────────────

export function playbookAdapter(d: {
  pool: Pick<Pool, 'query'>; history(agentId: string): Promise<PlaybookRow[]>; put(handle: string, body: unknown): Promise<unknown>;
}): ArtifactAdapter {
  const toRow = (agentId: string, handle: string | null, active: PlaybookRow | null, pending: PlaybookRow | null): ArtifactRow => ({
    type: 'playbook', id: agentId, title: `Playbook · ${handle ? `@${handle}` : agentId}`, agent: handle, channel: null, target: handle,
    status: pending ? 'pending_owner' : active ? 'active' : 'none', version: active?.version ?? pending?.version ?? null,
    updatedAt: iso((pending ?? active)?.createdAt),
    summary: [active ? `v${active.version} active` : null, pending ? `v${pending.version} waits for you` : null].filter(Boolean).join(' · ') || 'no playbook',
    live: !!active,
  });
  return {
    type: 'playbook',
    async list(f, dir) {
      const { rows } = await d.pool.query(
        `SELECT p.agent_id, max(p.version) FILTER (WHERE p.status = 'active') AS active_v, max(p.version) FILTER (WHERE p.status = 'pending_owner') AS pending_v,
                max(p.created_at) AS at
           FROM playbooks p WHERE p.status IN ('active', 'pending_owner') AND ($1::uuid IS NULL OR p.agent_id = $1)
          GROUP BY p.agent_id ORDER BY max(p.created_at) DESC LIMIT $2`, [f.agentId ?? null, f.limit]);
      return rows.map((r: any) => {
        const pending = r.pending_v != null;
        const status = pending ? 'pending_owner' : 'active';
        const handle = dir.byId.get(r.agent_id) ?? null;
        return {
          type: 'playbook' as const, id: r.agent_id, title: `Playbook · ${handle ? `@${handle}` : r.agent_id}`, agent: handle, channel: handle ? dir.byHandle.get(handle)?.channel ?? null : null,
          target: handle, status, version: r.active_v != null ? Number(r.active_v) : Number(r.pending_v), updatedAt: iso(r.at),
          summary: [r.active_v != null ? `v${r.active_v} active` : null, pending ? `v${r.pending_v} waits for you` : null].filter(Boolean).join(' · '),
          live: r.active_v != null,
        };
      }).filter((r) => !f.status || r.status === f.status);
    },
    async get(id, dir) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const hist = await d.history(id);
      if (!hist.length) return null;
      const active = hist.find((p) => p.status === 'active') ?? null;
      const pending = hist.find((p) => p.status === 'pending_owner') ?? null;
      const handle = dir.byId.get(id) ?? null;
      const row = { ...toRow(id, handle, active, pending), channel: handle ? dir.byHandle.get(handle)?.channel ?? null : null };
      return {
        row,
        body: {
          active: active ? { id: active.id, version: active.version, body: active.body, rationale: active.rationale, createdBy: active.createdBy } : null,
          pending: pending ? { id: pending.id, version: pending.version, body: pending.body, rationale: pending.rationale, createdBy: pending.createdBy, review: pending.review } : null,
        },
      };
    },
    async versions(id) {
      return (await d.history(id)).map((p) => ({ version: p.version, author: p.createdBy, reason: `${p.status}${p.rationale ? ` — ${p.rationale}` : ''}`, createdAt: iso(p.createdAt) }));
    },
    async version(id, v) {
      return (await d.history(id)).find((p) => p.version === v)?.body;
    },
    actions(r, body) {
      const pending = (body as { pending?: { id: string } | null } | null)?.pending;
      const out: ArtifactAction[] = [{ key: 'edit', label: 'Edit', method: 'PATCH' }];
      if (pending) {
        out.push({ key: 'approve', label: `Activate v${(pending as any).version}`, method: 'POST', path: `/api/playbooks/${pending.id}/approve` });
        out.push({ key: 'reject', label: 'Reject', method: 'POST', path: `/api/playbooks/${pending.id}/reject`, danger: true });
      }
      return r.agent ? out : out.filter((a) => a.key !== 'edit');
    },
    async edit(id, patch, _by, dir) {
      const handle = dir.byId.get(id);
      if (!handle) return { ok: false, error: 'not_found' };
      return tryEdit(() => d.put(handle, patch));
    },
  };
}

// ── resource profile and formatting ────────────────────────────────────────

const FORMAT_KEYS = ['format_prefs', 'format_locks'];

export function profileAdapter(d: {
  pool: Pick<Pool, 'query'>; raw(ref: string): Promise<Record<string, any> | null>; put(handle: string, ref: string, body: unknown): Promise<unknown>;
}, kind: 'profile' | 'formatting'): ArtifactAdapter {
  const vkind = kind === 'profile' ? 'profile' : 'format';
  const pick = (p: Record<string, any> | null) => {
    if (!p) return null;
    if (kind === 'formatting') return p.format_prefs ? { format_prefs: p.format_prefs, format_locks: p.format_locks ?? [] } : null;
    const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !FORMAT_KEYS.includes(k)));
    return Object.keys(rest).length ? rest : null;
  };
  const toRow = (ref: string, dir: AgentDirectory, version: number | null, at: Date, body: Record<string, any>): ArtifactRow => {
    const handle = dir.byRef.get(ref) ?? null;
    return {
      type: kind, id: ref, title: `${kind === 'profile' ? 'Profile' : 'Formatting'} · ${ref.startsWith('telegram:') ? ref.slice(9) : ref}`,
      agent: handle, channel: ref.startsWith('telegram:@') ? ref.slice(9) : null, target: ref, status: 'active', version, updatedAt: iso(at),
      summary: kind === 'profile' ? String(body.topic ?? '').slice(0, 140) : `${Object.keys(body.format_prefs ?? {}).length} settings · ${(body.format_locks ?? []).length} locked`,
      live: true,
    };
  };
  const versionOf = async (refs: string[]) => {
    if (!refs.length) return new Map<string, number>();
    const { rows } = await d.pool.query(
      `SELECT resource_ref, max(version) AS v FROM resource_profile_versions WHERE kind = $1 AND resource_ref = ANY($2::text[]) GROUP BY resource_ref`, [vkind, refs]);
    return new Map(rows.map((r: any) => [r.resource_ref as string, Number(r.v)]));
  };
  return {
    type: kind,
    async list(f, dir) {
      if (f.status && f.status !== 'active') return [];
      const { rows } = await d.pool.query(
        `SELECT resource_ref, profile, updated_at FROM resource_profiles WHERE profile <> '{}'::jsonb AND ($1::text IS NULL OR resource_ref = $1)
          ORDER BY updated_at DESC LIMIT $2`, [f.ref ?? (f.channel ? `telegram:${f.channel}` : null), f.limit * 2]);
      const found = rows.map((r: any) => ({ ref: r.resource_ref as string, body: pick(r.profile), at: r.updated_at as Date })).filter((r) => r.body).slice(0, f.limit);
      const v = await versionOf(found.map((r) => r.ref));
      return found.map((r) => toRow(r.ref, dir, v.get(r.ref) ?? null, r.at, r.body!));
    },
    async get(id, dir) {
      const body = pick(await d.raw(id).catch(() => null));
      if (!body) return null;
      const v = await versionOf([id]);
      const { rows } = await d.pool.query(`SELECT updated_at FROM resource_profiles WHERE resource_ref = $1`, [id]);
      return { row: toRow(id, dir, v.get(id) ?? null, rows[0]?.updated_at ?? new Date(0), body), body };
    },
    async versions(id) {
      const { rows } = await d.pool.query(
        `SELECT v.version, v.changed_by, v.reason, v.created_at, a.handle FROM resource_profile_versions v LEFT JOIN agents a ON a.id = v.agent_id
          WHERE v.resource_ref = $1 AND v.kind = $2 ORDER BY v.version DESC LIMIT 50`, [id, vkind]);
      return rows.map((r: any) => ({ version: Number(r.version), author: r.changed_by === 'agent' && r.handle ? `@${r.handle}` : r.changed_by, reason: r.reason ?? null, createdAt: iso(r.created_at) }));
    },
    async version(id, v) {
      const { rows } = await d.pool.query(
        `SELECT profile FROM resource_profile_versions WHERE resource_ref = $1 AND kind = $2 AND version = $3`, [id, vkind, v]);
      return rows[0] ? pick(rows[0].profile) ?? {} : undefined;
    },
    actions: (r) => (r.agent ? [{ key: 'edit', label: 'Edit', method: 'PATCH' }] : []),
    async edit(id, patch, by, dir) {
      const handle = dir.byRef.get(id);
      if (!handle) return { ok: false, error: 'no_agent', details: 'only a resource with an agent can be edited here' };
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'invalid_body', details: 'an object of fields' };
      const current = pick(await d.raw(id)) ?? {};
      const merged = { ...current, ...(patch as Record<string, unknown>) };
      return tryEdit(() => d.put(handle, id, kind === 'formatting' ? { ...merged, ...(by.reason ? { reason: by.reason } : {}) } : merged));
    },
  };
}
