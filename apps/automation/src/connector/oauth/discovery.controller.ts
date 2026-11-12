import { Controller, Get, Inject, NotFoundException, Res } from '@nestjs/common';
import { CONNECTOR_CONFIG, liveUrls, type ConnectorConfig } from '../http/config';
import type { ConnectorUrls } from '../types';

/** RFC 9728 Protected Resource Metadata and RFC 8414 Authorization Server Metadata (spec 103 §5 A1). Served at the origin root. */
export function protectedResourceDoc(u: ConnectorUrls) {
  return {
    resource: u.resource,
    authorization_servers: [u.issuer],
    scopes_supported: ['mcp:read', 'mcp:write'],
    bearer_methods_supported: ['header'],
    resource_name: 'ai0',
  };
}

export function authorizationServerDoc(u: ConnectorUrls) {
  return {
    issuer: u.issuer,
    authorization_endpoint: `${u.origin}/api/oauth/authorize`,
    token_endpoint: `${u.origin}/api/oauth/token`,
    registration_endpoint: `${u.origin}/api/oauth/register`,
    revocation_endpoint: `${u.origin}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ['mcp:read', 'mcp:write'],
  };
}

@Controller('.well-known')
export class DiscoveryController {
  constructor(@Inject(CONNECTOR_CONFIG) private readonly cfg: ConnectorConfig) {}

  private urls(): ConnectorUrls {
    const u = liveUrls(this.cfg);
    if (!u) throw new NotFoundException({ error: 'connector_off' });
    return u;
  }

  // The path-suffixed form is what Claude probes first; the bare form is for clients that do not add the resource path.
  @Get(['oauth-protected-resource', 'oauth-protected-resource/api/mcp'])
  prm(@Res({ passthrough: true }) res: any) {
    const u = this.urls();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return protectedResourceDoc(u);
  }

  @Get('oauth-authorization-server')
  as(@Res({ passthrough: true }) res: any) {
    const u = this.urls();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return authorizationServerDoc(u);
  }
}
