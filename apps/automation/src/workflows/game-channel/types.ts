export type GameContentType = 'giveaway' | 'deal' | 'news';

export interface GameChannelItem {
  type:         GameContentType;
  title:        string;
  description:  string;
  source:       string;       // URL — used for dedup
  imageUrl:     string | null;
  publishedAt:  string | null;

  // Giveaway / deal specific
  platform?:    string;
  endDate?:     string;
  instructions?: string;

  // Deal specific
  discount?:    number;       // e.g. 75
  salePrice?:   string;       // e.g. "$4.99"
  origPrice?:   string;       // e.g. "$19.99"

  // Steam metadata (enriched)
  reviewScore?:  string;       // e.g. "Very Positive"
  reviewCount?:  number;       // e.g. 5003171
  genres?:       string[];     // e.g. ["Action", "RPG"]
  minRam?:       string;       // e.g. "8 GB RAM"
  minStorage?:   string;       // e.g. "150 GB"
}
