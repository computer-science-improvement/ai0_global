/** Spec 037 T6: a platform post with a broken character fails lint (the critic gate stops it as well). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPlatformPost, PlatformPostSpecSchema } from './platform-spec';

test('lintPlatformPost: U+FFFD in the caption is a text_replacement_char error', () => {
  const spec = PlatformPostSpecSchema.parse({ format: 'th_text', title: 'Ledger', caption: 'Постраждалі пе�еважно в Азії.' });
  const r = lintPlatformPost(spec, { platform: 'threads' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'text_replacement_char' && e.message.includes('пе�еважно')));
  const clean = lintPlatformPost(PlatformPostSpecSchema.parse({ format: 'th_text', title: 'Ledger', caption: 'Постраждалі переважно в Азії.' }), { platform: 'threads' });
  assert.ok(!clean.errors.some((e) => e.code === 'text_replacement_char'));
});
