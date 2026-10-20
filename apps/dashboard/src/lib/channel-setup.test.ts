import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SetupOverviewRow, SetupPostRef, SetupSections } from '../api/channel-setup';
import { SETUP_SECTIONS } from '../api/channel-setup';
import { currentRows, estimateText, evidencePosts, expiredText, fmtUsd, isReviewable, isRunning, missingSetup, proposedRows, SECTION_LABEL, SETUP_STATUS, sectionPostKeys } from './channel-setup';

const sections: SetupSections = {
  summary: 'Short tips on digital safety.',
  brief_profile: {
    profile: { topic: 'Digital safety', audience: { who: 'smartphone users' }, language: 'uk', goals: ['engagement'], tone: 'calm', taboo: ['fear'] },
    brief: 'The channel posts short practical tips.', evidence: { post_ids: ['p1', 'p3'], note: 'same opening' },
  },
  formatting: {
    format_prefs: { emoji: 'light', length: { target: 300, max: 700 } }, style: { address: 'vy' },
    card: { hashtags: ['safety'], hashtag_min: 0, hashtag_max: 1, footer: 'Subscribe', emoji_policy: 'sparse' },
    evidence: { post_ids: ['p1'], note: 'signature in 5 of 8' },
  },
  format_mix: { formats: { photo: 0.4, text: 0.6 }, evidence: { post_ids: [], note: '3 of 8 with a photo' } },
  series_pillars: {
    series: [{ name: 'Tip of the day', cadence: 'daily@09:00', format: 'text', brief: 'One tip.', post_ids: ['p1', 'p3', 'p5'] }],
    pillars: [{ name: 'Tips', share: 50 }, { name: 'News', share: 30 }, { name: 'Questions', share: 20 }],
    evidence: { post_ids: ['p6'], note: 'three kinds' },
  },
  schedule: { posts_per_day_min: 1, posts_per_day_max: 2, quiet_start_hour: 23, quiet_end_hour: 8, best_hours: [12, 9], evidence: { post_ids: [], note: 'two a day' } },
  examples_voice: {
    example_ids: ['p1', 'p3', 'p7'],
    voice: { description: 'Short and calm.', rules: ['One tip, one action'], quotes: ['keep passwords in a manager'] },
    evidence: { post_ids: ['p1'], note: 'best engagement' },
  },
};

const row = (p: Partial<SetupOverviewRow> = {}): SetupOverviewRow => ({
  channelKey: '@tips', title: 'Tips', trackingStatus: 'ok', postsStored: 40, hasCard: true, mode: 'approve',
  hasBrief: true, hasProfile: true, hasPlaybook: true, agentHandle: 'tips', latest: null, ...p,
});

test('statuses: every server status has a label; running and reviewable states', () => {
  for (const s of ['queued', 'collecting', 'analyzing', 'ready', 'applied', 'partially_applied', 'discarded', 'superseded', 'failed', 'no_access', 'too_few_posts', 'expired'] as const) {
    assert.ok(SETUP_STATUS[s].label);
  }
  assert.deepEqual([SETUP_STATUS.expired.label, SETUP_STATUS.expired.tone], ['Expired', 'neutral']);
  assert.equal(isReviewable('expired'), false, 'an expired proposal is not waiting for a review');
  assert.equal(isRunning('expired'), false);
  assert.equal(isRunning('analyzing'), true);
  assert.equal(isRunning('ready'), false);
  assert.equal(isReviewable('partially_applied'), true);
  assert.equal(isReviewable('applied'), false);
  assert.deepEqual(SETUP_SECTIONS.map((s) => SECTION_LABEL[s]).length, 6);
});

test('missing setup and the cost line', () => {
  assert.deepEqual(missingSetup(row()), []);
  assert.deepEqual(missingSetup(row({ hasCard: false, hasPlaybook: false })), ['card', 'playbook']);
  assert.equal(estimateText(0.08, 5), '5 channels (about $0.40)');
  assert.equal(estimateText(null, 1), '1 channel (no cost estimate yet: it comes from past runs)');
  assert.equal(fmtUsd(0.004), '$0.0040');
});

test('proposed rows: shares in %, hours sorted, series and pillars, quotes', () => {
  assert.deepEqual(proposedRows('format_mix', sections), [{ label: 'text', value: '60%' }, { label: 'photo', value: '40%' }]);
  assert.deepEqual(proposedRows('schedule', sections), [
    { label: 'Posts per day', value: '1–2' }, { label: 'Quiet hours', value: '23:00 → 08:00' }, { label: 'Best hours', value: '09:00, 12:00' },
  ]);
  const sp = proposedRows('series_pillars', sections);
  assert.equal(sp[0].label, 'Series «Tip of the day»');
  assert.equal(sp[1].value, 'Tips 50% · News 30% · Questions 20%');
  assert.ok(proposedRows('examples_voice', sections).some((r) => r.value === '«keep passwords in a manager»'));
  const fmt = proposedRows('formatting', sections);
  assert.ok(fmt.some((r) => r.label === 'hashtags' && r.value === '#safety'));
  assert.ok(fmt.some((r) => r.label === 'length' && r.value === 'target 300, max 700'), 'objects read as key / value pairs');
  assert.ok(fmt.some((r) => r.label === 'style' && r.value === 'address vy'));
});

test('current rows from the section baseline: weights as shares, locked series marked, unset sections empty', () => {
  const current = {
    format_mix: { formats: { text: 1, photo: 1 } },
    series_pillars: { series: [{ name: 'Old', cadence: 'daily@10:00', format: 'text', locked: true }], pillars: [] },
    schedule: { postsPerDayMin: null, postsPerDayMax: null, quietStartHour: null, quietEndHour: null, bestHours: [] },
    brief_profile: { brief: null, profile: null },
  };
  assert.deepEqual(currentRows('format_mix', current), [{ label: 'text', value: '50%' }, { label: 'photo', value: '50%' }]);
  assert.deepEqual(currentRows('series_pillars', current), [{ label: 'Series «Old» (locked)', value: 'daily@10:00 · text' }]);
  assert.deepEqual(currentRows('schedule', current), []);
  assert.deepEqual(currentRows('brief_profile', current), []);
  assert.deepEqual(currentRows('examples_voice', null), []);
});

test('evidence: section keys include series and example posts; unknown keys are dropped', () => {
  assert.deepEqual(sectionPostKeys('series_pillars', sections), ['p6', 'p1', 'p3', 'p5']);
  assert.deepEqual(sectionPostKeys('examples_voice', sections), ['p1', 'p3', 'p7']);
  const posts: SetupPostRef[] = ['p1', 'p3'].map((key, i) => ({
    key, id: `id-${i}`, msgId: 10 + i, postedAt: '2026-10-15T09:00:00Z', firstLine: key, views: 1, hasMedia: false, mediaType: null, link: `https://t.me/tips/${10 + i}`,
  }));
  assert.deepEqual(evidencePosts(['p3', 'p9', 'p1'], posts).map((p) => p.key), ['p3', 'p1']);
});

test('expired (spec 057): the dialog line names the days from the reason and says what stays', () => {
  assert.equal(expiredText('expired: closed after 14 days without an apply'),
    'Closed after 14 days without an apply. Applied sections stay — analyze again for a fresh proposal.');
  assert.match(expiredText('expired: closed after 1 day without an apply'), /^Closed after 1 day without/);
  assert.equal(expiredText(null), 'Closed without an apply. Applied sections stay — analyze again for a fresh proposal.');
});
