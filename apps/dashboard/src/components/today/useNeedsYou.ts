// Spec 078 B1: what needs the owner, for Today's header and its "Needs you" panel — one hook so both read the same
// numbers. Notes come from the unread Inbox list (critical and action first), posts to approve from the approvals
// counter, cards waiting in a chat from the menu's attention list. Dismissing a note hides it at once, marks it read
// and offers Undo (mark unread).

import { useCallback, useMemo, useState } from 'react';
import { useAgentInbox, useMarkInboxRead, useMarkInboxUnread, type InboxItem } from '../../api/agents';
import { useApprovalsCount } from '../../api/approvals';
import { useNavAttention } from '../../api/nav';
import { toast } from '../ui/Toast';
import { NEEDS_ROWS, inboxLinkCount, needsSummary, openNotes, shorten } from '../../lib/today';

export function useNeedsYou() {
  const inbox = useAgentInbox(true);
  const approvalsQ = useApprovalsCount();
  const attention = useNavAttention();
  const markRead = useMarkInboxRead();
  const markUnread = useMarkInboxUnread();

  // Notes dismissed or settled on this page: they leave the list before the refetch confirms it.
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const hide = useCallback((id: number) => setHidden((prev) => new Set(prev).add(id)), []);
  const unhide = useCallback((id: number) => setHidden((prev) => { const next = new Set(prev); next.delete(id); return next; }), []);

  const notes = inbox.data?.items;
  const approvals = approvalsQ.data?.waiting ?? 0;
  const chatCards = attention.data?.chatCards.total ?? 0;

  const open = useMemo(() => openNotes(notes, hidden), [notes, hidden]);
  const summary = useMemo(() => needsSummary({ notes, approvals, chatCards, hidden }), [notes, approvals, chatCards, hidden]);
  const inboxCount = inboxLinkCount(notes, approvals, hidden);

  /** Mark one note done. The toast offers Undo for a few seconds; a failed request puts the note back (the error is toasted by the router). */
  const dismiss = useCallback(async (item: Pick<InboxItem, 'id' | 'title'>) => {
    hide(item.id);
    try {
      await markRead.mutateAsync([item.id]);
    } catch {
      unhide(item.id);
      return;
    }
    toast.success(`Marked as done: ${shorten(item.title)}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          unhide(item.id);
          markUnread.mutate([item.id], { onError: () => hide(item.id) });
        },
      },
    });
  }, [hide, unhide, markRead, markUnread]);

  return {
    /** The notes shown as rows (critical first, at most `NEEDS_ROWS`). */
    rows: open.slice(0, NEEDS_ROWS),
    /** All open notes, rows or not. */
    openCount: open.length,
    summary,
    approvals,
    chatCards,
    /** Unread notes of every severity, and with the posts to approve: the menu's Inbox counter. */
    unreadNotes: inboxCount - approvals,
    inboxCount,
    /** The Inbox answered: the headline may claim a number (or "nothing"). */
    loaded: inbox.isSuccess && !approvalsQ.isLoading,
    /** The Inbox could not be read at all: say so instead of claiming "all clear". */
    failed: inbox.isError && !inbox.data,
    retry: () => { void inbox.refetch(); },
    hide,
    dismiss,
  };
}

export type NeedsYou = ReturnType<typeof useNeedsYou>;
