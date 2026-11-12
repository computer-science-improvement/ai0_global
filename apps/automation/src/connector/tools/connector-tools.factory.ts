import type { HttpException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { EditorCard } from '../../editor/card';
import type { PublishSpecDeps } from '../../editor/publish/publish-spec';
import { prepareAndRender } from '../../editor/publish/publish-spec';
import { isPaused } from '../../editor/agents/agent.types';
import type { ConnectorPrincipal, ConnectorTool, ConnectorToolsFactory } from '../types';
import { ConnectorChatService } from '../chat/connector-chat.service';
import { ConnectorPostsRepository } from '../posts/connector-posts.repository';
import { ConnectorPostsService } from '../posts/connector-posts.service';
import { PgConnectorQueries } from '../queries/connector-queries';
import { isUuid } from './common';
import type { ConnectorReadPorts, ConnectorWritePorts, ReplanOutcome } from './ports';
import { buildReadTools } from './read-tools';
import { buildWriteTools } from './write-tools';

/**
 * The tools of the Claude connector (spec 103 §7). The editor's services are wired as small ports; the tool list of a
 * request is filtered by the grant's scopes, so a read-only grant never sees (and can never call) a write tool.
 */

/** The editor services the tools use (loose types on purpose: the module injects them, tests fake them). */
export interface ConnectorTooling {
  repos:      { channels: { list(): Promise<EditorCard[]>; get(key: string): Promise<EditorCard | null> }; runs: { get(id: string): Promise<any> } };
  ops:        { replan(key: string, o: { wait?: boolean; date?: string; instruction?: string }): Promise<unknown> };
  chat:       any;
  agentsSvc:  { handles(): Promise<{ agents: Array<{ handle: string }> }>; action(id: string): Promise<{ action: any }>; applyAction(id: string, input?: unknown): Promise<unknown>; discardAction(id: string): Promise<unknown> };
  approvals:  { approve(id: string): Promise<{ movedTo: Date | null }>; reject(id: string, body: unknown): Promise<{ replacementId: string | null }> };
  approval:   { mode(card: EditorCard): Promise<any> };
  agentInfra: { agents: { list(): Promise<any[]> }; channelKeyOf(a: any): Promise<string | null> };
  health:     { health(): Promise<any> };
  slo:        { get(c: string, day: string): Promise<any>; history(day: string, days: number, c: string): Promise<any[]> };
  publish:    Pick<PublishSpecDeps, 'media'>;
  pool:       Pool;
  env?:       (k: string) => string | undefined;
  now?:       () => Date;
  log?:       (m: string) => void;
}

const statusOf = (err: unknown): string | null => {
  const r = (err as HttpException)?.getResponse?.();
  return r && typeof r === 'object' ? String((r as { error?: unknown }).error ?? '') : null;
};

export class ConnectorToolsFactoryImpl implements ConnectorToolsFactory {
  private readonly all: ConnectorTool[];

  constructor(private readonly t: ConnectorTooling) {
    const now = t.now ?? (() => new Date());
    const queries = new PgConnectorQueries(t.pool);
    // The connector works with Telegram channels only (keys like @x).
    const cards = async () => (await t.repos.channels.list()).filter((c) => c.channelKey.startsWith('@'));
    const card = (k: string) => t.repos.channels.get(k);
    const modeOf = (c: EditorCard) => t.approval.mode(c);

    const posts = new ConnectorPostsService({
      store: new ConnectorPostsRepository(t.pool), card, modeOf, now,
      render: (c, spec, key) => prepareAndRender(t.publish, { channelKey: c.channelKey, spec, card: c, mediaKey: key }),
      approvals: t.approvals,
    });
    const agentRows = async () => {
      const list = await t.agentInfra.agents.list();
      return Promise.all(list.map(async (a) => ({
        handle: a.handle as string, name: a.name as string, kind: a.kind as string, mode: a.mode as string,
        channel: await t.agentInfra.channelKeyOf(a).catch(() => null), paused: isPaused(a, now()),
      })));
    };
    const chat = new ConnectorChatService({
      chat: {
        createChat: (o) => t.chat.createChat(o), validateSend: (id: string, text: unknown) => t.chat.validateSend(id, text),
        sendMessage: (id: string, text: unknown, o: any) => t.chat.sendMessage(id, text, o), getChat: (id: string) => t.chat.getChat(id),
        isRunning: (id: string) => t.chat.isRunning(id),
      },
      agents: {
        handles: async () => (await t.agentsSvc.handles()).agents.map((a) => a.handle.toLowerCase()),
        byId: async () => new Map((await t.agentInfra.agents.list()).map((a) => [a.id as string, { handle: a.handle as string, name: a.name as string }])),
      },
      log: t.log,
    });

    const read: ConnectorReadPorts = {
      now, env: t.env ?? ((k) => process.env[k]), cards, card, modeOf, slo: t.slo, health: () => t.health.health(), queries,
      run: (id) => t.repos.runs.get(id), agents: agentRows,
    };
    const write: ConnectorWritePorts = {
      now, cards, posts, chat,
      async replan(channelKey, o): Promise<ReplanOutcome> {
        try {
          await t.ops.replan(channelKey, { wait: false, date: o.day, instruction: o.instruction });
          return { status: 'started' };
        } catch (err) {
          const s = statusOf(err);
          if (s === 'replan_in_progress' || s === 'editor_disabled' || s === 'channel_off') return { status: s };
          throw err;
        }
      },
      cardsApi: {
        async get(id) {
          if (!isUuid(id)) return null;
          try {
            const { action } = await t.agentsSvc.action(id);
            return { id: action.id, kind: action.kind, status: action.status, summary: action.summary ?? '', chatId: action.chatId ?? null };
          } catch (err) { if (statusOf(err) === 'action_not_found') return null; throw err; }
        },
        apply: (id, input) => t.agentsSvc.applyAction(id, input ?? null),
        discard: (id) => t.agentsSvc.discardAction(id),
      },
    };
    this.all = [...buildReadTools({ ports: read, posts, chat }), ...buildWriteTools(write)];
  }

  async tools(p: ConnectorPrincipal): Promise<ConnectorTool[]> {
    return this.all.filter((x) => p.scopes.has(x.scope));
  }
}
