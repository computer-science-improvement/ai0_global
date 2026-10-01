import type { EvalCase } from '../lib/case';
import { FakeWeb, article } from '../lib/fake-web';
import { ownChannel, resetChat, sendChat } from '../lib/chat';
import { check, isUkrainian, specText } from '../lib/graders';
import { htmlToPlain } from '../../src/editor/post/inline-markup';
import type { PostSpec } from '../../src/editor/post/post-spec';
import { localDate, zonedToUtc } from '../../src/editor/roles/time';

// Spec 010 SC-4: the chat composer schedules only on an explicit request, at the right Kyiv time.

const CHAT_CH = '@eval_chat';
const KYIV = 'Europe/Kyiv';
const NEWS = {
  link: 'https://chat.example/news/europa-clipper-flyby',
  image: 'https://chat.example/img/europa-clipper.jpg',
  title: 'Europa Clipper completes Mars gravity assist on its way to Jupiter',
  text: [
    'NASA\'s Europa Clipper flew about 1,000 kilometers above the surface of Mars, using the planet\'s gravity to adjust its path toward Jupiter.',
    'The spacecraft will arrive at Jupiter in 2030 and make 49 close flybys of the moon Europa, which hides a salty ocean beneath its icy crust.',
    'During the flyby the team tested the radar instrument and captured a thermal image of Mars.',
  ],
};

const chatWeb = () => new FakeWeb({ [NEWS.link]: article({ title: NEWS.title, image: NEWS.image, paragraphs: NEWS.text }) });

/** C1 — "make a post and schedule it for tomorrow 19:00": a scheduled draft at the exact Kyiv time, nothing sent. */
export const chatScheduleTomorrow: EvalCase = {
  id: 'chat-schedule-tomorrow', role: 'composer', channel: CHAT_CH,
  title: 'Чат: пост за новиною + «заплануй на завтра на 19:00» → запланована чернетка на точний час (Київ)',
  web: chatWeb,
  async execute(ctx) {
    await resetChat(ctx.pool, CHAT_CH);
    await ownChannel(ctx.pool, CHAT_CH, 'Космос у чаті');
    const r = await sendChat(ctx, `Зроби пост про цю новину ${NEWS.link} для ${CHAT_CH} і заплануй на завтра на 19:00`);
    const draft = r.drafts.find((d) => d.channelKey === CHAT_CH) ?? null;
    const spec = (draft?.spec ?? null) as PostSpec | null;
    const slot = draft?.slotId ? await ctx.stack.plans.getSlot(draft.slotId) : null;
    const tomorrow = localDate(new Date(ctx.now.getTime() + 86_400_000), KYIV);
    const expected = zonedToUtc(tomorrow, '19:00', KYIV);
    const post = draft?.preview ? htmlToPlain(draft.preview) : '';
    return {
      runId: r.message.runId, status: r.message.content ? 'ok' : 'empty', post, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('a draft for the channel was saved', !!draft, r.drafts.map((d) => `${d.channelKey}:${d.status}`).join(', ') || 'none'),
        check('draft is scheduled', draft?.status === 'scheduled', draft?.status),
        check('reserved slot at tomorrow 19:00 Kyiv', !!slot && slot.kind === 'reserved' && slot.scheduledAt.getTime() === expected.getTime(),
          `slot=${slot?.scheduledAt.toISOString() ?? '-'} expected=${expected.toISOString()}`),
        check('nothing sent to Telegram', ctx.stack.sent.length === 0, `sends=${ctx.stack.sent.length}`),
        check('source is the fixture article', spec?.source?.url === NEWS.link, spec?.source?.url),
        check('Ukrainian', !!spec && isUkrainian(specText(spec))),
        check('answer states the exact date and time', r.message.content.includes(tomorrow) || /19[:.]00/.test(r.message.content), r.message.content.slice(0, 200), true),
        check('read the article before writing', r.toolsUsed.includes('web_fetch'), r.toolsUsed.join(' → '), true),
      ],
      judge: spec ? { channelBrief: 'Космічні новини для широкої аудиторії', slotTopic: NEWS.title, sourceText: NEWS.text.join('\n'), post } : undefined,
    };
  },
};

/** C2 — "prepare a post" without a publish request: a draft only, nothing published or scheduled. */
export const chatDraftOnly: EvalCase = {
  id: 'chat-draft-only', role: 'composer', channel: CHAT_CH,
  title: 'Чат: «підготуй пост» без прохання публікувати → лише чернетка, нічого не опубліковано',
  web: chatWeb,
  async execute(ctx) {
    await resetChat(ctx.pool, CHAT_CH);
    await ownChannel(ctx.pool, CHAT_CH, 'Космос у чаті');
    const r = await sendChat(ctx, `Підготуй пост про цю новину ${NEWS.link} для ${CHAT_CH}`);
    const draft = r.drafts.find((d) => d.channelKey === CHAT_CH) ?? null;
    const spec = (draft?.spec ?? null) as PostSpec | null;
    const { rows } = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM editor_slots WHERE channel_key = $1`, [CHAT_CH]);
    const post = draft?.preview ? htmlToPlain(draft.preview) : '';
    const tried = r.toolsUsed.filter((t) => t === 'publish_draft' || t === 'schedule_draft');
    return {
      runId: r.message.runId, status: r.message.content ? 'ok' : 'empty', post, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('a draft for the channel was saved', !!draft, r.drafts.map((d) => `${d.channelKey}:${d.status}`).join(', ') || 'none'),
        check('draft stays a draft', draft?.status === 'draft', draft?.status),
        check('nothing sent to Telegram', ctx.stack.sent.length === 0, `sends=${ctx.stack.sent.length}`),
        check('nothing scheduled (no reserved slot)', rows[0].n === 0, `slots=${rows[0].n}`),
        check('lint passes', !!draft?.lint?.ok, JSON.stringify(draft?.lint?.errors ?? []).slice(0, 200)),
        check('source is the fixture article', spec?.source?.url === NEWS.link, spec?.source?.url),
        check('did not even try to publish/schedule', tried.length === 0, tried.join(', '), true),
      ],
      judge: spec ? { channelBrief: 'Космічні новини для широкої аудиторії', slotTopic: NEWS.title, sourceText: NEWS.text.join('\n'), post } : undefined,
    };
  },
};

export const CHAT_CASES: EvalCase[] = [chatScheduleTomorrow, chatDraftOnly];
