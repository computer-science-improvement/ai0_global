import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { EditorPlansRepository, EditorSlot } from '../../src/editor/repo/editor-plans.repository';
import { localDate, zonedToUtc } from '../../src/editor/roles/time';

export const EVAL_SOURCE = 'eval-fixture';

/** Remove everything an eval case may have created for this channel (scratch DB only). */
export async function resetChannel(pool: Pool, key: string): Promise<void> {
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [key]);
  await pool.query(`DELETE FROM channel_stats_snapshots WHERE channel_id = $1`, [key]);
}

export async function resetLibrary(pool: Pool): Promise<void> {
  for (const t of ['recipes', 'pdr_questions', 'facts']) {
    await pool.query(`DELETE FROM ${t} WHERE source_name = $1`, [EVAL_SOURCE]);
  }
}

export interface CardSeed {
  channelKey: string; mode?: 'shadow' | 'live'; title: string; brief: string;
  formats: Record<string, number>; hashtags: string[]; hashtagMin?: number; hashtagMax?: number;
  postsPerDayMin?: number; postsPerDayMax?: number; minGapMinutes?: number; quietStartHour?: number; quietEndHour?: number;
  linkStyle?: 'inline' | 'footer' | 'button'; emojiPolicy?: 'none' | 'sparse' | 'free';
  sources?: unknown[]; bannedTerms?: string[]; createdDaysAgo?: number; exploreRatio?: number;
}

export async function createCard(pool: Pool, c: CardSeed): Promise<void> {
  await pool.query(
    `INSERT INTO editor_channels (channel_key, mode, title, brief, formats, hashtags, hashtag_min, hashtag_max,
       posts_per_day_min, posts_per_day_max, min_gap_minutes, quiet_start_hour, quiet_end_hour, link_style, emoji_policy,
       sources, banned_terms, explore_ratio, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now() - ($19 || ' days')::interval)`,
    [c.channelKey, c.mode ?? 'shadow', c.title, c.brief, JSON.stringify(c.formats), c.hashtags, c.hashtagMin ?? 1, c.hashtagMax ?? 3,
      c.postsPerDayMin ?? 2, c.postsPerDayMax ?? 5, c.minGapMinutes ?? 60, c.quietStartHour ?? 23, c.quietEndHour ?? 8,
      c.linkStyle ?? 'inline', c.emojiPolicy ?? 'sparse', JSON.stringify(c.sources ?? []), c.bannedTerms ?? [], c.exploreRatio ?? 0.2,
      String(c.createdDaysAgo ?? 30)]);
}

export interface PostSeed {
  daysAgo: number; hour: number; format: string; title: string; views: number; forwards?: number; reactions?: number; tags?: string[];
}

/** Historical posts with one stats snapshot taken 24 h after posting (→ views_per_hour = views / 24). */
export async function seedPosts(pool: Pool, key: string, posts: PostSeed[], now: Date): Promise<void> {
  let msg = 1000;
  for (const p of posts) {
    const day = new Date(now.getTime() - p.daysAgo * 86_400_000);
    const postedAt = zonedToUtc(localDate(day, 'Europe/Kyiv'), `${String(p.hour).padStart(2, '0')}:00`, 'Europe/Kyiv');
    const { rows } = await pool.query(
      `INSERT INTO published_posts (channel_id, message_id, title, strategy_type, tags, format, posted_at)
       VALUES ($1, $2, $3, 'editor', $4, $5, $6) RETURNING id`,
      [key, msg++, p.title, p.tags ?? [], p.format, postedAt]);
    await pool.query(
      `INSERT INTO post_stats_snapshots (post_id, captured_at, views, forwards, reactions_total) VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].id, new Date(postedAt.getTime() + 24 * 3600_000), p.views, p.forwards ?? 0, p.reactions ?? 0]);
  }
}

export async function seedSubscribers(pool: Pool, key: string, points: Array<{ daysAgo: number; subscribers: number }>, now: Date): Promise<void> {
  for (const p of points) {
    await pool.query(`INSERT INTO channel_stats_snapshots (channel_id, captured_at, subscribers) VALUES ($1, $2, $3)`,
      [key, new Date(now.getTime() - p.daysAgo * 86_400_000), p.subscribers]);
  }
}

/** A plan with one slot already claimed (status running) — exactly what the scheduler hands the executor. */
export async function runningSlot(pool: Pool, key: string, now: Date, s: { format: string; topic: string; angle?: string; hints?: string[]; experiment?: boolean }): Promise<EditorSlot> {
  const plans = new EditorPlansRepository(pool);
  const planId = await plans.createPlan(key, localDate(now, 'Europe/Kyiv'), 'eval plan', null, [{
    scheduledAt: new Date(now.getTime() - 60_000), format: s.format, topic: s.topic, angle: s.angle ?? null,
    sourceHints: s.hints ?? [], isExperiment: !!s.experiment,
  }]);
  const [slot] = await plans.listSlots(key, planId);
  await pool.query(`UPDATE editor_slots SET status = 'running', attempts = 1 WHERE id = $1`, [slot.id]);
  return (await plans.getSlot(slot.id))!;
}

/** A previously shadowed post — what check_similarity and the publish guard compare against. */
export async function shadowedPost(pool: Pool, key: string, now: Date, preview: string, sourceUrl?: string): Promise<void> {
  const plans = new EditorPlansRepository(pool);
  const planId = await plans.createPlan(key, localDate(new Date(now.getTime() - 86_400_000), 'Europe/Kyiv'), 'yesterday', null, [{
    scheduledAt: new Date(now.getTime() - 86_400_000), format: 'photo', topic: 'вчорашній пост', angle: null, sourceHints: [], isExperiment: false,
  }]);
  const [slot] = await plans.listSlots(key, planId);
  await plans.updateSlot(slot.id, { status: 'shadowed', renderedPreview: preview, postSpec: sourceUrl ? { source: { url: sourceUrl } } : {} });
}

export async function seedPdr(pool: Pool, rows: Array<{ text: string; answers: string[]; correct: number; explanation: string }>): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    const { rows: out } = await pool.query(
      `INSERT INTO pdr_questions (question_id, ticket_number, question_num, text, answers, correct_answer_num, explanation, source_name)
       VALUES ($1, 99, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [900000 + Math.floor(Math.random() * 99999), i + 1, r.text, JSON.stringify(r.answers), r.correct, r.explanation, EVAL_SOURCE]);
    ids.push(out[0].id);
  }
  return ids;
}

export async function seedRecipe(pool: Pool, r: { title: string; description: string; ingredients: string; instructions: string; image: string; url: string }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO recipes (title, slug, url, description, ingredients, instructions, image_url, tags, title_uk, ingredients_uk, instructions_uk, source_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $1, $5, $6, $8) RETURNING id`,
    [r.title, `eval-${randomUUID()}`, r.url, r.description, r.ingredients, r.instructions, r.image, EVAL_SOURCE]);
  return rows[0].id;
}
