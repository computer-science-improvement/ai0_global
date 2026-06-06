// scheduled-posts.types.ts
export type Sender    = 'bot' | 'mtproto_user';
export type MediaType = 'none' | 'photo' | 'video';
export type Placement = 'above' | 'below';
export interface ButtonRow { buttons: { label: string; url: string }[]; }

export interface ComposedPost {
  channelId:      string;
  sender:         Sender;
  botId:          string | null;
  text:           string;        // Telegram HTML
  mediaType:      MediaType;
  mediaUrl:       string | null;
  mediaPlacement: Placement;
  buttons:        ButtonRow[];
  scheduledAt:    string;        // ISO
}

export interface ScheduledPost extends ComposedPost {
  id:        string;
  status:    'pending' | 'sending' | 'sent' | 'failed' | 'canceled';
  messageId: number | null;
  error:     string | null;
  createdAt: string;
  updatedAt: string;
}
