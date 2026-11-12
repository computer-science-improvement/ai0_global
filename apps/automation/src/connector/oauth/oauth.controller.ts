import { Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { clientIp } from '../../auth/client-info';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { CONNECTOR_CONFIG, OAUTH_SERVICE, liveUrls, type ConnectorConfig } from '../http/config';
import type { ConnectorUrls } from '../types';
import { ClientRegistry } from './clients';
import { OAuthError } from './errors';
import type { OAuthService } from './oauth.service';

export const CLIENT_REGISTRY = 'CONNECTOR_CLIENT_REGISTRY';

/** Query values as plain strings (an array or object parameter is dropped, so a handler never sees one). */
function strings(q: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (q && typeof q === 'object') for (const [k, v] of Object.entries(q)) if (typeof v === 'string') out[k] = v;
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cannot connect</title>`
    + `<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}h1{font-size:1.25rem}</style></head>`
    + `<body><h1>Cannot connect</h1><p>${escapeHtml(message)}</p><p>Go back to Claude and try again.</p></body></html>`;
}

/** OAuth authorization server endpoints + the consent API (spec 103 §5). All answer 404 {error:'connector_off'} when the connector is off. */
@Controller('api/oauth')
export class OAuthController {
  constructor(
    @Inject(CONNECTOR_CONFIG) private readonly cfg: ConnectorConfig,
    @Inject(OAUTH_SERVICE) private readonly oauth: OAuthService,
    @Inject(CLIENT_REGISTRY) private readonly clients: ClientRegistry,
  ) {}

  private urls(): ConnectorUrls {
    const u = liveUrls(this.cfg);
    if (!u) throw new NotFoundException({ error: 'connector_off' });
    return u;
  }

  /** An OAuth failure becomes its RFC 6749 JSON body with its status; anything else is a 500 as usual. */
  private fail(res: any, e: unknown): never {
    if (e instanceof OAuthError) {
      res.setHeader('Cache-Control', 'no-store');
      throw new HttpException(e.body(), e.status);
    }
    throw e;
  }

  @Get('authorize')
  async authorize(@Req() req: any, @Res() res: any) {
    const urls = this.urls();
    const r = await this.oauth.authorize(strings(req.query), urls);
    res.setHeader('Cache-Control', 'no-store');
    if (r.kind === 'page') {
      res.status(400).type('html').send(errorPage(r.message));
      return;
    }
    res.redirect(302, r.location);
  }

  @Post('register')
  @HttpCode(201)
  async register(@Req() req: any, @Res({ passthrough: true }) res: any) {
    this.urls();
    try {
      res.setHeader('Cache-Control', 'no-store');
      return await this.clients.register(req.body, clientIp(req));
    } catch (e) {
      this.fail(res, e);
    }
  }

  @Post('token')
  @HttpCode(200)
  async token(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const urls = this.urls();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      return await this.oauth.token(body, urls, { ip: clientIp(req) });
    } catch (e) {
      this.fail(res, e);
    }
  }

  @Post('revoke')
  @HttpCode(200)
  async revoke(@Req() req: any) {
    this.urls();
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    await this.oauth.revoke(body, { ip: clientIp(req) }).catch(() => undefined);
    return {};
  }

  // ── consent API (the SPA page /app/oauth/consent calls these with the owner's session) ──

  @Get('requests/:id')
  @UseGuards(TrackingAuthGuard)
  async requestInfo(@Param('id') id: string, @Res({ passthrough: true }) res: any) {
    this.urls();
    res.setHeader('Cache-Control', 'no-store');
    try {
      return await this.oauth.requestInfo(id);
    } catch (e) {
      this.fail(res, e);
    }
  }

  @Post('requests/:id/decision')
  @HttpCode(200)
  @UseGuards(TrackingAuthGuard)
  async decision(@Param('id') id: string, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const urls = this.urls();
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers?.origin;
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      return await this.oauth.decide(id, body, urls, {
        authMethod: String(req.auth?.method ?? ''),
        production: this.cfg.production(),
        origin: typeof origin === 'string' ? origin : undefined,
        ip: clientIp(req),
      });
    } catch (e) {
      this.fail(res, e);
    }
  }
}
