import { EvalCase, runExecutor } from '../lib/case';
import { FakeWeb, article, rss } from '../lib/fake-web';
import { createCard } from '../lib/seed';
import { bannedHits, check, isUkrainian, specText, ungroundedNumbers } from '../lib/graders';
import { lintPost } from '../../src/editor/post/lint-post';
import type { PostSpec } from '../../src/editor/post/post-spec';
import type { TgMessage } from '../../src/editor/post/render-telegram';

/**
 * Spec 033 T4: does the executor use Telegram rich blocks where they help
 * (a comparison → table) and leave them out where they hurt (short news),
 * and does format_prefs.rich = never keep the post plain HTML? Live mode
 * with the fake Telegram, so the sent calls are checked. Written, not run
 * (paid): `--case executor-rich-comparison,executor-rich-short-news,executor-rich-never`.
 */

const TECH = '@eval_tech';
const TECH_BRIEF = 'Техніка без води: огляди й порівняння смартфонів і гаджетів для звичайних покупців, українською.';
const TECH_SOURCES = [{ id: 'tech_rss', kind: 'rss', ref: 'https://tech.example/rss' }];

const COMPARE = {
  link: 'https://tech.example/reviews/midrange-2026',
  image: 'https://tech.example/img/midrange.jpg',
  title: 'Midrange showdown: Galaxy A57 vs Pixel 10a vs Nothing Phone (4a)',
  text: [
    'We tested three midrange phones for two weeks: the Samsung Galaxy A57, the Google Pixel 10a and the Nothing Phone (4a).',
    'Prices: the Galaxy A57 costs 17,999 UAH, the Pixel 10a 21,499 UAH and the Nothing Phone (4a) 15,999 UAH.',
    'Battery: the Galaxy A57 has 5,000 mAh, the Pixel 10a 4,600 mAh and the Nothing Phone (4a) 5,100 mAh.',
    'Screen: the Galaxy A57 has a 6.7-inch 120 Hz panel, the Pixel 10a a 6.1-inch 120 Hz panel, and the Nothing Phone (4a) a 6.6-inch 120 Hz panel.',
    'Updates: Samsung promises 6 years of Android updates, Google 7 years and Nothing 4 years.',
    'Our pick for most people is the Pixel 10a for its camera and long support; the Nothing Phone (4a) is the best value.',
  ],
};

const NEWS = {
  link: 'https://tech.example/news/pixel-update-delay',
  image: 'https://tech.example/img/pixel-update.jpg',
  title: 'Google delays the October Pixel update by one week',
  text: [
    'Google has delayed the October security update for Pixel phones by one week because of a Bluetooth bug found in testing.',
    'The update will now arrive on October 14 for all supported Pixel models.',
  ],
};

function techWeb(): FakeWeb {
  return new FakeWeb({
    'https://tech.example/rss': rss('Tech Example', [
      { title: COMPARE.title, link: COMPARE.link, description: COMPARE.text[0] },
      { title: NEWS.title, link: NEWS.link, description: NEWS.text[0] },
    ]),
    [COMPARE.link]: article({ title: COMPARE.title, image: COMPARE.image, paragraphs: COMPARE.text }),
    [NEWS.link]: article({ title: NEWS.title, image: NEWS.image, paragraphs: NEWS.text }),
  });
}

const techCard = () => ({
  channelKey: TECH, mode: 'live' as const, title: 'Техніка без води', brief: TECH_BRIEF,
  formats: { text: 1, photo: 0.8 }, hashtags: ['смартфони', 'огляд', 'новини'], hashtagMin: 1, hashtagMax: 2,
  sources: TECH_SOURCES,
});

const tables = (spec: PostSpec | null) => (spec?.body ?? []).filter((b): b is Extract<PostSpec['body'][number], { type: 'table' }> => b.type === 'table');
const headings = (spec: PostSpec | null) => (spec?.body ?? []).filter((b) => b.type === 'heading').length;
/** Methods of the calls this case sent (the fake Telegram log is shared by the run). */
const methods = (sent: Array<{ channelKey: string; messages: TgMessage[] }>, from: number) =>
  sent.slice(from).filter((s) => s.channelKey === TECH).flatMap((s) => s.messages.map((m) => m.method));

async function setRichPref(ctx: { pool: import('pg').Pool }, pref: 'auto' | 'prefer' | 'never' | null): Promise<void> {
  await ctx.pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [`telegram:${TECH}`]);
  if (pref) await ctx.pool.query(`INSERT INTO resource_profiles (resource_ref, profile) VALUES ($1, $2)`, [`telegram:${TECH}`, { format_prefs: { rich: pref } }]);
}

