/**
 * Spec 037 T14 on a throwaway Postgres with every migration applied: the T1 golden posts (three DEV channels,
 * 07–14.10) loaded as published slots with their publications, the post audit run over them, and the expected flags
 * stored in `editor_post_audit` — per post exactly the labelled codes the registered checks implement, t.me links,
 * idempotent reruns, recompute after a rule change, the grouped view, the digest flags and the daily due logic.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostAuditService } from './post-audit.service';
import { PostAuditApi } from './post-audit.controller';
import { expectedNow, goldenCard, goldenStory, loadGolden, specOfGoldenPost } from './testing/golden-specs';
import { SqlQuality } from '../manager/quality-digest';
import { approvalFindingsHook } from './approval-findings';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const golden = loadGolden();
const CHANNELS = [...new Set(golden.posts.map((p) => p.channel))];
/** Golden channel title → a test channel key (public, so the t.me link is derivable). */
const KEY: Record<string, string> = Object.fromEntries(CHANNELS.map((c, i) => [c, `@pgt037t14_ch${i}`]));
const REF = (c: string) => `telegram:${KEY[c]}`;
const CHANNEL_OF = new Map(CHANNELS.map((c) => [REF(c), c]));
/** Just after the last golden post (14.10 14:00:57 +02:00): all 63 posts are in the 7-day window (the first is 07.10 14:02:41). */
const NOW = new Date('2026-10-14T12:01:00Z');
const SLOT = new Map<string, string>();   // golden id → slot id
let pool: Pool;

const service = () => new PostAuditService({
  pool,
  cardOf: async (ref) => {
    const ch = CHANNEL_OF.get(ref);
    return ch ? { card: goldenCard(golden, ch), render: { linkStyle: 'inline', footer: null } } : null;
  },
});

