import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionCounts, metaHasProblem } from './connection-counts';
import type { Bot, MetaAccount, MtprotoSession, TelegraphAccount } from '../api/types';
import type { TikTokAccount } from '../api/tiktok-accounts';

const bot = (p: Partial<Bot> = {}) => ({ id: 'b', bot_id: '1', verify_error: null, ...p }) as Bot;
const session = (p: Partial<MtprotoSession> = {}) => ({ id: 's', label: 's', verify_error: null, ...p }) as MtprotoSession;
const tg = (p: Partial<TelegraphAccount> = {}) => ({ id: 't', account_id: 't', verify_error: null, ...p }) as TelegraphAccount;
const meta = (platform: MetaAccount['platform'], p: Partial<MetaAccount> = {}) =>
  ({ id: platform, platform, verify_error: null, token_checked_at: null, token_valid: null, ...p }) as MetaAccount;
const tt = (p: Partial<TikTokAccount> = {}) => ({ id: 'x', open_id: 'x', refresh_error: null, ...p }) as TikTokAccount;

test('a list that has not loaded has no count, and no part of a sum', () => {
  const c = connectionCounts({ bots: [bot()] });
  assert.equal(c.bots, 1);
  assert.equal(c.sessions, undefined);
  assert.equal(c.telegram, undefined);
  assert.equal(c.meta, undefined);
  assert.equal(c.tiktok, undefined);
  assert.equal(c.problems, 0);
});

test('counts per tab and the totals of the Telegram and Meta sections', () => {
  const c = connectionCounts({
    sessions: [session(), session()], bots: [bot()], telegraph: [],
    meta: [meta('facebook'), meta('instagram'), meta('instagram'), meta('threads')], tiktok: [tt()],
  });
  assert.deepEqual([c.sessions, c.bots, c.telegraph, c.telegram], [2, 1, 0, 3]);
  assert.deepEqual([c.facebook, c.instagram, c.threads, c.meta, c.tiktok], [1, 2, 1, 4, 1]);
});

test('problems: a verify or refresh error, or a token that reported itself invalid', () => {
  assert.equal(metaHasProblem(meta('facebook')), false);
  assert.equal(metaHasProblem(meta('facebook', { verify_error: 'nope' })), true);
  assert.equal(metaHasProblem(meta('threads', { token_checked_at: '2026-10-01', token_valid: false })), true);
  // never checked: token_valid is meaningless
  assert.equal(metaHasProblem(meta('threads', { token_checked_at: null, token_valid: false })), false);
  const c = connectionCounts({
    sessions: [session({ verify_error: 'x' })], bots: [bot(), bot({ verify_error: 'y' })], telegraph: [tg({ verify_error: 'z' })],
    meta: [meta('instagram', { verify_error: 'q' })], tiktok: [tt({ refresh_error: 'r' })],
  });
  assert.equal(c.problems, 5);
});
