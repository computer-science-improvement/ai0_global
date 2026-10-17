/**
 * Spec 037 T14: the post audit's hooks — the approval card findings (sections, catalogue text, extra fields of a
 * check, platform posts, never throwing), the API's validation, the scheduler hook, the throttled tick and the
 * digest flags from the audit summary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { approvalAuditPost, approvalFindingsHook, toApprovalFindings } from './approval-findings';
import { PostAuditApi } from './post-audit.controller';
import { PostAuditService, type AuditSummary } from './post-audit.service';
import { EditorScheduler } from '../editor.scheduler';
import { assembleQuality, QUALITY_FLAGS, withAudit } from '../manager/quality-digest';
import { effectiveStyle } from '../post/style/resource-style';

const STYLE = effectiveStyle({ hashtags: 'off', address: 'vy' }, { kind: 'news' });

test('approval findings: sections in order (stories, facts, dates, lint), errors first, catalogue text, extra kept, duplicates once', () => {
  const list = toApprovalFindings([
    { code: 'slop_em_dash', level: 'warning', message: 'тире' },
    { code: 'stale_source', level: 'warning', message: 'старе джерело' },
    { code: 'number_not_in_sources', level: 'warning', message: 'число', excerpt: '90%' },
    { code: 'hashtag_while_off', level: 'error', message: 'хештеги' },
    { code: 'story_repeat', level: 'error', message: 'та сама історія', ...({ matches: [{ url: 'https://t.me/a/1', slot_id: 'x' }] } as object) },
    { code: 'slop_em_dash', level: 'warning', message: 'тире' },
  ]);
  assert.deepEqual(list.map((f) => [f.section, f.code]), [
    ['stories', 'story_repeat'], ['facts', 'number_not_in_sources'], ['dates', 'stale_source'], ['lint', 'hashtag_while_off'], ['lint', 'slop_em_dash'],
  ]);
  assert.deepEqual(list[0].extra, { matches: [{ url: 'https://t.me/a/1', slot_id: 'x' }] });
  assert.equal(list[0].title, 'Same story again');
  assert.equal(list[3].group, 'style_violation');
  assert.equal(list[1].excerpt, '90%');
});

test('approval findings hook: a waiting Telegram post is checked with the card style and the recent posts; forwards and bad specs give nothing', async () => {
  const card = { ...makeCard({ channelKey: '@news', timezone: 'Europe/Kyiv' }), style: STYLE };
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as any;
  const hook = approvalFindingsHook({ pool, cardOf: async () => ({ card, render: { linkStyle: 'inline', footer: null } }) });
  const spec = makeSpec({ hashtags: ['новини'] });
  const item = { id: '00000000-0000-0000-0000-000000000001', channelKey: '@news', resourceRef: 'telegram:@news', scheduledAt: new Date('2026-10-15T09:00:00Z'), timezone: 'Europe/Kyiv', postSpec: spec, topic: 'Тема', topicMode: 'fixed' };
  const findings = await hook(item);
  assert.ok(findings.some((f) => f.code === 'hashtag_while_off' && f.level === 'error' && f.fix.includes('hashtags')), JSON.stringify(findings.map((f) => f.code)));
  assert.ok(queries.some((q) => /FROM editor_slots/.test(q)), 'recent posts read');
  assert.deepEqual(await hook({ ...item, renderMessages: { kind: 'forward' } }), []);
  assert.deepEqual(await hook({ ...item, postSpec: { nope: true } }), []);
  const broken = approvalFindingsHook({ pool: { query: async () => { throw new Error('db down'); } } as any, cardOf: async () => { throw new Error('x'); } });
  assert.ok(Array.isArray(await broken(item)), 'never throws');
});

test('approval audit post: platform specs become platform posts, Telegram specs Telegram posts', () => {
  const base = { id: 's', channelKey: '@x', scheduledAt: new Date('2026-10-15T09:00:00Z'), timezone: 'Europe/Kyiv' };
  const tg = approvalAuditPost({ ...base, resourceRef: 'telegram:@x', postSpec: makeSpec() });
  assert.ok(tg && tg.text.length > 0 && tg.channel === 'telegram:@x');
  const ig = approvalAuditPost({ ...base, resourceRef: 'instagram:1', postSpec: { format: 'ig_photo', title: 'Title', caption: 'Hello', media: [{ url: 'https://x.test/a.jpg' }] } });
  assert.equal(ig?.text, 'Hello');
  assert.equal(approvalAuditPost({ ...base, resourceRef: 'instagram:1', postSpec: makeSpec() }), null);
});

test('API: refs and days are validated; run takes one resource or all', async () => {
  const calls: any[] = [];
  const api = new PostAuditApi({
    view: async (ref, now, days) => { calls.push(['view', ref, now.toISOString(), days]); return {} as any; },
    run: async (now, refs) => { calls.push(['run', refs ?? null]); return []; },
    activeRefs: async () => [],
  }, () => new Date('2026-10-15T00:00:00Z'));
  await api.view({ resource: 'telegram:@a' });
  await api.view({ resource: 'telegram:@a', days: '3' });
  await api.run({});
  await api.run({ resource: 'instagram:1' });
  assert.deepEqual(calls, [
    ['view', 'telegram:@a', '2026-10-15T00:00:00.000Z', 7], ['view', 'telegram:@a', '2026-10-15T00:00:00.000Z', 3], ['run', null], ['run', ['instagram:1']],
  ]);
  await assert.rejects(api.view({}), (e: any) => e.getResponse().error === 'invalid_ref');
  await assert.rejects(api.view({ resource: 'telegram:@a', days: '0' }), (e: any) => e.getResponse().error === 'invalid_days');
  await assert.rejects(api.run({ resource: 'bad' }), (e: any) => e.getResponse().error === 'invalid_ref');
});

test('tick: throttled, nothing due → no audit run', async () => {
  let reads = 0;
  const pool = { query: async () => { reads++; return { rows: [] }; } } as any;
  const s = new PostAuditService({ pool });
  const t0 = new Date('2026-10-15T00:00:00Z');
  assert.equal(await s.tick(t0), 0);
  const after = reads;
  assert.equal(await s.tick(new Date(t0.getTime() + 60_000)), 0);
  assert.equal(reads, after, 'within 10 min: not even a read');
  assert.equal(await s.tick(new Date(t0.getTime() + 11 * 60_000)), 0);
  assert.ok(reads > after);
});

test('scheduler: the post-audit hook runs every tick with the time; a failing hook is logged, the tick goes on', async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const card = { ...makeCard({ channelKey: '@birzha', mode: 'live' }), createdAt: new Date('2026-01-01T00:00:00Z') };
  const mk = (postAudit: (now: Date) => Promise<unknown>) => new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [card] },
    plans: {
      getActivePlan: async () => ({ rationale: 'plan' }) as any, claimDue: async () => { calls.push('claim'); return []; }, skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0,
    },
    runner: { runPlanner: async () => ({}) as any, runExecutor: async () => ({}) as any, runReviewer: async () => ({}) as any },
    enabled: () => true, notify: async () => {}, log: (m) => logs.push(m),
    postAudit,
  });
  await mk(async (now) => { calls.push(`audit ${now.toISOString()}`); }).tick(new Date('2026-10-15T10:00:00Z'));
  assert.deepEqual(calls, ['audit 2026-10-15T10:00:00.000Z', 'claim']);
  calls.length = 0;
  await mk(async () => { throw new Error('db'); }).tick(new Date('2026-10-15T10:00:00Z'));
  assert.deepEqual(calls, ['claim']);
  assert.ok(logs.some((l) => /post audit failed: db/.test(l)));
});

test('digest: audit groups with findings become quality flags; the summary rides on the block', () => {
  assert.ok(['story_repeat', 'fact_conflict', 'date_issue', 'text_hygiene', 'style_violation', 'dark_day'].every((f) => (QUALITY_FLAGS as readonly string[]).includes(f)));
  const q = assembleQuality({ critic: [], posts: [], owner: [], caps: { pollsPerWeek: null, questionsPerDay: 1 } as any });
  const audit: AuditSummary = { audited_at: '2026-10-15T00:00:00.000Z', posts: 9, findings: 4, groups: { date_issue: 1, style_violation: 3 }, codes: [{ code: 'hashtag_while_off', level: 'error', n: 3 }] };
  const out = withAudit(q, audit);
  assert.deepEqual(out.flags, ['date_issue', 'style_violation']);
  assert.equal(out.audit, audit);
  assert.deepEqual(out.signature.flags, ['date_issue', 'style_violation'], 'a new audit flag changes the digest hash');
  assert.equal(withAudit(q, undefined), q);
});
