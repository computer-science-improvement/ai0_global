import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { EditorRole } from '../llm/llm.types';
import {
  ANTHROPIC_PRICES, EDITOR_ROLES, STATIC_PRICES, builtinDefaultModel, builtinRoleModel, envModelKey, pickModel, pickReasoningEffort,
  type ModelSource, type ReasoningEffort,
} from '../llm/model-registry';
import { WORKSPACES, agentModelIn, type Workspace } from '../llm/workspace';
import { ORCHESTRATOR_CHILDREN, roleOfKind, telegramKeyOf, type Agent } from '../agents/agent.types';
import type { PriceRow } from '../../common/ai/usage/llm-prices.repository';
import type { CatalogModel, CatalogSnapshot, ModelCatalog } from './model-catalog';

/** Spend accounting key of the OpenRouter workspace's models (the Anthropic workspace's provider is `anthropic`). */
const PROVIDER = 'openrouter';

/** A model setting kept per workspace (WorkspaceModelStore). */
export interface WorkspaceModelSetting {
  get(ws?: Workspace): Promise<string | null>;
  set(ws: Workspace, model: string | null): Promise<void>;
}

export interface ModelsServiceDeps {
  pool:     Pick<Pool, 'query'>;
  agents:   { list(): Promise<Agent[]> };
  /** The OpenRouter catalog (public list). */
  catalog:  Pick<ModelCatalog, 'list'>;
  /** Spec 038: the Anthropic catalog (static list with prices, merged with the live /v1/models list when a key is set). */
  anthropicCatalog?: Pick<ModelCatalog, 'list'>;
  defaults: WorkspaceModelSetting;
  /** Spec 034 FR-004: the owner's pre-publish critic model (app_settings `ai.critic_model`); optional. */
  critic?:  WorkspaceModelSetting;
  /** Spec 038: the active workspace (absent → always openrouter). */
  workspace?: { get(): Promise<Workspace>; set(ws: Workspace): Promise<void> };
  /** Spec 038: whether the server has an Anthropic API key (never the value). */
  anthropicKey?: () => boolean;
  /** Spec 029 price cache; optional (tests, a build without the usage module). */
  prices?:  { price(provider: string, model: string): Promise<PriceRow | null>; invalidate(): void };
  env:      (key: string) => string | undefined;
  log?:     (msg: string) => void;
}

export interface ModelPrice { inPerM: number; outPerM: number; source: 'llm_prices' | 'catalog' | 'static' }

export interface AgentModelRow {
  id:            string;
  handle:        string;
  name:          string;
  emoji:         string | null;
  kind:          Agent['kind'];
  role:          EditorRole;
  scope:         Agent['scope'];
  parentId:      string | null;
  parentHandle:  string | null;
  /** The agent's own setting (null = not set). */
  model:         string | null;
  reasoningEffort: ReasoningEffort | null;
  effective: {
    model:  string;
    source: ModelSource;
    /** Set when the model comes from the orchestrator's own setting. */
    inheritedFrom: string | null;
    reasoningEffort: ReasoningEffort;
    reasoningSource: 'agent' | 'env' | 'default';
  };
  price:         ModelPrice | null;
  channelKey:    string | null;
}

const MODEL_ID = z.string().trim().min(3).max(100).regex(/^\S+$/, 'no spaces');
const WorkspaceBody = z.object({ workspace: z.enum(WORKSPACES as unknown as [Workspace, ...Workspace[]]) }).strict();
const DefaultBody = z.object({ model: MODEL_ID.nullable() }).strict();
const BulkBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('apply_all'), model: MODEL_ID }).strict(),
  z.object({ action: z.literal('reset_all') }).strict(),
]);
const ClearBody = z.object({
  channelKey: z.string().trim().min(1).max(200),
  role: z.enum(EDITOR_ROLES as unknown as [EditorRole, ...EditorRole[]]).optional(),
}).strict();

