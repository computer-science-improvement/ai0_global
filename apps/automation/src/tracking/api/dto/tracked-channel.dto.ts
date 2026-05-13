export interface TrackedChannelDto {
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
