import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, EmptyState, Field } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { ActionsTh, RowActions, TableAction } from '../components/ui/table';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError, toast } from '../components/ui/Toast';
import { Modal } from '../components/Modal';
import { ModelSelect } from '../components/models/ModelSelect';
import { KIND_LABEL } from '../components/agents/AgentsUi';
import {
  useBulkModels, useClearChannelModels, useModelCatalog, useModelWorkspace, useModelsOverview, useSetAgentModel, useSetCriticModel,
  useSetDefaultModel, useSetModelWorkspace, type AgentModelRow, type ModelsOverview, type Workspace, type WorkspaceInfo,
} from '../api/models';
import type { ReasoningEffort } from '../api/agents';
import { fmtContext, fmtPerM, groupAgents, ownCounts, SOURCE_HINT, SOURCE_LABEL, SOURCE_TONE, WORKSPACE_LABEL } from '../lib/models';
import '../components/models/models.css';

// Models (spec 035): the owner picks the LLM of every agent. One global default
// (app_settings `ai.default_model`, built-in z-ai/glm-5.3-flash); an agent's own
// model beats a channel card's legacy override, which beats EDITOR_MODEL_* env
// variables, which beat the default.
// Spec 038: one level above, the workspace — OpenRouter or Anthropic (the Claude API directly).
// Everything below the Workspace card edits the active workspace's choices; each workspace keeps its own.
export const Route = createFileRoute('/app/models')({ component: ModelsPage });

