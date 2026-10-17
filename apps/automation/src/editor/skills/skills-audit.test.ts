/**
 * Spec 034 FR-014: the skills audit. Every `editor-skills/*.md` must name only tools that exist, use current refs
 * (`data://`, spec 032), never say a new agent starts in shadow (spec 031: approve), use known roles and fit the
 * inline budgets of the prompts that inline it. Each rule also fails on a fixture, so a broken rule is caught too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_SKILLS_DIR, isOptionalSkill, isProtectedSkill, OPTIONAL_SKILL_PREFIX, parseSkill, SkillLibrary,
} from './skill-library';
import { SKILL_MAX_INLINE_BODY, SKILL_ROLES } from '../agents/skill-lint';
import { TONE_SKILL_BY_TYPE, toneSkillsFor } from '../migration/type-mapping';

// ── the tool registry, built from the code ──────────────────────────────────

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : []);
  });
}

/**
 * Every tool name an agent can be given: `defineTool({ name: '…' })` literals, plus the names of a tool factory
 * that passes `name` through (`defineTool({ name, … })` with a `name: 'a' | 'b'` parameter in the same file).
 */
function toolRegistryFromSource(files: Array<{ text: string }>): Set<string> {
  const out = new Set<string>();
  for (const { text } of files) {
    for (const m of text.matchAll(/defineTool\(\{\s*name:\s*['"`]([a-z0-9_]+)['"`]/g)) out.add(m[1]);
    if (/defineTool\(\{\s*name\s*,/.test(text)) {
      for (const u of text.matchAll(/\bname:\s*((?:'[a-z0-9_]+'\s*\|\s*)+'[a-z0-9_]+')/g)) {
        for (const lit of u[1].matchAll(/'([a-z0-9_]+)'/g)) out.add(lit[1]);
      }
    }
  }
  return out;
}

const REGISTRY = toolRegistryFromSource(sourceFiles(SRC).map((f) => ({ text: readFileSync(f, 'utf8') })));

/** Verbs our tool names start with: a backticked `verb_object` in a skill is read as a tool reference. */
const TOOL_VERBS = [
  'accept', 'add', 'attach', 'cancel', 'check', 'contest', 'create', 'decline', 'define', 'detach', 'edit', 'explain',
  'extract', 'fetch', 'file', 'finish', 'get', 'inspect', 'lint', 'list', 'load', 'pause', 'preview', 'propose',
  'publish', 'query', 'report', 'repurpose', 'retire', 'review', 'revise', 'save', 'schedule', 'search', 'set', 'skip',
  'submit', 'update', 'write',
];

/** Backticked identifiers that look like tools but are not (with why). */
const NOT_TOOLS: Readonly<Record<string, string>> = {
  pause_resource: 'a MANAGER directive kind (spec 025), executed by code',
  pause_series:   'a MANAGER directive kind (spec 025), executed via set_series_active',
};

const TOOL_LIKE = new RegExp(`\`((?:${TOOL_VERBS.join('|')})_[a-z0-9_]+)(?:\\([^\`]*\\))?\``, 'g');

// ── the audit ───────────────────────────────────────────────────────────────

interface AuditIssue { file: string; rule: string; detail: string }

/** A new agent / resource starts in approve (spec 031); text that sends it to shadow by default is stale. */
const SHADOW_DEFAULT = /(?:start\p{L}*\s+in\s+shadow|(?:стартує|починає|почне|працюватиме|працює|запускається)[^.\n]{0,40}\bshadow\b|перш\p{L}*\s+\d+\s+дн\p{L}*[^.\n]{0,40}\bshadow\b|shadow-режим\p{L}*)/iu;

/** Role prompts inline their workflow skill within an 8 000-char budget (`roles/prompts.ts`, `agent-prompts.ts`). */
const INLINE_BUDGET = 8_000;
const WORKFLOW_SKILLS = /^(?:editor-[a-z]+-workflow|manager-workflow|agent-onboarding|agent-chat-etiquette)$/;
/** Leave ≥ 2 000 chars of the budget to the card's and the agent's own inline skills. */
const WORKFLOW_MAX = INLINE_BUDGET - 2_000;
/** The executor prompt also carries the voice skills (FR-001); its workflow stays small. */
const EXECUTOR_WORKFLOW_MAX = 2_600;
/** FR-001: the always-inlined voice block. */
const VOICE_CORE_MAX = 2_500;

function auditSkills(files: Array<{ file: string; text: string }>, tools: ReadonlySet<string>): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const add = (file: string, rule: string, detail: string) => issues.push({ file, rule, detail });
  const names = new Map<string, string>();

  for (const { file, text } of files) {
    let skill;
    try {
      skill = parseSkill(file, text);
    } catch (err: any) {
      add(file, 'frontmatter', err?.message ?? String(err));
      continue;
    }
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    if (`${skill.name}.md` !== file) add(file, 'frontmatter', `name ${skill.name} differs from the file name`);
    if (names.has(skill.name)) add(file, 'frontmatter', `duplicate name ${skill.name} (also ${names.get(skill.name)})`);
    names.set(skill.name, file);

    const appliesLine = front.match(/^applies_to:\s*(.*)$/m);
    if (!appliesLine) add(file, 'applies_to_empty', 'applies_to is missing (the parser would default it)');
    else if (!skill.appliesTo.length) add(file, 'applies_to_empty', 'applies_to lists no role');
    const unknown = skill.appliesTo.filter((r) => !(SKILL_ROLES as readonly string[]).includes(r));
    if (unknown.length) add(file, 'applies_to_role', `unknown roles: ${unknown.join(', ')}`);

    const body = `${skill.description}\n${skill.body}`;
    for (const m of body.matchAll(TOOL_LIKE)) {
      const id = m[1];
      if (!tools.has(id) && !NOT_TOOLS[id]) add(file, 'unknown_tool', `\`${id}\` is not a registered tool`);
    }
    if (/library:\/\//.test(body)) add(file, 'library_ref', 'library:// refs are legacy aliases; write data://<dataset>/<id> (spec 032)');
    const shadow = body.match(SHADOW_DEFAULT);
    if (shadow) add(file, 'shadow_default', `"${shadow[0]}": new agents start in approve (spec 031); shadow is a manual dry run`);

    const len = skill.body.length;
    if (skill.name === 'editor-executor-workflow' && len > EXECUTOR_WORKFLOW_MAX) add(file, 'inline_size', `${len} > ${EXECUTOR_WORKFLOW_MAX}`);
    else if (WORKFLOW_SKILLS.test(skill.name) && len > WORKFLOW_MAX) add(file, 'inline_size', `${len} > ${WORKFLOW_MAX}`);
    if (isOptionalSkill(skill.name) && len > SKILL_MAX_INLINE_BODY) add(file, 'inline_size', `tone skill ${len} > ${SKILL_MAX_INLINE_BODY} (attached inline)`);
    if (skill.name === 'voice-core' && len > VOICE_CORE_MAX) add(file, 'inline_size', `voice-core ${len} > ${VOICE_CORE_MAX}`);
  }
  return issues;
}

const repoFiles = () => readdirSync(DEFAULT_SKILLS_DIR).filter((f) => f.endsWith('.md')).sort()
  .map((file) => ({ file, text: readFileSync(join(DEFAULT_SKILLS_DIR, file), 'utf8') }));

// ── the repo passes ─────────────────────────────────────────────────────────

test('skills audit: every editor skill passes every rule', () => {
  const files = repoFiles();
  assert.ok(files.length >= 36, `found ${files.length} skills`);
  assert.deepEqual(auditSkills(files, REGISTRY).map((i) => `${i.file} [${i.rule}] ${i.detail}`), []);
});

test('skills audit: the tool registry is built from the code (literal and factory names)', () => {
  for (const t of ['publish_post', 'submit_plan', 'load_skill', 'update_resource_format', 'attach_skill', 'detach_skill']) {
    assert.ok(REGISTRY.has(t), `${t} found`);
  }
  assert.ok(REGISTRY.size >= 80, `registry has ${REGISTRY.size} tools`);
  for (const id of Object.keys(NOT_TOOLS)) assert.ok(!REGISTRY.has(id), `${id} is allowlisted as a non-tool, so it must not be a tool`);
});

// ── each rule fails on a fixture ────────────────────────────────────────────

const fx = (name: string, body: string, front = `applies_to: [executor]`) =>
  ({ file: `${name}.md`, text: `---\nname: ${name}\ndescription: Скіл-фікстура для перевірки правил аудиту.\n${front}\n---\n${body}\n` });
const rulesOf = (files: Array<{ file: string; text: string }>) => auditSkills(files, REGISTRY).map((i) => i.rule);

test('skills audit fixture: an unknown tool fails; a real tool, a call form and an allowlisted id pass', () => {
  assert.deepEqual(rulesOf([fx('fx-tool', 'Виклич `publish_now` і `get_magic_numbers`.')]), ['unknown_tool', 'unknown_tool']);
  assert.deepEqual(rulesOf([fx('fx-tool-ok', 'Виклич `publish_post`, потім `fetch_api({source})`; директива `pause_series`; поле `format_prefs`.')]), []);
});

test('skills audit fixture: library:// refs fail', () => {
  assert.deepEqual(rulesOf([fx('fx-lib', '`"library_ref":"library://recipes/42"`')]), ['library_ref']);
  assert.deepEqual(rulesOf([fx('fx-data', '`"library_ref":"data://recipes/42"`')]), []);
});

test('skills audit fixture: shadow as the default start fails; shadow as a manual dry run passes', () => {
  for (const bad of [
    'Агент перші 3 дні працюватиме в **shadow**.',
    'Новий агент стартує в shadow.',
    'У shadow-режимі слайди не малюються.',
    'A new agent starts in shadow.',
  ]) assert.deepEqual(rulesOf([fx('fx-shadow', bad)]), ['shadow_default'], bad);
  assert.deepEqual(rulesOf([fx('fx-shadow-ok', 'Агент стартує в режимі апруву. Лише в режимі shadow (пробний прогін) превʼю текстом.')]), []);
});

test('skills audit fixture: missing, empty or unknown applies_to fails', () => {
  assert.deepEqual(rulesOf([fx('fx-no-roles', 'Текст.', 'safety: false')]), ['applies_to_empty']);
  assert.deepEqual(rulesOf([fx('fx-empty-roles', 'Текст.', 'applies_to: []')]), ['applies_to_empty']);
  assert.deepEqual(rulesOf([fx('fx-bad-role', 'Текст.', 'applies_to: [executor, editor_in_chief]')]), ['applies_to_role']);
});

test('skills audit fixture: broken frontmatter, a name/file mismatch and a duplicate fail', () => {
  assert.deepEqual(rulesOf([{ file: 'fx-broken.md', text: 'name: fx-broken\nбез фронтметеру' }]), ['frontmatter']);
  assert.deepEqual(rulesOf([{ ...fx('fx-a', 'Текст.'), file: 'fx-b.md' }]), ['frontmatter']);
  assert.deepEqual(rulesOf([fx('fx-dup', 'Текст.'), fx('fx-dup', 'Текст.')]), ['frontmatter']);
});

test('skills audit fixture: inline-candidate size limits', () => {
  const big = (n: number) => 'а'.repeat(n);
  assert.deepEqual(rulesOf([fx('editor-executor-workflow', big(EXECUTOR_WORKFLOW_MAX + 1))]), ['inline_size']);
  assert.deepEqual(rulesOf([fx('editor-planner-workflow', big(WORKFLOW_MAX + 1))]), ['inline_size']);
  assert.deepEqual(rulesOf([fx('editor-planner-workflow', big(WORKFLOW_MAX))]), []);
  assert.deepEqual(rulesOf([fx(`${OPTIONAL_SKILL_PREFIX}fixture`, big(SKILL_MAX_INLINE_BODY + 1))]), ['inline_size']);
  assert.deepEqual(rulesOf([fx('voice-core', big(VOICE_CORE_MAX + 1))]), ['inline_size']);
  assert.deepEqual(rulesOf([fx('format-fixture', big(7_000))]), [], 'an on-demand skill has only the lint body limit');
});

// ── locks and resource tone skills ──────────────────────────────────────────

test('protected voice skills: anti-slop, human-voice and voice-core are safety-locked by name', () => {
  for (const n of ['anti-slop', 'human-voice', 'voice-core']) assert.equal(isProtectedSkill(n), true, n);
  assert.equal(isProtectedSkill('format-hashtags'), false);
  const lib = new SkillLibrary();
  assert.equal(lib.get('anti-slop')?.safety, true);
  assert.equal(lib.get('human-voice')?.safety, true);
  assert.equal(parseSkill('voice-core.md', fx('voice-core', 'Голос.').text).safety, true, 'voice-core is locked as soon as it exists');
  assert.equal(lib.get('format-hashtags')?.safety, undefined);
});

test('tone skills: one per legacy channel-* skill, opt-in (unlisted for roles), mapped from the strategy types', () => {
  const legacyDir = join(SRC, '..', '.claude', 'skills');
  const legacy = existsSync(legacyDir) ? readdirSync(legacyDir).filter((n) => n.startsWith('channel-')) : [];
  assert.ok(legacy.length >= 9, `legacy channel skills: ${legacy.length}`);
  const lib = new SkillLibrary();
  for (const l of legacy) {
    const tone = lib.get(`tone-${l.slice('channel-'.length)}`);
    assert.ok(tone, `${l} has tone-${l.slice('channel-'.length)}`);
    assert.deepEqual([...tone!.appliesTo].sort(), ['composer', 'executor']);
    assert.ok(tone!.body.length <= SKILL_MAX_INLINE_BODY, `${tone!.name} fits inline`);
    assert.doesNotMatch(tone!.body, /<\/?[a-z]+>/i, `${tone!.name}: no raw HTML (PostSpec blocks only)`);
  }
  for (const role of ['executor', 'composer', 'planner'] as const) {
    assert.deepEqual(lib.list(role).filter((s) => isOptionalSkill(s.name)), [], `no tone skill listed for ${role}`);
  }
  assert.ok(lib.list().some((s) => s.name === 'tone-space'), 'the full catalogue (card validation) still knows them');
  for (const name of Object.values(TONE_SKILL_BY_TYPE)) assert.ok(lib.get(name), `${name} exists`);
  assert.deepEqual(toneSkillsFor(['recipes', 'recipe-carousel', 'quotes', 'space-news']), ['tone-recipes', 'tone-space']);
});

// ── spec 037 FR-015: content-integrity skills ───────────────────────────────

/**
 * Owner decisions of 2026-10-15 a skill must not contradict: «ви» for every resource (never an instruction to
 * address the reader with «ти»), no hashtags pushed on every post (news channels have `hashtags: off`), posters never
 * as a filler image, «» quotes (never "only straight quotes").
 */
const DECISION_RULES: ReadonlyArray<{ rule: string; re: RegExp; why: string }> = [
  { rule: 'address_ty', why: 'address is «ви» for every resource (spec 037 FR-008)',
    re: /(?:зверта\p{L}*|пиши|address\p{L}*)[^.\n]{0,40}(?<!\p{L})(?:на|as|with)\s+«?ти»?(?![\p{L}-])/iu },
  { rule: 'hashtags_always', why: 'news channels have hashtags off (spec 037 FR-008)',
    re: /(?:завжди|обовʼязково|обов'язково|always)\s+(?:став\p{L}*|дода\p{L}*|пиши|add|include)[^.\n]{0,20}(?:хештег|hashtag)/iu },
  { rule: 'poster_filler', why: 'posters only on non-news posts matching use_for, never as a filler (spec 037 FR-011)',
    re: /(?:немає|бракує|no)[^.\n]{0,30}(?:фото|зображен\p{L}*|картинк\p{L}*|image)[^.\n]{0,20}(?:—|→|,|:)\s*(?:візьми|став|бери|use|add)[^.\n]{0,20}(?:постер|poster)/iu },
  { rule: 'straight_quotes', why: 'Ukrainian text uses «» (spec 037 FR-006 normaliser)',
    re: /only straight \(|лише прямі лапки/iu },
];

function decisionIssues(files: Array<{ file: string; text: string }>): AuditIssue[] {
  const out: AuditIssue[] = [];
  for (const { file, text } of files) {
    for (const { rule, re, why } of DECISION_RULES) {
      const m = text.match(re);
      if (m) out.push({ file, rule, detail: `"${m[0]}": ${why}` });
    }
  }
  return out;
}

/** Every rule backed by a deterministic check names its code (spec 037 FR-015). */
const SKILL_CHECK_CODES: Readonly<Record<string, readonly string[]>> = {
  'news-followups':         ['story_repeat', 'followup_without_new_facts', 'followup_restates', 'story_cross_channel', 'fact_conflict', 'stale_source', 'stale_now_word', 'date_relative_mismatch', 'weekday_mismatch', 'relative_date_unanchored', 'event_date_missing', 'event_not_covered'],
  'deals-giveaways':        ['deal_expired', 'deal_expiring', 'source_is_homepage', 'number_not_in_sources', 'fact_conflict', 'image_not_from_source', 'process_leak', 'address_mixed', 'story_repeat'],
  'proper-nouns-terms':     ['glossary_violation', 'mixed_script_word', 'name_script_mixed', 'jargon_over_level', 'decimal_mixed'],
  'format-poll-quiz':       ['knowledge_poll', 'quiz_answer_revealed', 'poll_cap_reached', 'glossary_violation'],
  'fact-check':             ['number_not_in_sources', 'low_tier_claim', 'fact_conflict'],
  'editor-critic-workflow': ['date_relative_mismatch', 'story_repeat', 'process_leak', 'text_replacement_char', 'mixed_script_word', 'address_mixed', 'hashtag_while_off', 'knowledge_poll', 'image_not_from_source', 'poster_mismatch'],
  'anti-slop':              ['process_leak', 'address_mixed'],
  'content-sources':        ['source_is_homepage', 'stale_source', 'duplicate_attribution', 'low_tier_claim'],
  'source-licensing':       ['image_not_from_source', 'poster_mismatch'],
  'kpi-reading':            ['insufficient_data', 'confidence'],
  'grammar-ua':             ['decimal_mixed', 'text_replacement_char', 'mixed_script_word'],
  'format-hashtags':        ['hashtag_while_off', 'hashtag_not_in_vocabulary'],
  'tone-gaming':            ['address_mixed', 'stale_source'],
  'network-promo':          ['story_cross_channel', 'story_repost'],
};

test('037 skills: the three new skills exist, parse and reach the writer and the critic', () => {
  const lib = new SkillLibrary();
  for (const name of ['news-followups', 'proper-nouns-terms', 'deals-giveaways']) {
    const s = lib.get(name);
    assert.ok(s, `${name} exists`);
    for (const role of ['executor', 'composer', 'checker'] as const) assert.ok(s!.appliesTo.includes(role), `${name} applies to ${role}`);
    assert.ok(lib.list('executor').some((m) => m.name === name), `${name} is listed for the executor (load_skill)`);
    assert.ok(s!.body.length <= SKILL_MAX_INLINE_BODY, `${name} fits the inline limit (${s!.body.length})`);
  }
});

test('037 skills: a rule backed by a deterministic check names its code', () => {
  const lib = new SkillLibrary();
  for (const [name, codes] of Object.entries(SKILL_CHECK_CODES)) {
    const s = lib.get(name);
    assert.ok(s, `${name} exists`);
    for (const code of codes) assert.ok(s!.body.includes(code), `${name} names ${code}`);
  }
});

test('037 skills: the owner decisions of 2026-10-15 are stated where they belong', () => {
  const lib = new SkillLibrary();
  const body = (n: string) => lib.get(n)!.body;
  assert.match(body('news-followups'), /36 год/);
  assert.match(body('news-followups'), /72 год/);
  assert.match(body('news-followups'), /Не більше одного оновлення на сюжет на день/);
  assert.match(body('news-followups'), /відповіддю \(reply\) на оригінал/);
  assert.match(body('deals-giveaways'), /в останні 24 год/);
  assert.match(body('content-sources'), /Не більше одного на канал на день/);
  assert.match(body('format-hashtags'), /Новинні канали — `off`/);
  assert.match(body('kpi-reading'), /n ≥ 8 і медіана ≥ 30/);
  assert.match(body('kpi-reading'), /n < 3 або медіана < 10/);
  assert.match(body('kpi-reading'), /недостатньо даних/);
  assert.match(body('voice-core'), /типово на «ви»/);
  assert.match(body('source-licensing'), /Постер на новині — помилка/);
});

test('037 skills: no skill contradicts the owner decisions', () => {
  assert.deepEqual(decisionIssues(repoFiles()).map((i) => `${i.file} [${i.rule}] ${i.detail}`), []);
});

test('037 skills fixture: each decision rule fails on a contradicting text and passes the allowed wording', () => {
  const rules = (body: string) => decisionIssues([fx('fx-decision', body)]).map((i) => i.rule);
  assert.deepEqual(rules('Звертайся до читача на «ти», так ближче.'), ['address_ty']);
  assert.deepEqual(rules('Address the reader as ти.'), ['address_ty']);
  assert.deepEqual(rules('Завжди додавай 3 хештеги в кінці.'), ['hashtags_always']);
  assert.deepEqual(rules('Немає фото в джерелі — візьми постер з ai_posters.'), ['poster_filler']);
  assert.deepEqual(rules('- No curly quotes (“ ”) — only straight (" ").'), ['straight_quotes']);
  assert.deepEqual(rules([
    'Звертання — як у стилі ресурсу, типово на «ви»; «ти»-форми поруч із «ви» — помилка.',
    'Пиши на тиждень наперед; хештеги лише якщо стиль ресурсу їх дозволяє.',
    'Постер не заповнює порожнє місце: немає доречного — пост без зображення.',
    'Лапки — «ялинки».',
  ].join('\n')), []);
});
