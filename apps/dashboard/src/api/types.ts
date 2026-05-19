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

// ─── Phase 4: Discovery / Recommendations ─────────────────────────────────

export interface Theme {
  slug:  string;
  title: string;
}

export interface RecommendationItem {
  id:                 string;
  slug:               string;
  link:               string;
  title:              string;
  description:        string | null;
  themes:             string[];
  matchedThemes:      string[];
  score:              number;
  estimatedSubsPerAd: number | null;
  roiConfidence:      string | null;
  priceMin:           number;
  priceMax:           number | null;
  sexRatio:           number | null;
  avatarUrl:          string | null;
  language:           string | null;
  source:             string;
}

export interface RecommendResponse {
  recommendations: RecommendationItem[];
  targetThemes:    string[];
  warning?:        string;
}
