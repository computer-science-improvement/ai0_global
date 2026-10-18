import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../net/extract-page';
import { buildReadTools } from './read-tools';
import { buildPlatformTools } from '../platform/platform-tools';
import { buildDirectiveTools } from '../manager/directive-tools';
import { SkillLibrary } from '../skills/skill-library';

/** Spec 053 FR-003: tool results the model re-reads on every later step are smaller by default. */

test('web_fetch keeps 6k characters of a page; fetch_feed and get_network_posts default to fewer rows', () => {
  const html = `<html><body><article>${Array.from({ length: 400 }, (_, i) => `<p>Абзац ${i}: ${'слово '.repeat(10)}</p>`).join('')}</article></body></html>`;
  const page = extractPage(html, 'https://news.example/a');
  assert.ok(page.text.length <= 6_001, String(page.text.length));

  const read = buildReadTools({ pool: {} as any, readonly: {} as any, skills: new SkillLibrary('/nonexistent') });
  const feed = read.find((t) => t.name === 'fetch_feed')!;
  assert.equal((feed.input.parse({ url: 'https://news.example/rss' }) as any).limit, 6);
  const skill = read.find((t) => t.name === 'load_skill')!;
  assert.equal(skill.maxResultChars, 12_000, 'a skill is read whole, within a bound');

  const posts = buildPlatformTools({ pool: { query: async () => ({ rows: [] }) } as any, publish: {} as any, plans: {} as any }).find((t) => t.name === 'get_network_posts')!;
  assert.equal((posts.input.parse({}) as any).limit, 15);
});

test('list_directives: compact rows by default (body clipped, no rationale / verification); full rows by ids', async () => {
  const dir = {
    id: '00000000-0000-4000-8000-000000000001', kind: 'task', binding: 'directive', status: 'accepted', body: 'Б'.repeat(600), rationale: 'Р'.repeat(800),
    expected: { metric: 'views_per_post', direction: 'up', min_change_pct: 10 }, outcome: null, resolution: 'план', verification: { adherence: 0.8, detail: 'x'.repeat(900) },
    createdAt: new Date('2026-10-17T08:00:00Z'), toAgentId: 'o1', shadow: false,
  };
  const tools = buildDirectiveTools({ repo: { list: async () => [dir], get: async (id: string) => (id === dir.id ? dir : null) } } as any);
  const t = tools.find((x) => x.name === 'list_directives')!;
  const ctx = { role: 'manager', extras: {} } as any;
  const list: any = await t.execute(t.input.parse({}), ctx);
  const row = list.directives[0];
  assert.equal(row.body.length, 240);
  assert.equal(row.rationale, undefined);
  assert.equal(row.verification, undefined);
  assert.equal(row.adherence, 0.8);
  assert.equal((t.input.parse({}) as any).limit, 10);
  const full: any = await t.execute(t.input.parse({ ids: [dir.id] }), ctx);
  assert.equal(full.directives[0].rationale.length, 800);
  assert.equal(full.directives[0].verification.detail.length, 900);
  // An orchestrator sees only its own directives, by ids too.
  const other: any = await t.execute(t.input.parse({ ids: [dir.id] }), { role: 'orchestrator', extras: { orchestrator: { id: 'o2' } } } as any);
  assert.deepEqual(other.directives, []);
});
