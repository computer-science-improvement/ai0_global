import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { EditorRole } from '../llm/llm.types';
import {
  DEFAULT_EDITOR_MODEL, EDITOR_ROLES, STATIC_PRICES, envModelKey, pickModel, pickReasoningEffort,
  type ModelSource, type ReasoningEffort,
} from '../llm/model-registry';
import type { ModelDefaultsStore } from '../llm/model-defaults';
import { ORCHESTRATOR_CHILDREN, roleOfKind, telegramKeyOf, type Agent } from '../agents/agent.types';
import type { PriceRow } from '../../common/ai/usage/llm-prices.repository';
import type { CatalogModel, CatalogSnapshot, ModelCatalog } from './model-catalog';

/** Spend accounting key of every editor model (they all run through OpenRouter). */
const PROVIDER = 'openrouter';

export interface ModelsServiceDeps {
  pool:     Pick<Pool, 'query'>;
  agents:   { list(): Promise<Agent[]> };
  catalog:  Pick<ModelCatalog, 'list'>;
  defaults: Pick<ModelDefaultsStore, 'get' | 'set'>;
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

  /** GET /api/models — the tool-capable catalog, the current default first. */
  async catalog(): Promise<CatalogSnapshot & { defaultModel: string }> {
    const [snap, saved] = await Promise.all([this.d.catalog.list(), this.d.defaults.get()]);
    const def = saved ?? DEFAULT_EDITOR_MODEL;
    const first = snap.models.filter((m) => m.id === def);
    return { ...snap, models: [...first, ...snap.models.filter((m) => m.id !== def)], defaultModel: def };
  }

  /** GET /api/models/overview — the page: default, env notes, every agent's effective model, legacy overrides. */
  async overview() {
    const [saved, all, cards] = await Promise.all([this.d.defaults.get(), this.d.agents.list(), this.channelModels()]);
    const def = saved ?? DEFAULT_EDITOR_MODEL;
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
      if (!priceCache.has(m)) priceCache.set(m, this.priceOf(m));
      return priceCache.get(m)!;
    };
    const agents: AgentModelRow[] = await Promise.all(flat.map(async (a) => {
      const parent = a.parentId ? byId.get(a.parentId) ?? null : null;
      const orch = parent ?? a;
      const channelKey = telegramKeyOf(orch);
      const role = roleOfKind(a.kind);
      const agentModel = a.model ?? parent?.model ?? null;
      const pick = pickModel(role, this.d.env, channelKey ? cardOf.get(channelKey) ?? null : null, { agentModel, defaultModel: def });
      const effort = pickReasoningEffort(role, this.d.env, a.reasoningEffort ?? parent?.reasoningEffort ?? null);
      return {
        id: a.id, handle: a.handle, name: a.name, emoji: a.emoji, kind: a.kind, role, scope: a.scope,
        parentId: parent?.id ?? null, parentHandle: parent?.handle ?? null,
        model: a.model, reasoningEffort: a.reasoningEffort,
        effective: {
          model: pick.model, source: pick.source, inheritedFrom: !a.model && parent?.model ? parent.handle : null,
          reasoningEffort: effort.effort, reasoningSource: effort.source,
        },
        price: await priceOf(pick.model),
        channelKey,
      };
    }));
    return {
      defaultModel: { model: def, saved, builtin: DEFAULT_EDITOR_MODEL, price: await priceOf(def) },
      // Which roles an env EDITOR_MODEL_<ROLE> overrides (key names only — never the values).
      envOverrides: EDITOR_ROLES.filter((r) => !!this.d.env(envModelKey(r))?.trim()).map((r) => ({ role: r, key: envModelKey(r) })),
      agents,
      channelOverrides: cards.filter((c) => Object.keys(c.models).length > 0),
    };
  }

  /** PUT /api/models/default — `{model}` saves the global default, `{model: null}` returns to the built-in one. */
  async setDefault(body: unknown) {
    const p = DefaultBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const model = p.data.model;
    if (model) {
      const saved = await this.d.defaults.get();
      await this.assertKnown(model, [saved, DEFAULT_EDITOR_MODEL]);
      await this.d.defaults.set(model);
      await this.ensurePrice(model);
    } else {
      await this.d.defaults.set(null);
    }
    this.d.log?.(`default model → ${model ?? `built-in (${DEFAULT_EDITOR_MODEL})`}`);
    return { ok: true, defaultModel: model ?? DEFAULT_EDITOR_MODEL, saved: model };
  }

  /** POST /api/models/bulk — apply one model to every agent, or clear every agent's model. */
  async bulk(body: unknown) {
    const p = BulkBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    if (p.data.action === 'apply_all') {
      const model = p.data.model;
      const [saved, all] = await Promise.all([this.d.defaults.get(), this.d.agents.list()]);
      await this.assertKnown(model, [saved, DEFAULT_EDITOR_MODEL, ...all.map((a) => a.model)]);
      const { rowCount } = await this.d.pool.query(
        `UPDATE agents SET model = $1, updated_at = now() WHERE model IS DISTINCT FROM $1`, [model]);
      await this.ensurePrice(model);
      this.d.log?.(`model ${model} applied to ${rowCount ?? 0} agent(s)`);
      return { ok: true, action: 'apply_all' as const, model, updated: rowCount ?? 0 };
    }
    const { rowCount } = await this.d.pool.query(`UPDATE agents SET model = NULL, updated_at = now() WHERE model IS NOT NULL`);
    this.d.log?.(`agent models reset to the default on ${rowCount ?? 0} agent(s)`);
    return { ok: true, action: 'reset_all' as const, updated: rowCount ?? 0 };
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
    const saved = await this.d.defaults.get();
    await this.assertKnown(model, [current, saved, DEFAULT_EDITOR_MODEL]);
  }

  /** After a model was chosen: price it in llm_prices from the catalog when it has no price yet (spend stays accurate). */
  async ensurePrice(model: string): Promise<boolean> {
    try {
      if (!this.d.prices) return false;
      if (await this.d.prices.price(PROVIDER, model)) return false;
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

  private async assertKnown(model: string, allowed: Array<string | null | undefined>): Promise<void> {
    if (allowed.some((x) => x === model)) return;
    const snap = await this.d.catalog.list();
    if (snap.models.some((m) => m.id === model)) return;
    throw new BadRequestException({
      error: 'unknown_model',
      details: snap.source === 'fallback'
        ? `${model} is not in the offline model list (the OpenRouter catalog is unavailable right now)`
        : `${model} is not an OpenRouter model with tool support`,
    });
  }

  private async priceOf(model: string): Promise<ModelPrice | null> {
    try {
      const row = await this.d.prices?.price(PROVIDER, model);
      if (row) return { inPerM: row.inPerM, outPerM: row.outPerM, source: 'llm_prices' };
    } catch { /* fall through */ }
    try {
      const m = (await this.d.catalog.list()).models.find((x) => x.id === model);
      if (m && m.inPerM != null && m.outPerM != null) return { inPerM: m.inPerM, outPerM: m.outPerM, source: 'catalog' };
    } catch { /* fall through */ }
    const s = STATIC_PRICES[model];
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
