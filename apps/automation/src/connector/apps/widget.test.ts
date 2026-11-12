import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '../../editor/mcp/mcp-server';
import { RESOURCE_MIME_TYPE } from './apps';
import { SDK_GLOBAL, appSdkVersion, inlineSdk, loadAppSdk } from './sdk';
import { WIDGET_CLIENT } from './widget-client';
import { DEFAULT_IMAGE_HOSTS, VIEW_URI_PREFIX, buildWidgetHtml, imageOrigins, widgetHtml, widgetResource } from './widget';

test('spec 104: the SDK is the pinned version and inlines as a plain script with a local McpApps object', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
  const pinned = pkg.dependencies['@modelcontextprotocol/ext-apps'];
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'pinned to an exact version');
  assert.equal(appSdkVersion(), pinned, 'the installed SDK is the pinned one');
  const sdk = loadAppSdk();
  assert.ok(sdk.includes(`const ${SDK_GLOBAL}={`));
  assert.match(sdk, /App:[A-Za-z_$][\w$]*/);
  assert.ok(!/\bexport\s*\{/.test(sdk.slice(-2000)), 'no export left');
  assert.equal(inlineSdk('var a=1;export{a as App,b as PostMessageTransport};'), 'var a=1;\nconst McpApps={App:a,PostMessageTransport:b};\n');
});

test('inlineSdk refuses a bundle that would break out of <script> or is not self-contained', () => {
  assert.throws(() => inlineSdk('var a="</script>";export{a as App};'), /cannot be inlined/);
  assert.throws(() => inlineSdk('var a="<!--";export{a as App};'), /cannot be inlined/);
  assert.throws(() => inlineSdk('import x from "y";export{x as App};'), /self-contained/);
  assert.throws(() => inlineSdk('var a=import.meta.url;export{a as App};'), /self-contained/);
  assert.throws(() => inlineSdk('var a=1;'), /no trailing export/);
  assert.throws(() => inlineSdk('var a=1;export{a as Other};'), /no App export/);
  assert.throws(() => inlineSdk('var a=1;export{a-1 as App};'), /odd export/);
});

