/**
 * stdio MCP server for operating the ai0 editor network (spec 006 T012).
 *
 *   pnpm --silent --filter automation editor:mcp
 *
 * Env: EDITOR_API_URL (default http://localhost:3000), TRACKING_TOKEN (required),
 *      EDITOR_MCP_ALLOW_LIVE_RUN=true to let run_slot execute slots of live channels.
 * The repo-root .env is loaded first (same loader as the service).
 * stdout is reserved for the protocol — every diagnostic goes to stderr.
 */
import '../../load-env';
import { McpServer } from './mcp-server';
import { buildEditorMcpTools, HttpEditorApi } from './editor-mcp-tools';
import type { McpTool } from './mcp-server';

const log = (m: string) => process.stderr.write(`[ai0-editor-mcp] ${m}\n`);

async function main(): Promise<void> {
  const url = process.env.EDITOR_API_URL || 'http://localhost:3000';
  const token = process.env.TRACKING_TOKEN ?? '';
  if (!token) {
    log('TRACKING_TOKEN is not set — the editor API will answer 401. Set it in .env or the MCP client env.');
  }
  const api = new HttpEditorApi(url, token);
  const allowLiveRun = process.env.EDITOR_MCP_ALLOW_LIVE_RUN === 'true';

  // The read-tool list comes from the API; load it lazily and retry until it succeeds.
  let cached: McpTool[] | null = null;
  const tools = async () => {
    if (cached) return cached;
    const list = await buildEditorMcpTools(api, { allowLiveRun, log });
    if (list.some((t) => t.name === 'lint_post')) cached = list;
    return list;
  };

  const server = new McpServer({ name: 'ai0-editor', version: '1.0.0', tools, log });
  log(`serving on stdio → ${url}${allowLiveRun ? ' (live run_slot ALLOWED)' : ''}`);
  await server.attach(process.stdin, process.stdout);
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
