import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostValidator, validatePost } from './post.validator';

const GOOD = 'Нормальний пост українською, достатньо довгий для валідатора постів.';

test('validatePost: a good post is valid', () => {
  assert.deepEqual(validatePost(GOOD), { valid: true });
});

test('validatePost: no response at all (API failure / agent down) is transient', () => {
  for (const v of [null, undefined]) {
    const r = validatePost(v);
    assert.equal(r.valid, false);
    assert.equal(r.permanent, false);
  }
});

test('validatePost: billing / rate-limit / service errors are transient', () => {
  for (const t of [
    'Error: insufficient_quota for this request, please retry later on',
    'Rate limit reached for requests, please slow down and try again',
    'The service is overloaded right now, please try again in a minute',
  ]) {
    const r = validatePost(t);
    assert.equal(r.valid, false, t);
    assert.equal(r.permanent, false, t);
  }
});

test('validatePost: SKIP_POST, empty, too short/long, refusals and meta-commentary are permanent', () => {
  for (const t of [
    'SKIP_POST',
    '',
    '   ',
    'short',
    'x'.repeat(5000),
    'I cannot help with this request because it violates the policy guidelines.',
    'Here is the post you asked for about the new telescope launch today.',
  ]) {
    const r = validatePost(t);
    assert.equal(r.valid, false, JSON.stringify(t).slice(0, 40));
    assert.equal(r.permanent, true, JSON.stringify(t).slice(0, 40));
  }
});

test('PostValidator.reject: permanent → StrategyRejection, transient → null', () => {
  const v = new PostValidator();
  assert.deepEqual(v.reject(validatePost('SKIP_POST'), 'ctx'), {
    rejected: 'model signalled SKIP_POST — content not formattable',
  });
  assert.equal(v.reject(validatePost(null), 'ctx'), null);
});

test('PostValidator.check keeps its boolean contract', () => {
  const v = new PostValidator();
  assert.equal(v.check(GOOD, 'ctx'), true);
  assert.equal(v.check('SKIP_POST', 'ctx'), false);
  assert.equal(v.check(null, 'ctx'), false);
});
