import type { Finding } from '../../sysadmin/audit.types';
import { mkFinding } from '../finding';
import type { ChannelFacts } from '../facts.types';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.2: the series themselves. A series on a dataset whose source the agent may swap for another
 * (`series_source_not_required`), and a playbook draft that waits for the owner (`playbook_draft_waiting`).
 */

/** A pending draft older than this has waited too long. */
export const DRAFT_WAIT_MS = 24 * 3_600_000;

export const seriesCheck: DoctorCheck = {
  code: 'series_source_not_required',
  run(f: ChannelFacts): Finding[] {
    const out: Finding[] = [];
    for (const s of f.series) {
      if (s.active === false || s.source?.kind !== 'library' || s.source_mode === 'required') continue;
      out.push(mkFinding(f, {
        code: 'series_source_not_required',
        severity: 'warn',
        subject: { type: 'playbook', id: s.name, label: s.name },
        detail: `Series «${s.name}» reads the dataset ${s.source.table}, but its source is only suggested: the writer may take material from elsewhere. Requiring the source makes the series yours and locks it.`,
        evidence: { series: s.name, dataset: s.source.table, source_mode: s.source_mode, origin: s.origin, locked: s.locked },
        fix: { kind: 'series_source_require', channel: f.channelKey, series: s.name },
        values: { series: s.name, dataset: s.source.table },
      }));
    }

    const draft = f.pendingPlaybook;
    if (draft) {
      const waited = f.now.getTime() - Date.parse(draft.createdAt);
      if (Number.isFinite(waited) && waited > DRAFT_WAIT_MS) {
        const hours = Math.floor(waited / 3_600_000);
        out.push(mkFinding(f, {
          code: 'playbook_draft_waiting',
          severity: 'warn',
          subject: { type: 'playbook', id: draft.id, label: 'Playbook draft' },
          detail: `A playbook draft has been waiting for your decision for ${hours} hours. Until you approve or reject it, the channel keeps working from the active playbook.`,
          evidence: { playbook: draft.id, created_at: draft.createdAt, waiting_hours: hours },
        }));
      }
    }
    return out;
  },
};
