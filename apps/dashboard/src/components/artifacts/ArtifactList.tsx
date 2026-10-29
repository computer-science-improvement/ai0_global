// Artifacts as compact cards (spec 048 FR-006 / FR-007): the /app/artifacts page and the agent page's Artifacts tab.
// The card shows the type, the target, the status, the version and the date; its dialog is the artifact panel plus
// "Open in chat". An empty list names the chat command that makes that type.

import { useNavigate } from '@tanstack/react-router';
import { CompactCard } from '../ui/CompactCard';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';
import { describeError } from '../ui/Toast';
import { useArtifact, useArtifacts, type ArtifactFilter, type ArtifactRow, type ArtifactType } from '../../api/artifacts';
import { ARTIFACT_META, artifactMention, artifactParam, artifactTone, inView, statusLabel, type ArtifactView } from '../../lib/artifacts';
import { ArtifactPanel } from './ArtifactPanel';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** How the owner makes an artifact of this type (the empty state). */
export const MAKE_HINT: Record<ArtifactType, string> = {
  setup:      'Type /setup @yours in the chat: the agent reads the last 20 posts and proposes a setup.',
  steering:   'Type /steer @yours @theirs in the chat to learn the form of a channel you like.',
  rules:      'Tell a channel agent a rule in the chat (@agent always …), or type /rules @yours.',
  memory:     'The agents add lines here from reviews and your approvals.',
  skill:      'Ask an agent to write a skill in the chat, or type /skills @agent.',
  playbook:   '@ai0 drafts a playbook when it creates a channel agent.',
  profile:    '@ai0 drafts the profile when it creates a channel agent.',
  formatting: 'Set the formatting on the agent page, or ask @ai0 in the chat.',
  launch:     'Create the channel in Telegram, then type /launch @new_channel [@reference …] and a brief in the chat.',
  audit:      'The sysadmin audits the network every week; type /audit in the chat to run one now.',
};

export function ArtifactList({ filter, view = 'all', focus, empty }: {
  filter: ArtifactFilter; view?: ArtifactView; focus?: string | null; empty?: { title: string; note: string };
}) {
  const q = useArtifacts({ ...filter, limit: filter.limit ?? 200 });
  const all = q.data?.rows ?? [];
  const rows = all.filter((r) => inView(view, r.status));
  if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
  if (!q.data) return <div className="panel is-section compose-rise" style={{ height: 160, opacity: 0.55 }} aria-busy="true" aria-label="Loading artifacts" />;
  if (!rows.length && all.length) {
    return <EmptyState tone={view === 'needs-you' ? 'clear' : 'neutral'} icon="check" title={view === 'needs-you' ? 'Nothing waits for you' : 'Nothing here'} note={`${all.length} artifact${all.length === 1 ? '' : 's'} in the other views.`} />;
  }
  if (!rows.length) {
    const t = filter.type;
    return (
      <EmptyState icon={t ? ARTIFACT_META[t].icon : 'layers'} title={empty?.title ?? (t ? `No ${ARTIFACT_META[t].plural.toLowerCase()} yet` : 'No artifacts yet')}
        note={empty?.note ?? (t ? MAKE_HINT[t] : 'Setups, steering, rules, skills and playbooks appear here as the agents and you make them. Type / in the chat for the commands.')} />
    );
  }
  return (
    <div className="compact-grid">
      {rows.map((r, i) => <ArtifactCard key={`${r.type}:${r.id}`} r={r} focused={focus === artifactParam(r.type, r.id)} delay={Math.min(i, 10) * 30} />)}
    </div>
  );
}

function ArtifactCard({ r, focused, delay }: { r: ArtifactRow; focused: boolean; delay: number }) {
  const meta = ARTIFACT_META[r.type];
  const agent = r.agent ? `@${r.agent}` : null;
  const target = (r.channel ?? r.target)?.replace(/^telegram:/, '') ?? null;
  return (
    <CompactCard
      id={`artifact-${r.type}-${r.id}`}
      focused={focused}
      delay={delay}
      attention={r.status === 'ready' || r.status === 'pending_owner'}
      top={(
        <>
          <span className="chip" style={{ gap: 4 }}><Icon name={meta.icon} size={12} />{meta.label}</span>
          <Badge tone={artifactTone(r.status)}>{statusLabel(r.status)}</Badge>
        </>
      )}
      meta={<span className="mono">{when(r.updatedAt)}</span>}
      title={r.title}
      body={r.summary || null}
      extra={(
        <span className="text-micro mono ink-muted">
          {[agent, target && target !== agent ? target : null, r.version != null ? `v${r.version}` : null].filter(Boolean).join(' · ')}
        </span>
      )}
      note={r.status === 'ready' ? 'Review it and decide' : r.status === 'pending_owner' ? 'A new version waits for you' : undefined}
      hint="Open the artifact"
      dialog={{
        title: r.title,
        subtitle: `${meta.label} · ${statusLabel(r.status)}`,
        icon: meta.icon,
        size: 'lg',
        body: (close) => <ArtifactPanel bare type={r.type} id={r.id} onClose={close} />,
        actions: (close) => <OpenInChat r={r} onDone={close} />,
      }}
    />
  );
}

/** FR-006: the chat that made the artifact, or a new chat with its agent and the artifact referenced. */
function OpenInChat({ r, onDone }: { r: ArtifactRow; onDone: () => void }) {
  const q = useArtifact(r.type, r.id);
  const navigate = useNavigate();
  const art = artifactParam(r.type, r.id);
  const open = () => {
    onDone();
    const chatId = q.data?.chatId;
    if (chatId) void navigate({ to: '/app/chat', search: { c: chatId, art } });
    else void navigate({ to: '/app/chat', search: { q: `${r.agent ? `@${r.agent} ` : ''}${artifactMention(r.type, r.id)} `, art } });
  };
  return (
    <>
      <button type="button" className="btn-ghost" onClick={onDone}>Close</button>
      <button type="button" className="btn-secondary" onClick={open} disabled={q.isLoading}>
        <Icon name="chat" size={14} /> {q.data?.chatId ? 'Open in chat' : 'Ask in a new chat'}
      </button>
    </>
  );
}
