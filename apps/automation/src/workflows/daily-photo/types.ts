export interface DailyPhotoItem {
  title:       string;
  explanation: string;
  imageUrl:    string;
  hdUrl:       string | null;
  date:        string;       // YYYY-MM-DD
  mediaType:   string;       // 'image' | 'video'
  copyright:   string | null;
}
