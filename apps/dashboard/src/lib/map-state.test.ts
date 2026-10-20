import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIT_STATES } from '../api/map';
import {
  EVENT_ICON, HEALTH_META, PLATFORM_META, ROAD_META, STATE_META, ago, clock, compactNumber, isBadEvent, isDormant, isWorking, kindLabel,
  levelLine, resourceTitle, stateLine, usd,
} from './map-state';

test('every unit state has a label, a colour token and a glyph; the working ones are the four busy states', () => {
  for (const s of UNIT_STATES) {
    const m = STATE_META[s];
    assert.ok(m.label && m.icon && m.help, s);
    assert.match(m.color, /^var\(--color-/);
  }
  assert.deepEqual(UNIT_STATES.filter(isWorking), ['planning', 'writing', 'reviewing', 'publishing']);
  assert.deepEqual(UNIT_STATES.filter(isDormant), ['paused', 'off']);
  assert.equal(STATE_META.writing.icon, 'pen');
  assert.equal(STATE_META.reviewing.icon, 'search');
  assert.equal(STATE_META.planning.icon, 'map');
  assert.equal(STATE_META.waiting.icon, 'clock');
  assert.equal(STATE_META.publishing.icon, 'send');
  assert.equal(STATE_META.error.icon, 'warning');
  assert.equal(STATE_META.paused.icon, 'pause');
});

test('the lookup tables cover every platform, health, road kind and event kind', () => {
  assert.deepEqual(Object.keys(PLATFORM_META).sort(), ['facebook', 'instagram', 'telegram', 'threads', 'tiktok', 'youtube']);
  assert.deepEqual(Object.keys(HEALTH_META).sort(), ['broken', 'ok', 'unknown', 'warning']);
  assert.deepEqual(Object.keys(ROAD_META).sort(), ['duplicate', 'promo', 'repost']);
  assert.equal(Object.keys(EVENT_ICON).length, 11);
  assert.equal(isBadEvent('run_failed'), true);
  assert.equal(isBadEvent('post_published'), false);
});

test('texts: state line, level line, titles, numbers', () => {
  assert.equal(stateLine({ state: 'writing', detail: 'Bridge opens' }), 'Writing — Bridge opens');
  assert.equal(stateLine({ state: 'idle', detail: null }), 'Idle');
  assert.equal(levelLine({ clean: 12, pass: 18, rejected: 1, failedRuns: 0 }), '12 clean approvals, 18 critic passes, 1 rejection in 30 days');
  assert.equal(levelLine({ clean: 1, pass: 0, rejected: 0, failedRuns: 2 }), '1 clean approval, 0 critic passes, 0 rejections, 2 failed runs in 30 days');
  assert.equal(resourceTitle({ title: ' Recipes ', username: 'r', ref: 'telegram:@r' }), 'Recipes');
  assert.equal(resourceTitle({ title: null, username: 'r', ref: 'telegram:@r' }), '@r');
  assert.equal(resourceTitle({ title: null, username: null, ref: 'telegram:@r' }), '@r');
  assert.equal(kindLabel('executor'), 'Writer');
  assert.equal(compactNumber(18400), '18k');
  assert.equal(compactNumber(980), '980');
  assert.equal(compactNumber(1250), '1.3k');
  assert.equal(compactNumber(null), '');
  assert.equal(usd(0), '$0');
  assert.equal(usd(0.0421), '$0.042');
  assert.equal(usd(1.839), '$1.84');
  assert.equal(usd(null), '—');
});

test('ago and clock are English and tolerate missing values', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(ago('2026-10-20T11:59:58Z', now), 'just now');
  assert.equal(ago('2026-10-20T11:59:30Z', now), '30 s ago');
  assert.equal(ago('2026-10-20T11:55:00Z', now), '5 min ago');
  assert.equal(ago('2026-10-20T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-10-18T12:00:00Z', now), '2 d ago');
  assert.equal(ago(null, now), '—');
  assert.equal(clock(null), '—');
  assert.match(clock('2026-10-20T11:59:30Z'), /^\d\d:\d\d$/);
});
