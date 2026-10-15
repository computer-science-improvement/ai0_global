/**
 * Spec 037 T17 on a throwaway Postgres with every migration applied: what a run read is stored with the slot
 * (`editor_slots.critic -> 'sources'`, the critic gate writes it), and the approval card and the post audit read it
 * back — `image_not_from_source` without reading the page again, for Telegram and for a native platform post.
 * Rerunnable: every row it creates is deleted before and after. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { approvalFindingsHook } from './approval-findings';
import { PostAuditService } from './post-audit.service';
import { CriticGate } from '../critic/critic-gate';
import type { EditorTool } from '../harness/tool';
import { makeSpec } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const KEY = '@pgt037t17_ch';
const IG = 'instagram:pgt037t17';
const PAGE = 'https://news.example/2026/10/14/steam-update';
const OG = 'https://news.example/img/og.jpg';
const ART = (n: number) => `https://news.example/img/article-${n}.jpg`;
const POSTER = 'https://prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/17-fine-tune-model.png';
const NEWS = { card: { timezone: 'Europe/Kyiv', style: { content_kind: 'news' } as any }, render: { linkStyle: 'inline' as const, footer: null } };
const AT = new Date('2026-10-14T12:00:00Z');
let pool: Pool;
let plan: string;

async function cleanup() {
  await pool.query(`DELETE FROM editor_post_audit WHERE resource_ref = ANY($1::text[])`, [[`telegram:${KEY}`, IG]]);
  await pool.query(`DELETE FROM editor_post_audit_runs WHERE resource_ref = ANY($1::text[])`, [[`telegram:${KEY}`, IG]]);
  await pool.query(`DELETE FROM platform_posts WHERE resource_ref = $1`, [IG]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [KEY]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [KEY]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [KEY]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'approve', '{"text":1}')`, [KEY]);
  plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, '2026-10-14') RETURNING id`, [KEY])).rows[0].id;
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

/** What the critic gate stores for a run that read PAGE (main image `image`, article images `images`). */
async function storedCritic(image: string | null, images: string[], spec: unknown): Promise<Record<string, unknown>> {
  const updates: any[] = [];
  const gate = new CriticGate(
    { critic: { review: async () => ({ ok: false as const, error: 'offline', runIds: [], costUsd: 0 }) }, plans: { updateSlot: async (_id: string, p: unknown) => { updates.push(p); return null as any; } } },
    { slotId: 's', channelKey: KEY, mode: 'approve', resourceRef: `telegram:${KEY}`, platform: 'telegram', voice: {} },
  );
  const [fetch] = gate.wrapTools([{ name: 'web_fetch', execute: async () => ({ url: PAGE, title: 'Steam update', text: 'Valve оновила гру.', image, images }) }] as unknown as EditorTool[]);
  await fetch.execute({ url: PAGE }, {} as any);
  await gate.check({ text: 'Valve оновила гру.', spec, format: 'photo', warnings: [] });
  return updates.at(-1).critic;
}

