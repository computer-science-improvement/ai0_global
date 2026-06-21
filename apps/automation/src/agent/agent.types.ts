// apps/automation/src/agent/agent.types.ts
export type AgentCategory = 'ad' | 'vp' | 'question' | 'spam' | 'other';

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
