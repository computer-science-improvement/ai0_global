import { Logger, type HttpException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { EditorCard } from '../../editor/card';
import type { PublishSpecDeps } from '../../editor/publish/publish-spec';
import { prepareAndRender } from '../../editor/publish/publish-spec';
import { isPaused } from '../../editor/agents/agent.types';
import type { RenderedDraft } from '../../editor/chat/drafts.service';
import type { McpResource } from '../../editor/mcp/mcp-server';
import type { EditorDraft } from '../../editor/repo/editor-chat.repository';
import { withApps, type ViewPorts } from '../apps/apps';
import { DEFAULT_IMAGE_HOSTS, imageOrigins, widgetResource } from '../apps/widget';
import { connectorStatus, type ConnectorPrincipal, type ConnectorTool, type ConnectorToolsFactory } from '../types';
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
  /** The editor chat's drafts (spec 104: get_draft and the draft previews); absent → no draft is found. */
  drafts?:    { get(id: string): Promise<EditorDraft | null>; withRender(d: EditorDraft): Promise<RenderedDraft> };
  env?:       (k: string) => string | undefined;
  now?:       () => Date;
  log?:       (m: string) => void;
  /** Builds the MCP Apps view for the given image origins (default widgetResource; tests replace it). */
  viewResource?: (imageOrigins: string[]) => McpResource;
}

const statusOf = (err: unknown): string | null => {
  const r = (err as HttpException)?.getResponse?.();
  return r && typeof r === 'object' ? String((r as { error?: unknown }).error ?? '') : null;
};

/** MCP_APPS (spec 104): on unless set to off. */
export const appsOn = (env: (k: string) => string | undefined): boolean => (env('MCP_APPS') ?? 'on').trim().toLowerCase() !== 'off';

/** The CSP image origins of the view: the built-in hosts, MCP_APP_IMAGE_HOSTS, the site itself and the storage origin. */
export function viewImageOrigins(env: (k: string) => string | undefined): string[] {
  const extra = (env('MCP_APP_IMAGE_HOSTS') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const urls = connectorStatus(env).urls;
  return imageOrigins([...DEFAULT_IMAGE_HOSTS, ...extra], [urls?.origin, urls?.dashboardOrigin, env('SUPABASE_URL')]);
}

export class ConnectorToolsFactoryImpl implements ConnectorToolsFactory {
  private readonly all: ConnectorTool[];
  private readonly views: ViewPorts;
  private readonly env: (k: string) => string | undefined;
  private view: { key: string; resource: McpResource | null } | null = null;

  constructor(private readonly t: ConnectorTooling) {
    const now = t.now ?? (() => new Date());
    this.env = t.env ?? ((k) => process.env[k]);
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

    const draft = async (id: string) => (isUuid(id) && t.drafts ? t.drafts.get(id) : null);
    const read: ConnectorReadPorts = {
      now, env: this.env, cards, card, modeOf, slo: t.slo, health: () => t.health.health(), queries,
      run: (id) => t.repos.runs.get(id), agents: agentRows, draft,
    };
    this.views = {
      card, slotDetail: (id) => queries.slotDetail(id),
      ...(t.drafts ? { draft: async (id: string) => { const d = await draft(id); return d ? t.drafts!.withRender(d) : null; } } : {}),
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
    const mine = this.all.filter((x) => p.scopes.has(x.scope));
    const view = appsOn(this.env) ? this.resource() : null;
    return view ? withApps(mine, this.views, view.uri) : mine;
  }

  /** Spec 104: the MCP Apps view (none when MCP_APPS=off). The page is static, so any grant may read it. */
  async resources(): Promise<McpResource[]> {
    const view = appsOn(this.env) ? this.resource() : null;
    return view ? [view] : [];
  }

  /**
   * The view resource for the current image hosts (rebuilt only when they change: the URI hash covers the CSP). A page
   * that cannot be built (the SDK bundle missing or changed shape) never breaks the connector: the tools stay text-only.
   */
  private resource(): McpResource | null {
    const origins = viewImageOrigins(this.env);
    const key = origins.join(' ');
    if (this.view?.key !== key) {
      let resource: McpResource | null = null;
      try {
        resource = (this.t.viewResource ?? ((o) => widgetResource({ imageOrigins: o })))(origins);
      } catch (err) {
        const msg = `MCP Apps view unavailable, tools stay text-only: ${err instanceof Error ? err.message : String(err)}`;
        if (this.t.log) this.t.log(msg); else new Logger('McpConnector').warn(msg);
      }
      this.view = { key, resource };
    }
    return this.view.resource;
  }
}