async function cleanup() {
  const keys = Object.values(KEY);
  const refs = keys.map((k) => `telegram:${k}`);
  await pool.query(`DELETE FROM editor_post_audit WHERE resource_ref = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM editor_post_audit_runs WHERE resource_ref = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = ANY($1::text[])`, [keys]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  for (const ch of CHANNELS) {
    const key = KEY[ch];
    await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"text":1}')`, [key]);
    const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, '2026-10-14') RETURNING id`, [key])).rows[0].id;
    for (const p of golden.posts.filter((x) => x.channel === ch)) {
      // The writer declares a reminder / follow-up against the original's slot id (inserted earlier: posts are in time order).
      const spec = specOfGoldenPost(p, goldenStory(golden, p.id, (g) => SLOT.get(g)));
      const slot = (await pool.query(
        `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec)
         VALUES ($1, $2, $3, $4, $5, 'published', $6) RETURNING id::text AS id`,
        [plan, key, new Date(p.publishedAt), spec.format, spec.title, JSON.stringify(spec)])).rows[0].id;
      SLOT.set(p.id, slot);
      const messageId = p.messageIds?.[0] ?? Number(p.id.split(':')[1]);
      const pub = (await pool.query(
        `INSERT INTO published_posts (channel_id, message_id, title, strategy_type, posted_at, editor_slot_id) VALUES ($1, $2, $3, 'editor', $4, $5) RETURNING id`,
        [key, messageId, spec.title, new Date(p.publishedAt), slot])).rows[0].id;
      await pool.query(`UPDATE editor_slots SET published_post_id = $2 WHERE id = $1`, [slot, pub]);
    }
  }
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

/** Stored codes per golden id. */
async function stored(): Promise<Map<string, string[]>> {
  const { rows } = await pool.query(
    `SELECT post_id, array_agg(DISTINCT code ORDER BY code) AS codes FROM editor_post_audit WHERE resource_ref = ANY($1::text[]) GROUP BY post_id`,
    [CHANNELS.map(REF)]);
  const bySlot = new Map<string, string[]>(rows.map((r: any) => [r.post_id, r.codes]));
  return new Map(golden.posts.map((p) => [p.id, bySlot.get(SLOT.get(p.id)!) ?? []]));
}

test('golden posts as published slots: the audit stores exactly the labelled codes of the posts in the 7-day window', { skip }, async () => {
  const audit = service();
  assert.deepEqual((await audit.activeRefs(NOW)).filter((r) => CHANNEL_OF.has(r)), CHANNELS.map(REF).sort());
  const results = await audit.run(NOW, CHANNELS.map(REF));
  assert.ok(results.every((r) => !r.error), JSON.stringify(results));
  const from = NOW.getTime() - 7 * 86_400_000;
  const inWindow = golden.posts.filter((p) => Date.parse(p.publishedAt) >= from);
  assert.equal(results.reduce((s, r) => s + r.posts, 0), inWindow.length);
  assert.equal(inWindow.length, 63);
  const got = await stored();
  const diffs: string[] = [];
  for (const p of golden.posts) {
    const want = Date.parse(p.publishedAt) >= from ? expectedNow(golden, p.id) : [];
    if (JSON.stringify(got.get(p.id)) !== JSON.stringify(want)) diffs.push(`${p.id}: stored [${got.get(p.id)}] want [${want}]`);
  }
  assert.deepEqual(diffs, []);
  // Spot checks from the epic: hashtags in a news channel, a long lead, the US date «already tomorrow, 12 October».
  const all = [...got.values()].flat();
  for (const code of ['hashtags_disabled', 'lead_too_long', 'date_relative_mismatch', 'address_mixed']) assert.ok(all.includes(code), code);
});

test('rows carry the post: publish time, t.me link, excerpt, catalogue text in the grouped view', { skip }, async () => {
  const p = golden.posts.find((x) => x.id === 'ai-shukaie-novyny-dev:1105')!;
  const { rows } = await pool.query(`SELECT * FROM editor_post_audit WHERE slot_id = $1 ORDER BY code`, [SLOT.get(p.id)]);
  assert.ok(rows.length > 0);
  assert.equal(rows[0].post_url, `https://t.me/${KEY[p.channel].slice(1)}/1105`);
  assert.equal(rows[0].message_id, '1105');
  assert.equal(new Date(rows[0].published_at).toISOString(), new Date(p.publishedAt).toISOString());
  assert.equal(rows[0].post_excerpt, p.lead);
  assert.ok(rows.every((r: any) => r.rules_hash === service().hash));

  const api = new PostAuditApi(service(), () => NOW);
  const view = await api.view({ resource: REF(p.channel) });
  assert.equal(view.current, true);
  const hashtags = view.groups.find((g) => g.code === 'hashtags_disabled')!;
  assert.equal(hashtags.title, 'Hashtags are off');
  assert.match(hashtags.fix, /Remove the hashtags/);
  assert.equal(hashtags.group, 'style_violation');
  assert.ok(hashtags.count >= hashtags.posts && hashtags.items.length <= 10);
  assert.ok(hashtags.items.every((i) => i.url?.startsWith('https://t.me/')));
  assert.equal(view.groups[0].level, 'error', 'errors first');
  await assert.rejects(api.view({ resource: 'nope' }), /invalid_ref|Bad Request/);
  await assert.rejects(api.view({ resource: REF(p.channel), days: '99' }), /invalid_days|Bad Request/);
});

