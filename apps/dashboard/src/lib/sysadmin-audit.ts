// Spec 055 FR-003: how the audit report is grouped and named in the panel. Pure, so the order and the wording are tested.
import type { Tone } from '../components/ui/primitives';
import type { AuditFinding, AuditFix, AuditReport, FindingArea, FindingSeverity } from '../api/audits';

export const AREA_ORDER: FindingArea[] = ['skills', 'memory', 'rules', 'tools', 'prompt'];
export const AREA_LABEL: Record<FindingArea, string> = {
  skills: 'Skills', memory: 'Memory', rules: 'Rules and config', tools: 'Tools and runs', prompt: 'Prompt size',
};

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };
export const SEVERITY_TONE: Record<FindingSeverity, Tone> = { error: 'danger', warn: 'warning', info: 'neutral' };
export const SEVERITY_LABEL: Record<FindingSeverity, string> = { error: 'error', warn: 'warning', info: 'info' };

/** Open and failed findings need a decision; applied and dismissed ones are history. */
export const isOpen = (f: Pick<AuditFinding, 'status'>) => f.status === 'open' || f.status === 'failed';

export interface AreaGroup { area: FindingArea; label: string; findings: AuditFinding[] }

/** Open findings by area (fixed area order), worst first inside an area. */
export function groupOpen(findings: AuditFinding[]): AreaGroup[] {
  const open = findings.filter(isOpen);
  return AREA_ORDER
    .map((area) => ({
      area, label: AREA_LABEL[area],
      findings: open.filter((f) => f.area === area).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title)),
    }))
    .filter((g) => g.findings.length);
}

/** Applied and dismissed findings, newest change first. */
export const handled = (findings: AuditFinding[]): AuditFinding[] =>
  findings.filter((f) => !isOpen(f)).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

/** What the fix will do, in one line, for the button's confirmation and the dialog. */
export function fixText(fix: AuditFix): string {
  switch (fix.kind) {
    case 'skill_disable':     return `Switch the skill ${fix.skill} off for @${fix.agent}`;
    case 'skill_inline_off':  return `Stop loading the skill ${fix.skill} inline for @${fix.agent} (it stays available through load_skill)`;
    case 'memory_retire':     return `Retire memory row #${fix.id} of ${fix.channel} (the row stays in the history)`;
    case 'conflicts_resolve': return `Apply the rule-versus-config fixes for @${fix.agent}`;
  }
}

/** Where the model pass stands, when it did not run normally. */
export function llmNotice(r: Pick<AuditReport, 'llm'>): string | null {
  if (!r.llm || r.llm.status === 'ok') return null;
  return r.llm.note || 'The model pass did not run: the report has the checks of the code only.';
}

/** The headline of a report: counts of what is still open. */
export function countsLine(c: AuditReport['counts']): string {
  if (!c.total) return 'Nothing to report';
  if (!c.open) return 'Everything is handled';
  const parts = [c.error && `${c.error} error${c.error === 1 ? '' : 's'}`, c.warn && `${c.warn} warning${c.warn === 1 ? '' : 's'}`, c.info && `${c.info} info`].filter(Boolean);
  return `${parts.join(' · ')} open${c.fixable ? ` · ${c.fixable} with a fix` : ''}`;
}

/** Evidence as short `key: value` lines (long values clipped) for the dialog. */
export function evidenceLines(e: Record<string, unknown>): string[] {
  return Object.entries(e).filter(([, v]) => v !== null && v !== undefined && v !== '').slice(0, 12).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${s.length > 240 ? `${s.slice(0, 240)}…` : s}`;
  });
}