const badRequest = (r: z.ZodError) => new BadRequestException({ error: 'invalid_body', issues: r.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

/** Spec 035: the owner's model choices — global default, per-agent models, bulk actions, legacy channel overrides. */
export class ModelsService {
  constructor(private readonly d: ModelsServiceDeps) {}

  /** The active workspace (spec 038). */
  async active(): Promise<Workspace> {
    try { return this.d.workspace ? await this.d.workspace.get() : 'openrouter'; } catch { return 'openrouter'; }
  }

  private catalogOf(ws: Workspace): Pick<ModelCatalog, 'list'> {
    return ws === 'anthropic' && this.d.anthropicCatalog ? this.d.anthropicCatalog : this.d.catalog;
  }

  /** GET /api/models — the active workspace's tool-capable catalog, the current default first. */
  async catalog(): Promise<CatalogSnapshot & { defaultModel: string; workspace: Workspace }> {
    const ws = await this.active();
    const [snap, saved] = await Promise.all([this.catalogOf(ws).list(), this.d.defaults.get(ws)]);
    const def = saved ?? builtinDefaultModel(ws);
    const first = snap.models.filter((m) => m.id === def);
    return { ...snap, models: [...first, ...snap.models.filter((m) => m.id !== def)], defaultModel: def, workspace: ws };
  }

  /** GET /api/models/workspace — the active workspace, whether Anthropic can be chosen, each workspace's default model and how many agents have their own model there. */
  async workspaceInfo() {
    const [ws, all] = await Promise.all([this.active(), this.d.agents.list()]);
    const workspaces = await Promise.all(WORKSPACES.map(async (w) => {
      const saved = await this.d.defaults.get(w).catch(() => null);
      // Spec 046 FR-010: without a saved default the Anthropic workspace has a model per role.
      return { id: w, defaultModel: saved ?? builtinDefaultModel(w), perRole: !saved && w === 'anthropic', agentsWithOwnModel: all.filter((a) => !!agentModelIn(a, w)).length };
    }));
    return { active: ws, anthropicKey: !!this.d.anthropicKey?.(), switchable: !!this.d.workspace, workspaces };
  }

  /** PUT /api/models/workspace `{workspace}` — switch every agent's runs to that provider (Anthropic needs a key on the server). */
  async setWorkspace(body: unknown) {
    const p = WorkspaceBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    if (!this.d.workspace) throw new NotFoundException({ error: 'workspace_unavailable' });
    const ws = p.data.workspace;
    if (ws === 'anthropic' && !this.d.anthropicKey?.()) {
      throw new BadRequestException({
        error: 'anthropic_key_missing',
        details: 'Set EDITOR_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) on the server first: a key of the Console organization linked to your Claude plan.',
      });
    }
    await this.d.workspace.set(ws);
    this.d.log?.(`model workspace → ${ws}`);
    return { ok: true, workspace: ws };
  }

  /** GET /api/models/overview — the page: default, env notes, every agent's effective model, legacy overrides. */
  async overview() {
    const ws = await this.active();
    const [saved, all, cards] = await Promise.all([this.d.defaults.get(ws), this.d.agents.list(), this.channelModels()]);
    const def = saved ?? builtinDefaultModel(ws);
    const byId = new Map(all.map((a) => [a.id, a]));
    const cardOf = new Map(cards.map((c) => [c.channelKey, c.models]));
    const order: Record<string, number> = { manager: 0, builder: 1, orchestrator: 2 };
    const roots = all.filter((a) => !a.parentId || !byId.has(a.parentId))
      .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.handle.localeCompare(b.handle));
    const flat: Agent[] = [];
    for (const r of roots) {
      flat.push(r);
      const rank = (k: Agent['kind']) => { const i = ORCHESTRATOR_CHILDREN.indexOf(k); return i < 0 ? 99 : i; };
      flat.push(...all.filter((c) => c.parentId === r.id).sort((a, b) => rank(a.kind) - rank(b.kind) || a.handle.localeCompare(b.handle)));
    }
    const priceCache = new Map<string, Promise<ModelPrice | null>>();
    const priceOf = (m: string) => {
      if (!priceCache.has(m)) priceCache.set(m, this.priceOf(m, ws));
      return priceCache.get(m)!;
    };
    const agents: AgentModelRow[] = await Promise.all(flat.map(async (a) => {
      const parent = a.parentId ? byId.get(a.parentId) ?? null : null;
      const orch = parent ?? a;
      const channelKey = telegramKeyOf(orch);
      const role = roleOfKind(a.kind);
      const own = agentModelIn(a, ws);
      const parentOwn = agentModelIn(parent, ws);
      const agentModel = own ?? parentOwn;
      // The owner's saved default (null → each role's built-in model, as the runners resolve it).
      const pick = pickModel(role, this.d.env, channelKey ? cardOf.get(channelKey) ?? null : null, { agentModel, defaultModel: saved, workspace: ws });
      const effort = pickReasoningEffort(role, this.d.env, a.reasoningEffort ?? parent?.reasoningEffort ?? null);
      return {
        id: a.id, handle: a.handle, name: a.name, emoji: a.emoji, kind: a.kind, role, scope: a.scope,
        parentId: parent?.id ?? null, parentHandle: parent?.handle ?? null,
        model: own, reasoningEffort: a.reasoningEffort,
        effective: {
          model: pick.model, source: pick.source, inheritedFrom: !own && parentOwn ? parent!.handle : null,
          reasoningEffort: effort.effort, reasoningSource: effort.source,
        },
        price: await priceOf(pick.model),
        channelKey,
      };
    }));
    // Spec 034 FR-004: the critic runs as the `checker` role; the owner's choice beats env, env beats the default.
    const criticSaved = this.d.critic ? await this.d.critic.get(ws) : null;
    const criticPick = pickModel('checker', this.d.env, null, { agentModel: criticSaved, defaultModel: saved, workspace: ws });
    return {
      workspace: ws,
      defaultModel: {
        model: def, saved, builtin: builtinDefaultModel(ws), price: await priceOf(def),
        // Spec 046 FR-010: the built-in per-role models in force while the Anthropic workspace has no saved default.
        roleModels: !saved && ws === 'anthropic' ? Object.fromEntries(EDITOR_ROLES.map((r) => [r, builtinRoleModel(r, ws)])) : null,
      },
      criticModel: {
        model: criticPick.model, saved: criticSaved,
        source: (criticPick.source === 'agent' ? 'critic' : criticPick.source) as 'critic' | 'env' | 'default',
        price: await priceOf(criticPick.model),
      },
      // Which roles an env EDITOR_MODEL_<ROLE> overrides (key names only — never the values).
      envOverrides: EDITOR_ROLES.filter((r) => !!this.d.env(envModelKey(r, ws))?.trim()).map((r) => ({ role: r, key: envModelKey(r, ws) })),
      agents,
      // The cards' legacy overrides are OpenRouter ids: the Anthropic workspace ignores them (spec 038).
      channelOverrides: ws === 'openrouter' ? cards.filter((c) => Object.keys(c.models).length > 0) : [],
    };
  }

  /** PUT /api/models/default — `{model}` saves the global default, `{model: null}` returns to the built-in one. */
  async setDefault(body: unknown) {
    const p = DefaultBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const model = p.data.model;
    const ws = await this.active();
    if (model) {
      const saved = await this.d.defaults.get(ws);
      await this.assertKnown(model, [saved, builtinDefaultModel(ws)], ws);
      await this.d.defaults.set(ws, model);
      await this.ensurePrice(model, ws);
    } else {
      await this.d.defaults.set(ws, null);
    }
    this.d.log?.(`default model (${ws}) → ${model ?? `built-in (${builtinDefaultModel(ws)})`}`);
    return { ok: true, workspace: ws, defaultModel: model ?? builtinDefaultModel(ws), saved: model };
  }

  /** PUT /api/models/critic — `{model}` gives the pre-publish critic its own model, `{model: null}` makes it follow the default. */
  async setCritic(body: unknown) {
    const p = DefaultBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    if (!this.d.critic) throw new NotFoundException({ error: 'critic_unavailable' });
    const model = p.data.model;
    const ws = await this.active();
    if (model) {
      const [saved, def] = await Promise.all([this.d.critic.get(ws), this.d.defaults.get(ws)]);
      await this.assertKnown(model, [saved, def, builtinDefaultModel(ws)], ws);
      await this.d.critic.set(ws, model);
      await this.ensurePrice(model, ws);
    } else {
      await this.d.critic.set(ws, null);
    }
    this.d.log?.(`critic model (${ws}) → ${model ?? 'the default'}`);
    return { ok: true, workspace: ws, criticModel: model };
  }

  /** POST /api/models/bulk — apply one model to every agent, or clear every agent's model. */
  async bulk(body: unknown) {
    const p = BulkBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const ws = await this.active();
    // The column of the active workspace (a constant, never user input).
    const col = ws === 'anthropic' ? 'anthropic_model' : 'model';
    if (p.data.action === 'apply_all') {
      const model = p.data.model;
      const [saved, all] = await Promise.all([this.d.defaults.get(ws), this.d.agents.list()]);
      await this.assertKnown(model, [saved, builtinDefaultModel(ws), ...all.map((a) => agentModelIn(a, ws))], ws);
      const { rowCount } = await this.d.pool.query(
        `UPDATE agents SET ${col} = $1, updated_at = now() WHERE ${col} IS DISTINCT FROM $1`, [model]);
      await this.ensurePrice(model, ws);
      this.d.log?.(`model ${model} (${ws}) applied to ${rowCount ?? 0} agent(s)`);
      return { ok: true, action: 'apply_all' as const, workspace: ws, model, updated: rowCount ?? 0 };
    }
    const { rowCount } = await this.d.pool.query(`UPDATE agents SET ${col} = NULL, updated_at = now() WHERE ${col} IS NOT NULL`);
    this.d.log?.(`agent models (${ws}) reset to the default on ${rowCount ?? 0} agent(s)`);
    return { ok: true, action: 'reset_all' as const, workspace: ws, updated: rowCount ?? 0 };
  }

  /** POST /api/models/channels/clear — drop a channel card's legacy `models` override (one role, or all). */
  async clearChannel(body: unknown) {
    const p = ClearBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const { channelKey, role } = p.data;
    const { rows } = await this.d.pool.query(
      `UPDATE editor_channels SET models = CASE WHEN $2::text IS NULL THEN '{}'::jsonb ELSE models - $2::text END, updated_at = now()
        WHERE channel_key = $1 RETURNING models`, [channelKey, role ?? null]);
    if (!rows[0]) throw new NotFoundException({ error: 'channel_not_found', channelKey });
    return { ok: true, channelKey, models: rows[0].models ?? {} };
  }

  /**
   * Agent model guard for PATCH /api/agents/:handle: a new model must be in the
   * catalog (or be the value already set somewhere, so an offline catalog never
   * blocks keeping a model).
   */
  async checkAgentModel(model: string, current: string | null): Promise<void> {
    const ws = await this.active();
    const saved = await this.d.defaults.get(ws);
    await this.assertKnown(model, [current, saved, builtinDefaultModel(ws)], ws);
  }

  /** After a model was chosen: price it in llm_prices from the catalog when it has no price yet (spend stays accurate). */
  async ensurePrice(model: string, ws?: Workspace): Promise<boolean> {
    try {
      if (!this.d.prices) return false;
      const w = ws ?? await this.active();
      if (await this.d.prices.price(w, model)) return false;
      if (w === 'anthropic') {
        const a = ANTHROPIC_PRICES[model];
        if (!a) return false;
        const { rowCount } = await this.d.pool.query(
          `INSERT INTO llm_prices (provider, model, in_per_m, out_per_m, cached_read_per_m, cached_write_per_m, note, updated_at)
           VALUES ('anthropic', $1, $2, $3, $4, $5, 'Anthropic price list (Models page)', now())
           ON CONFLICT (provider, model, effective_from) DO NOTHING`,
          [model, a.inPerM, a.outPerM, a.cacheReadPerM, a.cacheWritePerM]);
        this.d.prices.invalidate();
        if (rowCount) this.d.log?.(`llm_prices: added anthropic ${model} from the price list`);
        return !!rowCount;
      }
      const snap = await this.d.catalog.list();
      const m = snap.source === 'openrouter' ? snap.models.find((x) => x.id === model) : undefined;
      if (!m || m.inPerM == null || m.outPerM == null) return false;
      const { rowCount } = await this.d.pool.query(
        `INSERT INTO llm_prices (provider, model, in_per_m, out_per_m, note, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (provider, model, effective_from) DO NOTHING`,
        [PROVIDER, model, m.inPerM, m.outPerM, `OpenRouter catalog ${(snap.fetchedAt ?? '').slice(0, 10)} (Models page)`]);
      this.d.prices.invalidate();
      if (rowCount) this.d.log?.(`llm_prices: added ${model} from the OpenRouter catalog`);
      return !!rowCount;
    } catch (err: any) {
      this.d.log?.(`price upsert for ${model} failed: ${err?.message ?? err}`);
      return false;
    }
  }

  private async assertKnown(model: string, allowed: Array<string | null | undefined>, ws: Workspace = 'openrouter'): Promise<void> {
    if (allowed.some((x) => x === model)) return;
    const snap = await this.catalogOf(ws).list();
    if (snap.models.some((m) => m.id === model)) return;
    throw new BadRequestException({
      error: 'unknown_model',
      details: ws === 'anthropic'
        ? `${model} is not an Anthropic model`
        : snap.source === 'fallback'
          ? `${model} is not in the offline model list (the OpenRouter catalog is unavailable right now)`
          : `${model} is not an OpenRouter model with tool support`,
    });
  }

  private async priceOf(model: string, ws: Workspace = 'openrouter'): Promise<ModelPrice | null> {
    try {
      const row = await this.d.prices?.price(ws, model);
      if (row) return { inPerM: row.inPerM, outPerM: row.outPerM, source: 'llm_prices' };
    } catch { /* fall through */ }
    try {
      const m = (await this.catalogOf(ws).list()).models.find((x) => x.id === model);
      if (m && m.inPerM != null && m.outPerM != null) return { inPerM: m.inPerM, outPerM: m.outPerM, source: 'catalog' };
    } catch { /* fall through */ }
    const a = ws === 'anthropic' ? ANTHROPIC_PRICES[model] : undefined;
    if (a) return { inPerM: a.inPerM, outPerM: a.outPerM, source: 'static' };
    const s = ws === 'openrouter' ? STATIC_PRICES[model] : undefined;
    return s ? { ...s, source: 'static' } : null;
  }

  private async channelModels(): Promise<Array<{ channelKey: string; title: string | null; models: Partial<Record<EditorRole, string>> }>> {
    const { rows } = await this.d.pool.query(`SELECT channel_key, title, models FROM editor_channels ORDER BY channel_key`);
    return rows.map((r: any) => {
      const models: Partial<Record<EditorRole, string>> = {};
      for (const [k, v] of Object.entries(r.models ?? {})) {
        if ((EDITOR_ROLES as readonly string[]).includes(k) && typeof v === 'string' && v.trim()) models[k as EditorRole] = v.trim();
      }
      return { channelKey: r.channel_key, title: r.title ?? null, models };
    });
  }
}

/** The fallback catalog (OpenRouter unreachable): OpenRouter rows of llm_prices + the static price map. */
export function fallbackCatalog(rows: PriceRow[]): CatalogModel[] {
  const latest = new Map<string, PriceRow>();
  for (const r of rows) {
    if (r.provider !== PROVIDER) continue;
    const prev = latest.get(r.model);
    if (!prev || r.effectiveFrom >= prev.effectiveFrom) latest.set(r.model, r);
  }
  const out = new Map<string, CatalogModel>();
  for (const [id, p] of Object.entries(STATIC_PRICES)) {
    out.set(id, { id, name: id, contextLength: null, inPerM: p.inPerM, outPerM: p.outPerM, supportsReasoning: false });
  }
  for (const r of latest.values()) {
    out.set(r.model, { id: r.model, name: r.model, contextLength: null, inPerM: r.inPerM, outPerM: r.outPerM, supportsReasoning: false });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
