// Spec 052 FR-005: the launch panel's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExternal, launchHeadline, mixRows, scheduleLine, stepLabel, stepTone, subsDelta, type LaunchView } from './launch';
import { mentionedArtifacts } from '../components/artifacts/ArtifactChip';
import { kindText } from './owner-bot';
import { SLASH_COMMANDS } from '../components/chat/SlashMenu';

test('the format mix is whole percentages adding up to 100, biggest first', () => {
  assert.deepEqual(mixRows({ text: 0.5, photo: 0.5 }), [{ format: 'photo', pct: 50 }, { format: 'text', pct: 50 }]);
  const three = mixRows({ text: 1, photo: 1, video: 1 });
  assert.equal(three.reduce((a, r) => a + r.pct, 0), 100);
  assert.deepEqual(three.map((r) => r.pct), [34, 33, 33]);
  assert.deepEqual(mixRows({}), []);
});

test('the schedule in one line', () => {
  assert.equal(scheduleLine({ posts_per_day_min: 1, posts_per_day_max: 2, quiet_start_hour: 23, quiet_end_hour: 8, best_hours: [19, 9] }),
    '1–2 posts a day · quiet 23:00–08:00 · best at 09:00, 19:00');
  assert.equal(scheduleLine({ posts_per_day_min: 1, posts_per_day_max: 1, quiet_start_hour: null, quiet_end_hour: null, best_hours: [] }), '1 post a day');
});

test('steps, growth and the headline', () => {
  assert.equal(stepTone('needs_you'), 'warning');
  assert.equal(stepLabel('needs_you'), 'needs you');
  assert.equal(stepTone('done'), 'success');
  assert.equal(subsDelta({ subsAtStart: 10, subsNow: 22, published: 3, promoJoins: 4 }), '+12 since Start');
  assert.equal(subsDelta({ subsAtStart: null, subsNow: 22, published: 3, promoJoins: 4 }), '');
  assert.ok(isExternal('https://t.me/coffee_home'));
  assert.ok(!isExternal('/app/approvals'));
  const v = { status: 'ready', startRequested: true, graduation: {} } as unknown as LaunchView;
  assert.match(launchHeadline(v)!, /as soon as the bot is an administrator/);
  assert.match(launchHeadline({ ...v, status: 'running', graduation: { proposedAt: 'x' } })!, /go live/);
});

test('launch is an artifact mention, a slash command and an owner-bot kind', () => {
  assert.deepEqual(mentionedArtifacts('see [[launch:abc-1]]').map((c) => `${c.type}:${c.id}`), ['launch:abc-1']);
  assert.ok(SLASH_COMMANDS.some((c) => c.name === 'launch'));
  assert.equal(kindText('launch', 2), '2 channel launches');
});
