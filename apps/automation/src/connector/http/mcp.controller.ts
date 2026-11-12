import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { McpEndpoint } from './mcp-endpoint';

export const MCP_ENDPOINT = 'CONNECTOR_MCP_ENDPOINT';

/** The connector's MCP URL. Bearer only: neither TRACKING_TOKEN nor a dashboard session is accepted here (no TrackingAuthGuard). */
@Controller('api/mcp')
export class McpController {
  constructor(@Inject(MCP_ENDPOINT) private readonly endpoint: McpEndpoint) {}

  @All()
  async mcp(@Req() req: any, @Res() res: any): Promise<void> {
    await this.endpoint.handle(req, res);
  }
}
