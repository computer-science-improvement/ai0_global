// owner-bot-bus.ts — the admin bot's long poll hands owner-bot buttons and commands (spec 012) to the editor-side
// handler. A tiny module-level registry, like chat-member-bus.ts, so the publishers module does not depend on the editor.

export interface OwnerCallback {
  id:        string;
  fromId:    number;
  chatId:    number | null;
  chatType:  string | null;
  messageId: number | null;
  data:      string;
}

export interface OwnerCommand {
  chatId:   number;
  chatType: string;
  fromId:   number;
  text:     string;
}

export interface OwnerBotHandler {
  /** A button whose data starts with `oc:`. */
  callback(cb: OwnerCallback): Promise<void>;
  /** A command from the owner; false when the handler does not know it. */
  command(cmd: OwnerCommand): Promise<boolean>;
  /** The /help lines of the handler's commands. */
  help(): string[];
}

let handler: OwnerBotHandler | null = null;

export function setOwnerBotHandler(h: OwnerBotHandler | null): void { handler = h; }
export function ownerBotHandler(): OwnerBotHandler | null { return handler; }

/** What the poll loop last did, for the Owner bot section of /app/health (FR-007). */
export interface PollState { running: boolean; lastPollAt: Date | null; lastUpdateAt: Date | null; lastError: string | null }
export const pollState: PollState = { running: false, lastPollAt: null, lastUpdateAt: null, lastError: null };
