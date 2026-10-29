import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '../sysadmin/audit.types';
import { channelDoctor } from './doctor';
import {
  ai0GlobalFacts, ORIGIN_SYNTHETIC, pdrDevFacts, POST_REQUIRES_095, promptsDevFacts,
} from './fixtures/onboarding-1027-facts';
import { NANOBANANA_SKILL, PROMPTHERO_SKILL } from './fixtures/real-skills-1027';

/**
 * Spec 072 T5, A1–A3, L10: the replay of the 10-27 onboarding review. Each channel took days of export and review to diagnose; the
 * doctor must name the same causes from the config alone, at no cost. Assertions are "includes" (code, severity, subject id), never
 * the whole list, so a new check does not break them. The fixtures are hand-built (see the header of the fixture file).
 */

const has = (out: Finding[], check: string, severity: Finding['severity'], idStarts: string) =>
  out.some((f) => f.check === check && f.severity === severity && f.subject.id.startsWith(idStarts));
const errors = (out: Finding[]) => out.filter((f) => f.severity === 'error');

test('@ai0_prompts_dev: both skills that send the writer elsewhere, the origin skill and the empty text are errors', () => {
  const out = channelDoctor(promptsDevFacts());
  assert.ok(has(out, 'series_source_contradicted', 'error', `Prompt|skill:${PROMPTHERO_SKILL.id.slice(0, 8)}`), 'prompthero skill (path 2: provider=prompthero)');
  assert.ok(has(out, 'series_source_contradicted', 'error', `Prompt|skill:${NANOBANANA_SKILL.id.slice(0, 8)}`), 'nanobanana skill (path 1, soft)');
  assert.ok(has(out, 'origin_original_with_source', 'error', ORIGIN_SYNTHETIC.id), 'the synthetic origin skill');
  assert.ok(has(out, 'dataset_low_fill', 'error', 'prompts'), 'prompt_text filled in 30 % of the rows under the 083 rule');
  assert.equal(out.filter((f) => f.check === 'series_source_contradicted').length, 2, 'one per skill (A8)');
});

test('@ai0_prompts_dev: each error offers what the owner would do first', () => {
  const out = channelDoctor(promptsDevFacts());
  const byId = (check: string, id: string) => out.find((f) => f.check === check && f.subject.id.startsWith(id))!;
  const proto = byId('series_source_contradicted', `Prompt|skill:${PROMPTHERO_SKILL.id.slice(0, 8)}`);
  assert.deepEqual(proto.fix, { kind: 'skill_disable', agent: 'ai0_prompts_dev', skill: 'prompthero-image-prompt-post' });
  assert.equal(proto.link, '/app/agents/ai0_prompts_dev?tab=skills');
  assert.equal(byId('origin_original_with_source', ORIGIN_SYNTHETIC.id).fix?.kind, 'skill_disable');
  const fill = byId('dataset_low_fill', 'prompts');
  assert.equal(fill.fix, undefined);
  assert.equal(fill.link, '/app/data/prompts');
  assert.match(fill.detail, /Only 30% of the rows of prompts/);
});

test('@ai0_prompts_dev: the dataset is healthy otherwise (rows left, a series on it) and the 095 rule and no skills clear every error', () => {
  const out = channelDoctor(promptsDevFacts());
  for (const code of ['material_exhausted', 'dataset_without_series', 'tools_missing_for_source']) assert.ok(!out.some((f) => f.check === code), code);
  const fixed = channelDoctor(promptsDevFacts({ skills: [], postRequires: POST_REQUIRES_095 }));
  assert.deepEqual(errors(fixed).map((f) => f.check), [], 'after switching the skills off and requiring the text there is nothing to stop the channel');
});

test('@pdr_dev_channel: a dataset no series reads and nothing left to post are both errors', () => {
  const out = channelDoctor(pdrDevFacts());
  assert.ok(has(out, 'dataset_without_series', 'error', 'pdr_questions'));
  assert.ok(has(out, 'material_exhausted', 'error', 'pdr_questions'));
  const used = out.find((f) => f.check === 'material_exhausted')!;
  assert.deepEqual(used.evidence, { dataset: 'pdr_questions', rows: 866, not_postable: 0, unused_postable: 0, reuse: { kind: 'never' } });
  assert.equal(used.link, '/app/data/pdr_questions');
  assert.ok(has(out, 'dataset_post_requires_missing', 'warn', 'pdr_questions'), 'the schema never said which fields a row needs');
});

test('@ai0_global: the channel that worked has no error, and its pause is information without a fix', () => {
  const out = channelDoctor(ai0GlobalFacts());
  assert.deepEqual(errors(out).map((f) => `${f.check}:${f.subject.id}`), [], 'no false alarm on a healthy channel');
  const pause = out.find((f) => f.check === 'series_paused')!;
  assert.ok(pause);
  assert.equal(pause.severity, 'info');
  assert.equal(pause.subject.id, 'pause-ai-news');
  assert.equal(pause.subject.label, 'AI-новини дня');
  assert.equal(pause.fix, undefined, 'a source_unreachable pause keeps the banner\'s own Resume');
});

test('@ai0_global: free series and absent dataset bindings give no source, tools or material finding', () => {
  const codes = new Set(channelDoctor(ai0GlobalFacts()).map((f) => f.check));
  for (const code of ['series_source_contradicted', 'series_source_not_required', 'dataset_without_series', 'material_exhausted', 'tools_missing_for_source', 'bot_not_admin']) {
    assert.ok(!codes.has(code), code);
  }
});

test('the three replays give unique keys, catalogue codes and agent and channel on every subject', () => {
  for (const [facts, handle, channel] of [[promptsDevFacts(), 'ai0_prompts_dev', '@ai0_prompts_dev'], [pdrDevFacts(), 'pdr_dev_channel', '@pdr_dev_channel'], [ai0GlobalFacts(), 'ai_global', '@ai0_global']] as const) {
    const out = channelDoctor(facts);
    assert.equal(new Set(out.map((f) => f.key)).size, out.length);
    for (const f of out) {
      assert.equal(f.subject.agent, handle);
      assert.equal(f.subject.channel, channel);
    }
  }
});

test('the fixture header says what is real and what is synthetic, and the export is not in the tree', () => {
  const text = readFileSync(join(__dirname, 'fixtures', 'onboarding-1027-facts.ts'), 'utf8');
  assert.match(text, /REAL \(copied from the export\)/);
  assert.match(text, /SYNTHETIC \(the export does not hold it\)/);
  assert.match(text, /prompt-origin-synthetic/);
  assert.doesNotMatch(text, /\b\d{8,10}:[A-Za-z0-9_-]{30,}/, 'no bot token');
});