/** R1 — a three-phone comparison becomes a rich post with a table (format_prefs.rich = auto). */
export const executorRichComparison: EvalCase = {
  id: 'executor-rich-comparison', role: 'executor', channel: TECH,
  title: 'Порівняння трьох смартфонів → таблиця в rich-повідомленні (live, фейковий Telegram)',
  web: techWeb,
  async execute(ctx) {
    await createCard(ctx.pool, techCard());
    await setRichPref(ctx, 'auto');
    const from = ctx.stack.sent.length;
    const r = await runExecutor(ctx, TECH, {
      format: 'text', topic: 'Порівняння трьох смартфонів середнього класу: ціна, батарея, екран, оновлення', hints: ['tech_rss'],
    });
    const spec = r.spec;
    const text = spec ? specText(spec) : '';
    const t = tables(spec)[0];
    const sent = methods(ctx.stack.sent, from);
    const card = r.card;
    const lint = spec ? lintPost(spec, card) : null;
    return {
      runId: r.res.runId, status: r.res.status, terminalTool: r.res.terminalTool, post: r.post, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('published (publish_post ok)', r.res.terminalTool === 'publish_post' && r.after.status === 'published', `slot=${r.after.status}`),
        check('uses a table', !!t, spec?.body.map((b) => b.type).join(',')),
        check('table compares the 3 phones (≥ 3 rows, 2–6 columns)', !!t && t.rows.length >= 3 && t.header.length >= 2 && t.header.length <= 6, t ? `${t.rows.length}×${t.header.length}` : '-'),
        check('sent as sendRichMessage', sent.includes('sendRichMessage'), sent.join(',')),
        check('Ukrainian', isUkrainian(text)),
        check('no banned phrases', bannedHits(text).length === 0, bannedHits(text).join(', ')),
        check('numbers grounded in source', ungroundedNumbers(text, COMPARE.text.join('\n')).length === 0, ungroundedNumbers(text, COMPARE.text.join('\n')).join(', ')),
        check('no rich lint warnings', !lint?.warnings.some((w) => ['table_in_short_post', 'too_many_headings'].includes(w.code)), lint?.warnings.map((w) => w.code).join(',') ?? '-', true),
        check('≤ 2 headings', headings(spec) <= 2, String(headings(spec)), true),
        check('loaded format-rich-telegram', r.steps.some((s) => s.tool_name === 'load_skill' && JSON.stringify(s.output ?? '').includes('format-rich-telegram')), r.toolsUsed.join(' → '), true),
      ],
      judge: spec ? { channelBrief: TECH_BRIEF, slotTopic: 'Порівняння трьох смартфонів', sourceText: COMPARE.text.join('\n'), post: r.post } : undefined,
    };
  },
};

/** R2 — a two-sentence news item stays a short plain post: no table, no headings. */
export const executorRichShortNews: EvalCase = {
  id: 'executor-rich-short-news', role: 'executor', channel: TECH,
  title: 'Коротка новина → без таблиць і підзаголовків',
  web: techWeb,
  async execute(ctx) {
    await createCard(ctx.pool, techCard());
    await setRichPref(ctx, 'auto');
    const from = ctx.stack.sent.length;
    const r = await runExecutor(ctx, TECH, { format: 'text', topic: 'Коротко: Google переніс жовтневе оновлення Pixel', hints: ['tech_rss'] });
    const spec = r.spec;
    const text = spec ? specText(spec) : '';
    return {
      runId: r.res.runId, status: r.res.status, terminalTool: r.res.terminalTool, post: r.post, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('published (publish_post ok)', r.res.terminalTool === 'publish_post' && r.after.status === 'published', `slot=${r.after.status}`),
        check('no table', tables(spec).length === 0, spec?.body.map((b) => b.type).join(',')),
        check('no headings', headings(spec) === 0, String(headings(spec))),
        check('sent as plain HTML (sendMessage / sendPhoto)', !methods(ctx.stack.sent, from).includes('sendRichMessage'), methods(ctx.stack.sent, from).join(',')),
        check('numbers grounded in source', ungroundedNumbers(text, NEWS.text.join('\n')).length === 0, ungroundedNumbers(text, NEWS.text.join('\n')).join(', ')),
        check('short (≤ 600 chars)', text.length <= 600, String(text.length), true),
      ],
      judge: spec ? { channelBrief: TECH_BRIEF, slotTopic: 'Перенесення оновлення Pixel', sourceText: NEWS.text.join('\n'), post: r.post } : undefined,
    };
  },
};

/** R3 — format_prefs.rich = never: whatever the agent writes goes out as HTML (tables as a monospace grid / rows). */
export const executorRichNever: EvalCase = {
  id: 'executor-rich-never', role: 'executor', channel: TECH,
  title: 'format_prefs.rich = never → порівняння йде звичайним HTML',
  web: techWeb,
  async execute(ctx) {
    await createCard(ctx.pool, techCard());
    await setRichPref(ctx, 'never');
    const from = ctx.stack.sent.length;
    try {
      const r = await runExecutor(ctx, TECH, { format: 'text', topic: 'Порівняння трьох смартфонів середнього класу', hints: ['tech_rss'] });
      const sent = methods(ctx.stack.sent, from);
      return {
        runId: r.res.runId, status: r.res.status, terminalTool: r.res.terminalTool, post: r.post, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
        checks: [
          check('published (publish_post ok)', r.res.terminalTool === 'publish_post' && r.after.status === 'published', `slot=${r.after.status}`),
          check('card carries rich = never', r.card.richPref === 'never', String(r.card.richPref)),
          check('nothing sent as sendRichMessage', !sent.includes('sendRichMessage') && sent.length > 0, sent.join(',')),
          check('comparison still readable (table rows or grid in the text)', /<pre>|• <b>/.test(r.after.renderedPreview ?? '') || tables(r.spec).length === 0, '', true),
        ],
      };
    } finally {
      await setRichPref(ctx, null);
    }
  },
};

export const RICH_CASES = [executorRichComparison, executorRichShortNews, executorRichNever];
