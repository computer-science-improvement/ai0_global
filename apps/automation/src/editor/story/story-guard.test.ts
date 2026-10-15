import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleTools, type RoleToolDeps, STORY_KPI_SAMPLE_FILTER } from '../tools/role-tools';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { AuditPost } from '../post/integrity/types';
import type { StoryHistory } from './story.repository';
import { CriticGate } from '../critic/critic-gate';
import { PreviewSink } from '../roles/preview-run';

/**
 * Spec 037 T2: the story guard inside publish_post (dry-run, approval, shadow and live) with a fake registry:
 * repeat → error, a sibling's story of 24 h → a decision (skip / own_angle / repost), a follow-up → a reply to the
 * original, the registry records the stored post, the critic gets the story's earlier posts.
 */

const NOW = new Date('2026-10-09T07:00:00Z'); // 10:00 Kyiv

const HUB = 'Apple і LG роблять розумний дім\n\nApple Home Hub з екраном керуватиме замком, термостатом і дверним дзвінком від LG. '
  + 'Партнерство Apple та LG охоплює лінійку пристроїв для розумного будинку, презентація очікується 13 жовтня.';

function prior(id: string, at: string, text: string, channel = '@chan', messageId = 77): AuditPost {
  return { id, channel, publishedAt: at, timezone: 'Europe/Kyiv', text, lead: text.split('\n')[0], links: [], buttons: [], hashtags: [], media: null, story: {}, messageIds: [messageId] };
}

const hubSpec = (story?: Record<string, unknown>, extraP = '') => makeSpec({
  format: 'text', media: [], title: 'Apple Home Hub', source: { url: 'https://example.com/hub', label: 'Example' }, hashtags: ['космос'],
  body: [
    { type: 'lead', text: 'Apple Home Hub: що відомо' },
    { type: 'p', text: `Apple Home Hub отримає екран і керуватиме пристроями розумного будинку від LG — замком, термостатом і дзвінком. Презентацію пристроїв чекають 13 жовтня.${extraP}` },
  ],
  ...(story ? { story } : {}),
});

function harness(history: Partial<StoryHistory>, mode: 'live' | 'shadow' | 'approve' = 'live') {
  const sent: any[] = [];
  const recorded: any[] = [];
  const updates: any[] = [];
  const d: RoleToolDeps = {
    pool: { query: async () => ({ rows: [] }) } as any,
    plans: {
      createPlan: async () => 'p', reservedSlots: async () => [],
      getSlot: async (id: string) => ({ id, channelKey: '@chan', status: 'running', scheduledAt: NOW, sourceHints: [], format: 'text', topic: 'Apple Home Hub' }) as any,
      updateSlot: async (id: string, p: any) => { updates.push([id, p]); },
      countPublishedSince: async () => 0, lastPostAt: async () => null, sourceAlreadyPosted: async () => false,
      recentTexts: async () => [], insertPublication: async () => 501,
    },
    memory: { listActive: async () => [], add: async () => 1, retireByReviewer: async () => true },
    channels: { setFormatWeights: async (_k: string, w: any) => w },
    publisher: { send: async (_k: string, m: any, o?: any) => { sent.push({ m, o }); return { messageIds: [900] }; } },
    recordPublish: () => {},
    now: () => NOW,
    stories: {
      history: async () => ({ scope: 'telegram:@chan', siblings: [], previous: [], network: [], ...history }),
      record: async (i) => { recorded.push(i); return { storyId: 'st-1', storyKey: 'apple-home-hub' }; },
    },
  };
  const tools = Object.fromEntries(buildRoleTools(d).map((t) => [t.name, t]));
  const ctx: any = { runId: 'run-1', role: 'executor', channelKey: '@chan', slotId: 'slot-1', extras: { card: makeCard({ mode, hashtags: ['космос'] }) } };
  return { tools, ctx, sent, recorded, updates };
}

test('a repeat of the resource\'s story is refused (story_repeat) and nothing is sent or recorded', async () => {
  const h = harness({ previous: [prior('slot-0', '2026-10-07T10:00:00+03:00', HUB)] });
  const r: any = await h.tools.publish_post.execute({ spec: hubSpec() }, h.ctx);
  assert.equal(r.error, 'story_repeat');
  assert.match(r.details, /Apple і LG роблять розумний дім/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.recorded.length, 0);
});