test('idempotent rerun; a finding the rules no longer give is deleted; a new rule recomputes at once', { skip }, async () => {
  const count = async () => Number((await pool.query(`SELECT count(*) FROM editor_post_audit WHERE resource_ref = ANY($1::text[])`, [CHANNELS.map(REF)])).rows[0].count);
  const ids = async () => (await pool.query(`SELECT id FROM editor_post_audit WHERE resource_ref = ANY($1::text[]) ORDER BY id`, [CHANNELS.map(REF)])).rows.map((r: any) => r.id);
  const before = await count();
  const idsBefore = await ids();
  const later = new Date(NOW.getTime() + 60_000);
  await service().run(later, CHANNELS.map(REF));
  assert.equal(await count(), before, 'same findings, same rows');
  assert.deepEqual(await ids(), idsBefore, 'upserted in place');

  // Not due within a day with the same rules; due after a day; due at once with another rule set.
  const audit = service();
  assert.deepEqual((await audit.dueRefs(new Date(later.getTime() + 3600_000))).filter((r) => CHANNEL_OF.has(r)), []);
  assert.deepEqual((await audit.dueRefs(new Date(later.getTime() + 25 * 3600_000))).filter((r) => CHANNEL_OF.has(r)), CHANNELS.map(REF).sort());
  await pool.query(`UPDATE editor_post_audit_runs SET rules_hash = 'old' WHERE resource_ref = $1`, [REF(CHANNELS[0])]);
  assert.deepEqual((await audit.dueRefs(new Date(later.getTime() + 3600_000))).filter((r) => CHANNEL_OF.has(r)), [REF(CHANNELS[0])]);

  // A post edited so it no longer has hashtags: its hashtags_disabled row goes, the rest stays.
  const edited = golden.posts.filter((p) => p.channel === CHANNELS[0] && p.hashtags.length).at(-1)!;
  const spec = { ...specOfGoldenPost(edited), hashtags: [] };
  await pool.query(`UPDATE editor_slots SET post_spec = $2 WHERE id = $1`, [SLOT.get(edited.id), JSON.stringify(spec)]);
  const n = await audit.tick(new Date(later.getTime() + 2 * 3600_000));
  assert.equal(n, 1, 'only the resource with the old rules hash');
  const after = await stored();
  assert.ok(!after.get(edited.id)!.includes('hashtags_disabled'));
  assert.deepEqual(after.get(edited.id), expectedNow(golden, edited.id).filter((c) => c !== 'hashtags_disabled'));
});

test('MANAGER digest: the audit flags and the summary on the quality block', { skip }, async () => {
  const ref = REF(CHANNELS[2]);
  const q = (await new SqlQuality(pool).digest([ref], NOW)).get(ref)!;
  assert.ok(q.audit, 'audit summary');
  assert.ok((q.audit!.groups.style_violation ?? 0) > 0);
  assert.ok(q.flags.includes('style_violation'));
  assert.ok(q.audit!.codes.length > 0 && q.audit!.codes.length <= 8);
  assert.ok(q.audit!.posts > 0);
});

test('approval card: a waiting post gets its findings against the real slots (history read, catalogue text)', { skip }, async () => {
  const ch = CHANNELS[2];
  const src = golden.posts.filter((p) => p.channel === ch && p.hashtags.length).at(-1)!;
  const spec = specOfGoldenPost(src);
  const plan = (await pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 LIMIT 1`, [KEY[ch]])).rows[0].id;
  const id = (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec) VALUES ($1, $2, $3, $4, 'Wait', 'awaiting_approval', $5) RETURNING id::text AS id`,
    [plan, KEY[ch], new Date(NOW.getTime() + 3600_000), spec.format, JSON.stringify(spec)])).rows[0].id;
  const hook = approvalFindingsHook({ pool, cardOf: async () => ({ card: goldenCard(golden, ch), render: { linkStyle: 'inline', footer: null } }) });
  const findings = await hook({ id, channelKey: KEY[ch], resourceRef: REF(ch), scheduledAt: new Date(NOW.getTime() + 3600_000), timezone: 'Europe/Kyiv', postSpec: spec, topic: 'Wait', topicMode: 'fixed' });
  const codes = new Set(findings.map((f) => f.code));
  // The same text as the published original: its labelled codes (history-free ones) are on the card.
  const want = expectedNow(golden, src.id).filter((c) => !c.startsWith('monotony_'));
  assert.ok(want.includes('hashtags_disabled'));
  assert.deepEqual(want.filter((c) => !codes.has(c)), [], [...codes].join(', '));
  assert.ok(findings.every((f) => f.title && f.fix && f.section));
  await pool.query(`DELETE FROM editor_slots WHERE id = $1`, [id]);
});
