export interface RecipeItem {
  title:        string;
  category:     string;
  area:         string;
  instructions: string;
  ingredients:  string[];
  imageUrl:     string | null;
  source:       string;        // URL — used for dedup
  youtubeUrl:   string | null;
}
