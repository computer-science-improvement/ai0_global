export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatOptions {
  /** Override the agent's default model */
  model?: string;
  maxTokens?: number;
  /** Spend-ledger feature of this call (spec 029, common/ai/usage/features.ts); overrides the ambient LLM context. */
  feature?: string;
}
