// Spec 059: the evidence of a skill probe — each recent post written twice (the text that was live, then the proposed
// text), side by side, with the critic's verdict, the lint count, the judge's call and its reasons. A rejected newest
// version can be adopted from here.

import type { CSSProperties } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Modal } from '../Modal';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { fmtDate } from '../../lib/format';
import {
  BETTER_LABEL, CRITIC_LABEL, betterTone, criticTone, probeBadge, probeSummary,
} from '../../lib/skill-probe';
import { useAdoptRejectedSkill, type ProbeSample, type ProbeSide, type SkillVersion } from '../../api/agents';

const muted: CSSProperties = { color: 'var(--color-ink-muted)' };

function SideColumn({ title, side }: { title: string; side: ProbeSide }) {
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{title}</span>
        <Badge tone={criticTone(side.critic)} title="The critic's verdict on this post">{CRITIC_LABEL[side.critic]}</Badge>
        <span className="text-micro tabular-nums" style={muted}>{side.lint} lint warning{side.lint === 1 ? '' : 's'} · {side.chars.toLocaleString()} chars</span>
      </div>
      {side.preview
        ? <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)', padding: 8, maxHeight: 220, overflow: 'auto', lineHeight: 1.5 }}>{side.preview}</div>
        : <div className="text-micro" style={{ ...muted, fontStyle: 'italic' }}>The critic stopped this post, so there is no text.</div>}
    </div>
  );
}

function SampleCard({ s, n }: { s: ProbeSample; n: number }) {
  return (
    <div className="card" style={{ padding: '10px 14px', display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="text-micro tabular-nums" style={muted}>Post {n}</span>
        <span className="text-body-sm clamp" title={s.topic} style={{ ['--clamp' as string]: 1, flex: 1, minWidth: 120, color: 'var(--color-ink)' }}>{s.topic}</span>
        <Badge tone={betterTone(s.judge.better)}>{BETTER_LABEL[s.judge.better]}</Badge>
        <span className="text-micro" style={muted}>{s.judge.by === 'judge' ? 'judged by the model' : 'decided by code'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <SideColumn title="Old text" side={s.old} />
        <SideColumn title="New text" side={s.new} />
      </div>
      {(s.judge.reasons.length > 0 || s.judge.risks.length > 0) && (
        <div className="text-micro" style={{ display: 'grid', gap: 2, ...muted }}>
          {s.judge.reasons.map((r, i) => <div key={`r${i}`} style={{ overflowWrap: 'anywhere' }}><strong>Why:</strong> {r}</div>)}
          {s.judge.risks.map((r, i) => <div key={`k${i}`} style={{ overflowWrap: 'anywhere' }}><strong>Risk:</strong> {r}</div>)}
        </div>
      )}
    </div>
  );
}

export function SkillProbeDialog({ skillId, skillName, version, newest, onClose }: {
  skillId: string; skillName: string; version: SkillVersion; /** The version is the newest one of the skill. */ newest: boolean; onClose: () => void;
}) {
  const adopt = useAdoptRejectedSkill();
  const confirm = useConfirm();
  const probe = version.probe ?? null;
  const badge = probeBadge(version);
  const summary = probeSummary(probe);
  const canAdopt = version.outcome === 'rejected' && newest;

  const onAdopt = async () => {
    if (!(await confirm(`adopt “${skillName}” v${version.version} anyway`, {
      danger: false, confirmLabel: 'Adopt anyway',
      details: <p className="text-micro" style={{ margin: 0, ...muted }}>The probe found this text worse than the live one. It goes live now and is reviewed against KPI after 7 days like any agent edit.</p>,
    }))) return;
    adopt.mutate({ id: skillId, version: version.version }, {
      onSuccess: onClose,
      onError: (e) => toast.error(describeError(e)),
    });
  };

  return (
    <Modal open onClose={onClose} size="xl" icon="eye" title={`Probe · ${skillName} v${version.version}`}
      subtitle={probe?.at ? `${badge?.label ?? 'Probe'} · ${fmtDate(probe.at)}` : badge?.label ?? 'Probe'}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          {summary && <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{summary}</span>}
        </div>
        {probe?.reason && <div className="text-body-sm" style={{ ...muted, overflowWrap: 'anywhere' }}>{probe.reason}</div>}
        {version.reason && <div className="text-micro" style={muted}>Reason for the change: {version.reason}</div>}
        {probe && probe.dropped ? <div className="text-micro" style={muted}>{probe.dropped} post{probe.dropped === 1 ? '' : 's'} could not be compared (a run failed or the critic did not answer).</div> : null}
        {!probe?.samples?.length && (
          <div className="panel text-body-sm" style={{ padding: 12, ...muted }}>{version.outcome === 'probing'
            ? 'This edit is waiting for its probe. It runs within the hour, within the daily limit; until then the previous text stays live.'
            : 'No posts were compared for this version.'}</div>
        )}
        {probe?.samples?.map((s, i) => <SampleCard key={s.slotId + i} s={s} n={i + 1} />)}
      </div>
      <div className="modal-foot">
        {canAdopt && (
          <button type="button" className="btn-primary" disabled={adopt.isPending} onClick={onAdopt} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14} /> {adopt.isPending ? 'Adopting…' : 'Adopt anyway'}
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
