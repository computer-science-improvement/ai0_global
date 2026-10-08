import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT_PREF_FIELDS, FormatPrefsSchema, renderFormatPrefs } from './resource-profile';
import { FormatPatchInput } from '../network/format-tools';
import { SkillLibrary } from '../skills/skill-library';
import { rowToCard } from '../repo/editor-channels.repository';
import { cardSummary } from '../card';
import { makeCard } from '../post/testing/fixtures';

// Spec 033 T4: format_prefs.rich (auto | prefer | never), owner-lockable like every field, and the agent guidance.

test('format_prefs.rich: schema, patch input, prompt line; lockable like any field', () => {
  assert.ok((FORMAT_PREF_FIELDS as readonly string[]).includes('rich'));
  for (const v of ['auto', 'prefer', 'never']) assert.equal(FormatPrefsSchema.safeParse({ rich: v }).success, true);
  assert.equal(FormatPrefsSchema.safeParse({ rich: 'always' }).success, false);
  assert.equal(FormatPatchInput.safeParse({ rich: 'prefer' }).success, true);
  assert.equal(FormatPatchInput.safeParse({ rich: null }).success, true, 'null clears it (back to auto)');
  assert.equal(renderFormatPrefs({ rich: 'never' }, ['rich']), 'Rich-повідомлення Telegram: ніколи — лише звичайний HTML (закріплено власником)');
  assert.match(renderFormatPrefs({ rich: 'auto' })!, /авто — коли в пості є заголовки, таблиці/);
});

test('the card row carries rich_pref / rich_unsupported; unknown values are ignored', () => {
  const base = { channel_key: '@c', mode: 'shadow', language: 'uk', timezone: 'Europe/Kyiv', link_style: 'inline', emoji_policy: 'sparse' };
  assert.equal(rowToCard({ ...base, rich_pref: 'prefer', rich_unsupported: true }).richPref, 'prefer');
  assert.equal(rowToCard({ ...base, rich_pref: 'prefer', rich_unsupported: true }).richUnsupported, true);
  const none = rowToCard({ ...base, rich_pref: 'sometimes', rich_unsupported: false });
  assert.equal('richPref' in none, false);
  assert.equal('richUnsupported' in none, false);
});

test('agents see the rich capability with the card, and the format-rich-telegram skill exists for executor/reviewer/composer', () => {
  const caps = cardSummary(makeCard()).capabilities as { rich?: string };
  assert.match(caps.rich ?? '', /heading, olist, table/);
  const skill = new SkillLibrary().get('format-rich-telegram');
  assert.ok(skill, 'skill loaded from editor-skills');
  assert.deepEqual([...skill!.appliesTo].sort(), ['composer', 'executor', 'reviewer']);
  for (const word of ['table', 'olist', 'heading', 'math', 'details', 'format_prefs.rich', 'table_in_short_post', 'too_many_headings']) {
    assert.ok(skill!.body.includes(word), `skill mentions ${word}`);
  }
  const executor = new SkillLibrary().get('editor-executor-workflow')!;
  assert.match(executor.body, /format-rich-telegram/);
});
