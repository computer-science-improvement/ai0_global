import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REASONS, reasonLink, reasonOfToken, reasonView } from './reasons';

// Spec 073 FR-014 (A28, A29, I12): the dashboard's mirror of the server's reason catalogue, and the links of its entries.

const SERVER = fileURLToPath(new URL('../../../automation/src/editor/reasons/catalogue.ts', import.meta.url));
const VARS = { channel: '@ai_tech', agent: 'sky', dataset: 'prompts' };

interface ServerEntry { code: string; kind: string; en: string; uk: string; fix?: { en: string; uk: string }; link?: string }

/** The `REASONS` array literal of the server file, evaluated (it is a plain literal on purpose). */
function serverReasons(): ServerEntry[] {
  const src = readFileSync(SERVER, 'utf8');
  const m = /export const REASONS: ReasonEntry\[\] = (\[[\s\S]*?\n\]);/.exec(src);
  assert.ok(m, 'REASONS not found in reasons/catalogue.ts: did it move?');
  return new Function(`return ${m[1]}`)() as ServerEntry[];
}

test('the mirror is the server catalogue: the same codes in the same order, with the same label, fix and link', { skip: !existsSync(SERVER) && 'backend source not in this checkout' }, () => {
  const server = serverReasons();
  assert.ok(server.length > 50, 'the server catalogue has its entries');
  const expected = server.map((e) => ({ code: e.code, en: e.en, ...(e.fix ? { fix: { en: e.fix.en } } : {}), ...(e.link ? { link: e.link } : {}) }));
  assert.deepEqual(REASONS, expected);
});

test('the mirror has unique codes and an English label for each', () => {
  assert.equal(new Set(REASONS.map((e) => e.code)).size, REASONS.length);
  for (const e of REASONS) assert.ok(e.en.trim(), e.code);
  assert.equal(reasonView('no_fresh_item')!.en, 'Nothing fresh in the sources');
  assert.equal(reasonView('nope'), undefined);
  assert.equal(reasonView(null), undefined);
});

test('reasonOfToken reads the leading <code> or <code>: and nothing else', () => {
  assert.equal(reasonOfToken('lint_failed: caption_too_long')!.code, 'lint_failed');
  assert.equal(reasonOfToken('mode_changed')!.code, 'mode_changed');
  assert.equal(reasonOfToken('  planner_skipped: x')!.code, 'planner_skipped');
  // The server's legacy-text mapping is not ported.
  assert.equal(reasonOfToken('retry after max_steps'), undefined);
  assert.equal(reasonOfToken('stale-source'), undefined);
  assert.equal(reasonOfToken(''), undefined);
  assert.equal(reasonOfToken(null), undefined);
});

test('reasonLink: one typed route for each template', () => {
  assert.deepEqual(reasonLink({ link: '/app/editor/:channel' }, VARS), { to: '/app/editor/$channel', params: { channel: '@ai_tech' } });
  assert.deepEqual(reasonLink({ link: '/app/agents/:agent' }, VARS), { to: '/app/agents/$handle', params: { handle: 'sky' } });
  assert.deepEqual(reasonLink({ link: '/app/agents/:agent?tab=schedule' }, VARS), { to: '/app/agents/$handle', params: { handle: 'sky' }, search: { tab: 'schedule' } });
  assert.deepEqual(reasonLink({ link: '/app/data/:dataset' }, VARS), { to: '/app/data/$key', params: { key: 'prompts' } });
  assert.deepEqual(reasonLink({ link: '/app/data/:dataset?tab=schema' }, VARS), { to: '/app/data/$key', params: { key: 'prompts' }, search: { tab: 'schema' } });
  assert.deepEqual(reasonLink({ link: '/app/agents/inbox?tab=approvals' }, {}), { to: '/app/agents/inbox', search: { tab: 'approvals' } });
});

test('reasonLink: an unknown ?tab= falls back to the bare route; an unknown template, a missing link or an unfilled placeholder is null', () => {
  assert.deepEqual(reasonLink({ link: '/app/agents/:agent?tab=nope' }, VARS), { to: '/app/agents/$handle', params: { handle: 'sky' } });
  assert.deepEqual(reasonLink({ link: '/app/data/:dataset?tab=nope' }, VARS), { to: '/app/data/$key', params: { key: 'prompts' } });
  assert.deepEqual(reasonLink({ link: '/app/agents/inbox?tab=nope' }, VARS), { to: '/app/agents/inbox' });
  assert.equal(reasonLink({ link: '/app/spend' }, VARS), null);
  assert.equal(reasonLink({ link: '/app/editor/:series' }, VARS), null);
  assert.equal(reasonLink({ link: 'https://example.com' }, VARS), null);
  assert.equal(reasonLink({}, VARS), null);
  assert.equal(reasonLink(null, VARS), null);
  assert.equal(reasonLink(undefined, VARS), null);
  assert.equal(reasonLink({ link: '/app/editor/:channel' }, { agent: 'sky' }), null);
  assert.equal(reasonLink({ link: '/app/agents/:agent?tab=schedule' }, { channel: '@x' }), null);
  assert.equal(reasonLink({ link: '/app/data/:dataset' }, { channel: '@x', agent: 'sky' }), null);
});

test('every link in the catalogue resolves to a route when its placeholders are filled (I12)', () => {
  const linked = REASONS.filter((e) => e.link);
  assert.ok(linked.length > 20, 'the catalogue has its links');
  for (const e of linked) assert.notEqual(reasonLink(e, VARS), null, `${e.code}: ${e.link}`);
  // A tab named in a link is a tab the page really has, so the link keeps its search rather than falling back.
  for (const e of linked.filter((x) => x.link!.includes('?tab='))) assert.ok('search' in reasonLink(e, VARS)!, `${e.code}: ${e.link} falls back to the bare route`);
});
