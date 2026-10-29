// Spec 059: the evidence of a skill probe — each recent post written twice (the text that was live, then the proposed
// text), side by side, with the critic's verdict, the lint count, the judge's call and its reasons. A rejected newest
// version can be adopted from here.
// Spec 078 D2: each compared post is an inset; classes of agent-playbook.css (apb-).

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

function SideColumn({ title, side }: { title: string; side: ProbeSide }) {
  return (
    <div className="apb-side">
      <div className="apb-side-head">
        <span className="apb-side-title">{title}</span>
        <Badge tone={criticTone(side.critic)} title="The critic's verdict on this post">{CRITIC_LABEL[side.critic]}</Badge>
        <span className="text-micro mono tabular-nums apb-muted">{side.lint} lint warning{side.lint === 1 ? '' : 's'} · {side.chars.toLocaleString()} chars</span>
      </div>
      {side.preview
        ? <div className="apb-post">{side.preview}</div>
        : <div className="text-micro apb-muted apb-italic">The critic stopped this post, so there is no text.</div>}
    </div>
  );
}

function SampleCard({ s, n }: { s: ProbeSample; n: number }) {
  return (
    <div className="inset apb-sample">
      <div className="apb-sample-head">
        <span className="text-overline">Post {n}</span>
        <span className="text-body-sm clamp apb-sample-topic" title={s.topic}>{s.topic}</span>
        <Badge tone={betterTone(s.judge.better)}>{BETTER_LABEL[s.judge.better]}</Badge>
        <span className="text-micro apb-muted">{s.judge.by === 'judge' ? 'judged by the model' : 'decided by code'}</span>
      </div>
      <div className="apb-sides">
        <SideColumn title="Old text" side={s.old} />
        <SideColumn title="New text" side={s.new} />
      </div>
      {(s.judge.reasons.length > 0 || s.judge.risks.length > 0) && (
        <div className="apb-judge">
          {s.judge.reasons.map((r, i) => <div key={`r${i}`}><strong>Why:</strong> {r}</div>)}
          {s.judge.risks.map((r, i) => <div key={`k${i}`}><strong>Risk:</strong> {r}</div>)}
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
      details: <p className="text-micro apb-note">The probe found this text worse than the live one. It goes live now and is reviewed against KPI after 7 days like any agent edit.</p>,
    }))) return;
    adopt.mutate({ id: skillId, version: version.version }, {
      onSuccess: onClose,
      onError: (e) => toast.error(describeError(e)),
    });
  };

  return (
    <Modal open onClose={onClose} size="xl" icon="eye" title={`Probe · ${skillName} v${version.version}`}
      subtitle={probe?.at ? `${badge?.label ?? 'Probe'} · ${fmtDate(probe.at)}` : badge?.label ?? 'Probe'}>
      <div className="apb-col">
        <div className="apb-chips">
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          {summary && <span className="text-body-sm apb-ink">{summary}</span>}
        </div>
        {probe?.reason && <div className="text-body-sm apb-muted apb-wrap">{probe.reason}</div>}
        {version.reason && <div className="text-micro apb-muted">Reason for the change: {version.reason}</div>}
        {probe && probe.dropped ? <div className="text-micro apb-muted">{probe.dropped} post{probe.dropped === 1 ? '' : 's'} could not be compared (a run failed or the critic did not answer).</div> : null}
        {!probe?.samples?.length && (
          <div className="inset text-body-sm apb-muted">{version.outcome === 'probing'
            ? 'This edit is waiting for its probe. It runs within the hour, within the daily limit; until then the previous text stays live.'
            : 'No posts were compared for this version.'}</div>
        )}
        {probe?.samples?.map((s, i) => <SampleCard key={s.slotId + i} s={s} n={i + 1} />)}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
        {canAdopt && (
          <button type="button" className="btn-warning" disabled={adopt.isPending} onClick={onAdopt}>
            <Icon name="check" size={14} /> {adopt.isPending ? 'Adopting…' : 'Adopt anyway'}
          </button>
        )}
      </div>
    </Modal>
  );
}