test('the view script is read and preview only: no HTML injection, no tool calls, no messages to the chat, no network', () => {
  for (const banned of [
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'createContextualFragment', 'srcdoc',
    'callServerTool', 'sendMessage', 'updateModelContext', 'sendLog', 'requestDisplayMode', 'downloadFile',
    'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'eval(', 'new Function', 'setTimeout("', 'location.', 'window.open', 'postMessage(',
  ]) {
    assert.ok(!WIDGET_CLIENT.includes(banned), `the view script must not use ${banned}`);
  }
  assert.ok(WIDGET_CLIENT.includes('app.openLink('), 'links open through the host');
  assert.ok(!WIDGET_CLIENT.includes('`') && !WIDGET_CLIENT.includes('${'), 'plain JS: no template literals in the view');
  // Every link the view opens passes safeUrl (http/https) first.
  assert.match(WIDGET_CLIENT, /function openUrl\(u\) \{\s*var url = safeUrl\(u\);\s*if \(!url\) return;/);
});

test('the page: one inline module script, strict page CSP, fonts and English text; no external script', () => {
  const html = buildWidgetHtml();
  assert.equal(html, widgetHtml(), 'built once, same page');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.match(html, /<script type="module">/);
  assert.ok(!/<script[^>]+src=/.test(html), 'no external script');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  for (const d of ["default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'"]) {
    assert.ok(csp.includes(d), `page CSP has ${d}`);
  }
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Geist/);
  assert.match(html, /--bg:#0A0C0B/);
  assert.match(html, /--accent:#3DDC97/);
  assert.ok(html.length < 1_000_000, `page is ${html.length} chars`);
  assert.throws(() => buildWidgetHtml('var x="</script>";const McpApps={};'), /cannot be inlined/);
});

test('image origins: defaults, extra hosts, wildcards, the site; nothing that is not an https host', () => {
  assert.deepEqual(imageOrigins(['cdn.example.com', '*.imgix.net', 'https://x.test/', 'javascript:alert(1)', 'a b.test', 'localhost', ''], ['https://dev.ai0.global/api/mcp', 'http://plain.test', 'nope', null]),
    ['https://dev.ai0.global', 'https://cdn.example.com', 'https://*.imgix.net', 'https://x.test']);
  assert.ok(imageOrigins(DEFAULT_IMAGE_HOSTS).includes('https://cdn.prompthero.com'));
});

test('the resource: MCP Apps MIME type, CSP and border in both the list entry and the read result; the URI hash follows page and CSP', async () => {
  const a = widgetResource({ imageOrigins: ['https://cdn.prompthero.com'], html: '<p>a</p>' });
  const b = widgetResource({ imageOrigins: ['https://cdn.prompthero.com', 'https://x.test'], html: '<p>a</p>' });
  const c = widgetResource({ imageOrigins: ['https://cdn.prompthero.com'], html: '<p>b</p>' });
  assert.equal(a.mimeType, RESOURCE_MIME_TYPE);
  assert.match(a.uri, /^ui:\/\/ai0\/preview-[0-9a-f]{12}\.html$/);
  assert.notEqual(a.uri, b.uri, 'the CSP is part of the hash');
  assert.notEqual(a.uri, c.uri, 'the page is part of the hash');
  assert.equal(a.uri, widgetResource({ imageOrigins: ['https://cdn.prompthero.com'], html: '<p>a</p>' }).uri, 'stable');
  const ui = (a._meta as any).ui;
  assert.deepEqual(ui.csp, { resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.prompthero.com'] });
  assert.equal(ui.prefersBorder, false);
  assert.equal(ui.domain, undefined, 'no ui.domain: the host picks its sandbox origin');
  assert.equal(ui.csp.connectDomains, undefined, 'the view reaches no network');
  assert.equal(ui.csp.frameDomains, undefined, 'and embeds no frames');
  const read = await a.read();
  assert.equal(read.text, '<p>a</p>');
  assert.deepEqual(read._meta, a._meta);
  assert.equal(a.matches!(`${VIEW_URI_PREFIX}-0123456789ab.html`), true, 'an older hash still reads the current page');
  assert.equal(a.matches!(`${VIEW_URI_PREFIX}.html`), true);
  assert.equal(a.matches!('ui://ai0/other.html'), false);
  assert.equal(a.matches!('ui://ai0/preview-../../etc.html'), false);
});

test('registered on the server: resources/list and resources/read carry the page and its _meta; unknown URIs are -32002', async () => {
  const res = widgetResource({ imageOrigins: [], html: '<p>v</p>' });
  const s = new McpServer({ name: 'ai0', version: '1', tools: async () => [], resources: async () => [res] });
  const init: any = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false }, resources: { listChanged: false } });
  const list: any = await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  assert.deepEqual(list.result.resources, [{ uri: res.uri, name: 'ai0-preview', title: 'ai0 preview', description: res.description, mimeType: RESOURCE_MIME_TYPE, _meta: res._meta }]);
  const read: any = await s.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: res.uri } });
  assert.deepEqual(read.result, { contents: [{ uri: res.uri, mimeType: RESOURCE_MIME_TYPE, text: '<p>v</p>', _meta: res._meta }] });
  const old: any = await s.handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'ui://ai0/preview-000000000000.html' } });
  assert.equal(old.result.contents[0].uri, 'ui://ai0/preview-000000000000.html', 'answered under the URI asked for');
  const missing: any = await s.handle({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ui://ai0/nope.html' } });
  assert.equal(missing.error.code, -32002);
  const noUri: any = await s.handle({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: {} });
  assert.equal(noUri.error.code, -32602);
  const templates: any = await s.handle({ jsonrpc: '2.0', id: 7, method: 'resources/templates/list' });
  assert.deepEqual(templates.result, { resourceTemplates: [] });
});