function ModelsPage() {
  const q = useModelsOverview();
  const catalog = useModelCatalog();
  const ws = useModelWorkspace();
  const data = q.data;
  const active: Workspace = data?.workspace ?? 'openrouter';

  return (
    <div>
      <PageHeader
        eyebrow={data ? `${WORKSPACE_LABEL[active]} workspace` : undefined}
        title="Models"
        subtitle="Choose where agents run and the LLM each agent runs on. Agents without their own model use the default."
      />

      <div className="mdl-stack">
        {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
        {!data && !q.error && <div className="panel is-section mdl-skeleton compose-rise" aria-hidden />}

        {ws.data?.switchable && <WorkspaceCard info={ws.data} />}

        {catalog.data?.source === 'fallback' && (
          <div className="callout-warning">
            <Icon name="warning" size={16} />
            <div>
              {active === 'anthropic'
                ? 'The Anthropic model list is unavailable right now, so only the models with a known price can be chosen. It is retried in a few minutes.'
                : 'The OpenRouter model list is unavailable right now, so only models with a known price can be chosen. It is retried in a few minutes.'}
            </div>
          </div>
        )}

        {data && data.envOverrides.length > 0 && <EnvNote env={data.envOverrides} />}
        {data && <DefaultCard data={data} />}
        {data?.criticModel && <CriticModelCard data={data} />}
        {data && <AgentsSection data={data} />}
        {data && data.channelOverrides.length > 0 && <ChannelOverrides data={data} />}

        {catalog.data && (
          <p className="mdl-note is-dim">
            {catalog.data.source === 'openrouter'
              ? `${catalog.data.models.length} models with tool support from OpenRouter${catalog.data.fetchedAt ? `, fetched ${new Date(catalog.data.fetchedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}${catalog.data.stale ? ' (refresh failed, list may be outdated)' : ''}. Prices are USD per 1M tokens.`
              : catalog.data.source === 'anthropic'
                ? `${catalog.data.models.length} Claude models${catalog.data.fetchedAt ? ` (Anthropic's list, fetched ${new Date(catalog.data.fetchedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })})` : ' (built-in price list)'}. Prices are Anthropic list prices, USD per 1M tokens; prompt caching makes repeated input much cheaper.`
                : `${catalog.data.models.length} priced models (offline list). Prices are USD per 1M tokens.`}
          </p>
        )}
      </div>
    </div>
  );
}

/** Spec 038: OpenRouter or Anthropic for every agent; the choice of models below belongs to the active one. */
function WorkspaceCard({ info }: { info: WorkspaceInfo }) {
  const save = useSetModelWorkspace();
  const confirm = useConfirm();
  const of = (w: Workspace) => info.workspaces.find((x) => x.id === w);

  const change = async (next: Workspace) => {
    if (next === info.active) return;
    if (next === 'anthropic' && !info.anthropicKey) {
      toast.error('Add an Anthropic API key on the server first (EDITOR_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY).');
      return;
    }
    const target = of(next);
    const ok = await confirm(`run every agent on ${WORKSPACE_LABEL[next]}`, {
      danger: false, confirmLabel: `Switch to ${WORKSPACE_LABEL[next]}`,
      details: (
        <p className="mdl-note">
          From their next run, agents use the {WORKSPACE_LABEL[next]} models: the default {target ? <span className="mdl-id">{target.defaultModel}</span> : null}
          {target && target.agentsWithOwnModel > 0 ? `, and ${target.agentsWithOwnModel} agent${target.agentsWithOwnModel === 1 ? '' : 's'} with their own ${WORKSPACE_LABEL[next]} model` : ''}.
          Your {WORKSPACE_LABEL[info.active]} choices are kept and come back when you switch back. Runs already in progress finish where they started.
          {next === 'anthropic' && (
            <><br /><br />Cost: Claude models cost far more per post than the OpenRouter default (the last review measured about $1.21 per published post on Claude against $0.06). Without a default of your own, each role gets its built-in Claude model (Sonnet for the writer, critic, manager and chats; Haiku for plans, idea reviews and the daily orchestration), and the agents cap under Budgets stops runs above your daily limit.</>
          )}
        </p>
      ),
    });
    if (!ok) return;
    try {
      await save.mutateAsync(next);
      toast.success(`Agents now run on ${WORKSPACE_LABEL[next]}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <SectionCard title="Workspace" delay={0}
      action={info.anthropicKey
        ? <Badge tone="success" title="The server has an Anthropic API key">Anthropic key set</Badge>
        : <Badge tone="warning" title="Set EDITOR_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY on the server">No Anthropic key</Badge>}>
      <div className="mdl-body">
        <p className="mdl-note">
          {info.active === 'anthropic'
            ? <>Agents call the Claude API directly with the server's Anthropic key. With a key from the Console organization linked to your Claude Max plan, runs are paid from its monthly API credits; unused credits expire at the end of each billing cycle, and when they run out, runs fail until the next grant or until you buy credits. Spend shows under the <span className="mdl-id">anthropic</span> provider.</>
            : <>Agents run through OpenRouter with the server's OpenRouter key and pay as they go. Any model with tool support from the OpenRouter catalog can be chosen.</>}
        </p>
        <div className="mdl-ws" role="group" aria-label="Workspace">
          {info.workspaces.map((w) => {
            const on = w.id === info.active;
            return (
              <button key={w.id} type="button" className="mdl-ws-option" aria-pressed={on} onClick={() => change(w.id)}>
                <span className="mdl-ws-head">
                  <span className="mdl-ws-name">{WORKSPACE_LABEL[w.id]}</span>
                  {on && <Badge tone="accent">Active</Badge>}
                </span>
                <span className="mdl-ws-meta">
                  Default {w.perRole ? 'per role (Sonnet / Haiku)' : <span className="mdl-id">{w.defaultModel}</span>} · {w.agentsWithOwnModel} agent{w.agentsWithOwnModel === 1 ? '' : 's'} with their own model
                </span>
              </button>
            );
          })}
        </div>
        {!info.anthropicKey && (
          <p className="mdl-note is-dim">
            To use Anthropic, link a Console organization to your Claude plan (claude.ai → Settings → Billing → API credits), create an API key in it and set it on the server as <span className="mdl-id">EDITOR_ANTHROPIC_API_KEY</span>, then restart.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function EnvNote({ env }: { env: ModelsOverview['envOverrides'] }) {
  return (
    <div className="callout-warning">
      <Icon name="info" size={16} />
      <div>
        <div style={{ marginBottom: 4 }}>
          Server environment variables override the default model for {env.length === 1 ? 'one role' : `${env.length} roles`}:
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
          {env.map((e) => <span key={e.key} className="chip mono">{e.key}</span>)}
        </div>
        <div className="mdl-note">
          They beat the default chosen here (an agent's own model still wins). Remove them on the server to let the default apply.
        </div>
      </div>
    </div>
  );
}

function PriceFacts({ inPerM, outPerM, context }: { inPerM: number | null | undefined; outPerM: number | null | undefined; context?: number | null }) {
  const item = (label: string, value: ReactNode) => (
    <div className="mdl-fact">
      <div className="text-overline">{label}</div>
      <div className="mdl-fact-value mono">{value}</div>
    </div>
  );
  return (
    <div className="inset mdl-facts" aria-label="Price and context">
      {item('Input / 1M', fmtPerM(inPerM))}
      {item('Output / 1M', fmtPerM(outPerM))}
      {context ? item('Context', fmtContext(context)) : null}
    </div>
  );
}

/** "claude-sonnet-5-5 — executor, checker…; claude-haiku-5-5 — planner…" (spec 046 built-in per-role models). */
function roleModelsText(m: Record<string, string>): string {
  const by = new Map<string, string[]>();
  for (const [role, model] of Object.entries(m)) by.set(model, [...(by.get(model) ?? []), role.replace('_', ' ')]);
  return [...by.entries()].map(([model, roles]) => `${model} for ${roles.join(', ')}`).join('; ');
}

function DefaultCard({ data }: { data: ModelsOverview }) {
  const def = data.defaultModel;
  const catalog = useModelCatalog();
  const save = useSetDefaultModel();
  const confirm = useConfirm();
  const entry = catalog.data?.models.find((m) => m.id === def.model);
  const following = data.agents.filter((a) => a.effective.source === 'default').length;

  const change = async (model: string | null) => {
    const next = model ?? def.builtin;
    if (next === def.model && (model !== null || !def.saved)) return;
    const ok = await confirm(`make ${next} the default model`, {
      danger: false, confirmLabel: 'Set default',
      details: (
        <p className="mdl-note">
          {following} agent{following === 1 ? '' : 's'} currently follow{following === 1 ? 's' : ''} the default and switch from {def.model} to {next} on their next run.
          Agents with their own model, a channel override or an env override keep theirs.
        </p>
      ),
    });
    if (!ok) return;
    try {
      await save.mutateAsync(model);
      toast.success(`Default model: ${next}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <SectionCard title="Default model" delay={0}
      action={def.saved ? <Badge tone="accent">Custom</Badge> : <Badge tone="neutral">Built-in</Badge>}>
      <div className="mdl-body">
        <div className="mdl-grid">
          <Field label="Model" hint={`${following} of ${data.agents.length} agents follow it`} style={{ marginBottom: 0 }}>
            <ModelSelect value={def.model} onChange={(m) => change(m)} ariaLabel="Default model" disabled={save.isPending} />
          </Field>
          <PriceFacts inPerM={entry?.inPerM ?? def.price?.inPerM} outPerM={entry?.outPerM ?? def.price?.outPerM} context={entry?.contextLength} />
        </div>
        {def.roleModels && (
          <p className="mdl-note">
            No default chosen, so each role runs its built-in Claude model: {roleModelsText(def.roleModels)}. Choosing a default here puts every role on that model.
          </p>
        )}
        {def.saved && (
          <div className="mdl-row">
            <button type="button" className="btn-secondary btn-sm" disabled={save.isPending} onClick={() => change(null)}>
              <Icon name="reset" size={13} /> Use the built-in default
            </button>
            <span className="mdl-id is-dim">{def.builtin}</span>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/** Spec 034 FR-004: the pre-publish critic reads every agent post before it is stored, sent or put up for approval. */
function CriticModelCard({ data }: { data: ModelsOverview }) {
  const c = data.criticModel!;
  const catalog = useModelCatalog();
  const save = useSetCriticModel();
  const confirm = useConfirm();
  const entry = catalog.data?.models.find((m) => m.id === c.model);

  const change = async (model: string | null) => {
    if (model !== null && model === c.saved) return;
    if (model === null && !c.saved) return;
    const next = model ?? data.defaultModel.model;
    const ok = await confirm(`use ${next} for the critic`, {
      danger: false, confirmLabel: 'Set critic model',
      details: (
        <p className="mdl-note">
          The critic reviews every post (once more after a rewrite), so its cost is added to each post. A stronger model catches more AI-sounding and senseless posts.
        </p>
      ),
    });
    if (!ok) return;
    try {
      await save.mutateAsync(model);
      toast.success(model ? `Critic model: ${model}` : 'The critic follows the default model');
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  const badge = c.source === 'critic' ? <Badge tone="accent">Custom</Badge>
    : c.source === 'env' ? <Badge tone="warning">Env override</Badge>
    : <Badge tone="neutral">Follows the default</Badge>;

  return (
    <SectionCard title="Critic model" delay={40} action={badge}>
      <div className="mdl-body">
        <p className="mdl-note">
          Before a post is published, stored as a preview or sent for your approval, the critic scores it (human voice, sense, tone, facts, reader asks, format)
          and passes it, asks the agent for one rewrite, or rejects it. Its spend shows as <span className="mdl-id">editor.checker</span> on the Spend page.
        </p>
        <div className="mdl-grid">
          <Field label="Model" hint={c.source === 'env' ? `${data.workspace === 'anthropic' ? 'EDITOR_ANTHROPIC_MODEL_CHECKER' : 'EDITOR_MODEL_CHECKER'} is set on the server; a model chosen here beats it` : undefined} style={{ marginBottom: 0 }}>
            <ModelSelect value={c.saved} onChange={(m) => change(m)} ariaLabel="Critic model" disabled={save.isPending}
              defaultLabel={`Default (${c.source === 'env' ? c.model : data.defaultModel.model})`} />
          </Field>
          <PriceFacts inPerM={entry?.inPerM ?? c.price?.inPerM} outPerM={entry?.outPerM ?? c.price?.outPerM} context={entry?.contextLength} />
        </div>
        {c.saved && (
          <div className="mdl-row">
            <button type="button" className="btn-secondary btn-sm" disabled={save.isPending} onClick={() => change(null)}>
              <Icon name="reset" size={13} /> Follow the default model
            </button>
            <span className="mdl-id is-dim">{data.defaultModel.model}</span>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function SourceBadge({ row }: { row: AgentModelRow }) {
  const s = row.effective.source;
  const title = row.effective.inheritedFrom ? `Inherited from @${row.effective.inheritedFrom}` : `From ${SOURCE_HINT[s]}`;
  return <Badge tone={SOURCE_TONE[s]} title={title}>{SOURCE_LABEL[s]}</Badge>;
}

function AgentsSection({ data }: { data: ModelsOverview }) {
  const bulk = useBulkModels();
  const setAgent = useSetAgentModel();
  const confirm = useConfirm();
  const [bulkModel, setBulkModel] = useState<string | null>(data.defaultModel.model);
  const [editing, setEditing] = useState<AgentModelRow | null>(null);
  const groups = groupAgents(data.agents);
  const own = ownCounts(data.agents);
  const byId = new Map(data.agents.map((a) => [a.id, a]));

  const applyAll = async () => {
    if (!bulkModel) return;
    const ok = await confirm(`run every agent (${data.agents.length}) on ${bulkModel}`, {
      danger: false, confirmLabel: 'Apply to all',
      details: (
        <p className="mdl-note">
          Sets {bulkModel} as the own model of every agent, including role agents. It beats channel and env overrides and later changes of the default.
          Use "Reset all to default" to undo.
        </p>
      ),
    });
    if (!ok) return;
    try {
      const r = await bulk.mutateAsync({ action: 'apply_all', model: bulkModel });
      toast.success(`${bulkModel} applied to ${r.updated} agent${r.updated === 1 ? '' : 's'}`);
    } catch (err) { toast.error(describeError(err)); }
  };

  const resetAll = async () => {
    const ok = await confirm(`clear the own model of ${own.models} agent${own.models === 1 ? '' : 's'}`, {
      danger: true, confirmLabel: 'Reset all',
      details: (
        <p className="mdl-note">
          Every agent goes back to the default model ({data.defaultModel.model}), unless a channel or env override applies. Reasoning effort settings are kept.
        </p>
      ),
    });
    if (!ok) return;
    try {
      const r = await bulk.mutateAsync({ action: 'reset_all' });
      toast.success(`${r.updated} agent${r.updated === 1 ? '' : 's'} reset to the default model`);
    } catch (err) { toast.error(describeError(err)); }
  };

  const resetRow = async (row: AgentModelRow) => {
    const what = [row.model && `model ${row.model}`, row.reasoningEffort && `effort ${row.reasoningEffort}`].filter(Boolean).join(' and ');
    if (!(await confirm(`reset @${row.handle} to the default (${what})`, { danger: false, confirmLabel: 'Reset' }))) return;
    try {
      await setAgent.mutateAsync({ handle: row.handle, model: null, reasoning_effort: null });
      toast.success(`@${row.handle} follows the default now`);
    } catch (err) { toast.error(describeError(err)); }
  };

  const rowView = (row: AgentModelRow, child: boolean) => (
    <tr key={row.id}>
      <td className={child ? 'mdl-child-pad' : undefined} style={{ minWidth: 180 }}>
        <div className="mdl-who">
          {child && <span aria-hidden className="mdl-dim"><Icon name="chevron-right" size={12} /></span>}
          <span aria-hidden>{row.emoji ?? ''}</span>
          <span style={{ minWidth: 0 }}>
            <Link to="/app/agents/$handle" params={{ handle: row.handle }} className={`mdl-who-name${child ? ' is-child' : ''}`}>
              {row.name}
            </Link>
            <span className="mdl-handle mono">@{row.handle}</span>
          </span>
        </div>
      </td>
      <td className="meta" style={{ whiteSpace: 'nowrap' }}>{KIND_LABEL[row.kind] ?? row.kind}</td>
      <td style={{ minWidth: 200 }}>
        <span className="mdl-id is-ink">{row.effective.model}</span>
        {row.effective.inheritedFrom && <span className="mdl-sub">via @{row.effective.inheritedFrom}</span>}
      </td>
      <td><SourceBadge row={row} /></td>
      <td className="num mono">{fmtPerM(row.price?.inPerM)}</td>
      <td className="num mono">{fmtPerM(row.price?.outPerM)}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {row.effective.reasoningEffort}
        {row.effective.reasoningSource !== 'default' && (
          <span className="mdl-sub-inline">
            {row.effective.reasoningSource === 'env' ? 'env' : row.reasoningEffort ? 'own' : 'inherited'}
          </span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <RowActions>
          <TableAction action="edit" title={`Change the model of @${row.handle}`} onClick={() => setEditing(row)} />
          <TableAction icon="reset" title="Reset to default" disabled={!row.model && !row.reasoningEffort} onClick={() => resetRow(row)} />
        </RowActions>
      </td>
    </tr>
  );

  return (
    <SectionCard title="Agents" delay={40} action={<span className="mdl-count mono">{data.agents.length} total</span>}>
      <div className="mdl-toolbar">
        <div className="mdl-toolbar-pick">
          <div className="text-eyebrow" style={{ marginBottom: 4 }}>Bulk model</div>
          <ModelSelect value={bulkModel} onChange={setBulkModel} ariaLabel="Model for all agents" compact />
        </div>
        <button type="button" className="btn-primary btn-sm" disabled={!bulkModel || bulk.isPending} onClick={applyAll}>Apply to all agents</button>
        <button type="button" className="btn-secondary btn-sm" disabled={own.models === 0 || bulk.isPending} onClick={resetAll}>
          <Icon name="reset" size={13} /> Reset all to default
        </button>
      </div>

      {data.agents.length === 0 ? (
        <EmptyState icon="agents" title="No agents yet" note="Agents appear here once the registry has them (Agents page)." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th>Agent</th><th>Role</th><th>Model</th><th>Source</th>
              <th className="num">In / 1M</th><th className="num">Out / 1M</th><th>Effort</th><ActionsTh />
            </tr></thead>
            <tbody>
              {groups.flatMap((g) => [rowView(g.root, false), ...g.children.map((c) => rowView(c, true))])}
            </tbody>
          </table>
        </div>
      )}
      <p className="mdl-note is-dim" style={{ marginTop: 12 }}>
        {data.workspace === 'anthropic'
          ? <>Precedence: the agent's own Anthropic model (role agents inherit their orchestrator's), then an env variable, then the default (without one, the role's built-in model). Channel overrides apply to OpenRouter only.</>
          : <>Precedence: the agent's own model (role agents inherit their orchestrator's), then a channel override, then an env variable, then the default.</>}
      </p>

      {editing && (
        <AgentModelModal row={editing} parent={editing.parentId ? byId.get(editing.parentId) ?? null : null}
          defaultModel={data.defaultModel.model} onClose={() => setEditing(null)} />
      )}
    </SectionCard>
  );
}

function AgentModelModal({ row, parent, defaultModel, onClose }: {
  row: AgentModelRow; parent: AgentModelRow | null; defaultModel: string; onClose: () => void;
}) {
  const [model, setModel] = useState<string | null>(row.model);
  const [effort, setEffort] = useState<'' | ReasoningEffort>(row.reasoningEffort ?? '');
  const save = useSetAgentModel();
  const fallback = parent?.model ? `Inherit from @${parent.handle} (${parent.model})` : `Default (${defaultModel})`;
  const patch: { model?: string | null; reasoning_effort?: ReasoningEffort | null } = {};
  if (model !== row.model) patch.model = model;
  if ((effort || null) !== row.reasoningEffort) patch.reasoning_effort = effort || null;
  const dirty = Object.keys(patch).length > 0;

  const submit = async () => {
    if (!dirty) return;
    try {
      await save.mutateAsync({ handle: row.handle, ...patch });
      toast.success(`@${row.handle}: ${model ?? 'default model'}`);
      onClose();
    } catch { /* shown inline */ }
  };

  return (
    <Modal open onClose={onClose} title={`Model for @${row.handle}`} subtitle={`${row.name} · ${KIND_LABEL[row.kind] ?? row.kind}`} icon="cpu">
      <Field label="Model" hint="the first entry clears the agent's own model">
        <ModelSelect value={model} onChange={setModel} defaultLabel={fallback} ariaLabel={`Model for @${row.handle}`} />
      </Field>
      <Field label="Reasoning effort" hint="low keeps reasoning models fast and cheap">
        <select className="input-field" style={{ width: '100%' }} value={effort} onChange={(e) => setEffort(e.target.value as '' | ReasoningEffort)}>
          <option value="">{parent?.reasoningEffort ? `Inherit from @${parent.handle} (${parent.reasoningEffort})` : 'Default for the role'}</option>
          <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
        </select>
      </Field>
      {row.effective.source === 'env' && !model && (
        <div className="callout-warning" style={{ marginBottom: 12 }}>
          <Icon name="info" size={16} />
          <div className="text-caption">An env variable on the server sets this role's model ({row.effective.model}); it beats the default.</div>
        </div>
      )}
      {save.error && <div className="callout-danger" style={{ marginBottom: 12 }}>{describeError(save.error)}</div>}
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!dirty || save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function ChannelOverrides({ data }: { data: ModelsOverview }) {
  const clear = useClearChannelModels();
  const confirm = useConfirm();
  const rows = data.channelOverrides.flatMap((c) => Object.entries(c.models).map(([role, model]) => ({ ...c, role, model })));

  const clearOne = async (channelKey: string, role: string, model: string) => {
    if (!(await confirm(`remove the ${role} override (${model}) of ${channelKey}`, { confirmLabel: 'Remove' }))) return;
    try {
      await clear.mutateAsync({ channelKey, role });
      toast.success(`${channelKey}: ${role} override removed`);
    } catch (err) { toast.error(describeError(err)); }
  };
  const clearAll = async () => {
    if (!(await confirm(`remove all ${rows.length} channel override${rows.length === 1 ? '' : 's'}`, { confirmLabel: 'Remove all' }))) return;
    try {
      for (const c of data.channelOverrides) await clear.mutateAsync({ channelKey: c.channelKey });
      toast.success('Channel overrides removed');
    } catch (err) { toast.error(describeError(err)); }
  };

  return (
    <SectionCard title="Channel overrides (legacy)" flush delay={80}
      action={<button type="button" className="btn-secondary btn-sm" disabled={clear.isPending} onClick={clearAll}>Clear all</button>}>
      <p className="mdl-note mdl-ovr-intro">
        Per-role models saved on a channel card (the older way to pick a model). They beat env variables and the default, but not an agent's own model.
      </p>
      {rows.map((r) => (
        <div key={`${r.channelKey}:${r.role}`} className="panel-row">
          <div className="mdl-ovr-main">
            <Link to="/app/editor/$channel" params={{ channel: r.channelKey }} className="mdl-ovr-name">{r.title ?? r.channelKey}</Link>
            {r.title && <span className="mdl-handle mono">{r.channelKey}</span>}
          </div>
          <span className="chip mono">{r.role}</span>
          <div className="mdl-ovr-model"><span className="mdl-id">{r.model}</span></div>
          <RowActions danger={<TableAction action="delete" title="Remove override" onClick={() => clearOne(r.channelKey, r.role, r.model)} />} />
        </div>
      ))}
    </SectionCard>
  );
}
