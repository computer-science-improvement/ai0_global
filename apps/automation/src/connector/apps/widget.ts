import { createHash } from 'node:crypto';
import type { McpResource } from '../../editor/mcp/mcp-server';
import { RESOURCE_MIME_TYPE } from './apps';
import { loadAppSdk } from './sdk';
import { WIDGET_CLIENT } from './widget-client';

/**
 * Spec 104: the one MCP Apps view of the connector, `ui://ai0/preview-<hash>.html`: a post or draft as Telegram
 * shows it, the schedule, a channel's head and an agent chat. The page is static (no data in it): the host hands it
 * each tool result. The hash changes with the page and its CSP, so a host never keeps an old copy; any
 * `ui://ai0/preview…` still reads the current page.
 */

/** Image hosts the view may load by default (where the network's posts take media from). MCP_APP_IMAGE_HOSTS adds more. */
export const DEFAULT_IMAGE_HOSTS = [
  'cdn.prompthero.com', 'pbs.twimg.com', 'raw.githubusercontent.com', 'upload.wikimedia.org',
  'cdn.akamai.steamstatic.com', 'shared.akamai.steamstatic.com', 'cdn.cloudflare.steamstatic.com', 'shared.cloudflare.steamstatic.com',
  'cdn1.epicgames.com', 'store-site-backend-static.ak.epicgames.com', 'images.unsplash.com',
] as const;

const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Geist:wght@300..800&family=Geist+Mono:wght@400;500&display=swap';
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** `https://<host>` for every valid host (bare hosts, `*.host` wildcards), deduplicated, in order. */
export function imageOrigins(hosts: Iterable<string>, extraOrigins: Iterable<string | null | undefined> = []): string[] {
  const out = new Set<string>();
  for (const raw of extraOrigins) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:') out.add(u.origin);
    } catch { /* not a URL */ }
  }
  for (const h of hosts) {
    const host = h.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
    if (HOST_RE.test(host)) out.add(`https://${host}`);
  }
  return [...out];
}

/** The page's own CSP, under the host's (both apply): inline script only, no network, no frames, no forms. */
const PAGE_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", `style-src 'unsafe-inline' ${FONT_ORIGINS[0]}`, `font-src ${FONT_ORIGINS[1]}`,
  'img-src https: data:', "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'",
].join('; ');

