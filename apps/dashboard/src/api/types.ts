export interface TrackedChannel {
  id: string;
  username: string | null;
  title: string | null;
  about: string | null;
  subsCount: number | null;
  isMine: boolean;
  isClosed: boolean;
  pollTier: 'hot' | 'warm' | 'cold';
  addedAt: string;
  lastPolledAt: string | null;
}

export interface TrackedPost {
  id: string;
  channelId: string;
  tgMessageId: string;
  text: string | null;
  hasMedia: boolean;
  postedAt: string;
  views: number | null;
  forwards: number | null;
  reactionsTotal: number | null;
  commentsCount: number | null;
  adRefs: unknown[] | null;
}

export interface SubsHistoryPoint { at: string; subs: number; }
export interface PageResp<T> { items: T[]; total: number; }

export interface Me { tgUserId: number; firstName: string; username?: string; }
