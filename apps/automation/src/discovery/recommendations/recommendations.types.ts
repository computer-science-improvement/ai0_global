// apps/automation/src/discovery/recommendations/recommendations.types.ts

export interface CandidateChannelRow {
  id:          string;
  source:      string;
  external_id: string;
  slug:        string;
  link:        string;
  title:       string;
  description: string | null;
  language:    string | null;
  themes:      string[];
  sex_ratio:   number | null;
  price_min:   number | null;
  price_max:   number | null;
  avatar_url:  string | null;
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

export interface RecommendInput {
  targetChannelId:        string;
  budget:                 number;
  limit?:                 number;
  excludeAlreadyTracked?: boolean;
}

export interface RecommendOutput {
  recommendations: RecommendationItem[];
  targetThemes:    string[];
  warning?:        string;
}