export const WIDGET_CSS = `
:root{--bg:#0A0C0B;--ink:#EDEFEE;--muted:#A3ABA7;--dim:#828C87;--accent:#3DDC97;--on-accent:#03170D;--warn:#F2B24C;--bad:#F2727F;
--s1:rgba(255,255,255,.04);--s2:rgba(255,255,255,.06);--s3:rgba(255,255,255,.08);--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
--tg:#0e1621;--bubble:#182533;--tglink:#6ab3f3;--tgmeta:#6c7883;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.root{padding:12px;max-width:640px;margin:0 auto}
.card{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px}
.card.compact{background:var(--s2);border-radius:14px;padding:10px;gap:8px;margin-top:8px}
.head{display:flex;align-items:center;gap:10px}
.ava{width:34px;height:34px;flex:none;border-radius:50%;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font-weight:600;font-size:14px}
.compact .ava{width:28px;height:28px;font-size:12px}
.who{flex:1;min-width:0}
.name{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;background:var(--s3);color:var(--muted);font-size:11px;font-weight:500;white-space:nowrap}
.chip.good{background:rgba(61,220,151,.14);color:var(--accent)}
.chip.bad{background:rgba(242,114,127,.14);color:var(--bad)}
.chip.wait{background:rgba(242,178,76,.14);color:var(--warn)}
.chip.src{background:transparent;border:1px solid var(--line2);color:var(--ink)}
.title{font-weight:500}
.note{color:var(--muted);font-size:12px}
.dim{color:var(--dim)}
.brief{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;background:var(--s2);border-radius:12px;padding:10px 12px}
.k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.v{overflow-wrap:anywhere}
.tg{background:var(--tg);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:440px;display:flex;flex-direction:column;gap:4px}
.bubble{position:relative;background:var(--bubble);border-radius:12px 12px 12px 4px;padding:8px 10px 18px;overflow:hidden;color:#e9edf0}
.bubble.bare{padding:0}
.bubble.bare .time{background:rgba(0,0,0,.45);color:#fff;border-radius:8px;padding:0 6px}
.txt{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px}
.bubble .media,.bubble .album{margin:-8px -10px 8px}
.bubble.bare .media{margin:0}
.bubble .txt+.media{margin:8px -10px -10px}
.media img{display:block;width:100%;max-height:520px;object-fit:cover;background:#0b121a}
.album{display:grid;gap:2px;grid-template-columns:1fr 1fr}
.album.n1{grid-template-columns:1fr}
.album .cell img{display:block;width:100%;height:160px;object-fit:cover}
.ph{min-height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:#0b121a;color:var(--tgmeta);padding:16px;text-align:center}
.phl{font-weight:500}
.phh{font-size:11px}
.time{position:absolute;right:8px;bottom:3px;font-size:11px;color:var(--tgmeta)}
.lnk,.ent{color:var(--tglink);cursor:pointer}
.lnk:hover{text-decoration:underline}
.ent:not(.lnk){cursor:text}
b{font-weight:600}
.icode,pre{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.icode{background:rgba(255,255,255,.08);border-radius:4px;padding:0 3px}
.pre{background:rgba(0,0,0,.28);border-radius:8px;margin:6px 0;overflow:hidden;white-space:normal}
.prehead{display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(255,255,255,.04);font-size:11px;color:var(--tgmeta)}
.pre pre{margin:0;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere;color:#d7e3ee}
.copy{background:none;border:0;color:var(--tglink);font:inherit;cursor:pointer;padding:0}
.quote{margin:4px 0;padding:2px 0 2px 10px;border-left:3px solid var(--tglink);white-space:pre-wrap}
.spoiler{background:#3a4a5c;color:transparent;border-radius:4px;cursor:pointer}
.spoiler.shown{background:transparent;color:inherit;cursor:auto}
.spoiler:not(.shown) *{color:transparent!important}
.lp{border-left:3px solid var(--tglink);padding:2px 0 2px 8px;margin:6px 0;font-size:12px}
.lph{font-weight:600;color:var(--tglink)}
.lpu{color:var(--tgmeta);overflow-wrap:anywhere}
.kb{display:flex;flex-direction:column;gap:4px}
.kbrow{display:flex;gap:4px}
.kbbtn{flex:1;background:rgba(24,37,51,.85);color:#fff;border:0;border-radius:8px;padding:7px 8px;font:inherit;font-size:12.5px;cursor:pointer}
.pollq{font-weight:600;margin-bottom:2px}
.pollk{color:var(--tgmeta);font-size:12px;margin-bottom:6px}
.opt{display:flex;align-items:center;gap:8px;padding:5px 0}
.opt .dot{width:16px;height:16px;border-radius:50%;border:2px solid var(--tgmeta);flex:none}
.opt.right .dot{border-color:var(--accent);background:var(--accent)}
.pollx{margin-top:6px;color:var(--tgmeta);font-size:12px}
.box{background:var(--s2);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.box.bad{box-shadow:inset 3px 0 0 var(--bad)}
.box.warn{box-shadow:inset 3px 0 0 var(--warn)}
.boxh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
.boxt{overflow-wrap:anywhere;white-space:pre-wrap}
.issues{margin:0;padding-left:18px}
.issues li{margin:2px 0;overflow-wrap:anywhere}
.actions{display:flex;gap:8px}
.btn{height:32px;padding:0 14px;border-radius:10px;border:0;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}
.btn.small{height:26px;padding:0 10px;font-size:12px;background:var(--s3);color:var(--ink)}
.btn:disabled,.kbbtn:disabled{opacity:.5;cursor:default}
.rows{display:flex;flex-direction:column}
.day{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:10px 0 4px}
.row{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
.day+.row{border-top:0}
.rtime{font-family:"Geist Mono",ui-monospace,monospace;color:var(--muted);width:42px;flex:none}
.rmain{flex:1;min-width:0}
.rtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsub{color:var(--dim);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rside{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.stats{display:flex;gap:8px;flex-wrap:wrap}
.stat{background:var(--s2);border-radius:12px;padding:8px 12px;min-width:110px}
.stat .v{font-size:16px;font-weight:600}
.sect{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.amsg{border-top:1px solid var(--line);padding-top:10px}
.amh{color:var(--dim);font-size:11.5px;margin-bottom:4px}
.amt{white-space:pre-wrap;overflow-wrap:anywhere}
.acard{background:var(--s2);border-radius:12px;padding:8px 10px;margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.acard .boxt{flex-basis:100%;color:var(--muted)}
.acardh{font-weight:500}
.empty{padding:18px;text-align:center;color:var(--muted);background:var(--s1);border:1px solid var(--line);border-radius:16px}
.foot{color:var(--dim);font-size:11px;text-align:center;padding:8px 0 0}
`;

/** The view's page: CSS, the inlined SDK and the view script, nothing fetched but fonts and the post's images. */
export function buildWidgetHtml(sdk: string = loadAppSdk()): string {
  const script = `${sdk}\n${WIDGET_CLIENT}`;
  if (/<\/script/i.test(script) || script.includes('<!--')) throw new Error('view script cannot be inlined');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<title>ai0 preview</title>',
    `<link rel="stylesheet" href="${FONTS_CSS}">`,
    `<style>${WIDGET_CSS}</style>`,
    '</head>',
    '<body>',
    '<main id="root" class="root"><div class="empty">Waiting for the result…</div></main>',
    `<script type="module">${script}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

let page: string | null = null;
/** The page, built once per process. */
export function widgetHtml(): string {
  page ??= buildWidgetHtml();
  return page;
}

export const VIEW_URI_PREFIX = 'ui://ai0/preview';
const VIEW_URI_RE = /^ui:\/\/ai0\/preview(-[0-9a-f]{1,64})?\.html$/;

export interface WidgetResourceOptions {
  /** CSP origins images may load from (imageOrigins). */
  imageOrigins: string[];
  html?: string;
}

/** The view as an MCP resource: its URI (with the hash), the list entry and the read result carry the same `_meta.ui`. */
export function widgetResource(o: WidgetResourceOptions): McpResource {
  const html = o.html ?? widgetHtml();
  const ui = {
    csp: { resourceDomains: [...FONT_ORIGINS, ...o.imageOrigins] },
    permissions: { clipboardWrite: {} },
    prefersBorder: false,
  };
  const hash = createHash('sha256').update(html).update('\0').update(JSON.stringify(ui)).digest('hex').slice(0, 12);
  const meta = { ui };
  return {
    uri: `${VIEW_URI_PREFIX}-${hash}.html`,
    name: 'ai0-preview',
    title: 'ai0 preview',
    description: 'Read-only view of a post or draft as Telegram shows it, the schedule, a channel and an agent chat.',
    mimeType: RESOURCE_MIME_TYPE,
    _meta: meta,
    matches: (uri) => VIEW_URI_RE.test(uri),
    read: async () => ({ text: html, _meta: meta }),
  };
}
