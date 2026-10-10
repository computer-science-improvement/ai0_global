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
  useBulkModels, useClearChannelModels, useModelCatalog, useModelsOverview, useSetAgentModel, useSetCriticModel, useSetDefaultModel,
  type AgentModelRow, type ModelsOverview,
} from '../api/models';
import type { ReasoningEffort } from '../api/agents';
import { fmtContext, fmtPerM, groupAgents, ownCounts, SOURCE_HINT, SOURCE_LABEL, SOURCE_TONE } from '../lib/models';

// Models (spec 035): the owner picks the LLM of every agent. One global default
// (app_settings `ai.default_model`, built-in z-ai/glm-5.3-flash); an agent's own
// model beats a channel card's legacy override, which beats EDITOR_MODEL_* env
// variables, which beat the default.
export const Route = createFileRoute('/app/models')({ component: ModelsPage });

const mono = { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 13 } as const;

function ModelsPage() {
  const q = useModelsOverview();
  const catalog = useModelCatalog();
  const data = q.data;

  return (
    <div>
      <PageHeader title="Models" subtitle="Choose the LLM each agent runs on. Agents without their own model use the default." />

      {q.error && <div className="callout-danger" style={{ marginBottom: 16 }}>{describeError(q.error)}</div>}
      {!data && !q.error && <div className="panel compose-rise" style={{ height: 160, opacity: 0.55 }} />}

      {catalog.data?.source === 'fallback' && (
        <div className="callout-warning" style={{ marginBottom: 12 }}>
          <Icon name="warning" size={16} />
          <div>The OpenRouter model list is unavailable right now, so only models with a known price can be chosen. It is retried in a few minutes.</div>
        </div>
      )}

      {data && data.envOverrides.length > 0 && <EnvNote env={data.envOverrides} />}
      {data && <DefaultCard data={data} />}
      {data?.criticModel && <CriticModelCard data={data} />}
      {data && <AgentsSection data={data} />}
      {data && data.channelOverrides.length > 0 && <ChannelOverrides data={data} />}

      {catalog.data && (
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '12px 0 0' }}>
          {catalog.data.source === 'openrouter'
            ? `${catalog.data.models.length} models with tool support from OpenRouter${catalog.data.fetchedAt ? `, fetched ${new Date(catalog.data.fetchedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}${catalog.data.stale ? ' (refresh failed, list may be outdated)' : ''}. Prices are USD per 1M tokens.`
            : `${catalog.data.models.length} priced models (offline list). Prices are USD per 1M tokens.`}
        </p>
      )}
    </div>
  );
}

function EnvNote({ env }: { env: ModelsOverview['envOverrides'] }) {
  return (
    <div className="callout-warning" style={{ marginBottom: 12 }}>
      <Icon name="info" size={16} />
      <div>
        <div style={{ marginBottom: 4 }}>
          Server environment variables override the default model for {env.length === 1 ? 'one role' : `${env.length} roles`}:
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
          {env.map((e) => <span key={e.key} className="chip" style={mono}>{e.key}</span>)}
        </div>
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
          They beat the default chosen here (an agent's own model still wins). Remove them on the server to let the default apply.
        </div>
      </div>
    </div>
  );
}

function PriceFacts({ inPerM, outPerM, context }: { inPerM: number | null | undefined; outPerM: number | null | undefined; context?: number | null }) {
  const item = (label: string, value: ReactNode) => (
    <div style={{ minWidth: 0 }}>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 2 }}>{label}</div>
      <div className="tabular-nums" style={{ color: 'var(--color-ink)', fontSize: 15 }}>{value}</div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}>
      {item('Input / 1M', fmtPerM(inPerM))}
      {item('Output / 1M', fmtPerM(outPerM))}
      {context ? item('Context', fmtContext(context)) : null}
    </div>
  );
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
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)', lineHeight: 1.6 }}>
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
    <SectionCard title="Default model" icon="cpu" delay={0} style={{ marginBottom: 12 }}
      action={def.saved ? <Badge tone="accent">Custom</Badge> : <Badge tone="neutral">Built-in</Badge>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 16, alignItems: 'end' }}>
        <Field label="Model" hint={`${following} of ${data.agents.length} agents follow it`}>
          <ModelSelect value={def.model} onChange={(m) => change(m)} ariaLabel="Default model" disabled={save.isPending} />
        </Field>
        <div style={{ paddingBottom: 18 }}>
          <PriceFacts inPerM={entry?.inPerM ?? def.price?.inPerM} outPerM={entry?.outPerM ?? def.price?.outPerM} context={entry?.contextLength} />
        </div>
      </div>
      {def.saved && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" style={{ gap: 6 }} disabled={save.isPending} onClick={() => change(null)}>
            <Icon name="reset" size={13} /> Use the built-in default
          </button>
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{def.builtin}</span>
        </div>
      )}
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
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)', lineHeight: 1.6 }}>
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
    <SectionCard title="Critic model" icon="sparkles" delay={40} style={{ marginBottom: 12 }} action={badge}>
      <p className="text-micro" style={{ margin: '0 0 12px', color: 'var(--color-ink-muted)', lineHeight: 1.6 }}>
        Before a post is published, stored as a preview or sent for your approval, the critic scores it (human voice, sense, tone, facts, reader asks, format)
        and passes it, asks the agent for one rewrite, or rejects it. Its spend shows as <span style={mono}>editor.checker</span> on the Spend page.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 16, alignItems: 'end' }}>
        <Field label="Model" hint={c.source === 'env' ? 'EDITOR_MODEL_CHECKER is set on the server; a model chosen here beats it' : undefined}>
          <ModelSelect value={c.saved} onChange={(m) => change(m)} ariaLabel="Critic model" disabled={save.isPending}
            defaultLabel={`Default (${c.source === 'env' ? c.model : data.defaultModel.model})`} />
        </Field>
        <div style={{ paddingBottom: 18 }}>
          <PriceFacts inPerM={entry?.inPerM ?? c.price?.inPerM} outPerM={entry?.outPerM ?? c.price?.outPerM} context={entry?.contextLength} />
        </div>
      </div>
      {c.saved && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" style={{ gap: 6 }} disabled={save.isPending} onClick={() => change(null)}>
            <Icon name="reset" size={13} /> Follow the default model
          </button>
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{data.defaultModel.model}</span>
        </div>
      )}
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
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)', lineHeight: 1.6 }}>
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
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)', lineHeight: 1.6 }}>
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

  const rowView = (row: AgentModelRow, child: boolean, i: number) => (
    <tr key={row.id} className="compose-rise" style={{ animationDelay: `${Math.min(i, 20) * 15}ms` }}>
      <td style={{ paddingLeft: child ? 36 : undefined, minWidth: 180 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {child && <span aria-hidden style={{ color: 'var(--color-ink-dim)' }}><Icon name="chevron-right" size={12} /></span>}
          <span aria-hidden>{row.emoji ?? ''}</span>
          <span style={{ minWidth: 0 }}>
            <Link to="/app/agents/$handle" params={{ handle: row.handle }} style={{ color: 'var(--color-ink)', textDecoration: 'none', fontWeight: child ? 400 : 500 }}>
              {row.name}
            </Link>
            <span className="text-micro" style={{ display: 'block', color: 'var(--color-ink-muted)' }}>@{row.handle}</span>
          </span>
        </div>
      </td>
      <td className="meta" style={{ whiteSpace: 'nowrap' }}>{KIND_LABEL[row.kind] ?? row.kind}</td>
      <td style={{ minWidth: 200 }}>
        <span style={{ ...mono, color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{row.effective.model}</span>
        {row.effective.inheritedFrom && <span className="text-micro" style={{ display: 'block', color: 'var(--color-ink-dim)' }}>via @{row.effective.inheritedFrom}</span>}
      </td>
      <td><SourceBadge row={row} /></td>
      <td className="num">{fmtPerM(row.price?.inPerM)}</td>
      <td className="num">{fmtPerM(row.price?.outPerM)}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {row.effective.reasoningEffort}
        {row.effective.reasoningSource !== 'default' && (
          <span className="text-micro" style={{ marginLeft: 6, color: 'var(--color-ink-dim)' }}>
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

  let n = 0;
  return (
    <SectionCard title="Agents" icon="agents" delay={40} style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, marginBottom: 14 }}>
        <div style={{ flex: '1 1 260px', maxWidth: 420, minWidth: 0 }}>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 4 }}>Bulk model</div>
          <ModelSelect value={bulkModel} onChange={setBulkModel} ariaLabel="Model for all agents" compact />
        </div>
        <button type="button" className="btn-primary" disabled={!bulkModel || bulk.isPending} onClick={applyAll}>Apply to all agents</button>
        <button type="button" className="btn-secondary" style={{ gap: 6 }} disabled={own.models === 0 || bulk.isPending} onClick={resetAll}>
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
              {groups.flatMap((g) => [rowView(g.root, false, n++), ...g.children.map((c) => rowView(c, true, n++))])}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '10px 0 0' }}>
        Precedence: the agent's own model (role agents inherit their orchestrator's), then a channel override, then an env variable, then the default.
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
          <div className="text-micro">An env variable on the server sets this role's model ({row.effective.model}); it beats the default.</div>
        </div>
      )}
      {save.error && <div className="callout-danger" style={{ marginBottom: 12 }}>{describeError(save.error)}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
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
    <SectionCard title="Channel overrides (legacy)" icon="channels" delay={80}
      action={<button type="button" className="btn-secondary" disabled={clear.isPending} onClick={clearAll}>Clear all</button>}>
      <p className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: '0 0 10px' }}>
        Per-role models saved on a channel card (the older way to pick a model). They beat env variables and the default, but not an agent's own model.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Channel</th><th>Role</th><th>Model</th><ActionsTh /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.channelKey}:${r.role}`}>
                <td>
                  <Link to="/app/editor/$channel" params={{ channel: r.channelKey }} style={{ color: 'var(--color-ink)', textDecoration: 'none' }}>{r.title ?? r.channelKey}</Link>
                  {r.title && <span className="text-micro" style={{ display: 'block', color: 'var(--color-ink-muted)' }}>{r.channelKey}</span>}
                </td>
                <td className="meta">{r.role}</td>
                <td><span style={{ ...mono, overflowWrap: 'anywhere' }}>{r.model}</span></td>
                <td style={{ textAlign: 'right' }}>
                  <RowActions danger={<TableAction action="delete" title="Remove override" onClick={() => clearOne(r.channelKey, r.role, r.model)} />} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
