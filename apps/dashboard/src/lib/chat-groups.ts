/** Spec 048 FR-004: the chat list groups chats by when they were last active (the viewer's local days). */
export type ChatGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export function chatGroup(updatedAt: string, now = new Date()): ChatGroup {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(new Date(updatedAt))) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Previous 7 days' : 'Older';
}
