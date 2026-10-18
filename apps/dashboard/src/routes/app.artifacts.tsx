import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { ArtifactList } from '../components/artifacts/ArtifactList';
import { useAgentHandles } from '../api/agents';
import { ARTIFACT_TYPES, type ArtifactType } from '../api/artifacts';
import { ARTIFACT_META, type ArtifactView } from '../lib/artifacts';

// Artifacts (spec 048 FR-006): everything that shapes an agent in one place — setups from history, steering, owner
// rules, memory, skills, playbooks, profiles and formatting. Filters live in the URL (?type, ?agent, ?view);
// ?open=type:id opens one. The chat makes them (/setup, /steer, or asking an agent), this page finds them.
const VIEWS: ReadonlyArray<{ key: ArtifactView; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs-you', label: 'Needs you' },
  { key: 'in-use', label: 'In use' },
  { key: 'closed', label: 'Closed' },
];

interface Search { type?: ArtifactType; agent?: string; view?: ArtifactView; open?: string }

export const Route = createFileRoute('/app/artifacts')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    type: typeof s.type === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(s.type) ? s.type as ArtifactType : undefined,
    agent: typeof s.agent === 'string' && s.agent ? s.agent.replace(/^@/, '') : undefined,
    view: VIEWS.some((v) => v.key === s.view && v.key !== 'all') ? s.view as ArtifactView : undefined,
    open: typeof s.open === 'string' && s.open ? s.open : undefined,
  }),
  component: ArtifactsPage,
});

function ArtifactsPage() {
  const { type, agent, view = 'all', open } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const handles = useAgentHandles().data?.agents ?? [];
  const set = (p: Partial<Search>) => navigate({ search: (s) => ({ ...s, ...p, open: undefined }), replace: true });
  const toChat = (q: string) => navigate({ to: '/app/chat', search: { q } });

  return (
    <div>
      <PageHeader
        title="Artifacts"
        subtitle="What shapes your agents: setups from history, steering, your rules, memory, skills, playbooks, profiles and formatting. Each keeps its versions. Make them in the chat, review and edit them here."
        actions={(
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => toChat('/setup ')}>
              <Icon name="sparkles" size={14} /> Setup from history
            </button>
            <button type="button" className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => toChat('/steer ')}>
              <Icon name="compass" size={14} /> New steering
            </button>
          </div>
        )}
      />

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }} role="group" aria-label="Type">
        <TypeChip label="All types" active={!type} onClick={() => set({ type: undefined })} />
        {ARTIFACT_TYPES.map((t) => (
          <TypeChip key={t} label={ARTIFACT_META[t].plural} icon={ARTIFACT_META[t].icon} active={type === t} onClick={() => set({ type: type === t ? undefined : t })} />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <SegmentedTabs value={view} onChange={(v) => set({ view: v === 'all' ? undefined : v })} options={VIEWS.map((v) => ({ key: v.key, label: v.label }))} />
        <label className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-ink-muted)' }}>
          Agent
          <select className="input-field" value={agent ?? ''} onChange={(e) => set({ agent: e.target.value || undefined })} style={{ minWidth: 160 }}>
            <option value="">All agents</option>
            {agent && !handles.some((h) => h.handle === agent) && <option value={agent}>@{agent}</option>}
            {handles.map((h) => <option key={h.handle} value={h.handle}>@{h.handle}</option>)}
          </select>
        </label>
      </div>

      <ArtifactList filter={{ type, agent }} view={view} focus={open} />
    </div>
  );
}

function TypeChip({ label, icon, active, onClick }: { label: string; icon?: import('../components/ui/Icon').IconName; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn-tiny" aria-pressed={active} onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        borderColor: active ? 'var(--color-accent)' : undefined, color: active ? 'var(--color-ink)' : undefined,
        background: active ? 'var(--color-surface-3)' : undefined,
      }}>
      {icon && <Icon name={icon} size={12} />}{label}
    </button>
  );
}
