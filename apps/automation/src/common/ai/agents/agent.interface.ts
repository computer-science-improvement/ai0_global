export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatOptions {
  /** Override the agent's default model */
  model?: string;
  maxTokens?: number;
}
