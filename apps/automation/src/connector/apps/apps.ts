import type { EditorCard } from '../../editor/card';
import type { RenderedDraft } from '../../editor/chat/drafts.service';
import type { SlotDetail } from '../queries/connector-queries';
import { clip, isUuid } from '../tools/common';
import type { ConnectorTool } from '../types';
import {
  channelView, chatView, draftIdsOf, postViewOfCheck, postViewOfDraft, postViewOfSlot, scheduleView, viewContent, type AnyView, type PostView,
} from './views';

/**
 * Spec 104 — MCP Apps (the `io.modelcontextprotocol/ui` extension, SDK @modelcontextprotocol/ext-apps) for the
 * Claude connector. Tools that show a post, a draft, a schedule or an agent chat name the one `ui://` view in
 * `_meta.ui.resourceUri`; a host that supports MCP Apps renders that view with the call's `structuredContent`, and
 * every other client reads the text result, which stays exactly as it was.
 *
 * Read and preview only: every connector tool is `visibility: ["model"]`, so a host refuses a tools/call that comes
 * from a view (the view itself never calls a tool, sends a message or changes the model's context).
 */

/** The MCP Apps resource MIME type (`RESOURCE_MIME_TYPE` of the SDK; a test checks they match). */
export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
/** The extension id a host advertises in its capabilities (`EXTENSION_ID` of the SDK). */
export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
/** The deprecated flat key the SDK's registerAppTool still writes next to `ui.resourceUri` for older hosts. */
export const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri';

/** What the view hooks read; the factory wires the editor's repositories, tests pass fakes. */
export interface ViewPorts {
  card(channelKey: string): Promise<EditorCard | null>;
  slotDetail(id: string): Promise<SlotDetail | null>;
  /** A draft with its Telegram render (DraftsService.get + withRender); absent → drafts are not drawn. */
  draft?(id: string): Promise<RenderedDraft | null>;
}

type ViewFn = (p: ViewPorts, args: Record<string, unknown>, result: unknown) => Promise<AnyView | null>;

const field = (result: unknown, k: string): string | null => {
  const v = result && typeof result === 'object' ? (result as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' && v ? v : null;
};

async function postById(p: ViewPorts, id: string | null): Promise<PostView | null> {
  if (!id || !isUuid(id)) return null;
  const detail = await p.slotDetail(id);
  if (!detail) return null;
  return postViewOfSlot(detail, await p.card(detail.slot.channelKey).catch(() => null));
}

async function draftById(p: ViewPorts, id: string | null): Promise<PostView | null> {
  if (!id || !isUuid(id) || !p.draft) return null;
  const d = await p.draft(id);
  if (!d) return null;
  return postViewOfDraft(d, await p.card(d.channelKey).catch(() => null));
}

const slotView: ViewFn = (p, _a, r) => postById(p, field(r, 'post_id'));

const chat: ViewFn = async (p, _a, r) => {
  const drafts = new Map<string, PostView>();
  for (const id of draftIdsOf(r)) {
    const v = await draftById(p, id).catch(() => null);
    if (v) drafts.set(id, v);
  }
  return chatView(r, drafts);
};

/** The tools with a view, and how each builds it from its arguments and result. */
export const TOOL_VIEWS: Readonly<Partial<Record<string, ViewFn>>> = {
  get_post:     slotView,
  prepare_post: slotView,
  update_post:  slotView,
  plan_post:    slotView,
  get_draft:    (p, _a, r) => draftById(p, field(r, 'draft_id')),
  check_post:   async (p, a, r) => {
    const key = field(r, 'channel');
    const card = key ? await p.card(key) : null;
    return card ? postViewOfCheck(card, a.post, r as Record<string, unknown>) : null;
  },
  list_schedule: async (_p, a, r) => scheduleView(r, typeof a.channel === 'string' && a.channel.trim() ? clip(a.channel.trim(), 80) : null),
  get_channel:   async (_p, _a, r) => channelView(r),
  talk_to_agent:   chat,
  read_agent_chat: chat,
};

/**
 * Every tool gets `_meta.ui.visibility: ["model"]` (no view can call it); the tools in TOOL_VIEWS also name the view
 * (`ui.resourceUri`, plus the legacy flat key) and build its structuredContent after a successful call.
 */
export function withApps(tools: ConnectorTool[], ports: ViewPorts, resourceUri: string): ConnectorTool[] {
  return tools.map((t) => {
    const build = Object.prototype.hasOwnProperty.call(TOOL_VIEWS, t.name) ? TOOL_VIEWS[t.name] : undefined;
    const ui = build ? { resourceUri, visibility: ['model'] } : { visibility: ['model'] };
    return {
      ...t,
      _meta: { ...(t._meta ?? {}), ui, ...(build ? { [LEGACY_RESOURCE_URI_KEY]: resourceUri } : {}) },
      ...(build ? {
        view: async (args: Record<string, unknown>, result: unknown) => {
          const v = await build!(ports, args, result);
          return v ? viewContent(v) : null;
        },
      } : {}),
    };
  });
}