test('a follow-up with a new fact goes out as a reply to the original and joins its story', async () => {
  const h = harness({ previous: [prior('slot-0', '2026-10-07T10:00:00+03:00', HUB, '@chan', 77)] });
  const spec = hubSpec({ followup_of: 'slot-0', kind: 'followup', new_facts: ['ціна $349'] }, ' Ціна — $349.');
  const r: any = await h.tools.publish_post.execute({ spec }, h.ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(h.sent[0].o, { replyTo: 77 });
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].assessment.role, 'followup');
  assert.equal(h.recorded[0].messageId, 900);
  assert.equal(h.recorded[0].publishedPostId, 501);
  assert.deepEqual(h.recorded[0].story.newFacts, ['ціна $349']);
  // Without new facts: refused.
  const bad: any = await harness({ previous: [prior('slot-0', '2026-10-07T10:00:00+03:00', HUB)] }).tools.publish_post
    .execute({ spec: hubSpec({ followup_of: 'slot-0', kind: 'followup' }) }, h.ctx);
  assert.equal(bad.error, 'followup_without_new_facts');
});

test('a sibling\'s story of the last 24 h needs a decision: none → refused; own_angle + reason → out with the warning', async () => {
  const sib = prior('slot-x', '2026-10-09T08:00:00+03:00', HUB, '@ai_tech', 55);
  const h = harness({ siblings: ['@ai_tech'], network: [sib] });
  const r: any = await h.tools.publish_post.execute({ spec: hubSpec() }, h.ctx);
  assert.equal(r.error, 'story_decision_required');
  assert.match(r.details, /skip_slot/);
  assert.match(r.details, /request_story_repost \(source_post_id telegram:@ai_tech\/55\)/);
  const noReason: any = await h.tools.publish_post.execute({ spec: hubSpec({ decision: 'own_angle' }) }, h.ctx);
  assert.equal(noReason.error, 'story_decision_required');

  const own = harness({ siblings: ['@ai_tech'], network: [sib] }, 'shadow');
  const ok: any = await own.tools.publish_post.execute({ spec: hubSpec({ decision: 'own_angle', reason: 'пояснюємо, як це працює з українськими сервісами' }) }, own.ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.warnings.some((w: any) => w.code === 'story_cross_channel'));
  assert.equal(own.recorded[0].story.decision, 'own_angle');
  assert.match(own.recorded[0].story.reason, /українськими/);
  assert.equal(own.updates.at(-1)[1].status, 'shadowed');
});

test('the critic reads the story: earlier posts and storyFirstPostAt', async () => {
  const h = harness({ previous: [prior('slot-0', '2026-10-07T10:00:00+03:00', HUB)] }, 'approve');
  let seen: any = null;
  const gate = new CriticGate({ critic: { review: async () => { throw new Error('not called'); } } as any, plans: { updateSlot: async () => {} } },
    { slotId: 'slot-1', channelKey: '@chan', mode: 'approve', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} });
  gate.check = async (p: any) => { seen = p; return { kind: 'proceed', critic: { verdict: 'pass', scores: null, notes: 'ok', pass: 1 } as any }; };
  h.ctx.extras.critic = gate;
  const spec = hubSpec({ followup_of: 'slot-0', kind: 'followup', new_facts: ['$349'] }, ' Ціна — $349.');
  const r: any = await h.tools.publish_post.execute({ spec }, h.ctx);
  assert.equal(r.awaiting_approval, true, JSON.stringify(r));
  assert.equal(seen.story.role, 'followup');
  assert.equal(seen.story.firstPostAt, '2026-10-07T10:00:00+03:00');
  assert.equal(seen.story.posts.length, 1);
  assert.deepEqual(seen.story.newFacts, ['$349']);
  assert.equal(h.recorded.length, 1, 'an approval post joins its story when it is stored');
});

test('a dry-run Preview runs the story guard but records nothing', async () => {
  const h = harness({ previous: [prior('slot-0', '2026-10-07T10:00:00+03:00', HUB)] });
  const sink = new PreviewSink();
  h.ctx.extras.dryRun = sink;
  const r: any = await h.tools.publish_post.execute({ spec: hubSpec() }, h.ctx);
  assert.equal(r.error, 'story_repeat');
  const ok: any = await h.tools.publish_post.execute({ spec: hubSpec({ followup_of: 'slot-0', kind: 'followup', new_facts: ['$349'] }, ' Ціна — $349.') }, h.ctx);
  assert.equal(ok.dry, true, JSON.stringify(ok));
  assert.equal(h.recorded.length, 0);
  assert.equal(h.sent.length, 0);
});

test('skip_slot takes the story_skip code; the KPI sample filter leaves reposts out', async () => {
  const h = harness({});
  const r: any = await h.tools.skip_slot.execute({ reason: '@ai_tech уже розповів цю історію', code: 'story_skip' }, h.ctx);
  assert.equal(r.code, 'story_skip');
  assert.match(h.updates[0][1].error, /^story_skip: /);
  assert.equal(STORY_KPI_SAMPLE_FILTER, `strategy_type IS DISTINCT FROM 'repost'`);
});
