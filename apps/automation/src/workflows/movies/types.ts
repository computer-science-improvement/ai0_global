export interface MovieItem {
  title:         string;
  originalTitle: string;
  overview:      string;
  releaseDate:   string;
  voteAverage:   number;
  voteCount:     number;
  genreNames:    string[];
  imageUrl:      string | null;
  backdropUrl:   string | null;
  source:        string;       // TMDB URL — used for dedup
  mediaType:     'movie' | 'tv';
}
