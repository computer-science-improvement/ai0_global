import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_LABEL, QUALITY_FLAGS, flagLabel, flaggedCount, qualityActive, qualityHeadline, qualityStats, type ResourceQuality } from './quality-view';
import { KIND_ORDER, parseDirectiveFilters } from './directive-view';

const Q = (o: Partial<ResourceQuality> = {}): ResourceQuality => ({
  days: 7, posts: 5,
  critic: { pass: 3, revise: 1, reject: 1, failed: 0, total: 5, revised_then_passed: 1, pass_rate: 0.6, mean: { sense: 3.4 }, notes: ['reject: nonsense'] },
  polls: { count: 2, slots: 6, share: 0.333, cap: 1, over: true },
  reader_questions: { cap: 1, with_questions: 2, over_cap: 1, examples: ['?'] },
  owner: { approved: 3, edited: 1, rejected: 1, rejection_rate: 0.25, reasons: ['too salesy'], edits: ['shortened'] },
  samples: [{ at: '2026-10-10T10:00:00Z', status: 'published', format: 'text', text: 'Post' }],
  flags: ['critic_reject', 'critic_low_pass', 'polls_over_cap', 'owner_rejections', 'owner_edits'],
  ...o,
});

test('quality stats: critic pass rate, polls vs cap, owner rejections with tones', () => {
  const [critic, polls, owner] = qualityStats(Q());
  assert.deepEqual([critic.label, critic.value, critic.tone], ['Critic pass', '60%', 'danger']);
  assert.match(critic.title, /3 pass · 1 revise · 1 reject \(1 passed after one rewrite\)/);
  assert.deepEqual([polls.value, polls.tone], ['2 / 1', 'danger']);
  assert.deepEqual([owner.value, owner.tone], ['1 · 1 edited', 'danger']);
  const calm = qualityStats(Q({
    critic: { pass: 5, revise: 0, reject: 0, failed: 0, total: 5, revised_then_passed: 0, pass_rate: 1, mean: null, notes: [] },
    polls: { count: 0, slots: 5, share: 0, cap: null, over: false }, owner: { approved: 2, edited: 0, rejected: 0, rejection_rate: 0, reasons: [], edits: [] }, flags: [],
  }));
  assert.deepEqual(calm.map((s) => [s.value, s.tone]), [['100%', 'success'], ['0 / ∞', 'neutral'], ['0', 'success']]);
});

test('headline, activity, labels and the network count', () => {
  assert.equal(qualityHeadline(Q()).tone, 'danger');
  assert.match(qualityHeadline(Q()).text, /critic rejected posts · low critic pass rate/);
  assert.deepEqual(qualityHeadline(Q({ flags: ['owner_edits'] })), { text: 'you edited posts', tone: 'warning' });
  assert.deepEqual(qualityHeadline(Q({ flags: [] })), { text: 'No quality flags', tone: 'success' });
  const empty = Q({ posts: 0, critic: { ...Q().critic, total: 0 }, owner: { ...Q().owner, approved: 0, rejected: 0 }, polls: { ...Q().polls, slots: 0 } });
  assert.equal(qualityActive(empty), false);
  assert.equal(qualityHeadline(empty).text, 'No posts in 7 days');
  assert.equal(qualityActive(null), false);
  for (const f of QUALITY_FLAGS) assert.ok(FLAG_LABEL[f] && !/_/.test(FLAG_LABEL[f]), f);
  assert.equal(flagLabel('something_new'), 'something new');
  assert.equal(flaggedCount([{ quality: Q() }, { quality: Q({ flags: [] }) }, { quality: null }, {}]), 1);
});

test('spec 037 T10: the evergreen share is its own stat and flag (English label)', () => {
  assert.equal(qualityStats(Q()).length, 3, 'no evergreen posts — no extra stat');
  const q = Q({ evergreen: { posts: 6, evergreen: 2, share: 0.333, over: true }, flags: ['evergreen_share_high'] });
  const ev = qualityStats(q).find((s) => s.key === 'evergreen')!;
  assert.deepEqual([ev.label, ev.value, ev.tone], ['Evergreen', '2 · 33%', 'danger']);
  assert.match(ev.title, /2 of 6 written posts/);
  assert.equal(flagLabel('evergreen_share_high'), 'evergreen over 25% of posts');
  assert.equal(qualityStats(Q({ evergreen: { posts: 8, evergreen: 1, share: 0.125, over: false } })).at(-1)?.tone, 'warning');
});

test('directive filters know the quality kinds', () => {
  assert.ok(KIND_ORDER.includes('voice_fix') && KIND_ORDER.includes('format_mix'));
  assert.deepEqual(parseDirectiveFilters({ kind: 'format_mix,voice_fix,bogus' }).kinds, ['voice_fix', 'format_mix']);
});
