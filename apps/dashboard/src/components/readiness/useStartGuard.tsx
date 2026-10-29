// Spec 072 FR-010, A23, A24: before a channel starts posting (off or shadow to approve or live, or the Start of a launch) the
// dashboard asks the doctor for a fresh result. With open blockers the owner is told which and confirms "Start anyway"; with none,
// or when the result cannot be read, nothing extra is asked and the action goes on exactly as before.
// Imported by components that node tests load, so this file imports no CSS.

import { useCallback, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfirm } from '../ui/ConfirmDialog';
import { getReadiness, readinessKey, type ReadinessView } from '../../api/readiness';
import { START_ANYWAY, blockedView, blockerIntro, blockerLines, startPhrase } from '../../lib/readiness';

/** The open blockers as the details of a confirm; `intro` adds the line that says what the list is (for a confirm with its own text). */
export function blockerDetails(view: Pick<ReadinessView, 'blockers' | 'findings'>, intro = false): ReactNode {
  return (
    <div>
      {intro && <div className="text-body-sm" style={{ marginBottom: 6 }}>{blockerIntro(view.blockers)}</div>}
      <ul className="text-body-sm">{blockerLines(view, 5).map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}

export interface StartGuard {
  /** A fresh look at the channel: the result when it has open blockers; null when it has none or could not be read. */
  check: (channelKey: string) => Promise<ReadinessView | null>;
  /** The confirm of a mode change that starts posting. true = go on (no blockers, an unreadable check, or "Start anyway"). */
  confirmStart: (channelKey: string, target?: string) => Promise<boolean>;
}

export function useStartGuard(): StartGuard {
  // The hook's own client (A24): the same cache the panel reads, so the fresh result also refreshes an open panel.
  const qc = useQueryClient();
  const confirm = useConfirm();

  const check = useCallback(
    (channelKey: string): Promise<ReadinessView | null> =>
      blockedView(() => qc.fetchQuery({ queryKey: readinessKey(channelKey), queryFn: () => getReadiness(channelKey, { fresh: true }), staleTime: 0 })),
    [qc],
  );

  const confirmStart = useCallback(async (channelKey: string, target?: string): Promise<boolean> => {
    const view = await check(channelKey);
    if (!view) return true;
    return confirm(startPhrase(target ?? channelKey, view.blockers), { confirmLabel: START_ANYWAY, danger: false, details: blockerDetails(view) });
  }, [check, confirm]);

  return { check, confirmStart };
}
