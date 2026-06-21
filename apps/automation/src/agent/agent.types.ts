// apps/automation/src/agent/agent.types.ts
export type AgentCategory = 'ad' | 'vp' | 'question' | 'spam' | 'other';

// SP4 Chat-intel types
export type OpportunityKind = 'ad_offer' | 'vp_request' | 'pricing' | 'other';
export type SuggestedAction = 'advertise' | 'do_vp' | 'skip';
export interface Opportunity { kind: OpportunityKind; summary: string; score: number; suggestedAction: SuggestedAction }
export interface ChatMessage { messageId: number; text: string; date: Date }
export interface JoinedGroup { chatId: string; title: string }
export interface MonitoredChatRow { chat_id: string; title: string | null; enabled: boolean; last_message_id: string; last_polled_at: Date | null; created_at: Date; updated_at: Date }
export interface OpportunityRow {
  id: string; chat_id: string; chat_title: string | null; message_id: string; message_text: string | null;
  kind: OpportunityKind; summary: string | null; score: number; suggested_action: SuggestedAction;
  status: 'new' | 'reviewed' | 'archived'; created_at: Date;
}

export type AgentActionType = 'reply' | 'schedule_post';
export type AgentActionStatus = 'pending' | 'approved' | 'done' | 'rejected' | 'failed';
export interface AgentActionRow {
  id:          string;
  type:        AgentActionType;
  status:      AgentActionStatus;
  thread_id:   string | null;
  payload:     Record<string, any>; // reply: {text}; schedule_post: {text, channelId, scheduledAt, scheduledPostId?}
  error:       string | null;
  created_at:  Date;
  updated_at:  Date;
  executed_at: Date | null;
}

export interface TriageResult {
  category:   AgentCategory;
  summary:    string;
  fields:     { channel?: string; budget?: string; dates?: string };
  draftReply: string;
  score:      number; // 0..100
}

export interface RawDm {
  peerId:       string;
  peerUsername: string | null;
  peerName:     string | null;
  messageId:    number;
  text:         string;
  date:         Date;
  out:          boolean; // true = sent by us (skip), false = incoming
}

export interface AgentThreadRow {
  id:               string;
  peer_id:          string;
  peer_username:    string | null;
  peer_name:        string | null;
  last_message_id:  string;   // bigint comes back as string from pg
  last_message_at:  Date;
  last_text:        string | null;
  category:         AgentCategory;
  summary:          string | null;
  fields:           Record<string, unknown>;
  draft_reply:      string | null;
  score:            number;
  status:           'new' | 'reviewed' | 'archived';
  created_at:       Date;
  updated_at:       Date;
}
