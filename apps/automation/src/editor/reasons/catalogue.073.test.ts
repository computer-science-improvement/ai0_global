import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, reasonFor, reasonOfError, reasonText } from './catalogue';
import { CONFIG_FAILURE_CODES } from '../readiness/slot-config';
import { SKELETON_CODES } from '../readiness/plan-skeleton';
import { CONTENT_FAILURE_CODES, SKIP_GROUPS, SKIP_SLOT_CAUSES, isNotAMiss, isOwnerDecision, skipGroupOf } from '../silent/skip-reasons';
import { PREFLIGHT_CODES } from '../preflight/slot-preflight';
import { EMPTY_DAY_ERROR_RE } from '../schedule/empty-day';
import { REVIEW4_SLOTS } from '../series-pause/fixtures/review4-skips';

/** Spec 073 FR-014 (A39): one catalogue; every code the editor can write to a slot has an entry in it. */

/** The codes `EMPTY_DAY_ERROR_RE` names: `^(a_(b|c)|d|e)` → a_b, a_c, d, e. */
function emptyDayCodes(): string[] {
  const body = EMPTY_DAY_ERROR_RE.replace(/^\^\(/, '').replace(/\)$/, '');
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '|' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.flatMap((p) => {
    const m = /^(.*)\(([^)]*)\)$/.exec(p);
    return m ? m[2].split('|').map((x) => `${m[1]}${x}`) : [p];
  });
}

/** The prefixes of `RULES` in `silent/skip-reasons.ts` (the table asserts each one still classifies into its group). */
const RULE_CODES: Array<[string, string]> = [
  ['critic_rejected', 'critic'], ['critic_failed', 'critic'],
  ['budget_exceeded', 'budget'], ['budget', 'budget'],
  ['lint_failed', 'lint'], ['guard_failed', 'lint'], ['too_similar', 'lint'], ['too_verbatim', 'lint'], ['source_already_posted', 'lint'],
  ['library_item_already_posted', 'lint'], ['already_posted', 'lint'], ['quiz_answer_mismatch', 'lint'], ['quiz_answer_key_invalid', 'lint'],
  ['live_source_missing', 'lint'], ['not_next_in_order', 'lint'],
  ...CONFIG_FAILURE_CODES.map((c) => [c, 'config'] as [string, string]),
  ['daily_cap_reached', 'cap'], ['poll_cap_reached', 'cap'], ['min_gap', 'cap'], ['quiet_hours', 'cap'], ['blackout_window', 'cap'],
  ['no_fresh_item', 'nothing_fresh'], ['source_not_published', 'nothing_fresh'],
  ['preflight_source_used', 'nothing_fresh'], ['preflight_stale', 'nothing_fresh'], ['preflight_host_blocked', 'nothing_fresh'], ['preflight_no_material', 'nothing_fresh'],
  ['planner_no_material', 'nothing_fresh'], ['planner_source_unreachable', 'nothing_fresh'], ['planner_skipped', 'other'],
];

/** One sample slot error for each `NOT_A_MISS` / `OWNER` pattern and the code it must read as. */
const SYSTEM_TEXTS: Array<[string, string, 'miss' | 'owner']> = [
  ['superseded by a new plan', 'superseded', 'miss'], ['mode_changed', 'mode_changed', 'miss'], ['draft canceled', 'draft_canceled', 'miss'],
  ['series_paused: its source ran dry', 'series_paused', 'miss'],
  ['config_series_gone: the owner switched the series off', 'config_series_gone', 'miss'],
  ['rejected by owner', 'rejected_by_owner', 'owner'], ['resource_paused', 'resource_paused', 'owner'],
  ['agent @sky is paused', 'agent_paused', 'owner'], ['agent paused', 'agent_paused', 'owner'],
];

const COVERED: Array<[string, readonly string[]]> = [
  ['SKIP_GROUPS', SKIP_GROUPS],
  ['CONTENT_FAILURE_CODES', CONTENT_FAILURE_CODES],
  ['CONFIG_FAILURE_CODES', CONFIG_FAILURE_CODES],
  ['SKELETON_CODES', SKELETON_CODES],
  ['the config warning that is never a slot error', ['series_rate_over_card_max']],
  ['SKIP_SLOT_CAUSES', SKIP_SLOT_CAUSES],
  ['PREFLIGHT_CODES', PREFLIGHT_CODES],
  ['EMPTY_DAY_ERROR_RE', emptyDayCodes()],
  ['RULES prefixes', RULE_CODES.map(([c]) => c)],
  ['NOT_A_MISS and OWNER', SYSTEM_TEXTS.map(([, c]) => c)],
  ['planner and the stalled series', ['planner_no_material', 'planner_source_unreachable', 'planner_skipped', 'series_stalled']],
  ['how a run ended', ['max_steps', 'no_terminal', 'error', 'disabled', 'retrying', 'waiting_for_budget', 'stale', 'skipped_by_agent', 'skipped_by_owner']],
];