async function waitingSlot(o: { spec: unknown; critic: unknown; resourceRef?: string; format?: string }): Promise<string> {
  return (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, resource_ref, scheduled_at, format, topic, status, post_spec, critic)
     VALUES ($1, $2, $3, $4, $5, 'Новина', 'awaiting_approval', $6, $7) RETURNING id::text AS id`,
    [plan, KEY, o.resourceRef ?? null, AT, o.format ?? 'photo', JSON.stringify(o.spec), JSON.stringify(o.critic)])).rows[0].id;
}

const hook = () => approvalFindingsHook({ pool, cardOf: async () => NEWS });
const codesOf = (fs: Array<{ code: string }>) => fs.map((f) => f.code);

test('approval card: the stored source says the page had another image → image_not_from_source; an album from it passes', { skip }, async () => {
  const foreign = makeSpec({ hashtags: [], source: { url: PAGE, label: 'Steam' }, media: [{ url: 'https://images.unsplash.com/stock.jpg' }] });
  const critic = await storedCritic(OG, [OG, ART(1), ART(2)], foreign);
  assert.deepEqual((critic.sources as any[])[0], { url: PAGE, title: 'Steam update', image: OG, images: [OG, ART(1), ART(2)] }, 'the gate stored the read page');
  const id = await waitingSlot({ spec: foreign, critic });
  const findings = await hook()({ id, channelKey: KEY, resourceRef: `telegram:${KEY}`, scheduledAt: AT, timezone: 'Europe/Kyiv', postSpec: foreign, topic: 'Новина', topicMode: 'fixed' });
  const f = findings.find((x) => x.code === 'image_not_from_source');
  assert.ok(f, codesOf(findings).join(', '));
  assert.equal(f!.level, 'error');
  assert.match(f!.excerpt ?? '', /unsplash/);
  assert.ok(f!.title && f!.fix, 'the English catalogue text is on the card');

  const album = makeSpec({ format: 'album', hashtags: [], source: { url: PAGE, label: 'Steam' }, media: [{ url: OG }, { url: ART(1) }, { url: `${ART(2)}?w=1200` }] });
  const ok = await waitingSlot({ spec: album, critic: await storedCritic(OG, [OG, ART(1), ART(2)], album), format: 'album' });
  const albumFindings = await hook()({ id: ok, channelKey: KEY, resourceRef: `telegram:${KEY}`, scheduledAt: AT, timezone: 'Europe/Kyiv', postSpec: album, topic: 'Новина', topicMode: 'fixed' });
  assert.ok(!codesOf(albumFindings).includes('image_not_from_source'), codesOf(albumFindings).join(', '));
});

test('approval card: the stored source says the page had no image → image_not_from_source (news goes without media)', { skip }, async () => {
  const spec = makeSpec({ hashtags: [], source: { url: PAGE, label: 'Steam' }, media: [{ url: OG }] });
  const id = await waitingSlot({ spec, critic: await storedCritic(null, [], spec) });
  const findings = await hook()({ id, channelKey: KEY, resourceRef: `telegram:${KEY}`, scheduledAt: AT, timezone: 'Europe/Kyiv', postSpec: spec, topic: 'Новина', topicMode: 'fixed' });
  const f = findings.find((x) => x.code === 'image_not_from_source');
  assert.ok(f, codesOf(findings).join(', '));
  assert.match(f!.message, /немає зображення/);
});

test('Instagram: the approval card and the post audit see image_not_from_source / poster_mismatch from the slot\'s stored source', { skip }, async () => {
  const spec = {
    format: 'ig_carousel', title: 'Оновлення Steam', caption: 'Valve оновила гру.', hashtags: [], source: { url: PAGE }, media: [],
    slides: [{ title: 'Що нового', text: 'Новий режим.', image: ART(1) }, { title: 'Ще', text: 'Нова карта.', image: 'https://cdn.example/stock.jpg' }],
  };
  const critic = await storedCritic(OG, [OG, ART(1)], spec);
  const id = await waitingSlot({ spec, critic, resourceRef: IG, format: 'ig_carousel' });
  const card = await hook()({ id, channelKey: KEY, resourceRef: IG, scheduledAt: AT, timezone: 'Europe/Kyiv', postSpec: spec });
  assert.deepEqual(codesOf(card).filter((c) => c === 'image_not_from_source'), ['image_not_from_source'], codesOf(card).join(', '));

  // Published: the audit joins the platform post to its slot and reads the stored source.
  await pool.query(`UPDATE editor_slots SET status = 'published' WHERE id = $1`, [id]);
  await pool.query(
    `INSERT INTO platform_posts (resource_ref, platform, slot_id, format, spec, status, posted_at) VALUES ($1, 'instagram', $2, 'ig_carousel', $3, 'published', $4)`,
    [IG, id, JSON.stringify(spec), AT]);
  const poster = { format: 'ig_photo', title: 'Qwen-Image-2.1-Turbo', caption: 'Alibaba випустила модель.', hashtags: [], media: [{ url: POSTER, kind: 'image' }], source: { url: 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo' } };
  await pool.query(
    `INSERT INTO platform_posts (resource_ref, platform, format, spec, status, posted_at) VALUES ($1, 'instagram', 'ig_photo', $2, 'published', $3)`,
    [IG, JSON.stringify(poster), new Date(AT.getTime() + 3600_000)]);
  const audit = new PostAuditService({ pool, cardOf: async () => NEWS });
  await audit.auditResource(IG, new Date(AT.getTime() + 2 * 3600_000));
  const { rows } = await pool.query(`SELECT code, level, excerpt FROM editor_post_audit WHERE resource_ref = $1 ORDER BY code`, [IG]);
  assert.deepEqual(rows.map((r: any) => `${r.code}:${r.level}`), ['image_not_from_source:error', 'poster_mismatch:error']);
  assert.match(rows[0].excerpt, /stock\.jpg/);

  // Rerunnable: a second audit stores the same rows once.
  await audit.auditResource(IG, new Date(AT.getTime() + 2 * 3600_000));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM editor_post_audit WHERE resource_ref = $1`, [IG])).rows[0].n, 2);
});
