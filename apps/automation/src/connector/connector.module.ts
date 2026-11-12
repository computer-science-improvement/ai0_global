import { Module, type Provider } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DB_POOL } from '../database/database.tokens';
import { AGENTS_SERVICE } from '../editor/agents/agents.controller';
import { APPROVALS_SERVICE } from '../editor/approval/approvals.controller';
import { EDITOR_CHAT, EDITOR_DRAFTS } from '../editor/api/editor-chat.controller';
import { EDITOR_OPS } from '../editor/api/editor.controller';
import { AGENT_INFRA, APPROVAL_INFRA, EDITOR_PUBLISH, EDITOR_REPOS, EditorModule } from '../editor/editor.module';
import { NETWORK_HEALTH } from '../editor/health/network-health.controller';
import { EDITOR_SLO_REPO } from '../editor/slo/slo.controller';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { ConnectorAdminController } from './admin/admin.controller';
import { CONNECTOR_AUDIT, PgAudit, type AuditSink } from './audit/audit';
import { CONNECTOR_CONFIG, CONNECTOR_ENV, OAUTH_SERVICE, makeConnectorConfig, type ConnectorConfig, type EnvReader } from './http/config';
import { MCP_ENDPOINT, McpController } from './http/mcp.controller';
import { McpEndpoint } from './http/mcp-endpoint';
import { ClientRegistry } from './oauth/clients';
import { DiscoveryController } from './oauth/discovery.controller';
import { CLIENT_REGISTRY, OAuthController } from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';
import { PgOAuthStore } from './oauth/pg-store';
import { OAUTH_STORE, type OAuthStore } from './oauth/store';
import { CONNECTOR_TOOLS, type ConnectorToolsFactory } from './types';
import { ConnectorToolsFactoryImpl } from './tools/connector-tools.factory';

/**
 * Spec 103 — the Claude connector: a remote MCP server (Streamable HTTP, stateless, JSON responses) with its own
 * OAuth 2.1 authorization server, running in this process and calling the editor's services directly.
 *
 *   /.well-known/oauth-protected-resource[/api/mcp], /.well-known/oauth-authorization-server   discovery
 *   /api/oauth/{authorize,token,register,revoke}, /api/oauth/requests/:id[/decision]          OAuth + consent
 *   /api/mcp                                                                                  MCP (bearer)
 *   /api/connector/*                                                                          Settings → Connectors
 *
 * Off unless MCP_CONNECTOR=on (read per request). The tools come from CONNECTOR_TOOLS (WP-C).
 */
/** The connector's providers (the module adds TrackingAuthGuard); exported so the module test can resolve them. */
export const CONNECTOR_PROVIDERS: Provider[] = [
  { provide: CONNECTOR_ENV, useValue: ((k: string) => process.env[k]) as EnvReader },
  { provide: CONNECTOR_CONFIG, inject: [CONNECTOR_ENV], useFactory: (env: EnvReader) => makeConnectorConfig(env) },
  { provide: OAUTH_STORE, useClass: PgOAuthStore },
  { provide: CONNECTOR_AUDIT, useClass: PgAudit },
  { provide: CLIENT_REGISTRY, inject: [OAUTH_STORE, CONNECTOR_AUDIT], useFactory: (store: OAuthStore, audit: AuditSink) => new ClientRegistry(store, undefined, undefined, audit) },
  {
    provide: OAUTH_SERVICE,
    inject: [OAUTH_STORE, CLIENT_REGISTRY, CONNECTOR_AUDIT],
    useFactory: (store: OAuthStore, clients: ClientRegistry, audit: AuditSink) => new OAuthService(store, clients, audit),
  },
  {
    provide: MCP_ENDPOINT,
    inject: [CONNECTOR_CONFIG, OAUTH_SERVICE, OAUTH_STORE, CONNECTOR_TOOLS, CONNECTOR_AUDIT],
    useFactory: (cfg: ConnectorConfig, oauth: OAuthService, store: OAuthStore, tools: ConnectorToolsFactory, audit: AuditSink) =>
      new McpEndpoint({ cfg, oauth, store, tools, audit }),
  },
  {
    provide: CONNECTOR_TOOLS,
    inject: [EDITOR_REPOS, EDITOR_OPS, EDITOR_CHAT, AGENTS_SERVICE, APPROVALS_SERVICE, APPROVAL_INFRA, AGENT_INFRA, NETWORK_HEALTH, EDITOR_SLO_REPO, EDITOR_PUBLISH, DB_POOL, EDITOR_DRAFTS],
    useFactory: (repos: any, ops: any, chat: any, agentsSvc: any, approvals: any, approval: any, agentInfra: any, health: any, slo: any, publish: any, pool: any, drafts: any) =>
      new ConnectorToolsFactoryImpl({ repos, ops, chat, agentsSvc, approvals, approval, agentInfra, health, slo, publish, pool, drafts }),
  },
];

export const CONNECTOR_CONTROLLERS = [DiscoveryController, OAuthController, McpController, ConnectorAdminController];

@Module({
  imports:     [AuthModule, EditorModule],
  controllers: CONNECTOR_CONTROLLERS,
  providers:   [TrackingAuthGuard, ...CONNECTOR_PROVIDERS],
})
export class ConnectorModule {}
