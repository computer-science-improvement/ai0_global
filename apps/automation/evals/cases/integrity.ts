import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { CaseCtx, EvalCase } from '../lib/case';
import { FakeWeb } from '../lib/fake-web';
import { check, isUkrainian } from '../lib/graders';
import { createCard } from '../lib/seed';
import { resetAgents } from './agents';
import { lintPost } from '../../src/editor/post/lint-post';
import { isSlopWarning } from '../../src/editor/post/slop-lint';
import { PostSpecSchema, type PostSpec } from '../../src/editor/post/post-spec';
import { bodyText, type AuditPost } from '../../src/editor/post/integrity/types';
import type { CriticRequest } from '../../src/editor/critic/critic.service';
import type { StoredCritic } from '../../src/editor/critic/critic';
import type { EditorCard } from '../../src/editor/card';

// Spec 037 FR-001 (T1): critic cases from the DEV-channel logs (07–14.10.2026) in the spec 034 T9 format. Real LLM,
// scratch DB, no web, nothing sent anywhere. Written, not run: see evals/README.md for the command and the cost.
//
// Each case gives the critic one published post from the golden fixture with the context the epic says it lacks:
// the publish time in the resource zone, the resource style (address «ви», hashtags off) and the earlier posts of
// the same story (or the companion post of a poll). Until T2/T5/T8/T12 add their own request fields, that context
// travels in `profile` (rendered under «Профіль ресурсу»); those tasks move it, the expected verdicts stay.
// Problem posts expect `revise` or `reject`; clean posts (hashtag line dropped, as the style now requires) `pass`.

const KYIV = 'Europe/Kyiv';
const NEWS = '@eval_int_news';
const TECH = '@eval_int_tech';
const GAMES = '@eval_int_games';
const KEYS = [NEWS, TECH, GAMES];

/** The golden fixture (63 posts of the three DEV channels). */
export const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../../src/editor/post/testing/channel-logs-2026-10.json'), 'utf8')) as { posts: AuditPost[] };
export const fixturePost = (id: string): AuditPost => {
  const p = FIXTURE.posts.find((x) => x.id === id);
  if (!p) throw new Error(`no fixture post ${id}`);
  return p;
};

const CARDS: Record<string, { title: string; brief: string; kind: 'news' | 'general'; fixtureChannel: string }> = {
  [NEWS]:  { title: 'AI Шукає Новини', brief: 'Новини технологій і ШІ для широкої аудиторії: що сталося і що це означає для читача, з джерелом.', kind: 'news', fixtureChannel: 'AI Шукає Новини | DEV' },
  [TECH]:  { title: 'AI Технології', brief: 'ШІ простими словами для звичайних людей: нові моделі й інструменти, пояснення термінів, практичні поради.', kind: 'general', fixtureChannel: 'AI Технології' },
  [GAMES]: { title: 'Біржа Ігор', brief: 'Ігри: роздачі, знижки, релізи й новини для гравців, з точними датами й цінами.', kind: 'general', fixtureChannel: 'Біржа Ігор | DEV' },
};

async function resetIntegrity(pool: Pool, keys: string[]): Promise<void> {
  await resetAgents(pool, keys);
  const refs = keys.map((k) => `telegram:${k}`);
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = ANY($1::text[])`, [refs]).catch(() => {});
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = ANY($1::text[])`, [keys]);
}

/** Leave the scratch DB as found (called once by the runner after all cases). */
export async function cleanupIntegrityEvals(pool: Pool): Promise<void> {
  await resetIntegrity(pool, KEYS);
}

async function integrityCard(ctx: CaseCtx, key: string): Promise<EditorCard> {
  const c = CARDS[key];
  await resetIntegrity(ctx.pool, [key]);
  await createCard(ctx.pool, {
    channelKey: key, title: c.title, brief: c.brief, formats: { text: 1, photo: 0.8, album: 0.3, poll: 0.2, quiz: 0.2 },
    hashtags: [], hashtagMin: 0, hashtagMax: 0,
  });
  await ctx.stack.profiles.patchFormat(`telegram:${key}`, { humor: 'none', slang: false, content_kind: c.kind }, { by: 'owner' });
  return (await ctx.stack.channels.get(key))!;
}

