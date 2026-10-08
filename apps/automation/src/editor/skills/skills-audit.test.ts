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
