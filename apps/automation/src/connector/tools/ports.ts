import type { ChannelMode, EditorCard } from '../../editor/card';
import type { NetworkHealth } from '../../editor/health/network-health';
import type { ChannelSloRow } from '../../editor/slo/channel-slo.repository';
import type { EditorRunRow, EditorRunStep } from '../../editor/repo/editor-runs.repository';
import type { EditorDraft } from '../../editor/repo/editor-chat.repository';
import type { ConnectorQueries } from '../queries/connector-queries';
import type { ConnectorChatService } from '../chat/connector-chat.service';
import type { ConnectorPostsService } from '../posts/connector-posts.service';

/**
 * What the connector's tools use of the editor, as small ports. The Nest provider wires the real services; unit tests
 * pass fakes. Nothing here can publish, change a mode, a setting, a model, a budget or a skill.
 */

export interface AgentRow {
  handle: string;
  name:   string;
  kind:   string;
  /** The Telegram channel key an orchestrator works for (null for system agents). */
  channel: string | null;
  mode:   string;
  paused: boolean;
}

export interface CardView { id: string; kind: string; status: string; summary: string; chatId: string | null }

export interface ReplanOutcome {
  /** started | replan_in_progress | editor_disabled | channel_off */
  status: 'started' | 'replan_in_progress' | 'editor_disabled' | 'channel_off';
}

export interface ConnectorReadPorts {
  now(): Date;
  env(key: string): string | undefined;
  cards(): Promise<EditorCard[]>;
  card(channelKey: string): Promise<EditorCard | null>;
  /** The mode the channel really runs in (its agent's mode ∧ its card's). */
  modeOf(card: EditorCard): Promise<ChannelMode>;
  slo: {
    get(channelKey: string, day: string): Promise<ChannelSloRow | null>;
    history(day: string, days: number, channelKey: string): Promise<ChannelSloRow[]>;
  };
  health(): Promise<NetworkHealth>;
  queries: ConnectorQueries;
  run(id: string): Promise<{ run: EditorRunRow; steps: EditorRunStep[] } | null>;
  agents(): Promise<AgentRow[]>;
  /** A draft of an agent chat (spec 104 get_draft); absent → get_draft finds none. */
  draft?(id: string): Promise<EditorDraft | null>;
}

export interface ConnectorWritePorts {
  now(): Date;
  cards(): Promise<EditorCard[]>;
  posts: ConnectorPostsService;
  chat: ConnectorChatService;
  /** The planner in the background with the owner's instruction (EditorOpsService.replan). */
  replan(channelKey: string, o: { day: 'today' | 'tomorrow'; instruction?: string }): Promise<ReplanOutcome>;
  cardsApi: {
    get(id: string): Promise<CardView | null>;
    /** The editor's answer: `{action}` with the settled card (status applied | failed | expired, error, result). */
    apply(id: string, input?: unknown): Promise<unknown>;
    discard(id: string): Promise<unknown>;
  };
}
