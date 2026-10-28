// Spec 078 B4.2: the Calendar's composer, a drawer on the right (`?compose=new&channel=&day=` or `?compose=edit&post=`).
// It builds the Calendar's side of PostComposer: which channel and time a "+ Add" starts on, what "Ask the agent" does
// (a one-off pin on the agent's schedule), and the toast with Undo after a save. A post that already went out (or failed,
// or was canceled) opens read-only.

import { useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/primitives';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { TelegramPreview } from '../post/TelegramPreview';
import { PostComposer, type AskAgent } from '../post/PostComposer';
import { scheduledPostsApi } from '../../api/scheduled-posts';
import { apiMessage, useAskAgentPin, useDisablePin } from '../../api/calendar';
import {
  agentOfChannel, askFormat, askHint, askRule, askUnavailable, dayLabel, defaultComposeDay, defaultTime, kyivInstant, savedText, splitKyiv,
  type CalAgent, type CalendarSearch, type ScheduleState,
} from '../../lib/calendar';
import { postInputOf } from '../../lib/post-problems';
import { publicationLabel, publicationTone } from '../../lib/status-tone';
import { KYIV_TZ } from '../../lib/zoned-time';
import type { ScheduledPost, TrackedChannel } from '../../api/types';

export interface ComposerDrawerProps {
  search: CalendarSearch;
  /** Close the drawer (drop its params from the address). */
  close: () => void;
  today: string;
  agents: readonly CalAgent[];
  schedules: Readonly<Record<string, ScheduleState | undefined>>;
  channels: readonly TrackedChannel[] | undefined;
  channelsLoading: boolean;
  posts: readonly ScheduledPost[] | undefined;
  postsLoading: boolean;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const channelName = (c: Pick<TrackedChannel, 'channelKey' | 'title'> | undefined) => c?.channelKey ?? c?.title ?? 'the channel';

export function ComposerDrawer(p: ComposerDrawerProps) {
  const { search } = p;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const pin = useAskAgentPin();
  const unpin = useDisablePin();
  const dirty = useRef(false);

  const channels = p.channels ?? [];
  const byId = new Map(channels.map((c) => [c.id, c] as const));
  const agentOf = (channelId: string): CalAgent | null => agentOfChannel(p.agents, byId.get(channelId));
  const refresh = () => qc.invalidateQueries({ queryKey: ['scheduled-posts'] });

  /** Closing over typed text asks first; every other path closes at once. */
  const finish = () => { dirty.current = false; p.close(); };
  const requestClose = async () => {
    if (dirty.current && !(await confirm('discard this unsaved post', { confirmLabel: 'Discard' }))) return;
    finish();
  };

  const post = search.compose === 'edit' ? p.posts?.find((x) => x.id === search.post) : undefined;
  const pending = post?.status === 'pending';
  const title = search.compose === 'new' ? 'New post' : pending ? 'Edit post' : 'Post details';

  // ── "Ask the agent": a one-off pin ───────────────────────────────────────────
  const dataOf = (a: CalAgent) => p.schedules[a.handle]?.data;
  const zoneOf = (channelId: string): string => {
    const a = agentOf(channelId);
    const d = a ? dataOf(a) : undefined;
    return (a && d?.resources.find((r) => r.ref === a.ref)?.timezone) ?? d?.planning?.timezone ?? KYIV_TZ;
  };
  const ask: AskAgent | undefined = p.agents.length === 0 ? undefined : {
    unavailable: (channelId) => { const a = agentOf(channelId); return askUnavailable(a, a ? p.schedules[a.handle]?.error : null); },
    zone: zoneOf,
    hint: (channelId, day, time) => {
      const a = agentOf(channelId);
      if (!a) return '';
      return askHint({ mode: a.mode, approval: dataOf(a)?.planning?.approval ?? a.mode === 'approve', time, zone: zoneOf(channelId), day });
    },
    submit: async ({ channelId, brief, day, time }) => {
      const a = agentOf(channelId);
      if (!a) throw new Error('This channel has no agent.');
      const format = askFormat(dataOf(a)?.resources.find((r) => r.ref === a.ref)?.formats);
      const out = await pin.mutateAsync({ handle: a.handle, rule: askRule({ ref: a.ref, day, time, format, brief }) });
      const id = out.rule.id;
      toast.success([savedText('Draft requested', a.channelKey, day, time), out.warnings?.[0]].filter(Boolean).join(' — '), {
        ttlMs: 10_000,
        action: {
          label: 'Undo',
          onClick: () => unpin.mutate({ handle: a.handle, id }, {
            onSuccess: () => toast.success('Request withdrawn'),
            onError: () => toast.error(`Could not withdraw it. Switch the pin off on @${a.handle}'s Schedule tab.`),
          }),
        },
      });
    },
  };

  // ── after a save: the toast carries the way back ─────────────────────────────
  const saved = (next: ScheduledPost) => {
    const when = splitKyiv(next.scheduledAt);
    const where = channelName(byId.get(next.channelId));
    if (post) {
      const before = postInputOf(post);
      toast.success(savedText('Post updated', where, when.day, when.time), {
        ttlMs: 10_000,
        action: { label: 'Undo', onClick: () => { scheduledPostsApi.update(next.id, before).then(refresh).catch((e) => toast.error(apiMessage(e))); } },
      });
    } else {
      toast.success(savedText('Scheduled', where, when.day, when.time), {
        ttlMs: 10_000,
        action: {
          label: 'Undo',
          onClick: () => { scheduledPostsApi.cancel(next.id).then(refresh).then(() => toast.success('Post canceled')).catch((e) => toast.error(apiMessage(e))); },
        },
      });
    }
  };

  const cancelPost = async (target: ScheduledPost) => {
    if (!(await confirm('cancel this scheduled post', { confirmLabel: 'Cancel post' }))) return;
    try {
      await scheduledPostsApi.cancel(target.id);
      await refresh();
    } catch (e) {
      toast.error(apiMessage(e));
      return;
    }
    finish();
    const before = postInputOf(target);
    toast.success('Post canceled', {
      ttlMs: 10_000,
      action: { label: 'Undo', onClick: () => { scheduledPostsApi.create(before).then(refresh).catch((e) => toast.error(apiMessage(e))); } },
    });
  };

  // ── what the sheet shows ─────────────────────────────────────────────────────
  let body;
  if (search.compose === 'new') {
    if (p.channelsLoading) {
      body = <Waiting />;
    } else {
      const preset = search.channel ? channels.find((c) => same(c.channelKey, search.channel)) ?? channels.find((c) => c.id === search.channel) : undefined;
      const day = search.day && search.day >= p.today ? search.day : defaultComposeDay(p.today);
      body = (
        <PostComposer
          key={`new:${preset?.id ?? ''}:${day}`} variant="drawer" onDone={finish} onCancel={requestClose} onSaved={saved} ask={ask} dirtyRef={dirty}
          initial={{ channelId: preset?.id ?? '', botId: preset?.botId ?? null, scheduledAt: kyivInstant(day, defaultTime(day)) }}
        />
      );
    }
  } else if (search.compose === 'edit') {
    if (p.postsLoading && !post) body = <Waiting />;
    else if (!post) body = <Gone onClose={finish} />;
    else if (pending) {
      body = (
        <PostComposer
          key={`edit:${post.id}`} variant="drawer" editing={post} onDone={finish} onCancel={requestClose} onSaved={saved} dirtyRef={dirty}
          footerExtra={<button type="button" className="btn-ghost" onClick={() => void cancelPost(post)}>Cancel post</button>}
        />
      );
    } else {
      body = <Details post={post} channel={channelName(byId.get(post.channelId))} onClose={finish} />;
    }
  } else {
    body = null;
  }

  return (
    <Modal open={!!search.compose} onClose={() => void requestClose()} title={title} icon="calendar" size="drawer">
      {body}
    </Modal>
  );
}

function Waiting() {
  return (
    <div className="pc-body" role="status" aria-busy>
      <p className="pc-note" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>
    </div>
  );
}

/** `?post=` names a post that is not there (deleted, or a stale link). */
function Gone({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="pc-body">
        <EmptyState title="This post is not here any more" note="It may have been canceled or removed. Your other posts are on the Scheduled page." />
      </div>
      <div className="modal-foot pc-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </>
  );
}

/** A post that already went out, failed, or was canceled: read-only. */
function Details({ post, channel, onClose }: { post: ScheduledPost; channel: string; onClose: () => void }) {
  const when = splitKyiv(post.scheduledAt);
  return (
    <>
      <div className="pc-body">
        <div className="pc-row">
          <span className="pc-label">Status</span>
          <div><Badge tone={publicationTone(post.status)}>{publicationLabel(post.status)}</Badge></div>
        </div>
        <div className="pc-row">
          <span className="pc-label">Channel</span>
          <span className="mono">{channel}</span>
        </div>
        <div className="pc-row">
          <span className="pc-label">{post.status === 'sent' ? 'Sent' : 'Planned for'}</span>
          <span className="mono">{dayLabel(when.day)} · {when.time} Kyiv</span>
        </div>
        {post.error && <div className="callout-danger" role="alert">{post.error}</div>}
        <div className="pc-row">
          <span className="pc-label">Post</span>
          <div className="pc-preview"><TelegramPreview post={postInputOf(post)} /></div>
        </div>
      </div>
      <div className="modal-foot pc-foot">
        <Link to="/app/scheduled" className="btn-ghost">Open Scheduled</Link>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </>
  );
}