// ── fixture post → what the critic sees ────────────────────────────────────

const TRAILER = /^(?:→\s.*|(?:#[\p{L}\p{N}_]+\s*)+)$/u;

/** The reader text under the new style: the hashtag line dropped, the rendered `→ Source` line kept. */
export function styledText(p: AuditPost): string {
  return p.text.split('\n').filter((l) => !/^(?:#[\p{L}\p{N}_]+\s*)+$/u.test(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A PostSpec of a published post (lead + paragraphs + bullet lists, the source, the poll) for the critic request. */
export function specOf(p: AuditPost): PostSpec {
  const paras = bodyText(p).split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x && !TRAILER.test(x));
  const body = paras.map((para, i) => {
    const lines = para.split('\n');
    if (lines.every((l) => l.startsWith('• '))) return { type: 'list', items: lines.map((l) => l.slice(2).slice(0, 300)) };
    if (i === 0 && p.lead && para === p.lead) return { type: 'lead', text: para.slice(0, 400) };
    return { type: 'p', text: para.slice(0, 1500) };
  }).slice(0, 20);
  const label = p.text.split('\n').find((l) => l.startsWith('→ '))?.slice(2).trim();
  return PostSpecSchema.parse({
    format: p.poll ? (p.poll.kind === 'quiz' ? 'quiz' : 'poll') : p.media?.count && p.media.count > 1 ? 'album' : p.media ? 'photo' : 'text',
    title: (p.lead ?? p.poll?.question ?? p.text).slice(0, 110) || 'Пост',
    origin: p.sourceUrl ? 'external' : 'original',
    body,
    media: [],
    hashtags: [],
    ...(p.sourceUrl ? { source: { url: p.sourceUrl, ...(label ? { label: label.slice(0, 60) } : {}) } } : {}),
    ...(p.poll ? { poll: { question: p.poll.question, options: p.poll.options, anonymous: p.poll.anonymous } } : {}),
  });
}

/** «середа, 08.10.2026 20:00 (Europe/Kyiv)» — the publish time as T5 will state it. */
export function publishLine(iso: string, timezone = KYIV): string {
  const d = new Date(iso);
  const wd = new Intl.DateTimeFormat('uk-UA', { timeZone: timezone, weekday: 'long' }).format(d);
  const dt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(d).replace(',', '').replace(/\//g, '.');
  return `${wd}, ${dt} (${timezone})`;
}

/** What the reader reads of a post (text, or the poll as question + options). */
const readerOf = (p: AuditPost) => [styledText(p), p.poll ? `Опитування: ${p.poll.question}\n${p.poll.options.map((o) => `- ${o}`).join('\n')}` : ''].filter(Boolean).join('\n\n');

export interface IntegrityCase {
  id: string;
  key: string;
  /** Fixture post the critic reviews. */
  post: string;
  /** Earlier posts of the same story (fixture ids, oldest first). */
  story?: string[];
  /** The post published in the same minute (poll intro / poll). */
  companion?: string;
  expect: 'pass' | 'not_pass';
  /** What the notes should name (a soft check). */
  names?: RegExp;
  why: string;
}

/** The context block the critic does not get yet (publish time, style, story posts, companion). */
export function integrityContext(c: IntegrityCase): string {
  const p = fixturePost(c.post);
  const s = ['### Контекст публікації', `Публікація: ${publishLine(p.publishedAt)}.`, 'Стиль ресурсу: звертання до читача на «ви»; хештегів немає.'];
  if (c.story?.length) {
    s.push('', 'Попередні пости цієї історії в каналі (від старішого):');
    for (const id of c.story) {
      const x = fixturePost(id);
      s.push(`- ${publishLine(x.publishedAt)}:`, readerOf(x).split('\n').map((l) => `  ${l}`).join('\n'));
    }
  }
  if (c.companion) {
    const x = fixturePost(c.companion);
    s.push('', `Супровідний пост, опублікований тієї ж хвилини (${publishLine(x.publishedAt)}):`, readerOf(x));
  }
  return s.join('\n');
}

export function integrityRequest(card: EditorCard, c: IntegrityCase): CriticRequest {
  const p = fixturePost(c.post);
  const spec = specOf(p);
  const lint = lintPost(spec, { ...card, hashtagMin: 0, hashtagMax: 0 });
  return {
    channelKey: card.channelKey, slotId: null, mode: 'shadow',
    card: { models: card.models, dailyBudgetUsd: card.dailyBudgetUsd, mode: card.mode },
    resourceRef: `telegram:${card.channelKey}`, platform: 'telegram', format: spec.format,
    topic: spec.title, angle: null,
    text: readerOf(p), spec, voice: { humor: card.humor, slang: card.slang, emoji: card.emojiPref, readerQuestionsMax: card.readerQuestionsMax },
    brief: card.brief, profile: integrityContext(c),
    source: p.sourceUrl ? { url: p.sourceUrl, excerpt: null } : null,
    slopWarnings: lint.warnings.filter((w) => isSlopWarning(w.code)).map((w) => ({ code: w.code, message: w.message })),
  };
}

const N = 'ai-shukaie-novyny-dev';
const T = 'ai-tekhnolohii';
const G = 'birzha-ihor-dev';

/** The cases: problem posts of the epic (spec 037 Why) and clean posts that must still pass. */
export const INTEGRITY_CRITIC_CASES: IntegrityCase[] = [
  { id: 'critic-037-date-tomorrow-mismatch', key: NEWS, post: `${N}:1120`, expect: 'not_pass', names: /завтра|11|12\s*жовт|дат/iu,
    why: '«Реліз очікується вже завтра, 12 жовтня» in a post of Saturday 10.10 (tomorrow is 11.10; the source caption is a US date).' },
  { id: 'critic-037-apple-fourth-announcement', key: NEWS, post: `${N}:1126`, story: [`${N}:1105`, `${N}:1119`, `${N}:1125`], expect: 'not_pass', names: /повтор|вже|анонс|нового/iu,
    why: 'Fourth announcement of the 13.10 Apple event without a new fact.' },
  { id: 'critic-037-replacement-char', key: NEWS, post: `${N}:1124`, expect: 'not_pass', names: /�|символ|переважно|пе.*важно|бит|зіпсов/iu,
    why: '«пе��еважно»: U+FFFD in the published text.' },
  { id: 'critic-037-knowledge-poll-revealed', key: NEWS, post: `${N}:1110`, companion: `${N}:1109`, expect: 'not_pass', names: /вікторин|quiz|відповід|LibreOffice/iu,
    why: 'Knowledge question as a regular poll; the answer (LibreOffice) is in the same-minute post.' },
  { id: 'critic-037-mistral-just-now-repeat', key: TECH, post: `${T}:1027`, story: [`${T}:1023`], expect: 'not_pass', names: /щойно|повтор|вже|вчора|07/iu,
    why: '«Mistral щойно показала Le Chonk» the day after the channel covered it, with no new fact.' },
  { id: 'critic-037-qwen-after-digest', key: TECH, post: `${T}:1042`, story: [`${T}:1034`], expect: 'not_pass', names: /повтор|вже|дайджест|нового/iu,
    why: 'Qwen-Image-2.1-Turbo two days after the digest that covered it, same facts (8 steps, 7B, 2K).' },
  { id: 'critic-037-netflix-fun-facts', key: TECH, post: `${T}:1047`, expect: 'not_pass', names: /джерел|80|факт|перевір/iu,
    why: '«Понад 80% контенту … Netflix» from a «20 fun facts» page.' },
  { id: 'critic-037-steam-repeat', key: GAMES, post: `${G}:849`, story: [`${G}:848`], expect: 'not_pass', names: /повтор|ті самі|вже|годин/iu,
    why: 'The same Steam deals 1 h 43 min after the first post.' },
  { id: 'critic-037-giveaway-expired', key: GAMES, post: `${G}:850`, expect: 'not_pass', names: /8 жовт|закінч|минул|вже|термін/iu,
    why: 'A giveaway «до 8 жовтня» published on 08.10 at 20:00 Kyiv.' },
  { id: 'critic-037-out-of-sight-conflict', key: GAMES, post: `${G}:858`, story: [`${G}:852`], expect: 'not_pass', names: /хлопч|дівч|Софі|суперечн/iu,
    why: '«сліпа дівчинка Софі» after «сліпий хлопчик» the day before (the new game TerraScape makes it an allowed follow-up otherwise).' },
  { id: 'critic-037-process-leak-third-post', key: GAMES, post: `${G}:862`, story: [`${G}:852`, `${G}:858`], expect: 'not_pass', names: /промокод|не знайшл|повтор|вже|ти|граєш/iu,
    why: 'Third post of the same giveaway, «промокодів … не знайшлось, тому в пості лише перевірені роздачі», «граєш».' },
  { id: 'critic-037-address-ty', key: GAMES, post: `${G}:851`, expect: 'not_pass', names: /ти|ви|звертан|висаджуєш/iu,
    why: '«Висаджуєшся», «виконуєш», «збираєш» on a resource that addresses readers with «ви».' },
  // Clean posts: hashtag line dropped (the style has no hashtags); nothing else wrong.
  { id: 'critic-037-clean-apple-lg', key: NEWS, post: `${N}:1105`, expect: 'pass', why: 'First post of the Apple hub story, dated, sourced.' },
  { id: 'critic-037-clean-windbg', key: NEWS, post: `${N}:1117`, expect: 'pass', why: 'WinDbg MCP news, plain and sourced.' },
  { id: 'critic-037-clean-cerebras', key: NEWS, post: `${N}:1130`, expect: 'pass', why: 'Cerebras CEO interview, quotes attributed, weekday correct (13.10 = Tuesday).' },
  { id: 'critic-037-clean-templates', key: TECH, post: `${T}:1041`, expect: 'pass', why: 'Five prompt templates for beginners (original content).' },
];

const scoresOf = (c: StoredCritic | null) => (c?.scores ? Object.entries(c.scores).map(([k, v]) => `${k} ${v}`).join(', ') : '-');

function toEvalCase(c: IntegrityCase): EvalCase {
  return {
    id: c.id, role: 'checker', channel: c.key,
    title: `Критик (037): ${c.expect === 'pass' ? 'чистий пост → pass' : 'проблемний пост → revise/reject'}: ${c.why}`,
    web: () => new FakeWeb({}),
    async execute(ctx) {
      const card = await integrityCard(ctx, c.key);
      if (!ctx.stack.critic) return { runId: null, status: 'disabled', checks: [check('critic enabled (EDITOR_CRITIC is not off)', false)] };
      const res = await ctx.stack.critic.review(integrityRequest(card, c));
      const v = res.ok ? res.critic : null;
      const checks = [check('critic answered', res.ok, res.ok ? undefined : res.error)];
      if (c.expect === 'pass') {
        checks.push(check('clean post: pass', v?.verdict === 'pass', `${v?.verdict} (${v?.reason}): ${v?.notes ?? ''}`));
      } else {
        checks.push(check('problem post: revise or reject', v?.verdict === 'revise' || v?.verdict === 'reject', `${v?.verdict} (${v?.reason})`));
        if (c.names) checks.push(check('notes name the problem', !!v && c.names.test(v.notes), v?.notes ?? '', true));
      }
      checks.push(check('notes in Ukrainian', !v?.notes || isUkrainian(v.notes), undefined, true));
      return {
        runId: v?.run_id ?? null, status: res.ok ? 'ok' : 'critic_error',
        post: `${c.post} → ${v?.verdict ?? (res.ok ? '' : res.error)} (${scoresOf(v)}): ${v?.notes ?? ''}`,
        checks,
      };
    },
  };
}

export const INTEGRITY_CASES: EvalCase[] = INTEGRITY_CRITIC_CASES.map(toEvalCase);
