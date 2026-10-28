// Spec 078 B2: the Inbox page. Posts to approve (tab) and the notes the agents leave for the owner (tabs All / Critical / Action /
// FYI, with an "Unread only" switch). A master-detail page: the rows on the left, the selected note on the right (what
// happened, why it matters, the buttons); at 860px and below the note opens in a bottom sheet.
//
// URL: `?tab=approvals|all|critical|action|fyi&unread=false&note=<id>`. Legacy `?tab=unread` and `?tab=all` still mean what
// they meant (lib/inbox-view.ts); a bare URL opens All with Unread only on, or To approve when nothing is unread but posts wait.
// The route (routes/app.agents_.inbox.tsx) owns the URL and the stylesheet; this component takes the search and a way to change it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import type { Crumb } from '../ui/Crumbs';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { Modal } from '../Modal';
import { ApprovalList } from '../approvals/ApprovalList';
import { InboxList } from './InboxList';
import { InboxDetail } from './InboxDetail';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { flattenTree, resolveHandle } from '../../lib/inbox-ref';
import {
  APPROVALS_EMPTY_NOTE, agentLabel, autoView, emptyCopy, findNote, groupBySubject, inTab, markedText, newestFirst,
  resolveView, selectNote, singleRows, tabCounts, toSearch, unreadIdsOf, type InboxSearch, type InboxTab,
} from '../../lib/inbox-view';
import { useAgentInbox, useAgentTree, useMarkInboxRead, useMarkInboxUnread, type AgentNode, type InboxItem } from '../../api/agents';
import { useApprovalsCount } from '../../api/approvals';