for (const [name, codes] of COVERED) {
  test(`every code of ${name} has an entry`, () => {
    assert.ok(codes.length > 0, `${name} is empty: did the list move?`);
    const missing = codes.filter((c) => !reasonFor(c));
    assert.deepEqual(missing, [], `${name} has codes with no catalogue entry`);
  });
}

test('the empty-day regex names the five codes (the table above reads it, so a new one is noticed)', () => {
  assert.deepEqual(emptyDayCodes().sort(), ['planner_no_material', 'planner_skipped', 'planner_source_unreachable', 'series_format_unavailable', 'series_in_quiet_hours']);
});

test('the RULES table still classifies each prefix into its group, and the system texts into NOT_A_MISS / OWNER', () => {
  for (const [code, group] of RULE_CODES) assert.equal(skipGroupOf(`${code}: x`), group, code);
  for (const [text, code, which] of SYSTEM_TEXTS) {
    assert.equal(which === 'miss' ? isNotAMiss(text) : isOwnerDecision(text), true, text);
    assert.equal(reasonOfError(text), code, text);
  }
});

test('entries are well formed: unique snake_case codes, English without Cyrillic, Ukrainian present, links of the known templates', () => {
  const seen = new Set<string>();
  const cyr = /[Ѐ-ӿ]/;
  const KINDS = ['skip', 'preflight', 'config', 'doctor', 'source', 'dataset'];
  for (const e of REASONS) {
    assert.match(e.code, /^[a-z][a-z0-9_]*$/, e.code);
    assert.ok(!seen.has(e.code), `duplicate code ${e.code}`);
    seen.add(e.code);
    assert.ok(KINDS.includes(e.kind), `${e.code}: kind ${e.kind}`);
    assert.ok(e.en.trim() && !cyr.test(e.en), `${e.code}: en must be English`);
    assert.ok(e.uk.trim(), `${e.code}: uk is empty`);
    if (e.fix) {
      assert.ok(e.fix.en.trim() && !cyr.test(e.fix.en), `${e.code}: fix.en must be English`);
      assert.ok(e.fix.uk.trim(), `${e.code}: fix.uk is empty`);
      assert.match(e.fix.en, /[.]$/, `${e.code}: fix.en is one sentence`);
      assert.equal((e.fix.en.match(/[.!?](\s|$)/g) ?? []).length, 1, `${e.code}: fix.en is ONE sentence`);
    }
    if (e.link) assert.match(e.link, /^\/app\/(editor\/:channel|agents\/:agent(\?tab=[a-z]+)?|data\/:dataset(\?tab=[a-z]+)?|agents\/inbox\?tab=approvals)$/, `${e.code}: link ${e.link}`);
  }
});

test('the labels of the 068 / 061 special cases are the labels the dashboard shows today', () => {
  assert.equal(reasonFor('no_fresh_item')!.en, 'Nothing fresh in the sources');
  assert.equal(reasonFor('critic_rejected')!.en, 'Rejected by the critic');
  assert.equal(reasonFor('critic_failed')!.en, 'Critic unavailable — held');
  assert.equal(reasonFor('superseded')!.en, 'Replaced by a newer plan');
  assert.equal(reasonFor('skipped_by_owner')!.en, 'Skipped by you');
  assert.equal(reasonFor('skipped_by_agent')!.en, 'Skipped by the agent');
  assert.equal(reasonFor('no_material')!.en, 'Skipped by the agent — no material');
  assert.equal(reasonFor('planner_no_material')!.en, 'Declared empty by the planner');
  assert.equal(reasonFor('preflight_no_material')!.en, 'Nothing to post from the library row');
  assert.equal(reasonFor('resource_paused')!.en, 'Resource paused');
  assert.equal(reasonFor('resource_unavailable')!.en, 'Connection broken');
  assert.equal(reasonFor('planner_skipped')!.en, 'Skipped by the planner');
});

