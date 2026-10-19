import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botStatus, kindText } from './owner-bot';
import type { OwnerBotState } from '../api/owner-bot';

const state = (p: Partial<OwnerBotState> = {}): OwnerBotState => ({
  configured: { token: true, owner: true }, cardsOn: true,
  polling: { running: true, lastPollAt: null, lastUpdateAt: null, lastError: null },
  cards: { open: 0, queued: 0, sentToday: 0, failedToday: 0 }, waiting: [],
  settings: { quietHours: '23-8', maxPerHour: 30, dailyAt: '21:00', weeklyAt: 'Mon 09:00' },
  reports: { dailyAt: null, weeklyAt: null }, ...p,
});

test('owner bot status: set up and polling, or what is wrong first', () => {
  assert.equal(botStatus(state()).label, 'On');
  assert.equal(botStatus(state({ configured: { token: false, owner: true } })).note, 'TELEGRAM_BOT_TOKEN is not set.');
  assert.equal(botStatus(state({ configured: { token: true, owner: false } })).label, 'Not set up');
  assert.equal(botStatus(state({ polling: { running: false, lastPollAt: null, lastUpdateAt: null, lastError: null } })).label, 'Not polling');
  assert.equal(botStatus(state({ polling: { running: true, lastPollAt: null, lastUpdateAt: null, lastError: 'timeout' } })).tone, 'warning');
  assert.equal(botStatus(state({ cardsOn: false })).label, 'Cards off');
});

test('what waits, by kind, in English', () => {
  assert.equal(kindText('approval', 1), '1 post to approve');
  assert.equal(kindText('approval', 3), '3 posts to approve');
  assert.equal(kindText('setup', 2), '2 setups from history');
  assert.equal(kindText('mystery', 2), '2 mystery');
});
