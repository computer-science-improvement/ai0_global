import { BadRequestException, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { clientIp } from '../../auth/client-info';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { CONNECTOR_AUDIT, type AuditSink } from '../audit/audit';
import { CONNECTOR_CONFIG, type ConnectorConfig } from '../http/config';
import { OAUTH_STORE, type OAuthStore } from '../oauth/store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (id: string) => { if (!UUID.test(id)) throw new BadRequestException({ error: 'invalid_id' }); return id; };

/** Settings → Connectors (spec 103 §9). Owner session or TRACKING_TOKEN; always available, also while the connector is off. */
@Controller('api/connector')
@UseGuards(TrackingAuthGuard)
export class ConnectorAdminController {
  constructor(
    @Inject(CONNECTOR_CONFIG) private readonly cfg: ConnectorConfig,
    @Inject(OAUTH_STORE) private readonly store: OAuthStore,
    @Inject(CONNECTOR_AUDIT) private readonly audit: AuditSink,
  ) {}

  @Get('status')
  status() {
    return this.cfg.current().status;
  }

  @Get('clients')
  async clients() {
    const rows = await this.store.listClients();
    return {
      clients: rows.map((c) => ({
        id: c.id, clientId: c.clientId, kind: c.kind, name: c.name,
        redirectHosts: [...new Set(c.redirectUris.map((u) => { try { return new URL(u).host; } catch { return u; } }))],
        createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, activeGrants: c.activeGrants,
      })),
    };
  }

  @Delete('clients/:id')
  async removeClient(@Param('id') id: string, @Req() req: any) {
    const r = await this.store.revokeClient(uuid(id), new Date());
    if (r.found) await this.audit.record({ event: 'revoked', summary: `client removed, ${r.revoked} grant(s) revoked`, ip: clientIp(req) });
    return { ok: r.found, revoked: r.revoked };
  }

  @Get('grants')
  async grants() {
    const rows = await this.store.listGrants();
    return {
      grants: rows.map((g) => ({
        id: g.id, clientId: g.clientId, clientName: g.clientName, scopes: g.scope.split(' ').filter(Boolean),
        createdAt: g.createdAt, lastUsedAt: g.lastUsedAt, lastIp: g.lastIp, expiresAt: g.expiresAt,
      })),
    };
  }

  @Delete('grants/:id')
  async revokeGrant(@Param('id') id: string, @Req() req: any) {
    const g = await this.store.getGrant(uuid(id));
    const ok = await this.store.revokeGrant(id, 'revoked_by_owner', new Date());
    if (ok) await this.audit.record({ event: 'revoked', grantId: id, clientId: g?.clientId ?? null, summary: 'revoked by the owner', ip: clientIp(req) });
    return { ok };
  }

  @Post('grants/revoke-all')
  @HttpCode(200)
  async revokeAll(@Req() req: any) {
    const revoked = await this.store.revokeAllGrants('revoked_by_owner', new Date());
    await this.audit.record({ event: 'revoked', summary: `all access revoked (${revoked})`, ip: clientIp(req) });
    return { ok: true, revoked };
  }

  @Get('activity')
  async activity(@Query('limit') limit?: string) {
    const n = Math.min(200, Math.max(1, Number.parseInt(limit ?? '50', 10) || 50));
    const rows = await this.audit.list(n);
    return {
      items: rows.map((r) => ({
        id: r.id, at: r.at, event: r.event, tool: r.tool, clientName: r.clientName, ok: r.ok, error: r.error, durationMs: r.durationMs, summary: r.summary,
      })),
    };
  }
}
