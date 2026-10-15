import { AdRef } from '../../types';
export interface TrackedPostDto {
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
  adRefs: AdRef[] | null;
  /** Spec 037 T2: a native forward of a network sibling's post — the source channel; null for own posts. */
  repostFrom: string | null;
  /** Spec 037 T10: an evergreen post (the editor's fallback for a failed slot) — counted apart in Analytics. */
  evergreen?: boolean;
}