export function InboxPage({ search, crumbs, onNavigate }: {
  search:     InboxSearch;
  /** The trail above the title (from the menu registry), if the route has one. */
  crumbs?:    Crumb[];
  /** Replaces the URL's search (the page never adds history entries). */
  onNavigate: (search: InboxSearch) => void;
}) {
  const narrow = useMediaQuery('(max-width: 860px)');
  const resolved = resolveView(search);

  const approvals = useApprovalsCount();
  const waiting = approvals.data?.waiting;
  const unreadList = useAgentInbox(true);
  const tree = useAgentTree();
  const agents = tree.data?.agents;
  const markRead = useMarkInboxRead();
  const markUnread = useMarkInboxUnread();

  // A URL without a tab is decided once from the data and then kept, so the page does not jump to another tab when the last
  // unread note is marked done.
  const unreadIds = useMemo(() => new Set((unreadList.data?.items ?? []).map((i) => i.id)), [unreadList.data]);
  const dataReady = !unreadList.isLoading && !approvals.isLoading;
  const auto = dataReady ? autoView({ note: resolved.note, unreadIds, waiting: waiting ?? 0 }) : null;
  const [frozen, setFrozen] = useState<{ tab: InboxTab; unread: boolean } | null>(null);
  useEffect(() => {
    if (resolved.tab != null) { if (frozen) setFrozen(null); } else if (!frozen && auto) setFrozen(auto);
  }, [resolved.tab, auto, frozen]);
  const fallback = frozen ?? auto;
  const tab: InboxTab | null = resolved.tab ?? fallback?.tab ?? null;
  const unreadOnly = resolved.unread ?? fallback?.unread ?? true;

  // With Unread only off the list is every note; with it on it is the same query as `unreadList`.
  const source = useAgentInbox(unreadOnly);
  const items = useMemo(() => newestFirst(source.data?.items ?? []), [source.data]);
  const counts = source.data ? tabCounts(items) : null;
  const visible = useMemo(() => (tab ? items.filter((i) => inTab(i.severity, tab)) : []), [items, tab]);
  // The All view collapses repeats of one problem into a row; the severity tabs list every note.
  const rows = useMemo(() => (tab === 'all' ? groupBySubject(visible) : singleRows(visible)), [visible, tab]);

  const byHandle = useMemo(() => new Map((flattenTree(agents) as AgentNode[]).map((n) => [n.handle, n])), [agents]);
  const agentOf = (it: InboxItem): AgentNode | null => {
    const h = resolveHandle(it, agents);
    return h ? byHandle.get(h) ?? null : null;
  };

  // Selection: the note named by `?note=`; on a wide screen the row that was selected, or the one that took its place when
  // it left the list; else the first row. On a narrow screen nothing is selected until a row is tapped (the sheet opens).
  const prev = useRef<{ key: string | null; index: number } | null>(null);
  const selection = narrow ? findNote(rows, resolved.note) : selectNote(rows, resolved.note, prev.current);
  useEffect(() => { prev.current = selection ? { key: selection.group.key, index: selection.index } : null; });

  const go = (next: { tab?: InboxTab; unread?: boolean; note?: number | null }) => {
    if (!tab) return;
    onNavigate(toSearch({ tab: next.tab ?? tab, unread: next.unread ?? unreadOnly, note: next.note ?? null }));
  };
  const setTab = (t: InboxTab) => { prev.current = null; go({ tab: t }); };
  const setUnread = (u: boolean) => { prev.current = null; go({ unread: u }); };
  const closeSheet = () => go({ note: null });

  const markDone = (ids: number[], closeAfter = false) => {
    if (!ids.length) return;
    markRead.mutate(ids, {
      onSuccess: () => toast.success(markedText(ids.length), { action: { label: 'Undo', onClick: () => markUnread.mutate(ids) } }),
    });
    if (closeAfter && narrow) closeSheet();
  };
  const markOneUnread = (ids: number[]) => markUnread.mutate(ids);
  // NoteActions' own "Got it" marked the note read; the toast it showed is replaced by one with Undo (same text).
  const gotIt = (it: InboxItem) => {
    toast.success(markedText(1), { action: { label: 'Undo', onClick: () => markUnread.mutate([it.id]) } });
    if (narrow) closeSheet();
  };
  const busy = markRead.isPending || markUnread.isPending;

  const unreadToMark = unreadIdsOf(rows);
  const showNotes = tab != null && tab !== 'approvals';

  const options = [
    { key: 'approvals' as const, label: 'To approve', count: waiting },
    { key: 'all' as const, label: 'All', count: counts?.all },
    { key: 'critical' as const, label: 'Critical', count: counts?.critical },
    { key: 'action' as const, label: 'Action', count: counts?.action },
    { key: 'fyi' as const, label: 'FYI', count: counts?.fyi },
  ];

  const empty = tab && tab !== 'approvals' ? emptyCopy(tab, unreadOnly) : null;

  return (
    <div>
      <PageHeader crumbs={crumbs} title="Inbox" subtitle="Posts to approve and everything the agents want you to know, in plain words, with a next step."
        actions={showNotes && (
          <Button variant="secondary" disabled={busy || unreadToMark.length === 0} onClick={() => markDone(unreadToMark)}>Mark all as done</Button>
        )} />

      {tab == null && <div className="panel is-section compose-rise" style={{ height: 160, opacity: 0.55 }} role="status" aria-label="Loading the inbox" />}

      {tab != null && (
        <div className="inbox-toolbar">
          <SegmentedTabs ariaLabel="Inbox filter" value={tab} onChange={setTab} options={options} />
          {showNotes && (
            <button type="button" className="chip-toggle" aria-pressed={unreadOnly} onClick={() => setUnread(!unreadOnly)}>Unread only</button>
          )}
        </div>
      )}

      {tab === 'approvals' && (
        <SectionCard title="Posts to approve" icon="check" delay={0}>
          <ApprovalList emptyNote={APPROVALS_EMPTY_NOTE} />
        </SectionCard>
      )}

      {showNotes && !source.data && !source.error && <div className="panel is-section compose-rise" style={{ height: 160, opacity: 0.55 }} role="status" aria-label="Loading notes" />}

      {showNotes && source.data && rows.length === 0 && empty && (
        <div className="panel is-section">
          <EmptyState tone={empty.tone} title={empty.title} note={empty.note} />
        </div>
      )}

      {showNotes && source.data && rows.length > 0 && (
        <div className="inbox-split">
          <InboxList groups={rows} selectedKey={selection?.group.key ?? null} popup={narrow}
            showUnreadDot={!unreadOnly} whoOf={(it) => { const a = agentOf(it); return a ? agentLabel(a) : null; }}
            onSelect={(it) => go({ note: it.id })} />
          {!narrow && selection && (
            <section key={selection.note.id} className="panel is-section inbox-pane anim-fade-up" aria-label="Selected note">
              <InboxDetail item={selection.note} group={selection.group} agent={agentOf(selection.note)} tree={agents} variant="pane" busy={busy}
                onMarkDone={markDone} onMarkUnread={markOneUnread} onGotIt={gotIt} onPick={(id) => go({ note: id })} />
            </section>
          )}
        </div>
      )}

      {narrow && selection && showNotes && (
        <Modal open onClose={closeSheet} title={selection.note.title} icon="inbox" size="drawer">
          <InboxDetail key={selection.note.id} item={selection.note} group={selection.group} agent={agentOf(selection.note)} tree={agents} variant="sheet" busy={busy}
            onMarkDone={(ids) => markDone(ids, true)} onMarkUnread={markOneUnread} onGotIt={gotIt} onPick={(id) => go({ note: id })} />
        </Modal>
      )}
    </div>
  );
}
