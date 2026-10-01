// chat-member-bus.ts — fan-out of Telegram `chat_member` updates received by the
// admin bot's long poll (spec 022: joins through tracked invite links). Kept as a
// tiny module-level registry so the publishers module does not depend on the editor.

export interface ChatMemberUpdate {
  chat: { id: number; username?: string; type?: string };
  from?: { id: number };
  new_chat_member: { status: string; user: { id: number; is_bot?: boolean } };
  old_chat_member?: { status: string };
  invite_link?: { invite_link: string; name?: string };
}

type Listener = (u: ChatMemberUpdate) => Promise<void> | void;
const listeners = new Set<Listener>();

export function onChatMember(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function emitChatMember(u: ChatMemberUpdate): Promise<void> {
  for (const fn of listeners) {
    try { await fn(u); } catch { /* a listener never breaks the poll loop */ }
  }
}