test('reasonOfError reads every error text of the 10-26 stage review', () => {
  const closed = REVIEW4_SLOTS.filter((s) => s.error);
  assert.ok(closed.length >= 20, 'the stage export has its closed slots');
  const codes = closed.map((s) => reasonOfError(s.error));
  assert.ok(codes.every((c) => c !== null && !!reasonFor(c)), 'a code with no entry');
  // The three shapes: a leading code, an agent cause or free text, and the pre-flight codes.
  assert.equal(reasonOfError('no_fresh_item: openai.com повертає 403'), 'no_fresh_item');
  assert.equal(reasonOfError('critic_rejected: second revise — revise (grounding 3): x'), 'critic_rejected');
  assert.equal(reasonOfError('preflight_host_blocked: сайт gamespot.com заблокований'), 'preflight_host_blocked');
  assert.equal(reasonOfError('preflight_format_unavailable: формат «carousel»'), 'preflight_format_unavailable');
  assert.equal(reasonOfError('skipped by agent: Джерело вже використано в каналі'), 'skipped_by_agent');
  assert.equal(reasonOfError('skipped by agent: no_material: row data://prompts/7 has no prompt_text'), 'no_material');
  assert.equal(reasonOfError('skipped by agent: source_unreachable: 403'), 'source_unreachable');
});

test('reasonOfError: the planner codes, the legacy texts, the run statuses and the unknown', () => {
  assert.equal(reasonOfError('planner_no_material: the library has no unposted rows'), 'planner_no_material');
  assert.equal(reasonOfError('planner_skipped: series "Prompt" is not planned today'), 'planner_skipped');
  assert.equal(reasonOfError('stale: missed its time window'), 'stale');
  assert.equal(reasonOfError('series "Prompt": required source data://prompts has nothing left'), 'required_source_empty');
  assert.equal(reasonOfError('retry after max_steps'), 'retrying');
  assert.equal(reasonOfError('waiting for budget: daily'), 'waiting_for_budget');
  assert.equal(reasonOfError('max_steps: lint_failed in the last step'), 'max_steps');
  assert.equal(reasonOfError('lint_failed twice: hashtag_count'), 'lint_failed');
  assert.equal(reasonOfError('budget: daily budget used'), 'budget');
  // Not a code of the catalogue: a prefix of a longer word, free text, empty.
  assert.equal(reasonOfError('stale-source'), null);
  assert.equal(reasonOfError('the service restarted'), null);
  assert.equal(reasonOfError(''), null);
  assert.equal(reasonOfError(null), null);
  assert.equal(reasonOfError(undefined), null);
});

test('reasonText: the label and the fix from the catalogue, the system words as the detail, the raw text when there is no entry', () => {
  const en = reasonText('no_fresh_item: no item <= 6 h in pravda.com.ua (4 old)', 'en');
  assert.match(en, /^Nothing fresh in the sources: no item <= 6 h in pravda\.com\.ua \(4 old\) — Add a source that publishes more often/);
  const uk = reasonText('no_fresh_item: no item', 'uk');
  assert.match(uk, /^У джерелах немає свіжого: no item — Додайте джерело/);
  // The detail that only repeats the label is dropped.
  assert.doesNotMatch(reasonText('stale: missed its time window', 'en'), /Missed its time window: missed/i);
  // An agent's own words are the detail of its cause.
  assert.match(reasonText('skipped by agent: no_material: row data://prompts/7 has no prompt_text', 'en'), /^Skipped by the agent — no material: row data:\/\/prompts\/7 has no prompt_text — Add material/);
  // No entry: the text itself, clipped; nothing recorded: a plain note.
  assert.equal(reasonText('something odd happened', 'en'), 'something odd happened');
  assert.equal(reasonText(null, 'en'), 'no reason recorded');
  assert.equal(reasonText('', 'uk'), 'причину не записано');
  assert.ok(reasonText(`no_fresh_item: ${'x'.repeat(500)}`, 'en').length <= 260);
});

test('W1 integration review: the Ukrainian texts address the owner formally and carry no internal tokens', () => {
  // Informal imperatives the 076 entries used («Пусти», «завантаж», «Перевір»…); the owner bot says «ви» everywhere.
  const INFORMAL = /(?<![\p{L}])(?:Пусти|пусти|Завантаж|завантаж|Перевір|перевір|Натисни|натисни|Додай|додай|Прибери|прибери|Заміни|заміни|Відкрий|відкрий|Залиш|залиш|Постав|постав)(?![\p{L}])/u;
  // `origin=original`, `post_requires`, a mode name in quotes: words the owner does not use.
  const TOKEN = /[a-z_]+=|[a-z]+_[a-z_]+|«(?:suggested|required)»/;
  for (const e of REASONS) {
    for (const [field, text] of [['uk', e.uk], ['fix.uk', e.fix?.uk]] as const) {
      if (!text) continue;
      assert.doesNotMatch(text, INFORMAL, `${e.code} ${field}: «${text}»`);
      assert.doesNotMatch(text, TOKEN, `${e.code} ${field}: «${text}»`);
    }
  }
});
