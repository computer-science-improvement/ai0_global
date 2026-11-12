import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EditorModule } from '../editor/editor.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';

/**
 * Spec 103 — the Claude connector: a remote MCP server (Streamable HTTP, stateless, JSON responses) with its own
 * OAuth 2.1 authorization server, running in this process and calling the editor's services directly.
 *
 *   /.well-known/oauth-protected-resource[/api/mcp], /.well-known/oauth-authorization-server   discovery
 *   /api/oauth/{authorize,token,register,revoke}, /api/oauth/requests/:id[/decision]          OAuth + consent
 *   /api/mcp                                                                                  MCP (bearer)
 *   /api/connector/*                                                                          Settings → Connectors
 *
 * Off unless MCP_CONNECTOR=on. Controllers and providers are added by the work packages (tasks.md).
 */
@Module({
  imports:     [AuthModule, EditorModule],
  controllers: [],
  providers:   [TrackingAuthGuard],
})
export class ConnectorModule {}
