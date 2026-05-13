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

export interface GraphNode {
  id: string; username: string | null; title: string | null;
  subs: number | null; isMine: boolean; category: string | null;
}
export interface GraphEdge {
  source: string; target: string | null; target_username: string;
  count: number; kind: string; colorTier: 'green' | 'orange' | 'red'; last_seen: string;
}
export interface GraphResponse { nodes: GraphNode[]; edges: GraphEdge[]; }

export interface RoiResponse {
  estimated_subs_per_ad: number;
  confidence: 'low' | 'medium' | 'high';
  narrative: string;
  risks: string[];
  source: 'heuristic' | 'claude';
  computed_at: string;
  inputs: { avg_views: number; subs: number; engagement_rate: number };
}
